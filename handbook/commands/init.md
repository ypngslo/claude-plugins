---
description: Set up handbook product docs in the current repo (scaffolds confluence/config.json + pages dir, then walks the user through the config values and verifies one round trip to Confluence).
---

Set up handbook docs in this repository:

1. Run `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs init` from the repo root.
   It scaffolds `confluence/config.json`, `confluence/.gitignore`, and
   `confluence/pages/_example.md.txt`, and never overwrites an existing file.
2. Open `confluence/config.json` and fill it in WITH the user:
   - `site` — `<org>.atlassian.net`, no scheme.
   - `spaceKey` — **never guess this.** Ask for the exact key (it is in the space
     URL, `/wiki/spaces/<KEY>/…`). A wrong key fails the space lookup before any
     other work happens.
   - `email` — their Atlassian login (safe to commit; the token is not).
   - `parentPageId` — the page the tree mounts under; leave `""` to mount at the
     space homepage.
   - `titlePrefix` — set it when the space already holds pages whose titles could
     collide. Confluence titles are unique per space, and a collision is a create
     failure this tool never auto-resolves.
   - `repoUrl` — link target in each page's banner.
   - `labels` — a short repo slug (e.g. `["acme"]`) when several repos share one
     space: it stamps every page and namespaces the per-page `hb-acme-<slug>`
     marker label. Leave `[]` when the space serves only this repo.
   Leave `kinds`, `audience`, `staleness`, `render`, and `sync` at their defaults
   for now; tune them once real pages exist.
3. Confirm the token: `CONFLUENCE_API_TOKEN` must be set in their environment
   (created at id.atlassian.com → API tokens). Check with
   `[ -n "$CONFLUENCE_API_TOKEN" ] && echo set`. **Never write the token to any
   file** — there is no `token` field in config, only `tokenEnv`. If the repo
   already keeps it in an env file under another name, set `envFile` and
   `tokenEnv`/`emailEnv` to match (the file only fills gaps; ambient env wins).
4. Verify one round trip. Copy `confluence/pages/_example.md.txt` to a real page
   file (e.g. `confluence/pages/overview.md`), write something true about this
   repo in it, and set `status: published`. First publish is the human's call, so
   ask the user explicitly whether to publish it, and only on their word set
   `approved: true`. Then run
   `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs sync --repo .` in the foreground
   and confirm the page exists in Confluence and the file gained its `pageId`.
   Read the failure, don't retry blindly:
   - **exit 3** — credentials missing; the message names the exact env vars.
   - **401** — the token is expired (all Atlassian tokens expire within 365 days)
     **or** it is a scoped token, which does not work against `site`. Scoped
     tokens need `"apiBase": "https://api.atlassian.com/ex/confluence/<cloudId>"`
     in config; get the cloud id from the user's Atlassian admin.
   - **403** — the account lacks permission on that space.
   - **404** on the space — the key is wrong or invisible to this account; the API
     conflates the two.
5. Load the `handbook-docs` skill and follow its contract from here on. Then run
   `/handbook:scaffold` to derive the initial page suite from the code.
