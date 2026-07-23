---
description: Force a jira3 sync now and report the outcome (normally unnecessary — hooks sync automatically on every task-file write).
---

Run `node ${CLAUDE_PLUGIN_ROOT}/bin/jira-sync.mjs sync --repo .` from the repo
root (foreground, so you see the output), then report to the user exactly what
it did: creates, content updates, transitions, warnings (especially any
"done but approved!=true" or credential warnings). If items failed, say which
and why — the sync is idempotent and safe to rerun. If the user asked about a
PAST sync instead, read `jira/.sync.log` and summarize the relevant tail.
