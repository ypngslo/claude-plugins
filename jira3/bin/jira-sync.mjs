#!/usr/bin/env node
/**
 * jira-sync — deterministic, zero-dependency mirror of local task files into
 * Jira. The design contract (see the plugin README):
 *
 *   - jira/tasks/*.md files are the SOURCE OF TRUTH. This CLI only pushes.
 *   - No model tokens are ever spent on Jira I/O: agents edit task files; a
 *     PostToolUse hook spawns this CLI detached. It must therefore always be
 *     safe to run concurrently (lockfile + rerun flag), idempotent (diff
 *     against .sync-state.json), and non-fatal on any Jira failure (the next
 *     trigger retries).
 *   - `status: done` only syncs when `approved: true` — the human-approval
 *     gate. Everything else about done-is-human is process (the skill);
 *     this is the mechanical backstop.
 *
 * Commands:
 *   jira-sync.mjs init   [--repo <dir>]             scaffold jira/ in a repo
 *   jira-sync.mjs sync   [--repo <dir>] [--dry-run] push local → Jira
 *   jira-sync.mjs pull   [--repo <dir>]             drift REPORT only (no writes, either side)
 *
 * Config: jira/config.json (per repo — site/project/status map; optional
 * `labels` to scope issues per repo when several repos share one Jira
 * project). Credentials
 * are NEVER in the repo: email + API token come from env (JIRA_EMAIL +
 * JIRA_API_TOKEN by default; names overridable in config).
 *
 * Exit codes: 0 ok (including "nothing to do" and "lock held, rerun queued");
 * 2 config/usage error; 3 credentials missing; 1 sync errors (some items
 * failed — safe to rerun).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const JIRA_DIR = path.join(repoRoot, 'jira');
const TASKS_DIR = path.join(JIRA_DIR, 'tasks');
const CONFIG_PATH = path.join(JIRA_DIR, 'config.json');
const STATE_PATH = path.join(JIRA_DIR, '.sync-state.json');
const LOCK_PATH = path.join(JIRA_DIR, '.sync.lock');
const RERUN_PATH = path.join(JIRA_DIR, '.sync.rerun');

const log = (msg) =>
  process.stdout.write(`${new Date().toISOString()} [jira-sync] ${msg}\n`);
const warn = (msg) =>
  process.stderr.write(`${new Date().toISOString()} [jira-sync] WARN ${msg}\n`);

// ---------------------------------------------------------------------------
// frontmatter — strict, tiny subset (key: value, arrays as [a, b], booleans)
// ---------------------------------------------------------------------------
export function parseTaskFile(raw, id) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${id}: missing frontmatter block`);
  const [, front, body] = match;
  const fields = {};
  for (const line of front.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) throw new Error(`${id}: unparseable frontmatter line: ${line}`);
    const [, key, rawValue] = kv;
    let value = rawValue.trim();
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
  return { id, fields, body: body.trim() };
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

const hash = (s) => {
  // FNV-1a — good enough for change detection, no crypto import needed.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
};

// ---------------------------------------------------------------------------
// config / state / credentials
// ---------------------------------------------------------------------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    warn(`no ${CONFIG_PATH} — run \`jira-sync init\` (or /jira3:init) first`);
    process.exit(2);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const required of ['site', 'projectKey', 'statusMap']) {
    if (!config[required]) {
      warn(`config.json missing required key: ${required}`);
      process.exit(2);
    }
  }
  resolveLabels(config); // fail fast on a malformed labels list
  return {
    emailEnv: 'JIRA_EMAIL',
    tokenEnv: 'JIRA_API_TOKEN',
    ...config,
  };
}

/**
 * Work-type vocabulary is 100% per-project: jira3 itself knows only HIERARCHY
 * (container vs child), never specific Jira type names. config.json `types`
 * maps each local `type:` keyword to its Jira issue-type name:
 *
 *   "types": { "epic":    { "name": "Epic", "container": true },
 *              "task":    { "name": "Task", "default": true },
 *              "feature": { "name": "Feature" } }
 *
 * `container: true` marks the parent level (created first; referenced by
 * children via the `epic:` field; gets the container branch prefix in
 * git-flow). `default: true` marks the type used when a file omits `type:`.
 * Legacy configs (issueType/epicIssueType) synthesize the same shape, so
 * existing repos keep working unchanged.
 */
