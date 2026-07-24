#!/usr/bin/env bash
# Schema/frontmatter validation: the marketplace manifest plus every in-repo
# plugin (the per-directory run is what checks skill/agent/command frontmatter
# and hooks.json).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

claude plugin validate .

while IFS= read -r dir; do
  claude plugin validate "$dir"
done < <(jq -r '.plugins[].source | select(type == "string" and startswith("./"))' .claude-plugin/marketplace.json)

echo "check-validate: OK"
