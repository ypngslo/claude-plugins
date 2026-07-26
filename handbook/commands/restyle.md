---
description: One-time editorial pass over the whole suite — restructure every page to the current section shapes (point-form steps, bulleted limits) and republish through the gate, which adds claim citations as it verifies.
---

Bring every existing page up to the current structure standard. This is a
restructuring pass, not a rewrite: the facts on each page stay exactly what they
are; only their shape changes. Load the `handbook-docs` skill first and read
`references/voice.md` — its skeleton defines the shapes you are converging on.

1. **List the work.** Run `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs lint --repo .`
   and note every wall-of-text warning and every page with no `## Claims`
   section. Work the whole suite — published and draft alike — not just the
   pages the staleness report would surface.
2. **Restructure, page by page:**
   - **How it behaves** → a numbered list: the main flow one line per step,
     unhappy paths as sub-bullets under the step where they occur, a table when
     the behavior is conditional.
   - **Limits & known gaps** → a bulleted list, one limit per line, the crisp
     fact first. At most one `> [!WARNING]` callout for the limit most likely to
     surprise someone.
   - Long paragraphs elsewhere: break them into points wherever a list says the
     same thing. Do not add new claims and do not drop existing ones — if a
     sentence looks wrong while you restructure it, that is an observation
     (capture per the skill's rule, zero extra tool calls, never a detour).
3. **Gate each page you touched**, exactly as the skill specifies. The gate is
   what adds the citations: mark the load-bearing claims `[^N]`, and the clean
   pass writes the `## Claims` section from the checkers' evidence in the same
   single write as the `## Editorial` trail and the status. One tool call per
   page, always.
4. Already-`published` pages republish autonomously — a content update needs no
   new approval. Drafts stay drafts; do not publish one without the human's
   explicit word.
5. Work one page at a time, gate and write it, then move to the next — each
   hook-spawned sync then carries only a page or two, so no pass ever
   approaches the update circuit breaker.
6. When the suite is done, run a foreground
   `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs sync --repo .` and report:
   pages restructured, claims cited per page, gate findings that sent a page
   back to draft, and observations captured. Warn the user once up front that
   every page will republish, so watchers get one notification wave — expected,
   and one-time.
