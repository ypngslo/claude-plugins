---
description: One health table for this repo's handbook docs — fresh/stale, gaps, gate-blocked, drifted in Confluence, orphaned, and not yet published.
---

Report the health of this repo's docs. Read-only: run the three report commands
from the repo root, then summarize. Do not edit any page file in this command.

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs stale --repo .
node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs lint  --repo .
node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs pull  --repo .
```

`pull` needs credentials and hits the network; if it exits 3 or errors, say so and
report the rest anyway. `stale` and `lint` are local.

Merge the three into ONE table, one row per page:

| Page | Status | Freshness | Gate | Confluence |
| ---- | ------ | --------- | ---- | ---------- |

- **Status** — `draft` / `published` / `retired` from frontmatter.
- **Freshness** — `fresh`, or `stale (N commits)` from the `stale` report;
  `missing-source` where a `sources:` pathspec matches nothing;
  `unanchored` where the kind needs sources and the page has none.
- **Gate** — `ok`, or the first blocking lint error with its line, or the missing
  gate condition (no `## Editorial`, placeholder Editorial, no `Audience-check:`
  line). A page that cannot publish must be visible as such here.
- **Confluence** — `not published` (no `pageId`), `in sync`, or the drift `pull`
  reported (`edited in Confluence (v9, we wrote v7)`, `renamed`, `moved`).

Below the table, list separately:

- **GAP** — tracked code under `staleness.watch` that no page claims, aggregated
  as the `stale` report gives it.
- **Orphans** — page files deleted while their Confluence page is still live
  (the sync warns about these every pass; they are in the log and in
  `.sync-state.json`'s `orphans`).

Close with the one or two actions that would move the needle most —
`/handbook:refresh` for stale pages, `/handbook:new` for gaps,
`/handbook:retire` for missing-source pages, and which pages are waiting on the
user's word to publish for the first time.
