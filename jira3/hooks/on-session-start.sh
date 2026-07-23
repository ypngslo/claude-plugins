#!/usr/bin/env bash
# SessionStart hook: if this project uses jira3 (jira/config.json present),
# run one detached reconcile pass so anything edited outside a session (or a
# previously failed push) syncs. Never blocks session start.
set -u

if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "${CLAUDE_PROJECT_DIR}/jira/config.json" ]; then
  nohup node "${CLAUDE_PLUGIN_ROOT}/bin/jira-sync.mjs" sync --repo "${CLAUDE_PROJECT_DIR}" \
    >> "${CLAUDE_PROJECT_DIR}/jira/.sync.log" 2>&1 &
fi

exit 0
