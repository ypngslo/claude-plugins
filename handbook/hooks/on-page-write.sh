#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): when the model writes a handbook page file,
# spawn the sync CLI DETACHED and return immediately — the working session
# never waits on Confluence. All failure handling lives in the CLI (lock, retry on
# next trigger); this script must never block or error the tool call.
set -u

INPUT="$(cat)"

# Extract tool_input.file_path without jq (node is guaranteed: the CLI needs it).
FILE_PATH="$(printf '%s' "$INPUT" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try { process.stdout.write(JSON.parse(raw).tool_input?.file_path ?? ""); } catch {}
});
' 2>/dev/null)"

case "$FILE_PATH" in
  */confluence/pages/*.md) ;;
  *) exit 0 ;;
esac

# Repo root = the directory containing confluence/config.json, walking up from the file.
DIR="$(dirname "$FILE_PATH")"
REPO=""
while [ "$DIR" != "/" ]; do
  if [ -f "$DIR/confluence/config.json" ]; then REPO="$DIR"; break; fi
  DIR="$(dirname "$DIR")"
done
[ -z "$REPO" ] && exit 0

nohup node "${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs" sync --repo "$REPO" \
  >> "$REPO/confluence/.sync.log" 2>&1 &

exit 0
