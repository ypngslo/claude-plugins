---
name: jira-conventions
description: Conventions for working with the IT Jira project in this repo — the issue hierarchy, status workflow, the local jira/ manifests and templates, and the rules that keep tracking accurate and undegraded. Load this whenever a task touches the IT Jira project, epics, issues, statuses, or the jira/ tracking files — including ad-hoc work outside the /jira:plan, /jira:pm, and /jira:work commands, and especially when the user declares work done or asks to transition an epic/issue (e.g. "T1 is done", "transition IT-20").
---

# Jira conventions (IT project)

Whenever a task in this repo touches the **IT** Jira project — creating or updating issues,
checking epic/issue status, transitioning work, or editing the `jira/` tracking files —
defer to the single source of truth:

**Read `jira/REFERENCE.md` and apply it.** It holds the connection constants (cloud id,
project, account), the issue-type hierarchy, the status workflow with ids, link directions,
the MCP call recipes, the local file layout, the manifest/template schemas, and the
anti-degradation rules. Don't re-derive any of that from scratch.

## Non-negotiables (summary — REFERENCE.md is authoritative)

- **Files are the source of truth, not memory.** Re-read the plan, manifests, and issue
  content files from disk; never trust a remembered summary across steps.
- **Read-only by default.** Jira *writes* (create / transition / link / comment) are the
  job of `/jira:pm` and `/jira:work`. For an ad-hoc request, prefer reading; only write
  when the user clearly asks — and still persist the result into the manifest.
- **Don't hardcode transition ids.** Look them up live with `getTransitionsForJiraIssue`
  and match by the target status *name*.
- **Set parent via** `additional_fields: { "parent": { "key": "IT-NN" } }`, then read the
  issue back to verify it stuck.
- **Persist before proceeding.** Write each returned key/status into the manifest before
  the next call; never create an issue that already has a `jira_key` (idempotent).
- **Manifests track every stage.** After any frontmatter change, regenerate the checkbox
  tracking tables from it — every stage up to the row's current `state` is `[x]`.
- **Use the skeletons in `jira/templates/`** (`plan.md`, `epic-manifest.md`, `issue.md`)
  rather than improvising file structure.

## User-declared verdicts ("done" / "transition")

The user reviews delivered work and gives verdicts in conversation — in **any** chat, not
just inside `/jira:work`. In this project, `Testing` means the AI's work is finished and
the item awaits human review; only the user decides `Done`. Claude performs the
transition, but only on an explicit instruction, and only after confirming the target:

- **Explicit means the words.** "T1 is done — transition it", "transition IT-20 to
  Done", "the epic is done, transition it" are action requests. A bare "looks good" or
  "nice" is **not** — ask whether they want the transition before touching Jira.
- **Confirm the exact target before writing.** Resolve whatever the user named (local
  id, `IT-NN` key, summary, "the epic") against the manifests, then state it back —
  e.g. "Transitioning **IT-20** (T1 — live picnob listing fetch) → Done?" — and wait for
  the yes. If the reference is ambiguous (several matches, epic vs. child), ask; never
  guess.
- **Then do the full bookkeeping**, not just the Jira write: look up the transition id
  live, transition the issue, set the manifest `state`, regenerate the tracking tables —
  and for a work item, merge its branch into `main` and delete it per the `/jira:work`
  git rules. The merge requires the work to be committed; if it isn't, say it needs the
  user's "commit" first — never commit or push on your own initiative.
- **An epic closes only when every child is `done`** — then transitioning the epic and
  marking both manifests `completed` is routine bookkeeping.

## The workflow

For the full lifecycle, use the commands in order: `/jira:plan <description>` →
`/jira:pm <epic-id>` → `/jira:work <epic-id>`. This skill is for following the same rules
during ad-hoc Jira work that the commands don't cover.
