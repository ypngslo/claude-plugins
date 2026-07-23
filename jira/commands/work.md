---
description: Do the work for an epic, one item at a time — reconcile status, implement the next ready item, transition it as far as Testing, then stop for review. Done is the user's call, made in Jira after they've tested.
argument-hint: <epic local_id/name, e.g. 001-event-rsvp or 001 or event-rsvp>
---

# /jira:work — execute an epic, stepwise

Epic to work: **$ARGUMENTS**

Read `jira/REFERENCE.md` first and follow its anti-degradation rules. This stage **writes
code and writes to Jira** (transitions, comments). It does **one work item per run**, then
stops for your review — maximum visibility, minimum drift.

**Git: branches are yours; commits are not.** Every work item gets its own local branch,
and you manage the whole branch lifecycle — create, switch, merge into `main` on Done,
delete — without being asked. But you **never `git commit` or `git push` on your own
initiative**: only when the user explicitly says so. No PRs, no GitHub ceremony — merges
happen locally. The user's interface is words — "done", "commit", "push"; everything
else (branches, transitions, manifests) is yours.

**Testing = the AI's work is finished and the item is ready for human review.** A work
run's ceiling is `Testing` — never move an item to `Done` on your own judgment. The user
reviews the delivered work and **says** when it's actually done ("T1 is done", "looks
good", etc. — in this session or any later one). On that word, *you* transition the
issue to `Done` in Jira, set `state: done`, and merge the item's branch per the git
rules. **`Testing` never blocks progress**: an item in `Testing` counts as a satisfied
dependency, and the next run moves straight on to the next item — the user's Done
verdict is bookkeeping that can arrive any time, not a gate. (The epic: once every child
is Done, closing the epic is bookkeeping, and step 3 does it.)

## Steps

1. **Resolve the epic & load local state.** Read `jira/REFERENCE.md` and `jira/manifest.md`,
   and resolve **$ARGUMENTS** to one epic by matching the global manifest on full `local_id`
   (`001-event-rsvp`), numeric prefix (`001`), or slug (`event-rsvp`); if it matches none or
   several, stop and ask. Then read that epic's `manifest.md`, `plan.md`, and the content
   files for any not-yet-done issues. The content files are the spec — read them, don't rely
   on memory of them.

2. **Reconcile with live Jira (read).** Query current status of the epic and its children
   (`searchJiraIssuesUsingJql`, JQL in REFERENCE.md). For each issue, update the manifest
   `state` to match the real Jira status (`Idea`→uploaded, `To Do`→todo,
   `In Progress`→in_progress, `Testing`→testing, `Done`→done). If local and remote
   disagree, **Jira wins** for status; report any surprises. Save the reconciled manifest.

   **Reconcile git too.** If an item is newly `done` and its branch is still unmerged:
   merge it into `main` locally and delete the branch — but only if its work is
   committed. If the branch holds uncommitted changes, note that it's awaiting the
   user's "commit" and carry on; do not commit it yourself. A predecessor sitting
   unmerged in `testing` is normal — the next item stacks on top of its branch (step 4).

3. **Report current status.** Show the epic's progress: each issue, its status, and which
   are blocked. Then name the **next item**: the lowest-`order` issue that is not `done`
   or `testing` and whose every `depends_on` is `done` **or `testing`** — testing
   dependencies are satisfied dependencies. If none are ready, say so and stop. In the
   report:
   - Items sitting in `testing` are awaiting the user's review — list them as a
     reminder, but they neither block the next item nor require a verdict before work
     continues. If the user does declare one done, *you* transition it to `Done` in
     Jira, set `state: done`, and merge its branch per step 2's git rules.
   - All items `done`: transition the epic to `Done`, set both manifests' epic
     `state: completed`, and stop.

4. **Start the item.** First, branch: create the item's branch named
   `<jira_key>_<item local_id>-<slug>` — e.g. `IT-20_t1-fetch-listing`, matching the
   existing `IT-12_context-refactor` convention — or switch back to it if it already
   exists from an interrupted run. Branch from `main` when every dependency is merged;
   if a dependency is still in `testing` (unmerged), branch from that predecessor's
   branch instead so its work is included — branches stack in dependency order and merge
   to `main` in that same order as Done verdicts arrive. If the working tree holds
   changes unrelated to this epic, stop and report rather than branching over them.
   Never work directly on `main`.

   Then ensure the epic is `In Progress` (transition it if still
   `Idea`/`To Do`; look up the transition id live). Transition the chosen item to
   `In Progress` and set its manifest `state: in_progress`. Add a brief Jira comment noting
   work is starting.

5. **Do the work — in the main thread.** Implement exactly what the content file's Scope
   and Acceptance criteria specify, following the repo's CLAUDE.md conduct and the existing
   code's conventions. You may use the **jira-researcher** sub-agent for read-only context
   gathering, but write the code yourself, in view. Honor the project's deferred list and
   locked constants — if the item appears to require something deferred, stop and ask
   rather than building it.

6. **Verify, then move to Testing.** Run the relevant verify gate (tests, the app — see the
   MVP build docs / CLAUDE.md). Transition the item to `Testing` and set `state: testing`.
   - If verification fails and you can't fix it cleanly, leave the item in `In Progress`,
     record what's wrong in the manifest/issue notes, and stop with a clear report.

7. **Hand off in Testing — do not transition to Done.** With the item in `Testing`, add a
   Jira comment summarizing what was done (what changed, where, how verified) and what the
   user should look at when testing. Stamp `updated` and regenerate the tracking tables
   (this item's `Testing` box now checks; `Done` stays unchecked). `Testing` is terminal
   for this *run* — the user reviews and says when the item is done; that word (now or in
   a later session) is what triggers the `Done` transition, performed by you.

8. **Stop for review.** Report: the item delivered to `Testing`, what was implemented and
   how it was verified, how the user can try it out, and the **next** ready item (or that
   it's blocked pending this item's Done). The work sits **uncommitted on the item's
   branch** — remind the user to say "commit" (and "push" if they want it pushed) when
   satisfied, and to say the item is **done** once reviewed; you handle the Done
   transition and the merge from there. **Do not start the next item** — wait for the
   user to run `/jira:work $ARGUMENTS` again.

## Guardrails
- One item per run. Stepwise by design (the chosen work mode) — don't batch.
- All code changes happen on the item's branch, never on `main`. The branch lifecycle
  (create → work → merge on Done → delete) is automatic and yours.
- **Never commit or push without the user's explicit instruction.** No exceptions, no
  "helpful" WIP commits. No PRs — merging is local, on Done, after the work is committed.
- Reconcile before acting; never transition based on stale local state.
- Transition ids are looked up live per issue, never hardcoded.
- Persist manifest changes immediately after each Jira write.
- Never transition a work item to `Done` unprompted — only on the user's explicit
  verdict, given in conversation; you then perform the transition (the user may also flip
  it in Jira directly — reconciliation honors that too). An item only reaches `Testing`
  after its acceptance criteria are met and verification actually ran; if you couldn't
  verify, say so and leave it in `In Progress`.
