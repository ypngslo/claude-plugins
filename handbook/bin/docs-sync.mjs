#!/usr/bin/env node
/**
 * docs-sync — deterministic, zero-dependency mirror of local page files into
 * Confluence Cloud. The design contract (docs/design.md is authoritative):
 *
 *   - confluence/pages/*.md files are the SOURCE OF TRUTH. This CLI only pushes.
 *   - No model tokens are ever spent on Confluence I/O: the session edits page
 *     files; a PostToolUse hook spawns this CLI detached. It must therefore
 *     always be safe to run concurrently (lockfile + rerun flag), idempotent
 *     (diff a hash of the GENERATED STORAGE against .sync-state.json), and
 *     non-fatal on any Confluence failure (the next trigger retries).
 *   - The FIRST publish of a page and any retire require `approved: true` —
 *     the human-approval gate. Content updates to an already-published page
 *     are autonomous; the audience gate (lint + ## Editorial trail) is the
 *     mechanical backstop on what may reach a PM's screen.
 *   - A malformed page file is THAT page's counted failure, never the pass's
 *     (deliberate divergence from jira3).
 *
 * Commands:
 *   docs-sync.mjs init   [--repo <dir>]                     scaffold confluence/
 *   docs-sync.mjs sync   [--repo <dir>] [--dry-run] [--force] [--adopt]
 *   docs-sync.mjs pull   [--repo <dir>]                     drift REPORT only
 *   docs-sync.mjs stale  [--repo <dir>] [--brief] [--exit-code]
 *   docs-sync.mjs lint   [<slug>] [--repo <dir>]
 *   docs-sync.mjs render <slug> [--repo <dir>]
 *
 * Config: confluence/config.json (per repo — site/spaceKey and the knobs in
 * docs/design.md §2). Credentials are NEVER in the repo: email + API token come
 * from env (CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN by default; names
 * overridable in config; `email` may be inlined, the token may not).
 *
 * Exit codes: 0 ok (including "nothing to do", "lock held, rerun queued" and
 * every report command); 1 one or more pages failed; 2 config/usage error;
 * 3 credentials missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RENDER_VERSION, renderStorage, firstParagraph } from './render.mjs';
import { lintPage, publishGateReason } from './lint.mjs';
import { headSha, staleReport } from './gitinfo.mjs';

// ---------------------------------------------------------------------------
// tiny arg parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const command = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const repoFlagIndex = argv.indexOf('--repo');
const repoRoot = path.resolve(
  repoFlagIndex !== -1 && argv[repoFlagIndex + 1] ? argv[repoFlagIndex + 1] : process.cwd()
);
const DRY = flags.has('--dry-run');
const FORCE = flags.has('--force');
const ADOPT = flags.has('--adopt');
const BRIEF = flags.has('--brief');
const EXIT_CODE = flags.has('--exit-code');

// Positionals skip `--repo`'s value, so `lint --repo /x` has no slug.
const positionals = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--repo') {
    i += 1;
    continue;
  }
  if (argv[i].startsWith('--')) continue;
  positionals.push(argv[i]);
}
const targetSlug = positionals[0];

const CONFLUENCE_DIR = path.join(repoRoot, 'confluence');
const PAGES_DIR = path.join(CONFLUENCE_DIR, 'pages');
const CONFIG_PATH = path.join(CONFLUENCE_DIR, 'config.json');
const STATE_PATH = path.join(CONFLUENCE_DIR, '.sync-state.json');
const LOCK_PATH = path.join(CONFLUENCE_DIR, '.sync.lock');
const RERUN_PATH = path.join(CONFLUENCE_DIR, '.sync.rerun');

const log = (msg) =>
  process.stdout.write(`${new Date().toISOString()} [handbook] ${msg}\n`);
const warn = (msg) =>
  process.stderr.write(`${new Date().toISOString()} [handbook] WARN ${msg}\n`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asArray = (value) =>
  Array.isArray(value) ? value.map(String) : value === undefined || value === null || value === '' ? [] : [String(value)];

// ---------------------------------------------------------------------------
// frontmatter — strict, tiny subset (key: value, arrays as [a, b], booleans)
// ---------------------------------------------------------------------------
export function parsePageFile(raw, slug) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${slug}: missing frontmatter block`);
  const [, front, body] = match;
  const fields = {};
  for (const line of front.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) throw new Error(`${slug}: unparseable frontmatter line: ${line}`);
    const [, key, rawValue] = kv;
    let value = rawValue.trim();
    // A fully-wrapping quote pair makes the value a literal string, BEFORE any
    // array/boolean detection — doc titles contain ':' and '[' routinely.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      fields[key] = value.slice(1, -1);
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    fields[key] = value;
  }
  return { slug, fields, body: body.trim() };
}

/** Rewrite ONE frontmatter key in place, preserving everything else byte-for-byte. */
export function setFrontmatterKey(raw, key, value) {
  const lines = raw.split('\n');
  const end = lines.indexOf('---', 1);
  for (let i = 1; i < end; i++) {
    if (lines[i].match(new RegExp(`^${key}:`))) {
      lines[i] = `${key}: ${value}`;
      return lines.join('\n');
    }
  }
  lines.splice(end, 0, `${key}: ${value}`);
  return lines.join('\n');
}

