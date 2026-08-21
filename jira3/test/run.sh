#!/usr/bin/env bash
# End-to-end test of jira-sync against the in-memory mock Jira.
# Covers: init, create+writeback, epic parenting, content update, the review
# gate (no transition on empty/placeholder report), transition with report
# comment, the done-approval gate, idempotent re-run, drift pull, repo-scoping
# labels (namespaced marker on create, additive retro-tag on update).
set -euo pipefail

PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$PLUGIN/bin/jira-sync.mjs"
PORT=8199
REPO="$(mktemp -d)"
export JIRA_BASE_URL_OVERRIDE="http://127.0.0.1:$PORT"
export JIRA_EMAIL="test@example.com"
export JIRA_API_TOKEN="test-token"

node "$PLUGIN/test/mock-jira.mjs" "$PORT" & MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null; rm -rf "$REPO"' EXIT
sleep 0.4

fail() { echo "FAIL: $1" >&2; exit 1; }
state() { curl -s "http://127.0.0.1:$PORT/__state"; }

# --- init -------------------------------------------------------------------
node "$CLI" init --repo "$REPO" >/dev/null
[ -f "$REPO/jira/config.json" ] || fail "init did not scaffold config"
cat > "$REPO/jira/config.json" <<'EOF'
{ "site": "mock.invalid", "projectKey": "TT",
  "statusMap": { "todo": "To Do", "in_progress": "In Progress", "review": "Testing", "done": "Done" } }
EOF

# --- create: an epic and a child task ---------------------------------------
cat > "$REPO/jira/tasks/epic-widgets.md" <<'EOF'
---
summary: Widgets epic
status: todo
type: epic
jiraKey:
approved: false
---
Epic body.
EOF
cat > "$REPO/jira/tasks/widget-a.md" <<'EOF'
---
summary: Build widget A
status: todo
type: task
epic: epic-widgets
jiraKey:
approved: false
---
Widget A description.

## Report

EOF

node "$CLI" sync --repo "$REPO" >/dev/null
grep -q 'jiraKey: TT-1' "$REPO/jira/tasks/epic-widgets.md" || fail "epic key not written back"
grep -q 'jiraKey: TT-2' "$REPO/jira/tasks/widget-a.md"     || fail "task key not written back"
state | grep -q '"parent":{"key":"TT-1"}' || fail "child not parented to epic"
[ "$(state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).counters.create))')" = "2" ] || fail "expected 2 creates"

# --- idempotent re-run: zero new writes --------------------------------------
node "$CLI" sync --repo "$REPO" >/dev/null
COUNTS="$(state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const c=JSON.parse(d).counters;console.log(`${c.create},${c.update},${c.transition},${c.comment}`)})')"
[ "$COUNTS" = "2,0,0,0" ] || fail "re-run was not idempotent (counters $COUNTS)"

# --- content update -----------------------------------------------------------
sed -i 's/Widget A description./Widget A description, refined./' "$REPO/jira/tasks/widget-a.md"
node "$CLI" sync --repo "$REPO" >/dev/null
state | grep -q 'refined' || fail "content update not pushed"

# --- review gate: refused on empty, placeholder, or trail-less ## Report ------
sed -i 's/^status: todo/status: review/' "$REPO/jira/tasks/widget-a.md"
OUT="$(node "$CLI" sync --repo "$REPO" 2>&1)" || true
echo "$OUT" | grep -q 'NOT transitioning' || fail "review gate did not refuse empty report"
state | grep -q '"status":"Testing"' && fail "review transitioned despite empty report"
printf '(Optional — filled when the work is done. Synced to Jira as a comment.)\n' >> "$REPO/jira/tasks/widget-a.md"
OUT="$(node "$CLI" sync --repo "$REPO" 2>&1)" || true
echo "$OUT" | grep -q 'NOT transitioning' || fail "review gate did not refuse placeholder report"
state | grep -q '"status":"Testing"' && fail "review transitioned despite placeholder report"
sed -i 's/^(Optional.*/Built widget A; tests green; commit abc123./' "$REPO/jira/tasks/widget-a.md"
OUT="$(node "$CLI" sync --repo "$REPO" 2>&1)" || true
echo "$OUT" | grep -q 'Auto-review' || fail "review gate did not refuse report missing the auto-review trail"
state | grep -q '"status":"Testing"' && fail "review transitioned despite missing auto-review trail"

# --- transition to review carries the report as a comment ---------------------
printf 'Auto-review: clean (skeptic-verified)\n' >> "$REPO/jira/tasks/widget-a.md"
node "$CLI" sync --repo "$REPO" >/dev/null
state | grep -q '"status":"Testing"' || fail "review transition missing"
state | grep -q 'commit abc123' || fail "report comment missing"

