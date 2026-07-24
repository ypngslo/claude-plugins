#!/usr/bin/env bash
# End-to-end install smoke test: register this checkout as a marketplace in a
# throwaway CLAUDE_CONFIG_DIR/CLAUDE_CODE_PLUGIN_CACHE_DIR sandbox, install
# every plugin, and assert the installed copy contains every tracked file with
# exec bits intact. Meaningful mainly in CI, where the checkout is fresh from
# git — locally the working tree can hide missing-from-git problems.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export CLAUDE_CONFIG_DIR="$tmp/config" CLAUDE_CODE_PLUGIN_CACHE_DIR="$tmp/plugins"
mkdir -p "$CLAUDE_CONFIG_DIR" "$CLAUDE_CODE_PLUGIN_CACHE_DIR"

mkt=$(jq -r .name .claude-plugin/marketplace.json)
claude plugin marketplace add "$root"

fail=0
while IFS=$'\t' read -r name source; do
  [[ $source == ./* ]] || continue
  dir=${source#./}

  claude plugin install "$name@$mkt"

  install_dir=$(find "$tmp/plugins/cache/$mkt/$name" -mindepth 1 -maxdepth 1 -type d | head -1)
  if [[ -z $install_dir ]]; then
    echo "check-install: $name: no installed copy found in cache" >&2
    fail=1
    continue
  fi

  while read -r mode _sha _stage path; do
    rel=${path#"$dir"/}
    if [[ ! -e "$install_dir/$rel" ]]; then
      echo "check-install: $name: tracked file missing from installed copy: $rel" >&2
      fail=1
    elif [[ $mode == 100755 && ! -x "$install_dir/$rel" ]]; then
      echo "check-install: $name: exec bit lost in installed copy: $rel" >&2
      fail=1
    fi
  done < <(git ls-files -s "$dir")

  echo "check-install: $name installed and complete"
done < <(jq -r '.plugins[] | [.name, (.source | if type == "string" then . else "external" end)] | @tsv' .claude-plugin/marketplace.json)

[[ $fail -eq 0 ]] && echo "check-install: OK"
exit "$fail"