export function resolveTypes(config) {
  const types = config.types ?? {
    epic: { name: config.epicIssueType ?? 'Epic', container: true },
    task: { name: config.issueType ?? 'Task', default: true },
  };
  const defaultKey =
    Object.keys(types).find((k) => types[k].default) ??
    Object.keys(types).find((k) => !types[k].container);
  if (!defaultKey) {
    warn('config.json types: every type is a container — mark one child type ("default": true)');
    process.exit(2);
  }
  return { types, defaultKey };
}

/**
 * Optional repo-scoping labels (config `labels: ["my-repo"]`). Several repos
 * can share one Jira project; these labels are stamped on every issue this
 * repo creates and additively pushed onto already-created issues on the next
 * content update, so `labels = my-repo` JQL/board filters see exactly this
 * repo's items. The first label also namespaces the per-task `lt-` marker
 * label, keeping markers collision-free when two repos use the same task id.
 */
export function resolveLabels(config) {
  const labels = config.labels ?? [];
  if (
    !Array.isArray(labels) ||
    labels.some((l) => typeof l !== 'string' || !/^\S+$/.test(l))
  ) {
    warn('config.json labels: must be an array of non-empty strings without spaces (Jira label syntax)');
    process.exit(2);
  }
  return labels;
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

const loadState = () =>
  fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : { tasks: {} };
const saveState = (state) =>
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

// ---------------------------------------------------------------------------
// locking: concurrent hook spawns collapse into "one more pass"
// ---------------------------------------------------------------------------
function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
    if (age > 120_000) {
      // stale (a crashed run) — steal it
      fs.rmSync(LOCK_PATH, { force: true });
      return acquireLock();
    }
    fs.writeFileSync(RERUN_PATH, '');
    log('another sync holds the lock — queued a rerun');
    return false;
  }
}
const releaseLock = () => fs.rmSync(LOCK_PATH, { force: true });

// ---------------------------------------------------------------------------
// Jira REST v2 (plain-string descriptions/comments; no ADF dependency)
// ---------------------------------------------------------------------------
function jiraClient(config, creds) {
  const base = process.env.JIRA_BASE_URL_OVERRIDE || `https://${config.site}`;
  const auth = `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`;
  return async function request(method, apiPath, body) {
    const response = await fetch(`${base}/rest/api/2${apiPath}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${method} ${apiPath} → ${response.status} ${text.slice(0, 300)}`);
    }
    return response.status === 204 ? null : response.json();
  };
}

// ---------------------------------------------------------------------------
// task loading + validation
// ---------------------------------------------------------------------------
const VALID_STATUSES = ['todo', 'in_progress', 'review', 'testing', 'done'];

function loadTasks(config) {
  if (!fs.existsSync(TASKS_DIR)) return [];
  const { types } = resolveTypes(config);
  const tasks = [];
  for (const file of fs.readdirSync(TASKS_DIR).sort()) {
    if (!file.endsWith('.md')) continue;
    const id = file.replace(/\.md$/, '');
    const filePath = path.join(TASKS_DIR, file);
    const raw = fs.readFileSync(filePath, 'utf8');
    const task = parseTaskFile(raw, id);
    task.filePath = filePath;
    task.raw = raw;
    const { fields } = task;
    if (!fields.summary) throw new Error(`${id}: frontmatter needs a summary`);
    if (!VALID_STATUSES.includes(fields.status))
      throw new Error(`${id}: status must be one of ${VALID_STATUSES.join('/')}`);
    if (!config.statusMap[fields.status])
      throw new Error(`${id}: status "${fields.status}" has no statusMap entry in config.json`);
    if (fields.type && !types[fields.type])
      throw new Error(`${id}: type "${fields.type}" not in config.json types (${Object.keys(types).join('/')})`);
    tasks.push(task);
  }
  // Containers first so children can resolve their parent's key in the same pass.
  const container = (t) => (types[t.fields.type]?.container ? 1 : 0);
  return tasks.sort((a, b) => container(b) - container(a));
}