# --- done gate: refused without approval --------------------------------------
sed -i 's/^status: review/status: done/' "$REPO/jira/tasks/widget-a.md"
OUT="$(node "$CLI" sync --repo "$REPO" 2>&1)" || true
echo "$OUT" | grep -q 'NOT transitioning' || fail "done gate did not refuse"
state | grep -q '"status":"Testing"' || fail "done synced despite approved!=true"

# --- approved done goes through ------------------------------------------------
sed -i 's/^approved: false/approved: true/' "$REPO/jira/tasks/widget-a.md"
node "$CLI" sync --repo "$REPO" >/dev/null
state | grep -q '"status":"Done"' || fail "approved done did not transition"

# --- pull drift report ----------------------------------------------------------
node -e '
const http = require("http");
const req = http.request({host:"127.0.0.1",port:'"$PORT"',path:"/rest/api/2/issue/TT-2/transitions",method:"POST",headers:{"Content-Type":"application/json",Authorization:"Basic x"}},()=>process.exit(0));
req.end(JSON.stringify({transition:{id:"2"}}));' # someone drags TT-2 back to In Progress in Jira
PULL="$(node "$CLI" pull --repo "$REPO")"
echo "$PULL" | grep -q 'drift widget-a' || fail "pull did not report drift"
echo "$PULL" | grep -q 'no drift' && fail "pull claimed no drift"

# --- envFile: credentials from a repo .env with custom var names ---------------
cat > "$REPO/jira/config.json" <<'EOF'
{ "site": "mock.invalid", "projectKey": "TT",
  "emailEnv": "MPMT_JIRA_EMAIL", "tokenEnv": "MPMT_JIRA_TOKEN", "envFile": ".env",
  "statusMap": { "todo": "To Do", "in_progress": "In Progress", "review": "Testing", "done": "Done" } }
EOF
printf 'export MPMT_JIRA_EMAIL="env-file@example.com"\nMPMT_JIRA_TOKEN=env-file-token\n' > "$REPO/.env"
cat > "$REPO/jira/tasks/env-file-check.md" <<'EOF'
---
summary: Prove envFile credentials work
status: todo
type: task
jiraKey:
approved: false
---
Created with credentials loaded from the repo .env, not the process env.
EOF
env -u JIRA_EMAIL -u JIRA_API_TOKEN JIRA_BASE_URL_OVERRIDE="http://127.0.0.1:$PORT" \
  node "$CLI" sync --repo "$REPO" >/dev/null
grep -q 'jiraKey: TT-3' "$REPO/jira/tasks/env-file-check.md" || fail "envFile credentials did not work"

# --- rework: transition back to todo carries ## Rework as a comment ------------
cat > "$REPO/jira/tasks/widget-b.md" <<'EOF'
---
summary: Build widget B
status: todo
type: task
jiraKey:
approved: false
---
Widget B description.
EOF
node "$CLI" sync --repo "$REPO" >/dev/null
grep -q 'jiraKey: TT-4' "$REPO/jira/tasks/widget-b.md" || fail "widget-b key not written back"
sed -i 's/^status: todo/status: in_progress/' "$REPO/jira/tasks/widget-b.md"
node "$CLI" sync --repo "$REPO" >/dev/null
sed -i 's/^status: in_progress/status: todo/' "$REPO/jira/tasks/widget-b.md"
printf '\n## Rework\n\nAuto-review: off-by-one in rotation loop (src/b.ts:42).\n' >> "$REPO/jira/tasks/widget-b.md"
node "$CLI" sync --repo "$REPO" >/dev/null
state | grep -q '"comments":\["Auto-review: off-by-one' || fail "rework comment missing"
state | grep -q '"status":"To Do"' || fail "rework todo transition missing"
state | grep -q '"description":"[^"]*off-by-one' && fail "rework section leaked into description"

# --- rework idempotent: re-run posts no duplicate comment ----------------------
BEFORE="$(state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).counters.comment))')"
node "$CLI" sync --repo "$REPO" >/dev/null
AFTER="$(state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).counters.comment))')"
[ "$BEFORE" = "$AFTER" ] || fail "rework comment duplicated on idempotent re-run"

