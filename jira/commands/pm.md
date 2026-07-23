---
description: Turn an epic's plan into concrete issues — locally first, then upload the epic and its children to Jira.
argument-hint: <epic local_id/name, e.g. 001-event-rsvp or 001 or event-rsvp>
---

# /jira:pm — formalize and upload an epic

Epic to process: **$ARGUMENTS**

Read `jira/REFERENCE.md` first and follow its anti-degradation rules. This stage **writes
to Jira** (creates the epic, its children, links, and sets initial status). It runs in two
phases with a **review checkpoint** between them: build everything locally, get approval,
then upload.

## Phase A — formalize locally (no Jira writes yet)

1. **Resolve the epic & load.** Read `jira/REFERENCE.md` and `jira/manifest.md`. Resolve
   **$ARGUMENTS** to one epic by matching the global manifest on any of: full `local_id`
   (`001-event-rsvp`), the numeric prefix (`001`), or the slug (`event-rsvp`). If it
   matches none or more than one, stop and ask. Then read that epic's `plan.md` +
   `manifest.md` + any `research*.md`. If the epic isn't in `state: planned`/`created`,
   say so and stop (it may already be uploaded).

2. **Decompose — in the main thread.** This is the high-judgment step; do it yourself, do
   not fan it out. Turn the plan's rough breakdown into concrete work items:
   - Choose the right type for each (Feature / Story / Task / Bug; Subtask only to split a
     single L0 item). Assign `local_id`s (`F1`,`S1`,`T1`,`B1`, subtasks `F1.1`).
   - Set `depends_on` (the `Blocks` graph) and an `order`.
   - For each item, **write a content file** by copying `jira/templates/issue.md` to
     `issues/<local_id>-slug.md` and filling it in (frontmatter + Context, Scope (in/out),
     Acceptance criteria, Implementation notes). Make it complete and self-contained — this
     body becomes the Jira description verbatim, so it must not need later guesswork.

3. **Update the epic manifest** `issues:` to match (every item with `type`, `summary`,
   `state: created`, `jira_key: null`, `parent`, `depends_on`, `order`, `file`). Set the
   epic `state: created`. Regenerate the tracking tables from the frontmatter (each issue
   now shows `Planned` and `Created` checked).

4. **Checkpoint — present for review.** Show the user the full breakdown: the epic, each
   issue (id, type, summary, deps, order), and the dependency ordering. Ask for approval
   or edits. **Iterate locally until approved. Do not upload before approval.**

## Phase B — upload to Jira (idempotent)

Only after approval. Before each create, check the manifest for an existing `jira_key` and
**skip if present** (re-runs must not duplicate). Persist every returned key to the
manifest *immediately* after each call.

5. **Create the Epic.** `createJiraIssue` with `issueTypeName: "Epic"`, the plan's title as
   `summary`, and a description summarizing the epic. Write the returned key to the epic
   manifest `jira_key` and the global manifest. (New issues land in `Idea`.)

6. **Create children**, in `order`. For each: `createJiraIssue` with the item's
   `issueTypeName`, `summary`, `description` = the content file body (markdown, verbatim),
   and `additional_fields: { "parent": { "key": "<EPIC-KEY>" } }`. Read the issue back to
   **verify the parent stuck**; if not, fix with `editJiraIssue`. Write each `jira_key`
   back to the manifest immediately and set that issue `state: uploaded`.

7. **Create subtasks** (if any) the same way, with `parent` = the owning child's key.

8. **Create dependency links.** For each `depends_on`, `createIssueLink({ type: "Blocks",
   inwardIssue: <blocker key>, outwardIssue: <blocked key> })`.

9. **Finalize.** Set the epic `state: uploaded` in both manifests, set every issue to at
   least `uploaded`, stamp `updated`, regenerate the tracking tables in both manifests.

10. **Report.** List the created epic and issues with their `IT-NN` keys and the
    `local_id ↔ jira_key` map. Tell the user the next step is `/jira:work $ARGUMENTS`.
    Stop — do not start working items.

## Guardrails
- Idempotent: never create an issue that already has a `jira_key`.
- Persist-before-proceed: write each key to disk before the next API call, so an
  interrupted upload can be safely resumed by re-running.
- Upload descriptions verbatim from the content files — do not paraphrase.
- Leave all issues in `Idea` here; moving to `To Do`/`In Progress` is `/jira:work`'s job.
