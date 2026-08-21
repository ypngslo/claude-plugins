# jira3 — local-first Jira tracking that never slows the session

Successor to `jira` / `jira2`. Those drove Jira from inside the model loop —
live transition-id lookups, MCP calls, and hand-regenerated manifest tables on
every state change, all costing tokens and wall-clock, all on an
interactively-authenticated MCP that breaks headless. jira3 inverts it:

> **Agents edit local task files. A deterministic CLI mirrors them to Jira,
> spawned detached by hooks. The model never talks to Jira at all.**

## How it works

```
jira/tasks/<id>.md  ──(model edits status/report)──▶  PostToolUse hook
                                                          │ spawns detached
                                                          ▼
                                              bin/jira-sync.mjs  ──REST──▶ Jira
                                              (diff vs .sync-state.json:
                                               create / update / transition /
                                               attach report comment)
```

- **Zero model cost per state change** — flipping `status:` in a file the
  orchestrator was already writing is the entire obligation. The hook returns
  immediately; sync runs in the background; failures retry on the next
  trigger (lockfile + rerun-flag collapse concurrent spawns).
- **Deterministic transitions** — status mapping lives in per-repo config;
  transition ids are looked up live *by the script*. No cognition involved.
- **No review without a report, mechanically** — `status: review` does not
  sync while `## Report` is empty, still the template placeholder, or missing
  its `Auto-review:` trail line (the mechanical proof the auto-review gate
  ran), so a bare status flip can't publish boilerplate as the report comment
  (which only rides the review transition) and an unreviewed branch can't
  slip into review; the next write with the completed report retries.
- **Done is the human's call, mechanically** — `status: done` does not sync
  unless `approved: true`, which the skill instructs agents to set only on
  the user's explicit word.
- **One-way by design** — local files are authoritative. `pull` produces a
  drift *report* only (someone edited Jira directly); reconcile by editing
  the local files. Bidirectional merge is deliberately out of scope.
- **No MCP, no dependencies** — direct REST v2 with an API token from env;
  works in hooks, cron, and headless runs. Node ≥ 20, zero npm deps.

## Per-repo setup

Run `/jira3:init` (or `node bin/jira-sync.mjs init` in the repo). It scaffolds:

```
jira/
  config.json      ← THE per-project Jira space: site, projectKey, email,
                     issue types, statusMap (local status → your workflow's
                     exact status names). Committed; contains no secrets.
  tasks/<id>.md    ← one file per item; frontmatter = state, body = description,
                     "## Report" section = synced as a comment on review.
  .gitignore       ← ignores .sync-state.json / .sync.lock / .sync.log
```

Credentials never live in `jira/` and are never committed. They resolve from
the process environment — `JIRA_API_TOKEN` (and `JIRA_EMAIL` unless `email`
is in config), var names overridable via `tokenEnv`/`emailEnv` — and, when
`envFile` is set (default `.env`), from that repo-relative env file as a
fallback: the file only fills gaps, the ambient environment always wins. So a
repo that already keeps e.g. `MPMT_JIRA_TOKEN` in its `.env` just points
`tokenEnv` at it. Different repos target different sites/projects entirely
through their own `config.json` — nothing is global.

Several repos can also share ONE Jira project: give each repo a `labels`
list (e.g. `"labels": ["my-repo"]`) and every issue that repo creates —
epics included — is stamped with it, so `project = X AND labels = my-repo`
scopes boards and JQL per repo. Labels are pushed additively (never replacing
hand-added ones), retro-applied to already-created issues on their next
content update, and the first label namespaces the per-task `lt-<id>` marker
label so identical task ids in two repos can't collide.

## Lifecycle contract (enforced by `skills/jira-tasks`)

| Local status  | Jira (default map) | Flipped when                                     |
| ------------- | ------------------ | ------------------------------------------------ |
| `todo`        | To Do              | item is planned (file created)                   |
| `in_progress` | In Progress        | work actually starts                             |
| `review`      | In Review          | implemented + gates green + auto-review clean; `## Report` filled in |
| `testing`     | Testing            | (optional — only when statusMap defines it) flipped by the merge-watch when the PR merges |
| `done`        | Done               | **the human's explicit word only** (`approved: true`) |

### Auto-review gate

Before any task may flip to `review`, the session dispatches a fresh critical reviewer
(`agents/task-reviewer.md`, opus at max effort) on the branch diff + the task's
acceptance criteria. Every finding must carry a file:line anchor and a concrete failure
scenario, and each one is independently attacked by a skeptic agent
(`agents/finding-skeptic.md`, default-refute) — so the reviewer is rewarded for clean
passes on clean work, not for finding *something*. Confirmed findings go into a
`## Rework` section and the task flips back to `todo` in one write: the sync posts the
findings as a Jira comment as it transitions the issue to To Do, then work resumes
until a fresh review passes clean. Like `## Report`, the `## Rework` section is
excluded from the Jira description; its comment rides the todo transition.

### Field sections (custom fields)

Optional config `fieldSections` maps additional body headings to Jira field
ids, e.g. `"fieldSections": { "Instructions": "customfield_10074" }`. A
`## Instructions` section is then stripped from the description and synced to
that field — so the description can stay a short, non-technical summary while
the technical work spec lives in its own field. Sections are only sent when
present, so issue types whose screens lack the field (e.g. Epics) are never
touched; deleting a section leaves the field's last value in Jira (blank the
section's content to clear it deliberately). The mapped field must be a
plain-text field on the work type's screen.