# --- git-flow merged: exit 0 iff the task's PR is merged (stubbed gh) ----------
GITFLOW="$PLUGIN/bin/git-flow.mjs"
STUB="$(mktemp -d)"
cat > "$STUB/gh" <<'EOF'
#!/usr/bin/env bash
echo "{\"state\":\"${GH_STUB_STATE:-OPEN}\",\"mergedAt\":\"2026-07-15T00:00:00Z\"}"
EOF
chmod +x "$STUB/gh"
sed -i 's/^branch:.*$//' "$REPO/jira/tasks/widget-b.md" 2>/dev/null || true
node -e '
const fs = require("fs");
const p = process.argv[1];
let raw = fs.readFileSync(p, "utf8");
if (!/^branch:/m.test(raw)) raw = raw.replace(/^approved: false$/m, "approved: false\nbranch: TT-4-widget-b");
fs.writeFileSync(p, raw);' "$REPO/jira/tasks/widget-b.md"
if PATH="$STUB:$PATH" GH_STUB_STATE=MERGED node "$GITFLOW" merged widget-b --repo "$REPO" >/dev/null 2>&1; then :; else
  fail "merged: expected exit 0 for MERGED PR"
fi
if PATH="$STUB:$PATH" GH_STUB_STATE=OPEN node "$GITFLOW" merged widget-b --repo "$REPO" >/dev/null 2>&1; then
  fail "merged: expected non-zero exit for OPEN PR"
fi

# --- git-flow clean-tree check ignores jira/activity.jsonl ---------------------
git -C "$REPO" init -q -b main 2>/dev/null || true
git -C "$REPO" add -A >/dev/null 2>&1 && git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm seed >/dev/null 2>&1
printf '{"ts":"2026-07-15T00:00:00.000Z","event":"agent:dispatch"}\n' >> "$REPO/jira/activity.jsonl"
OUT="$(PATH="$STUB:$PATH" node "$GITFLOW" branch widget-b --repo "$REPO" 2>&1)" || true
echo "$OUT" | grep -q 'working tree is dirty' && fail "activity.jsonl alone should not trip the dirty check"

# --- activity log: agent events append timestamped JSONL, gated on config -----
ALOG="$PLUGIN/bin/activity-log.mjs"
# Real Agent tool_response shape (observed 2026-07-16): a structured object
# with a top-level agentId; foreground runs also carry totals.
printf '{"hook_event_name":"PostToolUse","tool_name":"Agent","session_id":"s1","tool_input":{"subagent_type":"jira3:task-reviewer","model":"opus","description":"Review task x","prompt":"Review task phase-1-db against criteria"},"tool_response":{"status":"completed","agentId":"abc123","agentType":"jira3:task-reviewer","content":[{"type":"text","text":"done"}],"totalTokens":10358,"totalDurationMs":4048}}' \
  | CLAUDE_PROJECT_DIR="$REPO" node "$ALOG"
# Legacy/text response shape still yields the id via the regex fallback.
printf '{"hook_event_name":"PostToolUse","tool_name":"Agent","session_id":"s1","tool_input":{"subagent_type":"builder","prompt":"x"},"tool_response":"Async agent launched. agentId: legacy99 (internal)"}' \
  | CLAUDE_PROJECT_DIR="$REPO" node "$ALOG"
printf '{"hook_event_name":"SubagentStop","agent_id":"abc123","agent_type":"jira3:task-reviewer","session_id":"s1"}' \
  | CLAUDE_PROJECT_DIR="$REPO" node "$ALOG"
# Typeless SubagentStop = harness-internal helper -> skipped, keeps stream pairable.
printf '{"hook_event_name":"SubagentStop","agent_id":"internalzzz","agent_type":"","session_id":"s1"}' \
  | CLAUDE_PROJECT_DIR="$REPO" node "$ALOG"
printf '{"hook_event_name":"PostToolUse","tool_name":"SendMessage","session_id":"s1","tool_input":{"to":"abc123","summary":"continue the review"}}' \
  | CLAUDE_PROJECT_DIR="$REPO" node "$ALOG"
printf '{"hook_event_name":"PostToolUse","tool_name":"Workflow","session_id":"s1","tool_input":{"script":"export const meta = { name: '\''wf-test'\'', description: '\''x'\'' }"},"tool_response":"Workflow launched in background. Task ID: t1\\nSummary: probe workflow\\nRun ID: wf_test12-345"}' \
  | CLAUDE_PROJECT_DIR="$REPO" node "$ALOG"
