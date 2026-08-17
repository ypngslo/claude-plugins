---
name: jira-tasks
description: How to track work in Jira via this repo's local task files (jira/tasks/*.md). Load whenever a project has a jira/config.json and you are starting, finishing, or reporting on tracked work. You NEVER call the Jira API or MCP — you edit local files; a hook syncs them.
---

# jira-tasks — the local-first tracking contract

The `jira/tasks/*.md` files are the source of truth. A detached CLI
(`jira3`'s `bin/jira-sync.mjs`, spawned by hooks on every task-file write and
at session start) mirrors them to Jira: creates issues, pushes content
updates, performs status transitions, and attaches report comments. **Your
entire Jira obligation is to keep the local files truthful.** Never call the
Jira REST API or Atlassian MCP tools yourself; never wait for a sync.

## File format

One file per item: `jira/tasks/<id>.md` (`<id>` is the stable local id — a
short kebab slug). Frontmatter:

| Key        | Values                                     | Who writes it                          |
| ---------- | ------------------------------------------ | -------------------------------------- |
| `summary`  | one line, imperative                       | you, at creation                       |
| `status`   | `todo` → `in_progress` → `review` → `done` | you, at the lifecycle moments below    |
| `type`     | any key of config.json `types` (template: `epic`/`task`/`feature`/`bug`) | you, at creation — the project's config owns the vocabulary; `container: true` types (e.g. epic) hold children, the `default: true` type applies when omitted. Typical split: feature = user-facing capability, task = internal engineering, bug = defect |
| `epic`     | local id of the parent epic                | you, at creation                       |
| `deps`     | `[other-ids]` (informational)              | you, at creation                       |
| `jiraKey`  | leave blank                                | **the sync CLI** (never invent one)    |
| `approved` | `false` until the human's explicit word    | you, ONLY on that word                 |

Body above `## Report` = the Jira description (write for a reader who has
only Jira). The `## Report` section = the outcome summary; it is synced as a
Jira comment when the item enters review.

If config.json has a `fieldSections` map (e.g.
`{ "Instructions": "customfield_10074" }`), each mapped heading is its own
body section synced to that Jira field, stripped from the description. When
configured, honor the split the project chose — e.g. with an `Instructions`
mapping, write the description as a brief NON-TECHNICAL summary a
stakeholder can read, and put the technical work spec (files, changes,
pointers) under `## Instructions`. Acceptance criteria stay wherever the
project's convention puts them; a section is only synced when non-empty, and
epics typically don't carry these sections at all.

## Lifecycle — when to flip status

- **Create** (`todo`): when work is planned. One file per parallelizable item.
- **`in_progress`**: the moment you (or your wave of agents) actually start it.
  When the work gets a branch, that moment is right after `git-flow branch`
  cuts it (see Sequencing under GitHub flow) — flip and commit on the new
  branch, never before it exists.
- **`review`**: when the work is implemented, verified (gates green), AND the
  auto-review gate below has come back clean — fill
  in `## Report` first (what was built, evidence, commit hash), then flip the
  status, so a single write carries both. **"Single write" is literal: ONE
  Edit/Write tool call containing both the report and the status flip.** Two
  edits — even batched in the same message — fire two hook syncs, and the first
  one transitions to review with the placeholder report, which then gets posted
  as the Jira comment (the report comment only rides the transition). In
  practice: one `Write` of the whole file, or one `Edit` whose old_string spans
  from the `status:` line through the report. If you catch yourself changing
  `status:` to `review` on its own — the same one-line gesture as the earlier
  `in_progress` flip — stop. The CLI backstops this: it refuses to transition
  to review while `## Report` is empty or still the template placeholder (it
  warns and waits; the next write of the file retries). So a bare flip no
  longer publishes the placeholder — but Jira also doesn't move until a write
  carrying the real report lands.
- **`done` + `approved: true`**: ONLY on the human's explicit, unambiguous
  word for that item ("T1 is done", "mark the ramp item done"). A bare "ok" /
  "thanks" / silence is NOT approval. The CLI refuses to transition done
  without `approved: true` — but the real rule is yours: done is the human's
  call, in this session or any later one.

## Auto-review gate — before every review flip

No task enters `review` without a clean pass from a fresh critical review. After gates
are green, BEFORE the review write:

1. Dispatch **`jira3:task-reviewer`** with: the task file path, the task branch and its
   base, the acceptance-criteria pointer from the task body, AND the parent phase/epic
   contract pointer those criteria derive from — the reviewer checks the task file
   against its parent, because criteria you wrote yourself can inherit your own
   misreading of the contract. It returns a verdict plus evidence-anchored findings.
