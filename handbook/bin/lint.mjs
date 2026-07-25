/**
 * lint.mjs — the audience gate. Pure, side-effect-free rules over a page's
 * markdown SOURCE (so every finding carries a real 1-based line the model can
 * jump to), plus the publish gate that turns a lint result into one refusal
 * sentence.
 *
 *   lintPage(page, suite, config) → { errors, warns }   Finding = {rule, line, message}
 *   publishGateReason(page, lint)  → string | null      null ⇒ may publish
 *
 * Constraints:
 *   - may import render.mjs (firstParagraph) ONLY — importing docs-sync.mjs
 *     would be an import cycle.
 *   - errors block publish; warns never do.
 *   - `## Editorial` / `## Rework` are local-only sections: no rule looks at
 *     them EXCEPT the secret scan, which covers the whole file.
 *   - identifier / path / command / protocol shapes never fire inside fenced
 *     code blocks (the command rule deliberately still reads inline code
 *     spans — a backticked `git push` is exactly what it is hunting).
 *   - secret findings are NEVER waivable and NEVER echo what they matched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { firstParagraph } from './render.mjs';

// The bank a project inherits when config.audience.banned is unset (§8).
export const DEFAULT_BANNED = [
  'endpoint', 'middleware', 'refactor', 'schema', 'migration', 'mutex', 'async',
  'idempotent', 'deserialize', 'serialize', 'stack trace', 'null', 'boolean',
  'regex', 'cron', 'daemon', 'repo', 'backend', 'frontend', 'API', 'SDK', 'CLI',
  'JSON', 'YAML', 'SQL', 'database index', 'race condition', 'memory leak',
  'dependency injection', 'microservice', 'kubernetes', 'docker', 'webhook payload',
];

const CODE_EXT = 'tsx?|jsx?|mjs|py|go|rb|rs|java|kt|sql|ya?ml|json|sh|css|html';
const COMMANDS = 'git|npm|pnpm|yarn|docker|kubectl|psql|curl';
const HTTP_VERBS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

// Every pattern here is a shape, never a value: nothing matched is ever echoed.
const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/ghp_\w{20,}/, 'GitHub token'],
  [/xox[baprs]-/, 'Slack token'],
  [/sk-[A-Za-z0-9]{16,}/, 'API secret key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY/, 'private key block'],
  [/password\s*=/i, 'password assignment'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]*@/i, 'URL with embedded credentials'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/, 'bearer token'],
  [/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/, 'private network address'],
  [/\blocalhost:\d+/i, 'local host:port'],
  [/\b[a-z0-9][a-z0-9-]*\.(?:internal|local)\b/i, 'internal hostname'],
  [/(?:key|token|secret)[\w-]*["'\s:=]{1,4}[A-Za-z0-9+/_=-]{32,}/i, 'high-entropy value next to key/token/secret'],
];

// ---------------------------------------------------------------------------
// config / suite normalization — callers merge the §2/§3 defaults, but lint is
// also called straight from tests and hooks, so it defends every key it reads.
// ---------------------------------------------------------------------------
function normalizeConfig(config) {
  const audience = (config && typeof config.audience === 'object' && config.audience) || {};
  const allowList = Array.isArray(audience.allow) ? audience.allow : [];
  const patterns = [];
  for (const source of Array.isArray(audience.allowPattern) ? audience.allowPattern : []) {
    try {
      patterns.push(new RegExp(String(source)));
    } catch {
      // A malformed pattern is config's problem to report, not lint's to throw on.
    }
  }
  const banned = Array.isArray(audience.banned) ? audience.banned : DEFAULT_BANNED;
  const allow = new Set(allowList.map((term) => String(term).toLowerCase()));
  return {
    titlePrefix: typeof config?.titlePrefix === 'string' ? config.titlePrefix : '',
    envFile: typeof config?.envFile === 'string' ? config.envFile : null,
    repoRoot: typeof config?.repoRoot === 'string' ? config.repoRoot : null,
    allow,
    allowPatterns: patterns,
    banned: banned
      .map((term) => String(term).trim())
      .filter((term) => term && !allow.has(term.toLowerCase())),
    maxGrade: Number.isFinite(audience.maxGrade) ? audience.maxGrade : 10,
    maxWords: Number.isFinite(audience.maxWords) ? audience.maxWords : 1200,
  };
}

function normalizeKind(kind) {
  return {
    known: !!kind,
    label: kind?.label ?? null,
    requireSources: kind?.requireSources === true,
    allowCodeBlocks: kind?.allowCodeBlocks === true,
    requiredSections: Array.isArray(kind?.requiredSections) ? kind.requiredSections : [],
  };
}

function suitePages(suite) {
  if (suite?.pages instanceof Map) return suite.pages;
  if (suite?.pages && typeof suite.pages === 'object') return new Map(Object.entries(suite.pages));
  return new Map();
}

// ---------------------------------------------------------------------------
// source geometry: real line numbers, frontmatter span, local-only tail, fences
// ---------------------------------------------------------------------------
function pageSource(page) {
  if (typeof page?.raw === 'string' && page.raw.length) return { text: page.raw, framed: true };
  // Fallback when the caller passed a parsed page only: line numbers are then
  // relative to the publish body, which is still the region rules care about.
  const parts = [String(page?.publishBody ?? '')];
  if (page?.editorial) parts.push(`## Editorial\n${page.editorial}`);
  if (page?.rework) parts.push(`## Rework\n${page.rework}`);
  return { text: parts.join('\n\n'), framed: false };
}

function geometry(page) {
  const { text, framed } = pageSource(page);
  const lines = text.split('\n');
  let frontEnd = -1;
  let bodyStart = 0;
  if (framed && lines[0] === '---') {
    frontEnd = lines.indexOf('---', 1);
    if (frontEnd !== -1) bodyStart = frontEnd + 1;
  }
  let localStart = lines.length;
  for (let i = bodyStart; i < lines.length; i++) {
    if (/^## (Editorial|Rework)\s*$/.test(lines[i])) {
      localStart = i;
      break;
    }
  }
  return { lines, frontEnd, bodyStart, localStart };
}

function scanFences(lines, from, to) {
  const inFence = new Set();
  const opens = [];
  let fence = null;
  for (let i = from; i < to; i++) {
    const match = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      inFence.add(i);
      if (match && match[1][0] === fence.char && match[1].length >= fence.len && !match[2].trim()) {
        fence = null;
      }
      continue;
    }
    if (match) {
      fence = { char: match[1][0], len: match[1].length };
      inFence.add(i);
      opens.push({ index: i, info: match[2].trim() });
    }
  }
  return { inFence, opens };
}

/** Blank out inline code spans (positions preserved) and hand back their contents. */
function maskCodeSpans(line) {
  let masked = '';
  const spans = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let n = 1;
      while (line[i + n] === '`') n += 1;
      const marker = '`'.repeat(n);
      const close = line.indexOf(marker, i + n);
      if (close !== -1) {
        spans.push(line.slice(i + n, close));
        masked += ' '.repeat(close + n - i);
        i = close + n;
        continue;
      }
    }
    masked += line[i];
    i += 1;
  }
  return { masked, spans };
}