grep -q '"event":"agent:dispatch"' "$REPO/jira/activity.jsonl" || fail "dispatch not logged"
grep -q '"agent_type":"jira3:task-reviewer"' "$REPO/jira/activity.jsonl" || fail "agent type missing"
grep -q '"agent_id":"abc123"' "$REPO/jira/activity.jsonl" || fail "agent id not extracted from structured response"
grep -q '"total_tokens":10358' "$REPO/jira/activity.jsonl" || fail "foreground totals not logged"
grep -Eq '"started_ts":"[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$REPO/jira/activity.jsonl" || fail "foreground started_ts not derived"
grep -q '"agent_id":"legacy99"' "$REPO/jira/activity.jsonl" || fail "agent id not extracted from text response"
grep -q '"event":"agent:stop"' "$REPO/jira/activity.jsonl" || fail "stop not logged"
grep -q '"agent_id":"internalzzz"' "$REPO/jira/activity.jsonl" && fail "typeless internal stop should be skipped"
grep -q '"event":"agent:message"' "$REPO/jira/activity.jsonl" || fail "message not logged"
grep -q '"event":"workflow:dispatch"' "$REPO/jira/activity.jsonl" || fail "workflow dispatch not logged"
grep -q '"run_id":"wf_test12-345"' "$REPO/jira/activity.jsonl" || fail "workflow run_id not extracted"
grep -q '"name":"wf-test"' "$REPO/jira/activity.jsonl" || fail "workflow name not extracted from script meta"
grep -Eq '"ts":"[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$REPO/jira/activity.jsonl" || fail "timestamps missing"
NOREPO="$(mktemp -d)"
printf '{"hook_event_name":"SubagentStop","agent_id":"x","agent_type":"builder"}' | CLAUDE_PROJECT_DIR="$NOREPO" node "$ALOG"
[ -f "$NOREPO/jira/activity.jsonl" ] && fail "logged outside a jira3 project"
rm -rf "$NOREPO"

# --- git-flow watch-merge: blocks until terminal PR state ----------------------
if OUT="$(PATH="$STUB:$PATH" GH_STUB_STATE=MERGED node "$GITFLOW" watch-merge widget-b --repo "$REPO" 2>&1)"; then
  echo "$OUT" | grep -q 'MERGED' || fail "watch-merge did not report MERGED"
else
  fail "watch-merge: expected exit 0 for MERGED PR"
fi
if PATH="$STUB:$PATH" GH_STUB_STATE=CLOSED node "$GITFLOW" watch-merge widget-b --repo "$REPO" >/dev/null 2>&1; then
  fail "watch-merge: expected non-zero exit for CLOSED PR"
fi

# --- repo-scoping labels --------------------------------------------------------
# Several repos sharing one Jira project distinguish their issues via config
# `labels`: stamped on create (with a namespaced lt- marker), additively
# retro-tagged onto existing issues on the next pass, idempotent thereafter.
labels_of() { state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const i=JSON.parse(d).issues.find(x=>x.key===process.argv[1]);console.log(((i&&i.fields.labels)||[]).join(","))})' "$1"; }
cat > "$REPO/jira/config.json" <<'EOF'
{ "site": "mock.invalid", "projectKey": "TT", "labels": ["repo-a"],
  "statusMap": { "todo": "To Do", "in_progress": "In Progress", "review": "Testing", "done": "Done" } }
EOF
cat > "$REPO/jira/tasks/labeled-task.md" <<'EOF'
---
summary: Prove repo-scoping labels
status: todo
type: task
jiraKey:
approved: false
---
Created in a repo whose config carries labels: [repo-a].
EOF
node "$CLI" sync --repo "$REPO" >/dev/null
[ "$(labels_of TT-5)" = "repo-a,lt-repo-a-labeled-task" ] || fail "create labels wrong (got: $(labels_of TT-5))"
case "$(labels_of TT-2)" in
  *repo-a*) : ;; *) fail "existing issue not retro-tagged (TT-2 labels: $(labels_of TT-2))" ;;
esac
case "$(labels_of TT-2)" in
  *lt-widget-a*) : ;; *) fail "retro-tag clobbered the original lt- marker (TT-2 labels: $(labels_of TT-2))" ;;
esac
BEFORE="$(state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const c=JSON.parse(d).counters;console.log(`${c.create},${c.update}`)})')"
node "$CLI" sync --repo "$REPO" >/dev/null
AFTER="$(state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const c=JSON.parse(d).counters;console.log(`${c.create},${c.update}`)})')"
[ "$BEFORE" = "$AFTER" ] || fail "labeled sync not idempotent (create,update $BEFORE → $AFTER)"

# --- fieldSections: "## Instructions" syncs to a mapped custom field -----------
cat > "$REPO/jira/config.json" <<'EOF'
{ "site": "mock.invalid", "projectKey": "TT",
  "emailEnv": "MPMT_JIRA_EMAIL", "tokenEnv": "MPMT_JIRA_TOKEN", "envFile": ".env",
  "labels": ["repo-a"],
  "fieldSections": { "Instructions": "customfield_90001" },
  "statusMap": { "todo": "To Do", "in_progress": "In Progress", "review": "Testing", "done": "Done" } }