2. Discard any finding missing a file:line anchor or a concrete failure scenario
   (malformed — don't verify it). For each remaining finding, dispatch one
   **`jira3:finding-skeptic`** (in parallel) with the finding verbatim plus branch and
   base. Drop findings it REFUTES — silently; they are noise by definition.
3. **Clean pass** (no confirmed findings): proceed with the review write; include a
   one-line trail in `## Report`, e.g. `Auto-review: clean (skeptic-verified)` or
   `Auto-review: 2 findings confirmed and fixed in <commit>, re-review clean`. The
   trail is load-bearing: the sync refuses the review transition without an
   `Auto-review:` line in `## Report` — the gate is mechanical, like the done gate.
4. **Confirmed findings**: ONE write that fills a `## Rework` section with the
   confirmed findings (verbatim: file:line, defect, failure scenario) AND flips
   `status:` back to `todo`. The sync posts the section as a Jira comment as it
   transitions the issue — the rework event is tracked, never hidden. Then resume
   immediately (todo → in_progress per Sequencing, fix, gates green, re-review) unless
   a finding needs a decision only the human can make — then stop and surface it.
5. Re-review after rework is a FULL fresh pass — new reviewer, no memory of the prior
   round — and the loop repeats until clean. The clean review write drops the stale
   `## Rework` section (the Jira comment trail is the durable record).

A reviewer or skeptic that dies or returns garbage means the review did not happen:
retry once, then surface to the human. Never flip to `review` without a completed clean
pass.

## What you never do

- Never call Jira (API, MCP, curl) — the CLI owns all Jira I/O.
- Never edit `jira/.sync-state.json` or wait on `jira/.sync.log` mid-task
  (check the log only if the user asks whether something synced).
- Never set `jiraKey` yourself; never delete a task file to "cancel" an item
  synced already (set its status back and note why in the body instead).
- Never batch status flips you could make at the natural moment — the value
  of the mirror is that it tracks reality.

## Manual controls

- `/jira3:sync` — force a push now and report what happened (reads the log).
- `/jira3:report` (or `node <plugin>/bin/activity-report.mjs --repo .`) —
  per-agent durations, tokens, and orchestration gaps from `jira/activity.jsonl`;
  never hand-derive timings from the raw JSONL.
- `node <plugin>/bin/jira-sync.mjs pull --repo .` — drift report (someone
  edited Jira directly). Local files stay authoritative; reconcile by editing
  them.

## GitHub flow — branches and PRs are derived, never improvised

`bin/git-flow.mjs` computes all git/GitHub ceremony from the task files.
Never hand-name a branch or hand-assemble a PR for tracked work; run the
command and let the derivation hold everywhere:

| Moment | Command (from the repo root) |
| ------ | ---------------------------- |
| Starting a task (after it has a `jiraKey`) | `node <plugin>/bin/git-flow.mjs branch <task-id>` |
| Work committed, ready for review | `node <plugin>/bin/git-flow.mjs pr <task-id>` (add `--draft` while iterating) |
| After any push | `node <plugin>/bin/git-flow.mjs ci` — prints EVERY job's conclusion; never trust a wrapper exit code. Start it in the background (Bash `run_in_background`) and keep working — the merge request and any "CI green" claim block on its observed output, your next brief does not |
| After the review flip, awaiting the human's merge | arm the merge-watch (below) |

The derivation (also enforced by the CLI):

- **Names**: task `salt-module` with key `TRKI-15` → branch `TRKI-15-salt-module`;
  epic `phase-1` with key `TRKI-12` → `epic/TRKI-12-phase-1`. The Jira key in the
  branch name and PR title is what makes Jira's Development panel link branches,
  PRs, and commits to the work item **automatically** — because of that, NEVER
  post progress/status comments to Jira for git events. The panel is the tracking.
- **Bases**: a task with `epic:` branches off (and PRs into) its epic's branch;
  everything else uses the default base (`main`). The epic branch is auto-created
  from `main` the first time one of its tasks branches.
- **Sequencing**: `jira-sync` first (the branch needs the `jiraKey`), then
  `branch`, then the `in_progress` status flip committed as the first commit on
  the new branch, then work commits, then `pr`. `branch` requires a clean tree,
  and the CLI stamps `branch:` into the task file the same way sync stamps
  `jiraKey` (never write either by hand) — so flipping the status before
  branching forces a stash that collides with that stamp.
- **Merges are the human's click.** Task PRs are squash-merged into the epic
  branch (one commit per task, linear epic history); the epic → `main` PR is a
  regular merge when the phase/epic exit criteria are met. You may *request*
  review, but you never merge a PR and never delete branches unless the user
  explicitly says so — same spirit as the `done`/`approved` gate.
- **UI-facing tasks: screenshots on the PR.** Before the review flip, capture the
  changed surface (the gate re-run already drives a browser) and put the image(s)
  in the PR body. The human's merge click is the only taste check the process
  has — agents can verify tokens and behavior, not whether it looks right.
- **Commits** on a task branch follow the repo's own conventions; the Jira key
  lives in the branch and PR title, so squash-merged commits inherit it — do not
  prefix every commit message with the key.
- One epic branch active at a time unless epics genuinely run in parallel on
  disjoint files. If work is too small for an epic, don't invent one — a task
  branching off `main` is the correct shape for it.

## Merge-watch — the human steers by merging

After a task's review flip (PR open, CI green, task in `review`), arm a background
watch so the session continues the moment the human merges:

```bash
# Bash tool with run_in_background: true — one notification at the terminal state
node <plugin>/bin/git-flow.mjs watch-merge <task-id>
```

When it fires **MERGED**: pull the epic branch and start the next `todo` task in the
epic — full lifecycle (branch → in_progress flip → TDD → gates → auto-review → PR →
its own merge-watch). No Jira comment for the merge (the Development panel tracks it).
When it fires **CLOSED** (closed without merge): stop and surface to the human.

**A merge is NOT the done word.** The merged task stays in `review`; `done` +
`approved: true` still requires the human's explicit per-item word.

## Activity log — jira/activity.jsonl

Plugin hooks append one timestamped JSONL line per agent event (agent + workflow
dispatches, stops, messages; stops pair with dispatches by agent_id, and typeless
harness-internal helper stops are skipped) to `jira/activity.jsonl` in any repo with
`jira/config.json` — zero session tokens; this is how workflow performance gets
measured. Your only obligations:

- It's committed history: `git add jira/activity.jsonl` as part of whatever tracking
  commit you're already making (the in_progress flip, the report flip) — never a
  dedicated commit, never delete or rewrite it.
- `git-flow branch` ignores it when checking for a dirty tree, so pending lines never
  block a branch cut; they just ride along to the next commit.

Config (optional `github` block in `jira/config.json`):
`{ "defaultBase": "main", "epicPrefix": "epic/", "remote": "origin" }` — defaults
shown; omit the block entirely when they fit.
