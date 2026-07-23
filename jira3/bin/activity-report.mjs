#!/usr/bin/env node
/**
 * activity-report.mjs — summarize jira/activity.jsonl.
 *
 * Pairs agent dispatches with their stops, recovers true start times
 * (foreground dispatch lines are stamped at completion; started_ts, or
 * ts - duration_ms on pre-0.5.1 lines, gives the start), and prints one
 * table per session: start, duration, tokens, agent type, description —
 * followed by span / agent-busy / gap totals. Gap time is span minus the
 * merged coverage of agent intervals, so parallel agents don't double-count.
 *
 *   node activity-report.mjs [--repo <dir>] [--since <ISO>] [--session <prefix>]
 *
 * Read-only. Lines it cannot attribute (pre-0.5.1 dispatches without an
 * agent_id, stops whose dispatch predates the log or belongs to a workflow
 * run) are counted in the footer, never silently dropped.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};
const repoRoot = path.resolve(flagValue('--repo') ?? process.cwd());
const since = flagValue('--since');
const sessionPrefix = flagValue('--session');

const LOG_PATH = path.join(repoRoot, 'jira', 'activity.jsonl');
if (!fs.existsSync(LOG_PATH)) {
  console.error(`no ${LOG_PATH} — nothing to report`);
  process.exit(1);
}

const rows = fs
  .readFileSync(LOG_PATH, 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // a torn write shouldn't kill the report
    }
  })
  .filter((r) => (!since || r.ts >= since) && (!sessionPrefix || (r.session_id ?? '').startsWith(sessionPrefix)));

const stopsById = new Map();
for (const r of rows) {
  if (r.event === 'agent:stop' && r.agent_id) stopsById.set(r.agent_id, r);
}

// One entry per attributable agent run: {start, end, tokens, type, desc}.
const runs = [];
let unpairedDispatches = 0;
const claimedStops = new Set();
for (const r of rows) {
  if (r.event !== 'agent:dispatch') continue;
  if (!r.agent_id) {
    unpairedDispatches += 1;
    continue;
  }
  const end = r.duration_ms != null ? Date.parse(r.ts) : Date.parse(stopsById.get(r.agent_id)?.ts ?? NaN);
  const start =
    r.started_ts != null
      ? Date.parse(r.started_ts)
      : r.duration_ms != null
        ? Date.parse(r.ts) - r.duration_ms
        : Date.parse(r.ts);
  if (stopsById.has(r.agent_id)) claimedStops.add(r.agent_id);
  runs.push({
    session: r.session_id ?? '?',
    start,
    end: Number.isNaN(end) ? null : end, // background dispatch, no stop yet
    tokens: r.total_tokens ?? null,
    type: r.agent_type ?? '?',
    desc: r.description ?? '',
  });
}
const orphanStops = [...stopsById.keys()].filter((id) => !claimedStops.has(id)).length;
const workflows = rows.filter((r) => r.event === 'workflow:dispatch');
const messages = rows.filter((r) => r.event === 'agent:message').length;

const notes = [];
if (unpairedDispatches) notes.push(`${unpairedDispatches} dispatch(es) without agent_id (pre-0.5.1 lines) excluded`);
if (orphanStops) notes.push(`${orphanStops} stop(s) with no logged dispatch (workflow children or pre-log history)`);
if (messages) notes.push(`${messages} agent message(s)`);

if (!runs.length && !workflows.length) {
  console.log('no attributable agent runs in the selected window');
  if (notes.length) console.log(`note: ${notes.join('; ')}`);
  process.exit(0);
}

const fmtClock = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' '); // MM-DD HH:MM
const fmtMin = (ms) => (ms / 60000).toFixed(1);
const fmtTok = (n) => (n == null ? '—' : `${Math.round(n / 1000)}k`);

// Merge intervals to measure real coverage (parallel agents overlap).
function coverage(intervals) {
  const sorted = intervals
    .filter(([s, e]) => e != null)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const [s, e] of sorted) {
    if (curEnd == null || s > curEnd) {
      if (curEnd != null) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd != null) total += curEnd - curStart;
  return total;
}

const bySession = new Map();
for (const run of runs) {
  if (!bySession.has(run.session)) bySession.set(run.session, []);
  bySession.get(run.session).push(run);
}

for (const [session, sessionRuns] of bySession) {
  sessionRuns.sort((a, b) => a.start - b.start);
  const ends = sessionRuns.map((r) => r.end).filter((e) => e != null);
  const spanEnd = ends.length ? Math.max(...ends) : null;
  console.log(`\nsession ${session.slice(0, 8)} — ${sessionRuns.length} agent run(s)`);
  console.log('  START (UTC)   MIN   TOKENS  TYPE                      DESCRIPTION');
  for (const r of sessionRuns) {
    const dur = r.end != null ? fmtMin(r.end - r.start).padStart(5) : '  live';
    console.log(
      `  ${fmtClock(r.start)}  ${dur}  ${fmtTok(r.tokens).padStart(6)}  ${r.type.padEnd(24).slice(0, 24)}  ${r.desc}`
    );
  }
  if (spanEnd != null) {
    const span = spanEnd - sessionRuns[0].start;
    const busy = coverage(sessionRuns.map((r) => [r.start, r.end]));
    const tokens = sessionRuns.reduce((sum, r) => sum + (r.tokens ?? 0), 0);
    console.log(
      `  span ${fmtMin(span)} min · agent-busy ${fmtMin(busy)} min · gaps ${fmtMin(span - busy)} min · ${fmtTok(tokens)} tokens`
    );
  }
}

for (const w of workflows) {
  console.log(`\nworkflow ${w.run_id ?? '?'} (${w.name ?? 'unnamed'}) at ${w.ts} — agents correlate by session + time window`);
}

if (notes.length) console.log(`\nnote: ${notes.join('; ')}`);