EOF
cat > "$REPO/jira/tasks/widget-c.md" <<'EOF'
---
summary: Build widget C
status: todo
type: task
jiraKey:
approved: false
---
Plain-English summary for non-technical readers.

## Instructions

Refactor src/widget-c.ts:12 to use the rotation helper.
EOF
node "$CLI" sync --repo "$REPO" >/dev/null
state | grep -q '"customfield_90001":"Refactor src/widget-c.ts:12 to use the rotation helper."' || fail "instructions did not reach the custom field"
state | grep -q '"description":"[^"]*Refactor src' && fail "instructions leaked into description"

# fieldSections ride the content hash: editing only the section pushes an update
sed -i 's/rotation helper/shared rotation helper/' "$REPO/jira/tasks/widget-c.md"
node "$CLI" sync --repo "$REPO" >/dev/null
state | grep -q 'shared rotation helper' || fail "instructions edit not pushed"

# ...and adding fieldSections to config alone causes no writes to section-less tasks
BEFORE="$(state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).counters.update))')"
node "$CLI" sync --repo "$REPO" >/dev/null
AFTER="$(state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).counters.update))')"
[ "$BEFORE" = "$AFTER" ] || fail "fieldSections config caused spurious updates"

# --- roleFields + testing status -----------------------------------------------
cat > "$REPO/jira/config.json" <<'EOF'
{ "site": "mock.invalid", "projectKey": "TT",
  "emailEnv": "MPMT_JIRA_EMAIL", "tokenEnv": "MPMT_JIRA_TOKEN", "envFile": ".env",
  "labels": ["repo-a"],
  "roleFields": {
    "owner":    { "field": "customfield_80001", "default": ["Mickey Mock"] },
    "reviewer": { "field": "customfield_80002", "default": ["712020:abcd-ef01"] }
  },
  "statusMap": { "todo": "To Do", "in_progress": "In Progress", "review": "In Review", "testing": "Testing", "done": "Done" } }
EOF
cat > "$REPO/jira/tasks/widget-d.md" <<'EOF'
---
summary: Build widget D
status: todo
type: task
jiraKey:
approved: false
owner: Ben Mock
---
Widget D description.
EOF
node "$CLI" sync --repo "$REPO" >/dev/null
grep -q 'jiraKey: TT-7' "$REPO/jira/tasks/widget-d.md" || fail "widget-d key not written back"
state | grep -q '"customfield_80001":\[{"accountId":"acc:benmock"}\]' || fail "owner frontmatter override not resolved to accountId"
state | grep -q '"customfield_80002":\[{"accountId":"712020:abcd-ef01"}\]' || fail "accountId default not passed through"
state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const i=JSON.parse(d).issues.find(x=>x.key==="TT-1");process.exit("customfield_80001" in i.fields ?1:0)})' || fail "role field sent to an epic"

# testing is a first-class status: transitions to the mapped Jira status
sed -i 's/^status: todo/status: testing/' "$REPO/jira/tasks/widget-d.md"
node "$CLI" sync --repo "$REPO" >/dev/null
state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const i=JSON.parse(d).issues.find(x=>x.key==="TT-7");process.exit(i.fields.status==="Testing"?0:1)})' || fail "testing status did not transition"

# --- watch-merge flips review → testing on MERGED --------------------------------
sed -i 's/^status: todo/status: review/' "$REPO/jira/tasks/widget-b.md"
PATH="$STUB:$PATH" GH_STUB_STATE=MERGED node "$GITFLOW" watch-merge widget-b --repo "$REPO" >/dev/null 2>&1 || fail "watch-merge MERGED should exit 0"
grep -q '^status: testing' "$REPO/jira/tasks/widget-b.md" || fail "watch-merge did not flip review → testing"
state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const i=JSON.parse(d).issues.find(x=>x.key==="TT-4");process.exit(i.fields.status==="Testing"?0:1)})' || fail "watch-merge flip did not sync to Jira"

# --- malformed labels refused up front ------------------------------------------
cat > "$REPO/jira/config.json" <<'EOF'
{ "site": "mock.invalid", "projectKey": "TT", "labels": ["has space"],
  "statusMap": { "todo": "To Do", "in_progress": "In Progress", "review": "Testing", "done": "Done" } }
EOF
if node "$CLI" sync --repo "$REPO" >/dev/null 2>&1; then
  fail "sync accepted a label containing whitespace"
fi

echo "ALL PASS"