### Role fields (Owner / Reviewer / Tester)

Optional config `roleFields` maps role names to Jira user-picker (array)
fields with per-repo defaults:

```json
"roleFields": {
  "owner":    { "field": "customfield_10075", "default": ["<accountId or name>"] },
  "reviewer": { "field": "customfield_10076", "default": ["Ben"] },
  "tester":   { "field": "customfield_10077", "default": ["masha@example.com"] }
}
```

Every non-container issue gets the fields on create and update; a task's
frontmatter overrides per role (`owner: Ben`, or `owner: [a@x.com, b@x.com]`).
References resolve to accountIds via `/user/search` (cached in
`.sync-state.json`); bare accountIds pass through. Epics never receive the
fields (their screens typically lack them). Pairs well with a Jira automation
that re-assigns the issue from these fields on status transitions — e.g.
assign the Reviewer on In Review, the Tester on Testing.

## Commands / CLI

- `/jira3:init` — scaffold + guided config in the current repo.
- `/jira3:sync` — force a push now and report (hooks make this rarely needed).
- `bin/jira-sync.mjs sync --repo <dir> [--dry-run]` — the push reconcile.
- `bin/jira-sync.mjs pull --repo <dir>` — read-only drift report.
- `bin/git-flow.mjs branch|pr|ci|merged|watch-merge …` — git/GitHub ceremony (below).
- `bin/activity-log.mjs` — hook-driven agent-activity logger (below).
- `/jira3:report` / `bin/activity-report.mjs --repo <dir> [--since <ISO>] [--session <prefix>]`
  — read-only summary of `jira/activity.jsonl`: per-agent start/duration/tokens
  grouped by session, plus span / agent-busy / orchestration-gap totals
  (overlap-aware, so parallel agents don't double-count).

## GitHub flow (`bin/git-flow.mjs`)

The same philosophy applied to git: branches, PR titles/bases/bodies, and CI
verdicts are all **derivable from the task files**, so a deterministic CLI
computes them and no model tokens are spent on ceremony.

- `branch <task-id>` — creates/checks out + pushes the task's branch. Naming:
  `<JIRAKEY>-<task-id>` for tasks, `epic/<JIRAKEY>-<epic-id>` for epics. A task
  with `epic:` branches off its epic's branch (auto-created from the default
  base on first use); the chosen name is stamped back as `branch:` frontmatter.
- `pr <task-id> [--draft]` — opens the PR via `gh`: base = epic branch (or
  default base), title `KEY: summary`, body = the task description + Jira link.
- `ci [<ref>]` — polls the latest workflow run and prints **every job's
  conclusion** (never trust a wrapper exit code); exits non-zero on any red job.
- `merged <task-id>` — exit 0 iff the task's PR is merged (one-shot check).
- `watch-merge <task-id> [--interval-sec 60]` — blocks until the PR reaches a
  terminal state: exit 0 on MERGED (also flipping the task review → testing when
  the statusMap defines `testing`, so Jira hands it to the Tester), 1 on
  CLOSED-without-merge. The session arms
  it as a background command after the review flip, so the human's merge click
  wakes the workflow and the next todo task starts — a webhook with no server.

Because the Jira key is in every branch name and PR title, Jira's Development
panel (via the GitHub-for-Jira app) links branches/PRs/commits to work items
automatically — no status comments, no API calls. Merge policy (enforced by the
skill, executed by humans): squash task PRs into the epic branch, regular-merge
the epic into the default base when the epic's exit criteria are met.

Optional `github` block in `jira/config.json`:
`{ "defaultBase": "main", "epicPrefix": "epic/", "remote": "origin" }`.

## Activity log (`bin/activity-log.mjs`)

PostToolUse (`Agent`/`SendMessage`/`Workflow`) and `SubagentStop` hooks append
one timestamped JSONL line per agent event to `jira/activity.jsonl` in any
repo that has `jira/config.json` — `agent:dispatch` (agent id + type, model,
description, prompt size + head; foreground runs add total_tokens/duration_ms
and a derived started_ts, since the dispatch line itself is stamped at
completion — PostToolUse fires when the tool call returns),
`workflow:dispatch` (run_id + meta name — a workflow's individual agents are
not hook-visible at dispatch, so their stops correlate by session + time
window, or exactly via the run's journal.jsonl), `agent:message`, and
`agent:stop` (pairs with its dispatch by agent_id; typeless harness-internal
helper stops are skipped so every logged stop belongs to a dispatch or a
workflow). Hooks run out-of-band, so tracking costs the working session zero
tokens. The file is committed history: the skill sweeps it into the tracking
commits the session already makes, and `git-flow branch` exempts it from the
clean-tree check so pending lines never block a branch cut.

## Testing

`test/mock-jira.mjs` is an in-memory Jira REST v2 stand-in; `test/run.sh`
drives the full loop against it (create → writeback → content update →
review-gate refusal (empty/placeholder report) → transition + report comment
→ done-gate refusal → approved done → idempotent
re-run → drift report → repo-scoping labels). Run: `bash test/run.sh`.
