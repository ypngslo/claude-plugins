#!/usr/bin/env node
/**
 * git-flow — deterministic git/GitHub ceremony derived from jira3 task files.
 * Same contract as jira-sync: agents edit task files and run ONE command;
 * everything derivable (branch names, base branches, PR titles/bodies, CI
 * verdicts) is computed here, never by a model. Requires `git`; `pr` and `ci`
 * also require the `gh` CLI (authenticated).
 *
 * Branch model (see the jira-tasks skill, "GitHub flow"):
 *   epic task  →  branch  <epicPrefix><JIRAKEY>-<id>       off <defaultBase>
 *   task       →  branch  <JIRAKEY>-<id>                   off its epic's
 *                 branch when `epic:` is set, else off <defaultBase>
 *   PR base mirrors the same rule. Jira keys in branch names and PR titles
 *   make Jira's Development panel link everything automatically — that is the
 *   tracking mechanism; no status comments are ever posted from here.
 *
 * Commands:
 *   git-flow.mjs branch <task-id> [--repo <dir>]            create/checkout + push the task's branch
 *   git-flow.mjs pr     <task-id> [--draft] [--repo <dir>]  open the task's PR (gh)
 *   git-flow.mjs ci     [<ref>]   [--repo <dir>] [--timeout-min <n>]
 *                       poll the latest run for <ref> (default: current branch),
 *                       print EVERY job's conclusion (wrapper exit codes lie)
 *
 * Config: optional `github` block in jira/config.json —
 *   { "defaultBase": "main", "epicPrefix": "epic/", "remote": "origin" }
 *
 * Exit codes: 0 ok / CI all green (or no runs found); 1 CI red or PR/push
 * failure; 2 config/usage error (incl. dirty worktree, missing jiraKey);
 * 4 CI poll timeout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTaskFile, setFrontmatterKey, splitBody, resolveTypes } from './jira-sync.mjs';

const argv = process.argv.slice(2);
const command = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const repoRoot = path.resolve(flagValue('--repo', process.cwd()));

const log = (msg) => process.stdout.write(`[git-flow] ${msg}\n`);
const warn = (msg) => process.stderr.write(`[git-flow] WARN ${msg}\n`);
const die = (msg, code = 2) => {
  warn(msg);
  process.exit(code);
};

// ---------------------------------------------------------------------------
// config + task loading (jira/ layout shared with jira-sync)
// ---------------------------------------------------------------------------
function loadGithubConfig() {
  const configPath = path.join(repoRoot, 'jira', 'config.json');
  if (!fs.existsSync(configPath)) die(`no ${configPath} — run jira-sync init first`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const { types } = resolveTypes(config);
  return {
    site: config.site,
    defaultBase: 'main',
    epicPrefix: 'epic/',
    remote: 'origin',
    // Hierarchy comes from the per-project types map, never from type names.
    containerTypes: new Set(Object.keys(types).filter((k) => types[k].container)),
    ...(config.github ?? {}),
  };
}

function loadTask(id) {
  const filePath = path.join(repoRoot, 'jira', 'tasks', `${id}.md`);
  if (!fs.existsSync(filePath)) die(`no task file jira/tasks/${id}.md`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const task = parseTaskFile(raw, id);
  task.filePath = filePath;
  task.raw = raw;
  return task;
}

/** Branch name for a task: keys in names drive Jira's Development panel. */
export function branchNameFor(task, gh) {
  const key = task.fields.jiraKey;
  if (!key) return null;
  const isContainer = gh.containerTypes?.has(task.fields.type);
  return isContainer ? `${gh.epicPrefix}${key}-${task.id}` : `${key}-${task.id}`;
}

/** Base branch for an item's branch and PR: its container's branch, else defaultBase. */
export function resolveBase(task, gh, loadTaskById) {
  if (gh.containerTypes?.has(task.fields.type) || !task.fields.epic)
    return { base: gh.defaultBase, epic: null };
  const epic = loadTaskById(task.fields.epic);
  const epicBranch = branchNameFor(epic, gh);
  if (!epicBranch) return { base: null, epic };
  return { base: epicBranch, epic };
}

