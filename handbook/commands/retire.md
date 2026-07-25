---
description: Retire a handbook page — explain the retire modes, get the human's explicit word, then flip status and approved in one write.
---

Retire the page: **$ARGUMENTS**

Retiring is destructive in Confluence and is the human's decision, never yours.

1. Resolve the slug to `confluence/pages/<slug>.md` and read it. If the argument is
   empty or ambiguous, ask which page. Report to the user what will happen: the
   page's current title, whether it is live in Confluence (`pageId` present), and
   which pages link to it or name it as `parent:` — a retired page that is still a
   parent or still linked from an index page is a lint error, so those pages need
   fixing in the same round.
2. State this repo's `sync.retireMode` from `confluence/config.json` and what it
   does, so the user is choosing knowingly:
   - `banner` (default) — one last content update that prepends a warning panel,
     *"This page is no longer maintained and may be out of date."* The page stays
     live and readable. Reversible.
   - `archive` — moves the page to the space's archive. Recoverable in Confluence.
   - `trash` — moves the page to the trash. Recoverable by a space admin until it
     is purged.
   - `leave` — changes nothing in Confluence; the page just drops out of the local
     suite and out of generated index tables.
   If the user wants a different behavior than the configured mode, change
   `sync.retireMode` in config first and say that it applies to every retire.
3. **Get the user's explicit word for this page.** "Retire the coupons page" is
   approval; "ok", "thanks", or silence is not. If they have not said it, stop
   here and ask.
4. On their word, make **ONE write** to the page file setting both
   `status: retired` and `approved: true`. One write, because two writes fire two
   hook syncs and the first one publishes a half-changed state. The CLI refuses to
   retire without `approved: true`.
5. Never delete the page file. Deleting it makes the live Confluence page an
   orphan that the sync warns about on every pass forever and never cleans up.
6. Report what the sync did (`confluence/.sync.log`, or run `/handbook:publish` to
   watch it in the foreground), and list any index or cross-link fixes still owed.
