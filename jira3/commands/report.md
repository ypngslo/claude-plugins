---
description: Summarize agent activity from jira/activity.jsonl — per-agent durations, tokens, and orchestration gaps, grouped by session.
---

Run `node ${CLAUDE_PLUGIN_ROOT}/bin/activity-report.mjs --repo .` from the repo
root (add `--since <ISO>` or `--session <prefix>` when the user asked about a
specific window or session) and relay the tables. Then interpret briefly:
where the time went (agent-busy vs gaps — gaps are orchestration: gate
re-runs, CI watches, brief writing, merges), the most expensive runs, and
anything anomalous (a `live` run that never stopped, unpaired-line notes in
the footer). The report is read-only and derives true start times itself —
do not re-derive timings by hand from the raw JSONL.