// ---------------------------------------------------------------------------
// git/gh plumbing
// ---------------------------------------------------------------------------
const git = (...args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
const gitOk = (...args) => {
  try {
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
const gh = (...args) =>
  execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

const localBranchExists = (name) => gitOk('rev-parse', '--verify', '--quiet', `refs/heads/${name}`);
const remoteBranchExists = (remote, name) =>
  git('ls-remote', '--heads', remote, name).length > 0;

function requireCleanTree() {
  // jira/activity.jsonl is append-only telemetry written by hooks between
  // commits; it rides checkouts safely and must never block a branch cut.
  const dirty = git('status', '--porcelain')
    .split('\n')
    .filter(Boolean)
    // endsWith, not slice(3): the git() helper trims the first line's leading
    // space (unstaged ' M'), which would misalign a column-based match.
    .filter((line) => !line.endsWith('jira/activity.jsonl'));
  if (dirty.length > 0)
    die('working tree is dirty — commit or stash before switching branches');
}

/** Create (or check out) `name` from the freshest available `base`, push -u. */
function ensureBranch(name, base, remote) {
  if (localBranchExists(name)) {
    git('checkout', name);
    log(`checked out existing branch ${name}`);
  } else if (remoteBranchExists(remote, name)) {
    git('fetch', remote, name);
    git('checkout', '-b', name, `${remote}/${name}`);
    log(`checked out ${name} from ${remote}`);
  } else {
    const startPoint = remoteBranchExists(remote, base)
      ? (git('fetch', remote, base), `${remote}/${base}`)
      : base;
    if (!localBranchExists(base) && !remoteBranchExists(remote, base))
      die(`base branch ${base} exists neither locally nor on ${remote}`);
    git('checkout', '-b', name, startPoint);
    log(`created ${name} off ${startPoint}`);
  }
  try {
    git('push', '-u', remote, name);
    log(`pushed ${name} → ${remote}`);
  } catch (error) {
    die(`push failed: ${String(error.message).slice(0, 200)}`, 1);
  }
}

function stampBranch(task, name) {
  if (task.fields.branch === name) return;
  fs.writeFileSync(task.filePath, setFrontmatterKey(task.raw, 'branch', name));
  log(`stamped branch: ${name} into jira/tasks/${task.id}.md`);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
function cmdBranch(id) {
  const ghConfig = loadGithubConfig();
  const task = loadTask(id);
  const name = branchNameFor(task, ghConfig);
  if (!name) die(`${id} has no jiraKey — run jira-sync sync first (keys drive Jira linking)`);
  requireCleanTree();

  const { base, epic } = resolveBase(task, ghConfig, loadTask);
  if (base === null) die(`epic ${task.fields.epic} has no jiraKey — sync it first`);

  // An epic branch is auto-created the first time one of its tasks branches.
  if (epic) {
    const epicBranch = branchNameFor(epic, ghConfig);
    if (!localBranchExists(epicBranch) && !remoteBranchExists(ghConfig.remote, epicBranch)) {
      ensureBranch(epicBranch, ghConfig.defaultBase, ghConfig.remote);
      stampBranch(epic, epicBranch);
    }
  }
  ensureBranch(name, base, ghConfig.remote);
  stampBranch(task, name);
  log(`ready: ${name} (base ${base})`);
}

function cmdPr(id) {
  const ghConfig = loadGithubConfig();
  const task = loadTask(id);
  const name = task.fields.branch || branchNameFor(task, ghConfig);
  if (!name) die(`${id} has no jiraKey/branch — run branch first`);
  const { base } = resolveBase(task, ghConfig, loadTask);
  if (base === null) die(`epic ${task.fields.epic} has no jiraKey — sync it first`);

  const { description } = splitBody(task.body);
  const jiraUrl = ghConfig.site ? `\n\nJira: https://${ghConfig.site}/browse/${task.fields.jiraKey}` : '';
  const args = [
    'pr', 'create',
    '--head', name,
    '--base', base,
    '--title', `${task.fields.jiraKey}: ${task.fields.summary}`,
    '--body', `${description}${jiraUrl}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ];
  if (flags.has('--draft')) args.push('--draft');
  try {
    log(gh(...args));
  } catch (error) {
    die(`gh pr create failed: ${String(error.stderr || error.message).slice(0, 300)}`, 1);
  }
}

/** Exit 0 iff the task's PR is merged — the poll target for merge-watch monitors. */
function cmdMerged(id) {
  const ghConfig = loadGithubConfig();
  const task = loadTask(id);
  const name = task.fields.branch || branchNameFor(task, ghConfig);
  if (!name) die(`${id} has no jiraKey/branch — run branch first`);
  let pr;
  try {
    pr = JSON.parse(gh('pr', 'view', name, '--json', 'state,mergedAt'));
  } catch (error) {
    die(`gh pr view ${name} failed: ${String(error.stderr || error.message).slice(0, 200)}`, 2);
  }
  if (pr.state === 'MERGED') {
    log(`${name} merged at ${pr.mergedAt}`);
    return;
  }
  die(`${name} PR state: ${pr.state}`, 1);
}

/**
 * After a merge, flip the task review → testing when the project's statusMap
 * defines a testing status — the Jira side then hands the issue to the Tester
 * (e.g. via a project automation on the transition). Best effort: a failed
 * flip or sync is retried by the next hook-triggered sync; `done` still
 * requires the human's explicit word regardless.
 */
function flipToTesting(id) {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'jira', 'config.json'), 'utf8')
    );
    if (!config.statusMap?.testing) return;
    const task = loadTask(id);
    if (task.fields.status !== 'review') return;
    fs.writeFileSync(task.filePath, setFrontmatterKey(task.raw, 'status', 'testing'));
    log(`${id} review → testing (PR merged)`);
    const syncPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jira-sync.mjs');
    execFileSync(process.execPath, [syncPath, 'sync', '--repo', repoRoot], { stdio: 'ignore' });
  } catch (error) {
    warn(`testing flip for ${id} incomplete: ${String(error.message).slice(0, 200)} — the next sync retries`);
  }
}

/**
 * Block until the task's PR reaches a terminal state; exit 0 on MERGED,
 * 1 on CLOSED. Run via a background Bash until-notification — the merge-watch
 * that lets the human steer the pipeline by merging. On MERGED the watcher
 * also flips the task review → testing (see flipToTesting).
 */
async function cmdWatchMerge(id) {
  const ghConfig = loadGithubConfig();
  const task = loadTask(id);
  const name = task.fields.branch || branchNameFor(task, ghConfig);
  if (!name) die(`${id} has no jiraKey/branch — run branch first`);
  const intervalMs = Number(flagValue('--interval-sec', '60')) * 1000;

  let misses = 0;
  for (;;) {
    let pr = null;
    try {
      pr = JSON.parse(gh('pr', 'view', name, '--json', 'state,mergedAt'));
      misses = 0;
    } catch {
      // Transient gh/network failures shouldn't kill a long watch.
      misses += 1;
      if (misses >= 10) die(`gh pr view ${name} failed ${misses} times in a row`, 2);
    }
    if (pr?.state === 'MERGED') {
      log(`${name} MERGED at ${pr.mergedAt}`);
      flipToTesting(id);
      return;
    }
    if (pr?.state === 'CLOSED') die(`${name} PR CLOSED without merge`, 1);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function cmdCi(ref) {
  const branch = ref || git('rev-parse', '--abbrev-ref', 'HEAD');
  const timeoutMs = Number(flagValue('--timeout-min', '30')) * 60_000;
  const started = Date.now();

  // Match the run to the branch's current HEAD SHA — the newest run on the
  // branch is often the PREVIOUS push's (the new run takes seconds to appear),
  // and watching it silently reports stale conclusions. Poll until this SHA's
  // run exists.
  const sha = git('rev-parse', branch);
  let match = null;
  for (let attempt = 0; attempt < 7; attempt++) {
    const list = JSON.parse(
      gh(
        'run',
        'list',
        '--branch',
        branch,
        '--limit',
        '10',
        '--json',
        'databaseId,status,workflowName,headSha'
      )
    );
    match = list.find((r) => r.headSha === sha) ?? null;
    if (match) break;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!match) {
    log(`no workflow run for ${sha.slice(0, 7)} on ${branch} after 60 s (no CI, or not triggered)`);
    return;
  }
  const runId = String(match.databaseId);
  log(`watching run ${runId} (${match.workflowName}) on ${branch} @ ${sha.slice(0, 7)}`);

  let run;
  for (;;) {
    run = JSON.parse(gh('run', 'view', runId, '--json', 'status,conclusion,jobs'));
    if (run.status === 'completed') break;
    if (Date.now() - started > timeoutMs) die(`timed out after ${timeoutMs / 60000} min (run still ${run.status})`, 4);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }

  // The whole point: report EVERY job's conclusion, not the wrapper's word.
  let bad = 0;
  for (const job of run.jobs) {
    const ok = job.conclusion === 'success' || job.conclusion === 'skipped';
    if (!ok) bad += 1;
    log(`job ${job.name}: ${job.conclusion}${ok ? '' : '  ← NOT GREEN'}`);
  }
  if (bad > 0) die(`${bad} job(s) not green on ${branch}`, 1);
  log(`all ${run.jobs.length} job(s) green on ${branch}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  if (command === 'branch' && positional[0]) return cmdBranch(positional[0]);
  if (command === 'pr' && positional[0]) return cmdPr(positional[0]);
  if (command === 'ci') return cmdCi(positional[0]);
  if (command === 'merged' && positional[0]) return cmdMerged(positional[0]);
  if (command === 'watch-merge' && positional[0]) return cmdWatchMerge(positional[0]);
  die('usage: git-flow.mjs <branch|pr|merged|watch-merge> <task-id> | ci [<ref>] [--repo <dir>] [--draft] [--timeout-min <n>] [--interval-sec <n>]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    warn(String(error.message).slice(0, 300));
    process.exit(1);
  });
}