// Everything above the first special heading is the publish body. `## Editorial`
// (audience-gate trail) and `## Rework` (confirmed findings) are LOCAL ONLY:
// they never reach Confluence in any form and never touch the content hash.
export function splitBody(body) {
  const parts = { publishBody: body.trim(), editorial: null, rework: null };
  const headings = [...body.matchAll(/^## (Editorial|Rework)\s*$/gm)];
  if (!headings.length) return parts;
  parts.publishBody = body.slice(0, headings[0].index).trim();
  headings.forEach((m, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].index : body.length;
    parts[m[1].toLowerCase()] = body.slice(m.index + m[0].length, end).trim() || null;
  });
  return parts;
}

export function fnv1a(s) {
  // FNV-1a — good enough for change detection, no crypto import needed.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// config / state / credentials
// ---------------------------------------------------------------------------
const DEFAULT_KINDS = {
  index: { label: 'index', requireSources: false, allowCodeBlocks: false, requiredSections: [] },
  overview: {
    label: 'overview',
    requireSources: true,
    allowCodeBlocks: false,
    requiredSections: ['What it is', "Who it's for"],
  },
  feature: {
    label: 'feature',
    requireSources: true,
    allowCodeBlocks: false,
    requiredSections: ['What it does', 'How it behaves', 'Limits & known gaps'],
  },
  capabilities: {
    label: 'capabilities',
    requireSources: true,
    allowCodeBlocks: false,
    requiredSections: ['What it can do today', 'What it cannot do yet'],
  },
  glossary: { label: 'glossary', requireSources: false, allowCodeBlocks: false, requiredSections: [] },
  'release-notes': {
    label: 'release-notes',
    requireSources: false,
    allowCodeBlocks: false,
    requiredSections: [],
  },
  reference: { label: 'reference', requireSources: true, allowCodeBlocks: true, requiredSections: [] },
};

const DEFAULT_CODE_LANGUAGES = [
  'bash', 'css', 'html', 'java', 'javascript', 'json', 'kotlin', 'python', 'ruby', 'sql',
  'typescript', 'xml', 'yaml', 'go', 'rust', 'php', 'c', 'cpp', 'csharp', 'swift', 'text',
];

/**
 * Structure is the tool's business, vocabulary is the project's: docs-sync knows
 * only the four structural properties, never what a kind means. config `kinds`
 * is spread OVER the default bank so a project adds or replaces kinds wholesale;
 * a partial entry inherits the neutral defaults rather than undefined.
 */
export function resolveKinds(config) {
  const merged = { ...DEFAULT_KINDS, ...(config?.kinds ?? {}) };
  const out = {};
  for (const [key, value] of Object.entries(merged)) {
    out[key] = {
      label: value?.label ?? key,
      requireSources: value?.requireSources === true,
      allowCodeBlocks: value?.allowCodeBlocks === true,
      requiredSections: Array.isArray(value?.requiredSections) ? value.requiredSections : [],
    };
  }
  return out;
}

/**
 * Suite labels (config `labels: ["acme"]`) are stamped on every page this repo
 * owns, and the first one namespaces the per-page `hb-` marker label so two
 * repos publishing into one space never collide on a slug. Validated before any
 * network call — a malformed list is a config error, not a mid-pass surprise.
 */
export function resolveLabels(config) {
  const labels = config.labels ?? [];
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' || !/^\S+$/.test(l))) {
    warn('config.json labels: must be an array of non-empty strings without spaces (Confluence label syntax)');
    process.exit(2);
  }
  return labels;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    warn(`no ${CONFIG_PATH} — run \`docs-sync init\` (or /handbook:init) first`);
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const required of ['site', 'spaceKey']) {
    if (!raw[required]) {
      warn(`config.json missing required key: ${required}`);
      process.exit(2);
    }
  }
  const config = {
    parentPageId: '',
    titlePrefix: '',
    labels: [],
    emailEnv: 'CONFLUENCE_EMAIL',
    tokenEnv: 'CONFLUENCE_API_TOKEN',
    repoUrl: '',
    ...raw,
    // `audience.banned` is deliberately NOT defaulted here: absent means "use
    // lint.mjs's built-in bank", so the bank lives in exactly one place.
    audience: { allow: [], allowPattern: [], maxGrade: 10, maxWords: 1200, ...(raw.audience ?? {}) },
    staleness: { watch: [], ignore: ['**/*.test.*', '**/__snapshots__/**'], ...(raw.staleness ?? {}) },
    render: { toc: 'auto', banner: true, codeLanguages: DEFAULT_CODE_LANGUAGES, ...(raw.render ?? {}) },
    sync: {
      onRemoteEdit: 'block',
      adoptExisting: false,
      retireMode: 'banner',
      maxUpdatesPerRun: 25,
      ...(raw.sync ?? {}),
    },
  };
  resolveLabels(config); // fail fast on a malformed labels list
  return config;
}

/**
 * Optional per-repo env file (config.envFile, path relative to the repo root,
 * e.g. ".env"). Minimal KEY=VALUE parser: comments/blank lines skipped, an
 * `export ` prefix tolerated, single/double quotes stripped. Values NEVER
 * override the real process environment — the ambient env wins, the file only
 * fills gaps (same precedence contract as dotenv override:false).
 */
