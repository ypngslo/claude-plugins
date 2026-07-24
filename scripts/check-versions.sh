#!/usr/bin/env bash
# Version-bump guard. Every plugin here declares `version` in plugin.json,
# which PINS it: users only receive updates when the string changes. So any
# change to a plugin's files must come with a version bump.
#
# Usage: check-versions.sh [base-ref]   (default: origin/main)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base=${1:-origin/main}
if ! git rev-parse -q --verify "$base^{commit}" >/dev/null; then
  echo "check-versions: base ref '$base' not found, skipping" >&2
  exit 0
fi

fail=0
while IFS=$'\t' read -r name source; do
  [[ $source == ./* ]] || continue
  dir=${source#./}
  changed=$(git diff --name-only "$base...HEAD" -- "$dir/" | head -1)
  [[ -n $changed ]] || continue

  manifest="$dir/.claude-plugin/plugin.json"
  old_ver=$(git show "$base:$manifest" 2>/dev/null | jq -r '.version // empty' || true)
  new_ver=$(jq -r '.version // empty' "$manifest")

  if [[ -z $old_ver ]]; then
    echo "check-versions: $name is new or unversioned on $base, OK"
  elif [[ $old_ver == "$new_ver" ]]; then
    echo "check-versions: $name changed vs $base but version is still $new_ver — bump it in $manifest" >&2
    fail=1
  else
    echo "check-versions: $name $old_ver -> $new_ver, OK"
  fi
done < <(jq -r '.plugins[] | [.name, (.source | if type == "string" then . else "external" end)] | @tsv' .claude-plugin/marketplace.json)

[[ $fail -eq 0 ]] && echo "check-versions: OK"
exit "$fail"