// External link targets are machinery, not prose — a repo URL is not a "path shape".
const blank = (match) => ' '.repeat(match.length);
const maskExternalLinks = (text) =>
  text
    .replace(/\]\(\s*(?:https?:|mailto:|#)[^)]*\)/gi, blank)
    .replace(/\b(?:https?|mailto):\S+/gi, blank);

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countWords = (text) => (String(text).match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length;
const trimToken = (token) => token.replace(/[.,;:!?)\]}"']+$/, '');

function plainProse(lines, from, to, inFence) {
  const out = [];
  for (let i = from; i < to; i++) {
    if (inFence.has(i)) continue;
    let line = lines[i];
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|.*)?$/.test(line)) continue; // table alignment row
    line = line
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/[*_~|]/g, ' ');
    out.push(line);
  }
  return out.join('\n');
}

/** Flesch–Kincaid grade, with a vowel-group syllable heuristic. Null when too short to judge. */
function fkGrade(prose) {
  const words = prose.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  if (words.length < 30) return null;
  const sentences = Math.max(1, (prose.match(/[.!?](?=\s|$)/g) ?? []).length);
  let syllables = 0;
  for (const word of words) {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) continue;
    if (w.length <= 3) {
      syllables += 1;
      continue;
    }
    const groups = w.replace(/(?:es|ed|e)$/, '').match(/[aeiouy]+/g);
    syllables += Math.max(1, groups ? groups.length : 1);
  }
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
}