// The body up to the first special heading is the Jira description. Special
// sections ride along as COMMENTS on status transitions — audit trail without
// model tokens: "## Report" (builder's outcome summary) on the transition to
// review; "## Rework" (auto-review findings) on the transition back to todo.
// Headings named in config `fieldSections` are also lifted out of the
// description and returned under `sections` (keyed by heading name) so the
// sync can write them to mapped Jira fields — e.g. "## Instructions" → a
// custom text field.
export function splitBody(body, sectionNames = []) {
  const parts = { description: body.trim(), report: null, rework: null, sections: {} };
  const names = [...new Set(['Report', 'Rework', ...sectionNames])];
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const headings = [...body.matchAll(new RegExp(`^## (${escaped.join('|')})\\s*$`, 'gm'))];
  if (!headings.length) return parts;
  parts.description = body.slice(0, headings[0].index).trim();
  headings.forEach((m, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].index : body.length;
    const content = body.slice(m.index + m[0].length, end).trim() || null;
    if (m[1] === 'Report' || m[1] === 'Rework') parts[m[1].toLowerCase()] = content;
    else if (content) parts.sections[m[1]] = content;
  });
  return parts;
}

// The review transition is the only ride the report comment gets — refuse to
// take it with nothing real aboard. Returns null when the report may ship,
// else the reason it may not: empty/absent, still the task template's
// "(Optional — …)" boilerplate, or missing the "Auto-review:" trail line the
// skill mandates — the only mechanical proof the review gate actually ran.
export function reviewGateReason(report) {
  if (!report) return 'empty';
  if (/^\(optional\b/i.test(report)) return 'still the template placeholder';
  if (!/^auto-review:/im.test(report)) return 'missing its "Auto-review:" trail line';
  return null;
}

// ---------------------------------------------------------------------------
// sync (push)
// ---------------------------------------------------------------------------
async function syncOnce(config, request, state) {
  const tasks = loadTasks(config);
  const { types, defaultKey } = resolveTypes(config);
  const labels = resolveLabels(config);
  // Optional config `fieldSections` maps body headings to Jira field ids:
  //   "fieldSections": { "Instructions": "customfield_10074" }
  // A matching "## Instructions" section is stripped from the description and
  // written to that field. Only sent when the section exists, so issue types
  // whose screens lack the field (e.g. Epics) never receive it — which also
  // means deleting a section leaves the field's last value in Jira (blank the
  // section's content instead to clear it deliberately).
  const fieldSections = config.fieldSections ?? {};
  // Optional config `roleFields` maps role names to Jira user-picker (array)
  // fields with per-repo defaults:
  //   "roleFields": { "owner": { "field": "customfield_10075",
  //                              "default": ["<accountId, email, or name>"] } }
  // A task's frontmatter can override per role (`owner: Ben` or
  // `owner: [a@x.com, b@x.com]`). References resolve to accountIds via
  // /user/search (cached in .sync-state.json); bare accountIds pass through.
  // Container types (epics) never carry the fields — their screens lack them.
  const roleFields = config.roleFields ?? {};
  state.users ??= {};
  const resolveUser = async (ref) => {
    if (/^[0-9a-zA-Z]+:[0-9a-f-]+$/i.test(ref)) return ref;
    if (state.users[ref]) return state.users[ref];
    const found = await request('GET', `/user/search?query=${encodeURIComponent(ref)}`);
    const users = (found ?? []).filter((u) => u.accountType !== 'app');
    if (!users.length) throw new Error(`no Jira user matches "${ref}"`);
    if (users.length > 1)
      warn(`"${ref}" matches ${users.length} users — using ${users[0].displayName}`);
    state.users[ref] = users[0].accountId;
    return users[0].accountId;
  };
  let failures = 0;

  for (const task of tasks) {
    const { id, fields } = task;
    const { description, report, rework, sections } = splitBody(
      task.body,
      Object.keys(fieldSections)
    );
    const known = state.tasks[id] ?? {};

    try {
      const extraFields = {};
      for (const [name, fieldId] of Object.entries(fieldSections))
        if (sections[name]) extraFields[fieldId] = sections[name];
      const isContainer = Boolean((types[fields.type] ?? types[defaultKey])?.container);
      if (!isContainer)
        for (const [role, spec] of Object.entries(roleFields)) {
          const refs = fields[role] ?? spec.default ?? [];
          const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
          if (list.length) {
            const ids = [];
            for (const ref of list) ids.push(await resolveUser(ref));
            extraFields[spec.field] = ids.map((accountId) => ({ accountId }));
          }
        }
      // The epic parent rides updates too (not just create), so a task whose
      // epic gains its jiraKey later — or whose epic: field changes — gets
      // re-parented on the next pass instead of staying an orphan forever.
      // Only sent when resolvable: removing epic: locally does NOT un-parent
      // the Jira issue.
      const parentKey = fields.epic ? (state.tasks[fields.epic]?.jiraKey ?? null) : null;
      // Labels ride the content hash so adding them to config retro-tags every
      // existing issue on the next pass; the no-labels hash stays byte-identical
      // to the historical form so upgrading the CLI alone causes zero updates.
      // Field sections, role fields, and the parent ride it the same way (only
      // when present).
      const contentHash = hash(
        `${fields.summary}\n${description}${labels.length ? `\n${labels.join(',')}` : ''}${
          Object.keys(extraFields).length ? `\n${JSON.stringify(extraFields)}` : ''
        }${parentKey ? `\nparent:${parentKey}` : ''}`
      );
      let jiraKey = fields.jiraKey || known.jiraKey;

      // -- create ----------------------------------------------------------
      if (!jiraKey) {
        const create = {
          fields: {
            project: { key: config.projectKey },
            issuetype: { name: (types[fields.type] ?? types[defaultKey]).name },
            summary: fields.summary,
            description,
            ...extraFields,
            labels: [...labels, labels.length ? `lt-${labels[0]}-${id}` : `lt-${id}`],
            ...(parentKey ? { parent: { key: parentKey } } : {}),
          },
        };
        if (DRY) {
          log(`DRY create ${id} → ${config.projectKey} (${fields.summary})`);
          continue;
        }
        const created = await request('POST', '/issue', create);
        jiraKey = created.key;
        fs.writeFileSync(task.filePath, setFrontmatterKey(task.raw, 'jiraKey', jiraKey));
        state.tasks[id] = { jiraKey, hash: contentHash, status: null };
        log(`created ${jiraKey} ← ${id}`);
      }

      const entry = (state.tasks[id] ??= { jiraKey, hash: null, status: null });
      entry.jiraKey = jiraKey;

      // -- update content ---------------------------------------------------
      if (entry.hash !== contentHash) {
        if (DRY) log(`DRY update ${jiraKey} content (${id})`);
        else {
          // Labels go through the additive `update` verb, never `fields.labels`
          // (which REPLACES the whole set and would clobber the lt- marker or
          // any hand-added labels).
          await request('PUT', `/issue/${jiraKey}`, {
            fields: {
              summary: fields.summary,
              description,
              ...extraFields,
              ...(parentKey ? { parent: { key: parentKey } } : {}),
            },
            ...(labels.length
              ? { update: { labels: labels.map((l) => ({ add: l })) } }
              : {}),
          });
          entry.hash = contentHash;
          log(`updated ${jiraKey} content ← ${id}`);
        }
      }

      // -- transition -------------------------------------------------------
      if (entry.status !== fields.status) {
        const reviewBlock = fields.status === 'review' ? reviewGateReason(report) : null;
        if (fields.status === 'done' && fields.approved !== true) {
          warn(
            `${id}: status done but approved!=true — NOT transitioning ${jiraKey} (done is the human's call; set approved: true only on their explicit word)`
          );
        } else if (reviewBlock) {
          warn(
            `${id}: status review but ## Report is ${reviewBlock} — NOT transitioning ${jiraKey} (the report comment only rides this transition; complete ## Report and rewrite the file to retry)`
          );
        } else if (DRY) {
          log(`DRY transition ${jiraKey} → ${config.statusMap[fields.status]}`);
        } else {
          const targetName = config.statusMap[fields.status];
          // Unknown last-synced status (fresh create, or state lost): check the
          // live status first — a just-created issue is usually already in the
          // workflow's initial status, and "transitioning" to it is at best a
          // wasted call, at worst an error on stricter workflows.
          if (entry.status === null || entry.status === undefined) {
            const live = await request('GET', `/issue/${jiraKey}?fields=status`);
            if (live.fields?.status?.name?.toLowerCase() === targetName.toLowerCase()) {
              entry.status = fields.status;
              continue;
            }
          }
          const { transitions } = await request('GET', `/issue/${jiraKey}/transitions`);
          const target = transitions.find(
            (t) => t.to?.name?.toLowerCase() === targetName.toLowerCase()
          );
          if (!target) {
            throw new Error(
              `${jiraKey}: no transition to "${targetName}" from current status (available: ${transitions.map((t) => t.to?.name).join(', ')})`
            );
          }
          await request('POST', `/issue/${jiraKey}/transitions`, {
            transition: { id: target.id },
          });
          const comment =
            fields.status === 'review' ? report : fields.status === 'todo' ? rework : null;
          if (comment) {
            await request('POST', `/issue/${jiraKey}/comment`, { body: comment });
          }
          entry.status = fields.status;
          log(
            `transitioned ${jiraKey} → ${targetName}${comment ? ` (+${fields.status === 'review' ? 'report' : 'rework'} comment)` : ''}`
          );
        }
      }
    } catch (error) {
      failures += 1;
      warn(`${id}: ${error.message}`);
    }
  }

  if (!DRY) saveState(state);
  return failures;
}

// ---------------------------------------------------------------------------
// pull (drift report — strictly read-only, both sides)
// ---------------------------------------------------------------------------
async function pullReport(config, request, state) {
  const tasks = loadTasks(config);
  let drift = 0;
  for (const task of tasks) {
    const jiraKey = task.fields.jiraKey || state.tasks[task.id]?.jiraKey;
    if (!jiraKey) {
      log(`drift ${task.id}: not yet in Jira (no key)`);
      drift += 1;
      continue;
    }
    try {
      const issue = await request('GET', `/issue/${jiraKey}?fields=status,summary`);
      const remoteStatus = issue.fields.status?.name;
      const expected = config.statusMap[task.fields.status];
      if (remoteStatus?.toLowerCase() !== expected.toLowerCase()) {
        log(`drift ${task.id}: Jira ${jiraKey} is "${remoteStatus}", local expects "${expected}"`);
        drift += 1;
      }
      if (issue.fields.summary !== task.fields.summary) {
        log(`drift ${task.id}: summary differs (Jira: "${issue.fields.summary}")`);
        drift += 1;
      }
    } catch (error) {
      warn(`${task.id}: ${error.message}`);
      drift += 1;
    }
  }
  log(drift === 0 ? 'no drift' : `${drift} drift item(s) — local files remain authoritative; reconcile by editing them`);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function init() {
  const templatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates');
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(path.join(templatesDir, 'config.json'), CONFIG_PATH);
    log(`wrote ${CONFIG_PATH} — fill in site/projectKey/statusMap`);
  }
  const gitignorePath = path.join(JIRA_DIR, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '.sync-state.json\n.sync.lock\n.sync.rerun\n.sync.log\n');
  }
  const exampleTask = path.join(TASKS_DIR, '_example.md.txt');
  if (!fs.existsSync(exampleTask)) {
    fs.copyFileSync(path.join(templatesDir, 'task.md'), exampleTask);
  }
  log('initialized. Task files go in jira/tasks/<id>.md (see _example.md.txt).');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  if (command === 'init') return init();
  if (command !== 'sync' && command !== 'pull') {
    warn('usage: jira-sync.mjs <init|sync|pull> [--repo <dir>] [--dry-run]');
    process.exit(2);
  }

  const config = loadConfig();
  const creds = loadCredentials(config);
  const request = jiraClient(config, creds);

  if (command === 'pull') {
    return pullReport(config, request, loadState());
  }

  if (!acquireLock()) return; // rerun queued; current holder will pick it up
  try {
    let failures = 0;
    do {
      fs.rmSync(RERUN_PATH, { force: true });
      failures = await syncOnce(config, request, loadState());
    } while (fs.existsSync(RERUN_PATH));
    if (failures > 0) {
      warn(`${failures} item(s) failed — safe to rerun (next trigger will retry)`);
      process.exitCode = 1;
    }
  } finally {
    releaseLock();
  }
}

// Run only as a CLI (the parse helpers are imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    warn(error.message);
    releaseLock();
    process.exit(1);
  });
}
