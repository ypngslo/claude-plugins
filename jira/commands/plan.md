---
description: Understand an epic request, examine the code, ask clarifying questions, and write a local plan. Read-only toward Jira.
argument-hint: <free-form description of the epic>
---

# /jira:plan — design an epic locally

You are starting the **plan** stage for a new epic described as:

> $ARGUMENTS

Read `jira/REFERENCE.md` first — it holds the project constants, file layout, manifest
schemas, and the anti-degradation rules. Follow those rules throughout. This stage is
**read-only toward Jira** and writes **no code**. It produces local planning files only.

## Steps

1. **Load context.** Read `jira/REFERENCE.md` and `jira/manifest.md`. Determine the next
   epic sequence number from the global manifest (highest `NNN` + 1, zero-padded to 3).
   Derive a short kebab `slug` from the description. The epic `local_id` is `NNN-slug`.

2. **Research the codebase (read-only fan-out).** Create the epic folder
   `jira/epics/NNN-slug/`. Spawn the **jira-researcher** sub-agent with the epic
   description as the question and `jira/epics/NNN-slug/research.md` as its output path.
   For a large or multi-area epic, spawn a few researchers in parallel, each scoped to one
   area, each writing to its own file (`research-<area>.md`). When they return, **read the
   research file(s) yourself** — the detail must enter the main thread via disk, not be
   trusted from the sub-agent's summary.

3. **Ask clarifying questions.** Based on the request and the research, identify the
   genuine unknowns — scope boundaries, priorities, constraints, what's explicitly out of
   scope. Ask the user (use the question tool for discrete choices; plain prose for
   open ones). Do **not** guess past real ambiguity. Iterate until the intent is clear.

4. **Write `jira/epics/NNN-slug/plan.md`.** Copy `jira/templates/plan.md` to that path and
   fill it in (replace `{{LOCAL_ID}}`, `{{TITLE}}`, `{{DATE}}` and each section). Capture,
   in the user's intent and grounded in the research:
   - **Goal** — what success looks like, in one or two sentences.
   - **Background / context** — why, and the relevant existing code (cite `path:line`).
   - **Scope** — explicit in / out lists.
   - **Proposed breakdown** — a *rough* list of the work items you expect (Feature/Story/
     Task/Bug), each a line or two. This is a sketch for `/jira:pm` to formalize, not the
     final issues.
   - **Dependencies & ordering** — what must come before what.
   - **Open questions / decisions made** — record what was asked and answered, so nothing
     is re-litigated or lost later.
   - **Risks / deferred items** — anything touching the project's deferred list or locked
     constants (see the repo's CLAUDE.md and MVP docs).

5. **Create the epic manifest.** Copy `jira/templates/epic-manifest.md` to
   `jira/epics/NNN-slug/manifest.md` and fill the frontmatter (`local_id`, `title`,
   `state: planned`, `jira_key: null`, today's date). Add the rough issue list as `issues:`
   entries, each with `state: planned` and `jira_key: null` (no content files yet). Then
   regenerate its tracking tables (epic row + work-items table) from the frontmatter.

6. **Register in the global manifest.** Add the epic to `jira/manifest.md`'s `epics:`
   frontmatter with `state: planned`, then regenerate its tracking table from the
   frontmatter (every stage up to `state` = `[x]`) per REFERENCE.md.

7. **Report.** Tell the user the `local_id`, where the files are, the proposed breakdown
   at a glance, and that the next step is `/jira:pm NNN-slug`. Do **not** proceed to
   `/jira:pm` automatically — stop here.

## Guardrails
- No Jira writes. No code changes. Exploration and planning only.
- Use today's date (run `date +%Y-%m-%d`) for the `created`/`updated` fields.
- If the description matches an epic already in the global manifest, stop and ask whether
  to revise that one instead of creating a duplicate.