// ---------------------------------------------------------------------------
// .env key NAMES (never values) join the secret bank for this repo
// ---------------------------------------------------------------------------
const envNameCache = new Map();

function envKeyNames(cfg, page) {
  const root =
    cfg.repoRoot ??
    (typeof page?.file === 'string' && page.file
      ? path.resolve(path.dirname(page.file), '..', '..')
      : process.cwd());
  const cacheKey = `${root}\u0000${cfg.envFile ?? ''}`;
  const cached = envNameCache.get(cacheKey);
  if (cached) return cached;
  const names = new Set();
  for (const candidate of ['.env', cfg.envFile]) {
    if (!candidate) continue;
    const file = path.resolve(root, candidate);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // no .env is the normal case
    }
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      // Short names would ban ordinary prose; only distinctive ones are literals.
      if (match && match[1].length >= 4) names.add(match[1]);
    }
  }
  const list = [...names];
  envNameCache.set(cacheKey, list);
  return list;
}

// ---------------------------------------------------------------------------
// lintPage
// ---------------------------------------------------------------------------
export function lintPage(page, suite, config) {
  const errors = [];
  const warns = [];
  const seen = new Set();
  const add = (bucket, rule, line, message) => {
    const key = `${rule}\u0000${line}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    bucket.push({ rule, line, message });
  };
  const error = (rule, line, message) => add(errors, rule, line, message);
  const warn = (rule, line, message) => add(warns, rule, line, message);

  const cfg = normalizeConfig(config);
  const kind = normalizeKind(page?.kind);
  const pages = suitePages(suite);
  const fields = page?.fields ?? {};
  const slug = page?.slug ?? '';
  const { lines, frontEnd, bodyStart, localStart } = geometry(page);
  const { inFence, opens } = scanFences(lines, bodyStart, localStart);
  const at = (index) => index + 1;
  const frontLine = (key) => {
    if (frontEnd === -1) return null;
    for (let i = 1; i < frontEnd; i++) if (lines[i].startsWith(`${key}:`)) return at(i);
    return null;
  };

  secretScan(lines, cfg, page, error);
  structureRules({ page, fields, slug, kind, cfg, pages, lines, bodyStart, localStart, inFence, opens, frontLine, at, error, warn });
  contentRules({ cfg, lines, bodyStart, localStart, inFence, at, error });
  readabilityRules({ page, cfg, lines, bodyStart, localStart, inFence, at, warn });

  return { errors, warns };
}

// -- secrets: whole file (frontmatter + Editorial + Rework included) ---------
function secretScan(lines, cfg, page, error) {
  const envNames = envKeyNames(cfg, page);
  const envPattern = envNames.length
    ? new RegExp(`\\b(?:${envNames.map(escapeRe).join('|')})\\b`)
    : null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (!pattern.test(line)) continue;
      error(
        'secret',
        i + 1,
        `possible secret on this line (${label}) — the match is deliberately not echoed; remove it. This rule is never waivable`
      );
    }
    if (envPattern && envPattern.test(line)) {
      error(
        'secret',
        i + 1,
        'this line names a key from the repo\'s .env — credentials and their names never belong in product docs. This rule is never waivable'
      );
    }
  }
}

// -- structure --------------------------------------------------------------
function structureRules(x) {
  const { page, fields, slug, kind, cfg, pages, lines, bodyStart, localStart, inFence, opens, frontLine, at, error, warn } = x;

  if (!kind.known) {
    error(
      'unknown-kind',
      frontLine('kind'),
      `kind "${fields.kind ?? ''}" is not in the kind bank — add it to config.json "kinds" or use one of the defaults`
    );
  }

  const title = String(fields.title ?? '').trim();
  if (!title) {
    error('title-missing', frontLine('title'), 'frontmatter needs a title — it is the Confluence page heading');
  } else {
    const effective = `${cfg.titlePrefix}${title}`;
    for (const [key, other] of pages) {
      if (!other || (other.slug ?? key) === slug) continue;
      const otherTitle = String(other.fields?.title ?? '').trim();
      if (otherTitle && `${cfg.titlePrefix}${otherTitle}` === effective) {
        error(
          'duplicate-title',
          frontLine('title'),
          `title "${effective}" is also used by ${other.slug ?? key} — Confluence titles are unique per space`
        );
      }
    }
  }

  const parent = typeof fields.parent === 'string' ? fields.parent.trim() : '';
  if (parent) {
    if (!pages.has(parent)) {
      error('parent-missing', frontLine('parent'), `parent "${parent}" has no page file in confluence/pages/`);
    } else {
      const cycle = parentCycle(slug, parent, pages);
      if (cycle) error('parent-cycle', frontLine('parent'), `parent cycle: ${cycle.join(' → ')}`);
    }
  }

  const sources = Array.isArray(fields.sources) ? fields.sources.filter(Boolean) : [];
  if (kind.requireSources && !sources.length && fields.unanchored !== true) {
    error(
      'sources-required',
      frontLine('sources'),
      `kind "${fields.kind ?? ''}" must name the code it documents — fill sources: [...] or set unanchored: true`
    );
  }

  // Headings, H1 refusal, required sections (all over the publish body only).
  const headings = [];
  for (let i = bodyStart; i < localStart; i++) {
    if (inFence.has(i)) continue;
    if (/^#(?!#)/.test(lines[i])) {
      error('h1', at(i), 'no "# " heading — the frontmatter title is the page heading; sections start at "##"');
      continue;
    }
    const match = lines[i].match(/^##\s+(.+?)\s*$/);
    if (match) headings.push({ index: i, text: match[1].trim() });
  }
  for (const required of kind.requiredSections) {
    const found = headings.find((h) => h.text === required);
    if (!found) {
      error('required-section', null, `kind "${fields.kind ?? ''}" requires a "## ${required}" section`);
      continue;
    }
    if (/\b(limits?|gaps?|cannot|caveats?)\b/i.test(required)) {
      const body = sectionBody(lines, found.index, localStart);
      if (!body || /^(none|n\/a|na|nothing|tbd|-)\.?$/i.test(body)) {
        warn(
          'empty-limits',
          at(found.index),
          `"## ${required}" is empty — a page with no stated limits reads as a promise the code does not make`
        );
      }
    }
  }

  if (!kind.allowCodeBlocks && opens.length) {
    error(
      'code-fence',
      at(opens[0].index),
      `kind "${fields.kind ?? ''}" does not allow code blocks — describe the behaviour instead of showing the code`
    );
  }

  // Cross-links: [text](slug.md) / [text](slug.md#Anchor).
  for (let i = bodyStart; i < localStart; i++) {
    if (inFence.has(i)) continue;
    for (const match of lines[i].matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const dest = match[1].trim();
      const hash = dest.indexOf('#');
      const target = (hash === -1 ? dest : dest.slice(0, hash)).trim();
      if (!/\.md$/i.test(target)) continue;
      const targetSlug = path.basename(target).replace(/\.md$/i, '');
      const linked = pages.get(targetSlug);
      if (!linked) {
        error('link-target', at(i), `link to "${targetSlug}" has no page file in confluence/pages/`);
      } else if (linked.fields?.status !== 'published') {
        warn(
          'link-unpublished',
          at(i),
          `link target "${targetSlug}" is ${linked.fields?.status ?? 'unset'} — the link breaks until that page publishes`
        );
      }
    }
  }

  if (fields.status === 'retired' && slug) {
    const pattern = new RegExp(`\\]\\(\\s*(?:\\./)?${escapeRe(slug)}\\.md[^)]*\\)`);
    for (const [key, other] of pages) {
      if (!other || (other.slug ?? key) === slug) continue;
      if (normalizeKind(other.kind).label !== 'index') continue;
      if (pattern.test(String(other.publishBody ?? ''))) {
        error(
          'retired-linked',
          null,
          `retired, but the index page ${other.slug ?? key} still links to it — remove that link before retiring`
        );
      }
    }
  }
}

function sectionBody(lines, headingIndex, end) {
  const out = [];
  for (let i = headingIndex + 1; i < end; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').replace(/^[\s\-*]+|[\s.]+$/g, '').trim();
}

function parentCycle(slug, parent, pages) {
  const chain = [slug];
  let current = parent;
  while (typeof current === 'string' && current.trim()) {
    const next = current.trim();
    if (chain.includes(next)) return [...chain, next];
    chain.push(next);
    const page = pages.get(next);
    if (!page) return null; // parent-missing already reports the broken link
    current = page.fields?.parent;
  }
  return null;
}

// -- shapes: identifiers, paths, commands, protocol, jargon -----------------
function contentRules(x) {
  const { cfg, lines, bodyStart, localStart, inFence, at, error } = x;
  const bannedPatterns = cfg.banned.map((term) => [
    term,
    new RegExp(`\\b${escapeRe(term).replace(/\s+/g, '\\s+')}\\b`, 'i'),
  ]);

  for (let i = bodyStart; i < localStart; i++) {
    if (inFence.has(i)) continue;
    // The index-table placement marker is the one HTML comment the renderer
    // accepts; its "<!--"/"-->" must not read as code syntax.
    if (/^\s*<!-- children -->\s*$/.test(lines[i])) continue;
    const line = lines[i];
    const { masked, spans } = maskCodeSpans(line);
    const probe = maskExternalLinks(masked);
    const lineNo = at(i);

    identifierShapes(probe, lineNo, cfg, error);
    pathShapes(probe, lineNo, cfg, error);
    commandShapes(probe, spans, lineNo, cfg, error);
    protocolShapes(probe, lineNo, cfg, error);

    for (const [term, pattern] of bannedPatterns) {
      if (pattern.test(line)) {
        error('jargon', lineNo, `"${term}" is engineer vocabulary — say what the reader sees instead`);
      }
    }
  }
}

const exempt = (token, cfg) =>
  cfg.allow.has(token.toLowerCase()) || cfg.allowPatterns.some((re) => re.test(token));

function identifierShapes(probe, lineNo, cfg, error) {
  for (const match of probe.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const token = match[0];
    if (exempt(token, cfg)) continue;
    if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(token)) {
      const humps = (token.match(/[A-Z]/g) ?? []).length;
      if (humps >= 2 || token.length >= 8) {
        error('identifier', lineNo, `"${token}" is a code identifier (camelCase) — name it the way a user would`);
      }
    } else if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(token)) {
      error('identifier', lineNo, `"${token}" is a code identifier (snake_case) — name it the way a user would`);
    } else if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(token) && token.length >= 5) {
      error('identifier', lineNo, `"${token}" is a code identifier (SCREAMING_SNAKE) — name it the way a user would`);
    }
  }
  for (const match of probe.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\([^()]*\)/g)) {
    const token = match[0];
    if (exempt(token, cfg) || exempt(token.slice(0, token.indexOf('(')), cfg)) continue;
    error('identifier', lineNo, `"${token}" is function-call syntax — describe what it does, not how it is called`);
  }
  for (const operator of ['::', '->', '=>']) {
    if (probe.includes(operator) && !exempt(operator, cfg)) {
      error('identifier', lineNo, `"${operator}" is code syntax — write the relationship as a sentence`);
    }
  }
}

function pathShapes(probe, lineNo, cfg, error) {
  const patterns = [
    new RegExp(`[^\\s)\\](),"'\`]*/[^\\s)\\](),"'\`]*\\.(?:${CODE_EXT})\\b`, 'g'),
    /(?:^|[\s([{"'])(\.{1,2}\/[^\s)\]},"'`]+)/g,
    /(?:^|[\s([{"'])(src\/[^\s)\]},"'`]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of probe.matchAll(pattern)) {
      const token = trimToken(match[1] ?? match[0]);
      if (!token || exempt(token, cfg)) continue;
      error('path', lineNo, `"${token}" is a file path — the reader never opens the code`);
    }
  }
}

function commandShapes(probe, spans, lineNo, cfg, error) {
  const invocation = new RegExp(`^\\s*(?:\\$\\s*)?(?:${COMMANDS})\\s+\\S`);
  if (invocation.test(probe) && !exempt(probe.trim(), cfg)) {
    error('command', lineNo, 'this line is a shell command — product docs describe outcomes, not commands');
  }
  for (const span of spans) {
    if (invocation.test(span) && !exempt(span.trim(), cfg)) {
      error('command', lineNo, `\`${span.trim()}\` is a shell command — product docs describe outcomes, not commands`);
    }
  }
}

function protocolShapes(probe, lineNo, cfg, error) {
  for (const match of probe.matchAll(new RegExp(`\\b(?:${HTTP_VERBS})\\s+/\\S*`, 'g'))) {
    if (exempt(match[0], cfg)) continue;
    error('protocol', lineNo, `"${trimToken(match[0])}" is an API call — describe the capability, not the wire`);
  }
  for (const match of probe.matchAll(/\b(?:returns?|responds?|responding|returning)\b(?:\s+\w+){0,3}\s+([1-5]\d{2})\b/gi)) {
    if (exempt(match[1], cfg)) continue;
    error('protocol', lineNo, `"${match[1]}" is an HTTP status code — say what the user sees happen`);
  }
  if (/\bSELECT\b.+\bFROM\b/.test(probe)) {
    error('protocol', lineNo, 'this reads as a database query — describe the information, not how it is fetched');
  }
}

// -- readability / shape warnings -------------------------------------------
function readabilityRules(x) {
  const { page, cfg, lines, bodyStart, localStart, inFence, at, warn } = x;
  const prose = plainProse(lines, bodyStart, localStart, inFence);

  const grade = fkGrade(prose);
  if (grade !== null && grade > cfg.maxGrade) {
    warn(
      'grade',
      null,
      `reading grade ~${grade.toFixed(1)} (ceiling ${cfg.maxGrade}) — shorter sentences and plainer words`
    );
  }

  const words = countWords(prose);
  if (words > cfg.maxWords) {
    warn('max-words', null, `${words} words (soft ceiling ${cfg.maxWords}) — consider splitting this page`);
  }

  let firstLine = null;
  for (let i = bodyStart; i < localStart; i++) {
    if (lines[i].trim()) {
      firstLine = at(i);
      break;
    }
  }
  const opener = firstParagraph(String(page?.publishBody ?? ''));
  if (typeof opener !== 'string' || !opener.trim()) {
    warn(
      'summary-paragraph',
      firstLine,
      'the first block should be one 20–60 word paragraph — it becomes this page\'s summary in its parent index'
    );
  } else {
    const openerWords = countWords(opener);
    if (openerWords < 20 || openerWords > 60) {
      warn(
        'summary-paragraph',
        firstLine,
        `the opening paragraph is ${openerWords} words — aim for 20–60; it becomes this page's summary in its parent index`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// the publish gate — pure; returns the refusal sentence, or null to proceed
// ---------------------------------------------------------------------------
export function publishGateReason(page, lint) {
  const errors = Array.isArray(lint?.errors) ? lint.errors : [];
  if (errors.length) {
    const [first] = errors;
    const where = Number.isFinite(first.line) ? ` at line ${first.line}` : '';
    const more = errors.length - 1;
    return `lint: ${first.rule}${where}${more > 0 ? ` (+${more} more)` : ''}`;
  }
  const editorial = String(page?.editorial ?? '').trim();
  if (!editorial) return 'no ## Editorial section';
  if (/^\(optional\b/i.test(editorial)) return 'the ## Editorial section is still the template placeholder';
  if (!/^audience-check:/im.test(editorial)) return 'missing its "Audience-check:" trail line';
  return null;
}
