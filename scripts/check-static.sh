#!/usr/bin/env bash
# Static checks on the executable surface `claude plugin validate` ignores:
#   - bash -n + shellcheck on tracked shell scripts
#   - node --check on tracked .mjs files
#   - every hooks.json command that references ${CLAUDE_PLUGIN_ROOT} must point
#     at a file that exists (and is executable when invoked directly)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0

# --- shell scripts -----------------------------------------------------------
mapfile -t sh_files < <(git ls-files '*.sh')
for f in "${sh_files[@]}"; do
  bash -n "$f" || fail=1
done
if command -v shellcheck >/dev/null; then
  shellcheck --severity=warning "${sh_files[@]}" || fail=1
else
  echo "check-static: shellcheck not installed, skipping (CI runs it)" >&2
fi

# --- node scripts ------------------------------------------------------------
while IFS= read -r f; do
  node --check "$f" || fail=1
done < <(git ls-files '*.mjs' '*.js' '*.cjs')

# --- hooks.json command targets ----------------------------------------------
while IFS= read -r hooks_json; do
  plugin_dir=$(dirname "$(dirname "$hooks_json")")
  while IFS= read -r cmd; do
    for word in $cmd; do
      [[ $word == *'${CLAUDE_PLUGIN_ROOT}'* ]] || continue
      path=${word//'${CLAUDE_PLUGIN_ROOT}'/$plugin_dir}
      if [[ ! -e $path ]]; then
        echo "check-static: $hooks_json references missing file: $path" >&2
        fail=1
      elif [[ $cmd == "\${CLAUDE_PLUGIN_ROOT}"* && ! -x $path ]]; then
        echo "check-static: $hooks_json invokes non-executable file: $path (chmod +x)" >&2
        fail=1
      fi
    done
  done < <(jq -r '.hooks | to_entries[].value[].hooks[].command' "$hooks_json")
done < <(git ls-files '*/hooks/hooks.json')

[[ $fail -eq 0 ]] && echo "check-static: OK"
exit "$fail"
