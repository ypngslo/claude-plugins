---
description: Put one ad-hoc page in Confluence now — a decision record, explainer, runbook, or any requested content — as a `general` page outside the product-doc voice rules, published on this request and mirrored from its file thereafter.
---

Add to Confluence: **$ARGUMENTS**

This is the one-off path. The handbook suite documents the product for a PM reader
under an audience gate; this command publishes **whatever the user asked for** —
a decision record, an explainer, meeting notes, a runbook, a design note — as a
`general` page. It is still a tracked page file: editing the file updates the
Confluence page; `/handbook:retire` removes it; deleting the file orphans it.

Load the `handbook-docs` skill first (its "General pages" section is the contract
for this kind), then:

1. **Read the argument for the three things it can carry:** the content (or where
   it comes from), a title, and a placement.
   - Content comes from the user's words, from a repo file they named (`--from
     <path>` or "put plans/foo.md in Confluence"), or from something produced
     earlier in this session. A repo file is *converted*, not copied: keep its
     substance, drop its H1 (the frontmatter title is the heading), and bring it
     inside the renderer's markdown subset (`references/markdown.md` — headings,
     lists, tables, callouts, code fences; no raw HTML, no local images).
   - Title: what they called it, or a short plain title you derive. It must be
     unique across the suite and the space.
   - Placement: `--parent <slug>` files it under a suite page; `--parent <id>`
     (digits) or "under the X page" with a Confluence page id files it under any
     existing Confluence page, managed or not; nothing ⇒ the configured root.
     **Do not prompt for a parent** — default to the root and say so in the report.
2. **Derive the slug:** a short kebab stem of the title (`decision-billing-tiers`,
   `runbook-legacy-import`). It is permanent (state key, marker label, link
   target). Check `confluence/pages/` — if taken, pick a sharper one.
3. **Write the page file** `confluence/pages/<slug>.md` from
   `${CLAUDE_PLUGIN_ROOT}/templates/kinds/general.md`: `kind: general`, the title,
   `parent:` **or** `parentId:` (never both), `sources: []` (the kind needs none —
   set them only if the page genuinely documents code and you want staleness
   tracking), `status: draft`, `approved: false`, and the body. Open with one
   short paragraph that says what the page is; then the content under `##`
   headings. Never write `pageId`.
4. **Run the mechanical checks** and fix what they report before going on:
   `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs lint <slug> --repo .` (for this
   kind that is the secret scan + structure: H1, duplicate title, parent,
   links) and `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs render <slug> --repo .`
   (the renderer fails closed — a line it refuses is a line you rewrite, never a
   line you let vanish). A secret finding is never waivable: remove the secret
   or stop and tell the user.
5. **Publish in ONE write.** The user's request *is* the per-page approval for a
   page they asked to put in Confluence — so one Edit/Write sets all three of:
   `status: published`, `approved: true`, and the honest trail in `## Editorial`:
   `Audience-check: not applied — general page, published on the requester's word;
   secret scan + structure lint clean`. One write, because two writes fire two
   hook syncs and the first one publishes a half-finished page. If the user did
   NOT ask for it to go up yet (they said "draft it" / "show me first"), stop
   after step 4 and leave it `draft`.
6. **Sync in the foreground and report the URL.** Run
   `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs sync --repo .` so the page lands
   now rather than on the next hook, then tell the user: the title, where it sits
   (parent, or "at the handbook root"), and the page link
   (`https://<site>/wiki/spaces/<spaceKey>/pages/<pageId>` — `pageId` is written
   back into the file). Relay any refusal verbatim (title already taken → suggest
   `titlePrefix` or a rename; bad parent id; lock held → it retries on the next
   write).

What this command never does: call Confluence directly, publish a page that
failed lint or render, write `pageId`, or turn a product-doc page (`feature`,
`overview`, `capabilities`, …) into a `general` one to dodge the audience gate —
if the user wants product documentation, that is `/handbook:new`.
