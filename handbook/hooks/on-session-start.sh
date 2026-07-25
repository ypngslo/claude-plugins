#!/usr/bin/env bash
# SessionStart hook: if this project uses handbook (confluence/config.json present),
# print a brief staleness report (pure git, no network) then run one detached
# reconcile pass so anything edited outside a session (or a previously failed
# push) syncs. Never blocks session start.
set -u

if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "${CLAUDE_PROJECT_DIR}/confluence/config.json" ]; then
  timeout 5 node "${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs" stale --brief --repo "${CLAUDE_PROJECT_DIR}" 2>/dev/null || true

  nohup node "${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs" sync --repo "${CLAUDE_PROJECT_DIR}" \
    >> "${CLAUDE_PROJECT_DIR}/confluence/.sync.log" 2>&1 &
fi

exit 0