export function parseEnvFile(raw) {
  const out = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let [, key, value] = match;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function applyEnvFile(config) {
  if (!config.envFile) return;
  const envPath = path.resolve(repoRoot, config.envFile);
  if (!fs.existsSync(envPath)) {
    warn(`config.envFile points at ${envPath}, which does not exist — continuing on process env only`);
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(envPath, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function loadCredentials(config) {
  applyEnvFile(config);
  const email = config.email || process.env[config.emailEnv];
  const token = process.env[config.tokenEnv];
  if (!email || !token) {
    warn(
      `credentials missing: need ${config.email ? '' : `${config.emailEnv} and `}${config.tokenEnv} in the environment. Nothing synced; will retry on next trigger.`
    );
    process.exit(3);
  }
  return { email, token };
}

function loadState() {
  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : {};
  state.pages ??= {};
  state.orphans ??= {};
  return state;
}
const saveState = (state) => {
  state.renderVersion = RENDER_VERSION;
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
};

// ---------------------------------------------------------------------------
// locking: concurrent hook spawns collapse into "one more pass"
// ---------------------------------------------------------------------------
let iOwnLock = false;
let stealAttempts = 0;

function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    iOwnLock = true;
    return true;
  } catch {
    // The holder can release between the failed open and this stat — treat a
    // vanished lock as infinitely stale so the bounded retry re-acquires it.
    let age = Infinity;
    try {
      age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
    } catch {
      age = Infinity;
    }
    if (age > 120_000 && stealAttempts < 2) {
      stealAttempts += 1;
      fs.rmSync(LOCK_PATH, { force: true });
      return acquireLock();
    }
    fs.writeFileSync(RERUN_PATH, '');
    log('another sync holds the lock — queued a rerun');
    return false;
  }
}

// Only ever remove a lock this process actually created.
const releaseLock = () => {
  if (!iOwnLock) return;
  iOwnLock = false;
  fs.rmSync(LOCK_PATH, { force: true });
};

// ---------------------------------------------------------------------------
// Confluence HTTP (v2 for pages, v1 for labels + archive)
// ---------------------------------------------------------------------------
const RETRYABLE = new Set(['GET', 'PUT', 'DELETE']);

const jitter = () => 0.7 + Math.random() * 0.6;
const backoffMs = (attempt) => Math.round(Math.min(5000 * 2 ** (attempt - 1), 30_000) * jitter());
const retryAfterMs = (response) => {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
};

function describeStatus(method, apiPath, status, text) {
  if (status === 401) {
    return `${method} ${apiPath} → 401 token rejected — expired (all Atlassian tokens expire ≤365 days) or a scoped token that needs config.apiBase = https://api.atlassian.com/ex/confluence/<cloudId>`;
  }
  if (status === 403) {
    return `${method} ${apiPath} → 403 permission — this account may not do that in this space`;
  }
  if (status === 404) {
    return `${method} ${apiPath} → 404 does not exist OR you lack permission (the API conflates them)`;
  }
  return `${method} ${apiPath} → ${status} ${text.slice(0, 300)}`;
}

function confluenceClient(config, creds) {
  const base = (
    process.env.CONFLUENCE_BASE_URL_OVERRIDE ||
    config.apiBase ||
    `https://${config.site}`
  ).replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`;
  return async function request(method, apiPath, body) {
    let attempt = 0;
    let sendRetries = 0;
    for (;;) {
      attempt += 1;
      let response;
      try {
        response = await fetch(`${base}${apiPath}`, {
          method,
          headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        // A POST that may already have been executed is NEVER retried — the
        // duplicate-title trap. The next pass re-queries and sees the truth.
        if (!RETRYABLE.has(method) || sendRetries >= 2) {
          throw new Error(`${method} ${apiPath} → ${error.message}`);
        }
        sendRetries += 1;
        await sleep(500 * sendRetries);
        continue;
      }
      if (response.status === 429 && attempt < 4) {
        const floor = retryAfterMs(response);
        await sleep(floor === null ? backoffMs(attempt) : floor);
        continue;
      }
      if (response.status >= 500 && RETRYABLE.has(method) && sendRetries < 2) {
        sendRetries += 1;
        await sleep(500 * sendRetries);
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(describeStatus(method, apiPath, response.status, text));
      }
      return response.status === 204 ? null : response.json();
    }
  };
}

// Cursor links come back absolute or relative depending on the deployment.
function nextPath(link) {
  if (!link) return null;
  try {
    const url = new URL(link, 'https://placeholder.invalid');
    return `${url.pathname}${url.search}`;
  } catch {
    return link;
  }
}

// ---------------------------------------------------------------------------
// page loading, ordering, render context
// ---------------------------------------------------------------------------
// 0-based index of publishBody's first line, so RenderError lines land in
// whole-file coordinates like lint's do.
function bodyLineOffset(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') return 0;
  const end = lines.indexOf('---', 1);
  if (end === -1) return 0;
  let start = end + 1;
  while (start < lines.length && lines[start].trim() === '') start += 1;
  return start;
}

export function loadPages(config, pagesDir = PAGES_DIR) {
  const kinds = resolveKinds(config);
  const pages = [];
  if (!fs.existsSync(pagesDir)) return pages;
  for (const file of fs.readdirSync(pagesDir).sort()) {
    if (!file.endsWith('.md')) continue;
    const slug = file.replace(/\.md$/, '');
    const filePath = path.join(pagesDir, file);
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
      const page = parsePageFile(raw, slug);
      const { publishBody, editorial, rework } = splitBody(page.body);
      page.publishBody = publishBody;
      page.editorial = editorial;
      page.rework = rework;
      page.filePath = filePath;
      page.raw = raw;
      page.bodyLineOffset = bodyLineOffset(raw);
      page.kind = kinds[page.fields.kind] ?? null;
      pages.push(page);
    } catch (error) {
      // A malformed file is this page's failure — the rest of the suite syncs.
      pages.push({
        slug,
        filePath,
        raw,
        error,
        fields: {},
        body: '',
        publishBody: '',
        editorial: null,
        rework: null,
        kind: null,
      });
    }
  }
  return pages;
}

const orderOf = (page) => {
  const n = Number(page.fields.order);
  return Number.isFinite(n) ? n : 100;
};
const parentSlugOf = (page) => (page.error ? '' : String(page.fields.parent ?? '').trim());
const effectiveTitle = (config, page) => `${config.titlePrefix ?? ''}${page.fields.title ?? ''}`;
const markerLabel = (config, slug) =>
  config.labels.length ? `hb-${config.labels[0]}-${slug}` : `hb-${slug}`;

/**
 * Parents first: a child needs its parent's Confluence id in the same pass.
 * Memoized depth over `parent:`; a cycle fails the pages inside it AND every
 * page hanging off them, naming the loop. Filename order breaks depth ties.
 */
function orderPages(pages) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const depth = new Map();
  const cycleError = new Map();

  const visit = (slug, trail) => {
    if (depth.has(slug)) return depth.get(slug);
    if (cycleError.has(slug)) return null;
    const at = trail.indexOf(slug);
    if (at !== -1) {
      const loop = [...trail.slice(at), slug].join(' → ');
      for (const member of trail.slice(at)) cycleError.set(member, `parent cycle: ${loop}`);
      return null;
    }
    const page = bySlug.get(slug);
    const parent = page ? parentSlugOf(page) : '';
    if (!parent || !bySlug.has(parent)) {
      depth.set(slug, 0);
      return 0;
    }
    const parentDepth = visit(parent, [...trail, slug]);
    if (parentDepth === null) {
      cycleError.set(slug, cycleError.get(parent) ?? `parent cycle at ${slug}`);
      return null;
    }
    depth.set(slug, parentDepth + 1);
    return parentDepth + 1;
  };

  for (const page of pages) visit(page.slug, []);
  const ordered = [...pages].sort((a, b) => {
    const da = depth.has(a.slug) ? depth.get(a.slug) : Number.MAX_SAFE_INTEGER;
    const db = depth.has(b.slug) ? depth.get(b.slug) : Number.MAX_SAFE_INTEGER;
    return da - db || a.slug.localeCompare(b.slug);
  });
  return { ordered, cycleError, bySlug };
}

function makeDeps(config, pages, state = { pages: {}, orphans: {} }) {
  const { ordered, cycleError, bySlug } = orderPages(pages);
  const suite = { pages: new Map(pages.filter((p) => !p.error).map((p) => [p.slug, p])) };
  return { config, state, pages, ordered, cycleError, bySlug, suite, kinds: resolveKinds(config) };
}

// Published, non-retired direct children, in index-table order.
function childrenOf(parentSlug, deps) {
  const { config, bySlug } = deps;
  return [...bySlug.values()]
    .filter((p) => !p.error && parentSlugOf(p) === parentSlug && p.fields.status === 'published')
    .sort((a, b) => orderOf(a) - orderOf(b) || a.slug.localeCompare(b.slug))
    .map((child) => ({
      slug: child.slug,
      title: effectiveTitle(config, child),
      kindLabel: child.kind?.label ?? String(child.fields.kind ?? ''),
      firstParagraph: firstParagraph(child.publishBody),
    }));
}

// `children` is an ARRAY for index kinds and undefined everywhere else — the
// renderer reads its presence as "this page is an index" (it decides both the
// trailing table and whether a "<!-- children -->" marker is legal here).
function buildCtx(page, deps, retired = false) {
  const { config, bySlug } = deps;
  const isIndex = page.fields.kind === 'index' || page.kind?.label === 'index';
  return {
    config,
    kind: page.kind,
    resolveTitle: (slug) => {
      const target = bySlug.get(String(slug ?? '').replace(/\.md$/, ''));
      return target && !target.error && target.fields.title ? effectiveTitle(config, target) : null;
    },
    children: isIndex ? childrenOf(page.slug, deps) : undefined,
    ...(retired ? { retired: true } : {}),
  };
}

const describeRenderError = (error) => {
  const line = error?.line;
  if (!line) return error?.message ?? String(error);
  return error.message.includes(`line ${line}`) ? error.message : `${error.message} (line ${line})`;
};

const render = (page, deps, { retired = false } = {}) =>
  renderStorage(
    {
      slug: page.slug,
      fields: page.fields,
      publishBody: page.publishBody,
      bodyLineOffset: page.bodyLineOffset ?? 0,
    },
    buildCtx(page, deps, retired)
  );

// ---------------------------------------------------------------------------
// sync — planning (no network) then execution (writes serialized)
// ---------------------------------------------------------------------------

function planPage(page, deps) {
  const { config, state, cycleError, kinds, suite } = deps;
  const slug = page.slug;
  if (page.error) return { page, action: 'error', message: page.error.message };
  if (cycleError.has(slug)) return { page, action: 'error', message: cycleError.get(slug) };
  const fields = page.fields;
  if (!fields.title) return { page, action: 'error', message: 'frontmatter needs a title' };
  if (!page.kind) {
    return {
      page,
      action: 'error',
      message: `unknown kind "${fields.kind ?? ''}" — known kinds: ${Object.keys(kinds).join(', ')}`,
    };
  }

  const entry = state.pages[slug];
  const pageId = String(fields.pageId || entry?.pageId || '');
  const title = effectiveTitle(config, page);
  const status = String(fields.status || 'draft');

  if (status === 'draft') return { page, action: 'draft' };

  if (status === 'retired') {
    if (entry?.retired) return { page, action: 'settled' };
    if (fields.approved !== true) return { page, action: 'unapproved-retire' };
    if (!pageId) return { page, action: 'retire-unpublished' };
    const storage =
      config.sync.retireMode === 'banner' ? render(page, deps, { retired: true }) : null;
    return { page, action: 'retire', pageId, title, storage, hash: storage ? fnv1a(storage) : null };
  }

  if (status !== 'published') {
    return { page, action: 'error', message: `unknown status "${status}" — expected draft, published or retired` };
  }

  const gate = publishGateReason(page, lintPage(page, suite, config));
  if (gate) return { page, action: 'gated', reason: gate };

  const storage = render(page, deps);
  const bytes = Buffer.byteLength(storage, 'utf8');
  if (bytes > 5_000_000) {
    return { page, action: 'error', message: `storage is ${bytes} bytes — Confluence rejects bodies over 5 MB` };
  }
  return { page, action: 'publish', pageId, title, storage, hash: fnv1a(storage) };
}

function resolveParentId(page, deps) {
  const { config, state, bySlug } = deps;
  const parent = parentSlugOf(page);
  if (!parent) return String(config.parentPageId || '');
  const parentPage = bySlug.get(parent);
  const id = parentPage?.fields?.pageId || state.pages[parent]?.pageId || '';
  return String(id || config.parentPageId || '');
}

function writebackPageId(page, pageId) {
  page.raw = setFrontmatterKey(page.raw, 'pageId', pageId);
  page.fields.pageId = String(pageId);
  fs.writeFileSync(page.filePath, page.raw);
}

// PUT the whole page. 400/409 means our version number lost a race: re-GET once
// and retry once with a fresh number, then it is this page's failure.
async function putPage(request, pageId, payload, versionNumber) {
  const send = (number) =>
    request('PUT', `/wiki/api/v2/pages/${pageId}`, {
      id: String(pageId),
      status: 'current',
      title: payload.title,
      ...(payload.parentId ? { parentId: payload.parentId } : {}),
      body: { representation: 'storage', value: payload.storage },
      version: { number, message: payload.message },
    });
  try {
    return await send(versionNumber);
  } catch (error) {
    if (!/→ (400|409)\b/.test(error.message)) throw error;
    const live = await request('GET', `/wiki/api/v2/pages/${pageId}`);
    return send((live?.version?.number ?? versionNumber - 1) + 1);
  }
}

async function findExactTitle(request, spaceId, title) {
  let apiPath = `/wiki/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&title=${encodeURIComponent(title)}&status=current&limit=250`;
  for (let page = 0; apiPath && page < 20; page += 1) {
    const data = await request('GET', apiPath);
    // The API's title filter is a prefix/substring match — verify exactly here,
    // or adoption silently swallows a neighbouring page.
    const exact = (data?.results ?? []).find((result) => result.title === title);
    if (exact) return exact;
    apiPath = nextPath(data?._links?.next);
  }
  return null;
}

async function ensureSpaceId(request, config, state) {
  if (state.spaceId) return state.spaceId;
  const data = await request(
    'GET',
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(config.spaceKey)}&limit=1`
  );
  const space = data?.results?.[0];
  if (!space) {
    throw new Error(`space ${config.spaceKey} does not exist OR you lack permission (the API conflates them)`);
  }
  state.spaceId = String(space.id);
  return state.spaceId;
}

/**
 * Labels are declarative over the set WE wrote: anything a human added by hand
 * is never in state.labels, so it is never removed. Dropping a label from
 * config removes exactly that label on the next pass.
 */
async function syncLabels(request, deps, page, entry) {
  const { config } = deps;
  const desired = [
    ...new Set([
      ...config.labels,
      page.kind.label,
      ...asArray(page.fields.labels),
      markerLabel(config, page.slug),
    ]),
  ].filter(Boolean);
  const owned = asArray(entry.labels);
  const add = desired.filter((label) => !owned.includes(label));
  const remove = owned.filter((label) => !desired.includes(label));
  if (!add.length && !remove.length) {
    entry.labels = desired;
    return;
  }
  if (DRY) {
    log(`DRY labels ${page.slug}${add.length ? ` +${add.join(',')}` : ''}${remove.length ? ` -${remove.join(',')}` : ''}`);
    return;
  }
  if (add.length) {
    await request(
      'POST',
      `/wiki/rest/api/content/${entry.pageId}/label`,
      add.map((name) => ({ prefix: 'global', name }))
    );
  }
  for (const name of remove) {
    await request('DELETE', `/wiki/rest/api/content/${entry.pageId}/label?name=${encodeURIComponent(name)}`);
  }
  entry.labels = desired;
  log(
    `labels page ${entry.pageId} ← ${page.slug}${add.length ? ` +${add.join(',')}` : ''}${remove.length ? ` -${remove.join(',')}` : ''}`
  );
  // Label writes can bump the page version — refresh the drift oracle.
  const refreshed = await request('GET', `/wiki/api/v2/pages/${entry.pageId}`);
  if (refreshed?.version?.number) entry.version = refreshed.version.number;
}

async function executeRetire(request, deps, plan, versionMessage) {
  const { config, state } = deps;
  const page = plan.page;
  const mode = config.sync.retireMode;
  const entry = (state.pages[page.slug] ??= {
    pageId: plan.pageId,
    title: plan.title,
    parentId: '',
    hash: null,
    version: null,
    labels: [],
    retired: false,
  });
  entry.pageId = plan.pageId;
  if (DRY) {
    log(`DRY retire ${page.slug} → page ${plan.pageId} (${mode})`);
    return;
  }
  if (mode === 'leave') {
    log(`retired ${page.slug} — leaving page ${plan.pageId} live (sync.retireMode: leave)`);
  } else if (mode === 'trash') {
    await request('DELETE', `/wiki/api/v2/pages/${plan.pageId}`);
    log(`retired ${page.slug} — page ${plan.pageId} moved to the trash`);
  } else if (mode === 'archive') {
    await request('POST', '/wiki/rest/api/content/archive', { pages: [{ id: String(plan.pageId) }] });
    log(`retired ${page.slug} — page ${plan.pageId} archived`);
  } else {
    const live = await request('GET', `/wiki/api/v2/pages/${plan.pageId}`);
    const number = (live?.version?.number ?? 0) + 1;
    const updated = await putPage(
      request,
      plan.pageId,
      {
        title: plan.title,
        parentId: entry.parentId || '',
        storage: plan.storage,
        message: versionMessage(page.slug),
      },
      number
    );
    entry.hash = plan.hash;
    entry.title = plan.title;
    entry.version = updated?.version?.number ?? number;
    log(`retired ${page.slug} — no-longer-maintained banner posted to page ${plan.pageId}`);
  }
  entry.retired = true;
}

async function executePublish(request, deps, plan, versionMessage) {
  const { config, state } = deps;
  const page = plan.page;
  const slug = page.slug;
  const parentId = resolveParentId(page, deps);
  let pageId = plan.pageId;

  // -- create --------------------------------------------------------------
  if (!pageId) {
    if (page.fields.approved !== true) {
      warn(`${slug}: NOT publishing — first publish is the human's call — set approved: true`);
      return;
    }
    if (DRY) {
      log(`DRY create ${slug} → "${plan.title}"`);
      return;
    }
    const adopted =
      ADOPT || config.sync.adoptExisting
        ? await findExactTitle(request, await ensureSpaceId(request, config, state), plan.title)
        : null;
    if (adopted) {
      pageId = String(adopted.id);
      writebackPageId(page, pageId);
      state.pages[slug] = {
        pageId,
        title: adopted.title,
        parentId: String(adopted.parentId || ''),
        hash: null,
        version: null,
        labels: [],
        retired: false,
      };
      log(`ADOPTED page ${pageId} "${adopted.title}" ← ${slug} — handbook owns it now and will overwrite it from this file`);
      // falls through to the update path, which re-reads the live version
    } else {
      const spaceId = await ensureSpaceId(request, config, state);
      let created;
      try {
        created = await request('POST', '/wiki/api/v2/pages', {
          spaceId: String(spaceId),
          status: 'current',
          title: plan.title,
          ...(parentId ? { parentId } : {}),
          body: { representation: 'storage', value: plan.storage },
        });
      } catch (error) {
        if (/→ 400\b/.test(error.message) && /already exists/i.test(error.message)) {
          throw new Error(
            `another page owns this title — set titlePrefix, rename, or run with --adopt ("${plan.title}")`
          );
        }
        throw error;
      }
      pageId = String(created.id);
      writebackPageId(page, pageId);
      const entry = {
        pageId,
        title: plan.title,
        parentId,
        hash: plan.hash,
        version: created?.version?.number ?? 1,
        labels: [],
        retired: false,
      };
      state.pages[slug] = entry;
      log(`created page ${pageId} ← ${slug} ("${plan.title}")`);
      await syncLabels(request, deps, page, entry);
      return;
    }
  }

  // -- update --------------------------------------------------------------
  const entry = (state.pages[slug] ??= {
    pageId,
    title: null,
    parentId: null,
    hash: null,
    version: null,
    labels: [],
    retired: false,
  });
  entry.pageId = pageId;
  entry.retired = false;
  const changed = FORCE || entry.hash !== plan.hash;
  const renamed = entry.title !== plan.title;
  const moved = entry.parentId !== parentId;

  if (changed || renamed || moved) {
    if (DRY) {
      log(
        `DRY update ${slug} → page ${pageId}${changed ? ' content' : ''}${renamed ? ' title' : ''}${moved ? ' parent' : ''}`
      );
      return;
    }
    const live = await request('GET', `/wiki/api/v2/pages/${pageId}`);
    const liveNumber = live?.version?.number ?? 0;
    if (entry.version !== null && entry.version !== undefined && liveNumber !== entry.version) {
      if (config.sync.onRemoteEdit === 'block') {
        warn(
          `${slug}: page ${pageId} was edited in Confluence (live v${liveNumber}, we wrote v${entry.version}) — NOT overwriting (sync.onRemoteEdit: block); fold the change into the page file, or set overwrite`
        );
        return;
      }
      log(
        `${slug}: page ${pageId} was edited in Confluence (live v${liveNumber}, we wrote v${entry.version}) — overwriting (sync.onRemoteEdit: overwrite)`
      );
    }
    if (renamed && !changed && !moved) {
      // Title-only endpoint: no body round trip, and it takes NO version object.
      await request('PUT', `/wiki/api/v2/pages/${pageId}/title`, { status: 'current', title: plan.title });
      const refreshed = await request('GET', `/wiki/api/v2/pages/${pageId}`);
      entry.title = plan.title;
      entry.version = refreshed?.version?.number ?? liveNumber + 1;
      log(`renamed page ${pageId} ← ${slug} ("${plan.title}")`);
    } else {
      const updated = await putPage(
        request,
        pageId,
        { title: plan.title, parentId, storage: plan.storage, message: versionMessage(slug) },
        liveNumber + 1
      );
      entry.title = plan.title;
      entry.parentId = parentId;
      entry.hash = plan.hash;
      entry.version = updated?.version?.number ?? liveNumber + 1;
      log(`updated page ${pageId} ← ${slug} (v${entry.version})`);
    }
  }

  await syncLabels(request, deps, page, entry);
}

async function syncOnce(config, request, state) {
  const pages = loadPages(config);
  const deps = makeDeps(config, pages, state);
  let failures = 0;

  if (state.renderVersion !== undefined && state.renderVersion !== RENDER_VERSION) {
    log(`renderer version ${state.renderVersion} → ${RENDER_VERSION} — every page re-renders this pass`);
  }

  // -- orphans: a page file went away, its Confluence page did not ----------
  for (const [slug, entry] of Object.entries(state.pages)) {
    if (deps.bySlug.has(slug)) continue;
    state.orphans[slug] = { pageId: entry.pageId, title: entry.title };
    delete state.pages[slug];
  }
  for (const [slug, orphan] of Object.entries(state.orphans)) {
    if (deps.bySlug.has(slug)) {
      delete state.orphans[slug];
      continue;
    }
    warn(
      `orphan ${slug} → page ${orphan.pageId} "${orphan.title}" is still live in Confluence — restore the file or retire it deliberately`
    );
  }

  // -- plan (pure, no network) ---------------------------------------------
  const plans = [];
  for (const page of deps.ordered) {
    try {
      plans.push(planPage(page, deps));
    } catch (error) {
      plans.push({ page, action: 'error', message: describeRenderError(error) });
    }
  }

  // -- circuit breaker: count the update legs BEFORE any write -------------
  const max = Number(config.sync.maxUpdatesPerRun ?? 25);
  let updates = 0;
  for (const plan of plans) {
    if (plan.action !== 'publish' || !plan.pageId) continue;
    const entry = state.pages[plan.page.slug];
    const parentId = resolveParentId(plan.page, deps);
    if (!entry || entry.hash !== plan.hash || entry.title !== plan.title || entry.parentId !== parentId) {
      updates += 1;
    }
  }
  if (Number.isFinite(max) && updates > max && !FORCE) {
    warn(`this pass would update ${updates} pages (max ${max}) — run --dry-run to inspect, --force to proceed`);
    if (!DRY) return { failures: 0, aborted: true };
  }

  const sha = (() => {
    try {
      return headSha(repoRoot);
    } catch {
      return null;
    }
  })();
  const versionMessage = (slug) =>
    `handbook: confluence/pages/${slug}.md${sha ? ` @ ${sha}` : ''}`;

  // -- execute -------------------------------------------------------------
  for (const plan of plans) {
    const slug = plan.page.slug;
    try {
      switch (plan.action) {
        case 'error':
          failures += 1;
          warn(`${slug}: ${plan.message}`);
          break;
        case 'draft':
          log(`${slug}: draft — not published`);
          break;
        case 'settled':
          break;
        case 'unapproved-retire':
          warn(
            `${slug}: status retired but approved!=true — NOT retiring (retire is the human's call; set approved: true only on their explicit word)`
          );
          break;
        case 'retire-unpublished':
          log(`${slug}: retired — never published, nothing to retire`);
          if (state.pages[slug]) state.pages[slug].retired = true;
          break;
        case 'gated':
          warn(`${slug}: NOT publishing — ${plan.reason}`);
          break;
        case 'retire':
          await executeRetire(request, deps, plan, versionMessage);
          break;
        case 'publish':
          await executePublish(request, deps, plan, versionMessage);
          break;
        default:
          break;
      }
    } catch (error) {
      failures += 1;
      warn(`${slug}: ${error.message}`);
    }
  }

  if (!DRY) saveState(state);
  return { failures, aborted: false };
}

// ---------------------------------------------------------------------------
// pull (drift report — strictly read-only, both sides)
// ---------------------------------------------------------------------------
async function pullReport(config, request, state) {
  const pages = loadPages(config);
  let drift = 0;
  for (const page of pages) {
    if (page.error) {
      warn(`${page.slug}: ${page.error.message}`);
      drift += 1;
      continue;
    }
    const entry = state.pages[page.slug] ?? {};
    const pageId = String(page.fields.pageId || entry.pageId || '');
    if (!pageId) {
      log(`drift ${page.slug}: not yet published`);
      drift += 1;
      continue;
    }
    try {
      const live = await request('GET', `/wiki/api/v2/pages/${pageId}`);
      const liveNumber = live?.version?.number ?? 0;
      if (entry.version !== null && entry.version !== undefined && liveNumber !== entry.version) {
        log(`drift ${page.slug}: edited in Confluence (v${liveNumber}, we wrote v${entry.version})`);
        drift += 1;
      }
      const expectedTitle = entry.title ?? effectiveTitle(config, page);
      if (live?.title !== expectedTitle) {
        log(`drift ${page.slug}: renamed in Confluence ("${live?.title}", we wrote "${expectedTitle}")`);
        drift += 1;
      }
      const liveParent = String(live?.parentId ?? '');
      if (entry.parentId !== undefined && entry.parentId !== null && liveParent !== String(entry.parentId)) {
        log(`drift ${page.slug}: moved in Confluence (parent ${liveParent || 'homepage'}, we wrote ${entry.parentId || 'homepage'})`);
        drift += 1;
      }
    } catch (error) {
      warn(`${page.slug}: ${error.message}`);
      drift += 1;
    }
  }
  log(
    drift === 0
      ? 'no drift'
      : `${drift} drift item(s) — local files remain authoritative; reconcile by editing them`
  );
}

// ---------------------------------------------------------------------------
// stale (read-only, no network — pure git)
// ---------------------------------------------------------------------------
function staleCommand(config) {
  const pages = loadPages(config).filter((page) => !page.error);
  let report;
  try {
    report = staleReport(pages, config, repoRoot);
  } catch (error) {
    warn(`staleness unavailable: ${error.message}`);
    return;
  }
  if (report.noGit) {
    warn('no usable git history here (not a repo, or a shallow clone) — staleness needs git; skipping');
    return;
  }
  const stale = report.stale ?? [];
  const missing = report.missingSource ?? [];
  const unanchored = report.unanchored ?? [];
  const gaps = report.gaps ?? [];
  const dirty = report.dirty ?? [];

  if (BRIEF) {
    const parts = [];
    if (stale.length) parts.push(`${stale.length} stale`);
    if (missing.length) parts.push(`${missing.length} missing-source`);
    if (unanchored.length) parts.push(`${unanchored.length} unanchored`);
    if (gaps.length) parts.push(`${gaps.length} gap${gaps.length === 1 ? '' : 's'}`);
    if (parts.length) {
      log(`handbook: ${parts.join(', ')} — run /handbook:refresh`);
      if (stale.length) {
        const names = stale.slice(0, 3).map((item) => item.slug);
        log(`  stale: ${names.join(', ')}${stale.length > names.length ? ` (+${stale.length - names.length} more)` : ''}`);
      }
    }
  } else {
    if (stale.length) {
      log(`STALE (${stale.length})`);
      for (const item of stale) {
        log(`  ${item.slug} — ${item.title ?? ''}`);
        log(`    sources: ${asArray(item.sources).join(' ') || '(none)'}`);
        log(`    ${(item.commits ?? []).length} commit(s) since ${item.baseSha ?? '(unknown)'}:`);
        for (const commit of (item.commits ?? []).slice(0, 10)) {
          log(`      ${commit.sha} ${commit.date} ${commit.subject}`);
        }
        if (item.reviewCmd) log(`    review: ${item.reviewCmd}`);
      }
    }
    if (missing.length) {
      log(`MISSING-SOURCE (${missing.length})`);
      for (const item of missing) log(`  ${item.slug} — "${item.path}" matches no tracked file at HEAD`);
    }
    if (unanchored.length) {
      log(`UNANCHORED (${unanchored.length})`);
      for (const slug of unanchored) log(`  ${slug} — this kind requires sources: (or an explicit unanchored: true)`);
    }
    if (gaps.length) {
      log(`GAP (${gaps.length})`);
      for (const gapPath of gaps) log(`  ${gapPath} — watched, but claimed by no page's sources:`);
    }
    if (dirty.length) {
      log(`DIRTY (${dirty.length})`);
      for (const item of dirty) log(`  ${item.slug} — uncommitted: ${asArray(item.paths).join(' ')}`);
    }
    if (!stale.length && !missing.length && !unanchored.length && !gaps.length && !dirty.length) {
      log('every page is fresh against the code');
    }
  }

  if (EXIT_CODE && (stale.length || missing.length)) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// lint / render
// ---------------------------------------------------------------------------
function lintCommand(config) {
  const pages = loadPages(config);
  const deps = makeDeps(config, pages);
  const targets = targetSlug ? pages.filter((page) => page.slug === targetSlug) : pages;
  if (targetSlug && !targets.length) {
    warn(`no page file confluence/pages/${targetSlug}.md`);
    process.exit(2);
  }
  let errors = 0;
  let warns = 0;
  for (const page of targets) {
    const slug = page.slug;
    if (page.error) {
      errors += 1;
      warn(`${slug}: ERROR parse: ${page.error.message}`);
      continue;
    }
    const at = (finding) => (finding.line ? `${slug}:${finding.line}` : slug);
    const result = lintPage(page, deps.suite, config);
    for (const finding of result.errors ?? []) {
      errors += 1;
      warn(`${at(finding)} ERROR ${finding.rule}: ${finding.message}`);
    }
    for (const finding of result.warns ?? []) {
      warns += 1;
      log(`${at(finding)} WARN ${finding.rule}: ${finding.message}`);
    }
    if (page.kind) {
      try {
        render(page, deps);
      } catch (error) {
        errors += 1;
        warn(`${slug} ERROR render: ${describeRenderError(error)}`);
      }
    }
    if (!(result.errors ?? []).length && page.fields.status === 'published') {
      const gate = publishGateReason(page, result);
      if (gate) log(`${slug}: publish gate — ${gate}`);
    }
  }
  log(
    errors
      ? `lint: ${errors} error(s), ${warns} warning(s) across ${targets.length} page(s)`
      : `lint clean — ${targets.length} page(s), ${warns} warning(s)`
  );
  if (errors) process.exitCode = 1;
}

function renderCommand(config) {
  if (!targetSlug) {
    warn('usage: docs-sync.mjs render <slug> [--repo <dir>]');
    process.exit(2);
  }
  const pages = loadPages(config);
  const deps = makeDeps(config, pages);
  const page = pages.find((candidate) => candidate.slug === targetSlug);
  if (!page) {
    warn(`no page file confluence/pages/${targetSlug}.md`);
    process.exit(2);
  }
  if (page.error) {
    warn(`${targetSlug}: ${page.error.message}`);
    process.exit(1);
  }
  if (!page.kind) {
    warn(`${targetSlug}: unknown kind "${page.fields.kind ?? ''}" — known kinds: ${Object.keys(deps.kinds).join(', ')}`);
    process.exit(1);
  }
  try {
    process.stdout.write(`${render(page, deps)}\n`);
  } catch (error) {
    warn(`${targetSlug}: ${describeRenderError(error)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function init() {
  const templatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates');
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    log(`${CONFIG_PATH} already exists — left untouched`);
  } else {
    fs.copyFileSync(path.join(templatesDir, 'config.json'), CONFIG_PATH);
    log(`wrote ${CONFIG_PATH} — fill in site/spaceKey`);
  }
  const gitignorePath = path.join(CONFLUENCE_DIR, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '.sync-state.json\n.sync.lock\n.sync.rerun\n.sync.log\n');
  }
  const examplePage = path.join(PAGES_DIR, '_example.md.txt');
  if (!fs.existsSync(examplePage)) {
    fs.copyFileSync(path.join(templatesDir, 'page.md'), examplePage);
  }
  log('initialized. Page files go in confluence/pages/<slug>.md (see _example.md.txt).');
  log(
    'next: set site + spaceKey in confluence/config.json, export CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN, then run /handbook:scaffold.'
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const COMMANDS = ['init', 'sync', 'pull', 'stale', 'lint', 'render'];

async function main() {
  if (command === 'init') return init();
  if (!COMMANDS.includes(command)) {
    warn(
      'usage: docs-sync.mjs <init|sync|pull|stale|lint|render> [--repo <dir>] [--dry-run] [--force] [--adopt] [--brief] [--exit-code]'
    );
    process.exit(2);
  }

  const config = loadConfig();

  // The offline commands never need credentials and never take the lock.
  if (command === 'stale') return staleCommand(config);
  if (command === 'lint') return lintCommand(config);
  if (command === 'render') return renderCommand(config);

  const creds = loadCredentials(config);
  const request = confluenceClient(config, creds);

  if (command === 'pull') return pullReport(config, request, loadState());

  if (!acquireLock()) return; // rerun queued; the current holder will pick it up
  try {
    let failures = 0;
    for (;;) {
      fs.rmSync(RERUN_PATH, { force: true });
      const result = await syncOnce(config, request, loadState());
      failures = result.failures;
      if (result.aborted) {
        process.exitCode = 1;
        break;
      }
      if (!fs.existsSync(RERUN_PATH)) break;
    }
    if (failures > 0) {
      warn(`${failures} page(s) failed — safe to rerun (next trigger will retry)`);
      process.exitCode = 1;
    }
  } finally {
    releaseLock();
  }
}

// Run only as a CLI (the parse helpers are imported by tests and by lint.mjs's callers).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    warn(error.message);
    releaseLock();
    process.exit(1);
  });
}
