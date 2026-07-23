# jira3 auto-review gate — design

Date: 2026-07-15. Status: approved direction, pending spec review.

## Purpose

Every tracked task gets a fresh, critical, adversarially-verified review before it may
enter `review`. Confirmed findings are posted to the Jira work item as a comment and the
item is kicked back to To Do — a visible, tracked rework event — rather than silently
fixed. The reviewer must be thorough and critical **without inventing findings to
perform**; that calibration is the core of this design.

## Components

### 1. `agents/task-reviewer.md` — the critical reviewer

Plugin agent definition. Model: `opus`, maximum thinking/effort (exact frontmatter key
verified against current Claude Code agent docs at implementation time). Tools: Read,
Grep, Glob, Bash (read-only git usage).

Inputs (given in the dispatch prompt by the orchestrating session):

- task branch and base branch (from the task file's `branch:` and derived epic base)
- path to the task file
- the acceptance-criteria pointer from the task body (e.g. a phase-doc section)

Scope contract (in the agent's system prompt):

- Judge exactly two things: (a) defects in the changed code (`git diff base...branch`),
  (b) gaps between the diff and the recorded acceptance criteria.
- Pre-existing code, style preferences, and hypothetical future requirements are out of
  scope by contract.

Calibration contract (the anti-confabulation core):

- Every finding must carry a **concrete failure scenario** — specific inputs/state →
  specific wrong behavior — anchored to `file:line`. "Could be fragile" is not a finding.
- **Zero findings is a first-class, creditable verdict.** The prompt states: a clean pass
  on genuinely clean work is the most valuable report the reviewer can produce; an
  invented finding is the only failing outcome. No quota; nothing implies findings are
  expected.
- Findings are typed (`correctness` / `criteria-gap` / `test-gap`) and severity-ranked.
- The reviewer must also narrate **what it checked and found sound** (coverage list), so
  thoroughness is demonstrated by coverage, not by finding count — the performative
  pressure gets a harmless outlet.

Output: structured findings list (type, severity, file:line, defect statement, failure
scenario) plus the coverage narration.

### 2. `agents/finding-skeptic.md` — the refuter

Plugin agent definition. Model: `fable`, low effort. Tools: Read, Grep, Glob, Bash
(read-only).

One skeptic per finding, dispatched in parallel. Its only job is to **refute** the
finding: reproduce the failure scenario from the actual code, or show why it cannot
happen. Default verdict is `REFUTED` — a finding survives only if the skeptic, trying to
kill it, confirms the failure scenario holds. Output: `CONFIRMED` or `REFUTED` with
independent reasoning.

### 3. Skill changes — `skills/jira-tasks/SKILL.md`

New mandatory lifecycle step, inserted between "gates green" and the review flip:

1. Dispatch `jira3:task-reviewer` on the branch (inputs above).
2. For each finding, dispatch one `jira3:finding-skeptic`; drop refuted findings
   silently (they are noise by definition).
3. **Clean pass (no confirmed findings):** proceed with the normal single-write review
   flip; the `## Report` carries a one-line trail, e.g.
   `Auto-review (opus + skeptic pass): clean`.
4. **Confirmed findings:** ONE write that (a) fills a `## Rework` section in the task
   file with the confirmed findings (verbatim failure scenarios, file:line), and
   (b) flips `status:` back to `todo`. The sync hook posts the findings as a Jira
   comment and transitions the issue to To Do — the rework event is tracked, not
   hidden. The session then resumes work immediately (todo → in_progress per the normal
   sequencing, fix the findings, gates green, re-review) unless a finding requires a
   decision only the human can make — then stop and surface it.
5. Re-review after rework is a full fresh pass (new reviewer instance, no memory of the
   prior round). The loop repeats until a clean pass.

The single-write rule applies to the rework write exactly as it does to the review
write, for the same reason: the comment rides the transition.

### 4. CLI change — `bin/jira-sync.mjs`

Mirror the existing `## Report` mechanism:

- `splitBody` additionally extracts an optional `## Rework` section; like `## Report`,
  it is excluded from the Jira description.
- On a transition to `todo`, if the rework section is non-empty, post it as a comment
  (same pattern as the report comment on the `review` transition;
  `entry.status === null` initial-creation path posts nothing, unchanged).
- Everything else (hashing, create/update, done gate) unchanged.

`## Rework` content persists in the task file during the redo as guidance; the next
rework cycle overwrites it, and the eventual clean review flip removes the section
(the findings were addressed; the Jira comment trail is the durable record). Plugin version bump; CLI change covered by the existing
`test/run.sh` + `mock-jira.mjs` harness.

## Data flow (findings path)

task branch (gates green)
→ task-reviewer (opus, max) reads diff + criteria → findings + coverage
→ N × finding-skeptic (fable, low) → CONFIRMED subset
→ single write: `## Rework` + `status: todo` → hook → Jira comment + To Do transition
→ session resumes: in_progress → fixes → gates → fresh review → … → clean
→ single write: `## Report` (with auto-review trail) + `status: review` → Jira comment

## Error handling

- Reviewer or skeptic agent dies / returns garbage: treat as "review did not happen" —
  block the review flip and retry once; if it fails again, surface to the human. Never
  proceed to `review` without a completed clean pass.
- Reviewer reports a finding without a failure scenario or file anchor: the orchestrator
  rejects it (does not dispatch a skeptic for it) — malformed findings don't get to
  clog the loop.
- Sync/transition failures are already handled by the CLI (logged warnings, retried on
  next write); unchanged.

## Testing

1. **CLI (deterministic):** extend the existing mock-Jira harness — `## Rework` +
   todo-flip posts a comment and transitions; empty/no section posts nothing; review
   path unchanged.
2. **Reviewer calibration (prompt tests, writing-skills discipline):** planted-scenario
   micro-tests, 5 reps per arm, manually read:
   - a diff with a real seeded bug → the bug is found and survives the skeptic;
   - a genuinely clean diff → zero findings ("reports nothing on clean input" is the
     exact behavior at risk, so it gets the most reps);
   - a plausible-but-false finding handed to the skeptic → refuted.
3. **End-to-end:** one real task run through the gate in a sandbox repo (tracki or a
   fixture), observing the Jira comment + To Do bounce and the eventual clean flip.

## Out of scope

- Reviewing epic → main PRs (the gate is per-task).
- Any Jira I/O from agents (the CLI owns it, unchanged).
- Auto-merge or any change to the human-gated done/merge rules.
