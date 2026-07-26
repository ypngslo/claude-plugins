---
description: The main handbook loop — find stale pages from git, read what actually changed, update the affected pages, run the audience gate, and publish.
---

Bring this repo's docs back in line with the code. Load the `handbook-docs` skill
first; its gate sequence and single-write rule govern every write below.

1. **Get the report:** `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs stale --repo .`
   It prints STALE, MISSING-SOURCE, UNANCHORED, GAP, and DIRTY sections. Work the
   list; do not go hunting for changes it did not report.
2. **For each STALE page, read the commits it names** — run the exact
   `git log --stat` command the report prints for that page, then read the diffs
   that matter. Judge what changed *for the user*:
   - **Cosmetic** (refactor, rename, tests, internal restructuring, no behavior
     change a user could notice): leave the body alone and record one line in the
     page's `## Editorial` section saying which commits you reviewed and why they
     changed nothing. That is a real outcome, not a cop-out.
   - **Behavioral** (new capability, changed flow, changed limit, removed
     ability): rewrite the affected sections against the code as it is now. Read
     the code, not just the diff — the diff shows the delta, the page must
     describe the current whole.
3. **Never edit a page you did not verify against the code.** Every sentence you
   leave standing is a claim you are re-asserting.
4. **MISSING-SOURCE** (a `sources:` pathspec matching nothing at HEAD): the code
   this page documents is gone or moved. Either repoint `sources:` at where it
   moved, or propose retiring the page to the user (`/handbook:retire <slug>`).
   Never silently delete the page file — the live Confluence page would be
   orphaned.
5. **GAP** (tracked code under `staleness.watch` claimed by no page): propose
   `/handbook:new` for the capability it represents, or propose adding it to an
   existing page's `sources:`. Say what you propose and why; never silently
   expand a page's `sources:` to make the report quiet.
6. **DIRTY** is informational — uncommitted source changes. Mention it; it never
   blocks anything.
7. **Capture observations, never hunt them.** If the reading this loop already
   required put something in front of you that looks wrong (broken-seeming
   behavior, an inconsistency, an apparently dead feature), note it in one line
   and move on — per the skill's observations rule, **zero extra tool calls, no
   detours**. At the end of the pass, write the collected lines into
   `observations.md` (kind `observations`), dated, as things to investigate —
   not confirmed findings. If nothing was noticed, touch nothing.
8. **Run the gate on every page you touched**, exactly as the skill specifies:
   lint clean → `handbook:audience-reviewer` → one `handbook:claim-checker` per
   load-bearing claim in parallel → then ONE write that carries both the
   `## Editorial` trail and the final `status:` — and, on a clean pass, the
   `## Claims` section rebuilt from the checkers' evidence (path, line, HEAD short
   sha, mechanism) in that same single write. Two writes fire two hook syncs
   and publish a half-finished page.
9. A page that is already `published` republishes on its content update — no
   approval needed. A page publishing for the FIRST time needs the human's
   explicit word (`approved: true`); ask for it per page, and leave the page a
   draft until you get it.
10. Report to the user: pages refreshed, pages judged cosmetic-only, gate
    findings that sent a page back to draft, observations captured, and anything
    you proposed (retire / new) that needs their decision.
