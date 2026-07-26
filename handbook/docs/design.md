# handbook — design & build contract (v0.1.0)

This document is the **authoritative spec** for the `handbook` plugin. It was synthesized
from two independent design drafts plus extracts of jira3's implementation and the live
Confluence Cloud OpenAPI specs (July 2026). Where anything here conflicts with those
drafts, **this document wins**. Where this document is silent on an idiom (logging shape,
error style, arg parsing), **copy jira3** (`jira3/bin/jira-sync.mjs` and friends) — it is
the reference implementation for every mechanic that is not Confluence-specific.

**What the plugin is:** non-technical product documentation for a repo, kept in Confluence,
with the codebase as the source of truth. The Claude session derives/updates local page
files from the code; a deterministic zero-dependency CLI mirrors them one-way to Confluence,
spawned detached by hooks. The model never talks to Confluence.

Hard constraints (identical to jira3): Node ≥ 20, **zero npm dependencies** (global `fetch`,
`node:fs`, `node:path`, `node:child_process` only), local files authoritative, one-way push,
`pull` is a read-only drift report, no MCP, credentials only via env indirection.

---

## 1. Per-repo on-disk contract

All under `<repo>/confluence/`:

```
confluence/
  config.json          committed; no secrets ever
  pages/               FLAT — one .md per Confluence page; filename stem = slug
    _example.md.txt    scaffold copy of templates/page.md (.txt so the loader can't ingest it)
  .gitignore           written by init: .sync-state.json  .sync.lock  .sync.rerun  .sync.log
  .sync-state.json     gitignored cache; every field recoverable
  .sync.lock  .sync.rerun  .sync.log
```

The **slug** (filename stem, e.g. `feature-checkout`) is the stable identity: state key,
marker-label suffix, `parent:` reference target, cross-link target. Tree shape lives in
frontmatter (`parent:`), never in directories — moving a page is a one-line edit, not a
`git mv` the state file would misread as delete+create.

## 2. `config.json` schema

Required: `site`, `spaceKey` (validated up front, exit 2). Defaults-first/spread-last like
jira3's `loadConfig`. Full field list:

| Key | Default | Meaning |
|---|---|---|
| `site` | — | `your-site.atlassian.net`, no scheme |
| `spaceKey` | — | resolved once to `spaceId` via `GET /wiki/api/v2/spaces?keys=<KEY>&limit=1`, cached in state |
| `parentPageId` | `""` | Confluence id the tree mounts under; `""` ⇒ omit `parentId` on create (space homepage) |
| `titlePrefix` | `""` | prepended to every title at push time (space-wide title uniqueness escape hatch) |
| `labels` | `[]` | suite labels on every page; jira3 `resolveLabels` validation (array of `/^\S+$/` strings, exit 2 on malformed, fail before any network call) |
| `email` | unset | plaintext email allowed in committed config |
| `emailEnv` | `CONFLUENCE_EMAIL` | ignored when `email` set |
| `tokenEnv` | `CONFLUENCE_API_TOKEN` | the ONLY way to supply a token; no `config.token` exists |
| `envFile` | unset | repo-relative; jira3 `parseEnvFile`/`applyEnvFile` verbatim — ambient env always wins, file fills gaps, missing file warns and continues |
| `apiBase` | unset | full base override for scoped tokens (`https://api.atlassian.com/ex/confluence/<cloudId>`); paths below are appended to it |
| `repoUrl` | `""` | link target in the page banner |
| `kinds` | see §3 | per-kind structural rules; spread over the defaults so a project can add/override kinds |
| `audience.banned` | built-in bank | case-insensitive whole-word jargon terms that block publish |
| `audience.allow` | `[]` | literal terms exempted from banned bank AND identifier heuristics |
| `audience.allowPattern` | `[]` | regex strings exempted from identifier heuristics |
| `audience.maxGrade` | `10` | Flesch–Kincaid ceiling — **warn only** |
| `audience.maxWords` | `1200` | per-page soft ceiling — warn only |
| `staleness.watch` | `[]` | git pathspecs whose files must be claimed by some page's `sources:` (drives GAP reports) |
| `staleness.ignore` | `["**/*.test.*", "**/__snapshots__/**"]` | pathspecs excluded from staleness AND gap analysis |
| `render.toc` | `"auto"` | `auto` = TOC macro when ≥3 `##` headings; `always`/`never` |
| `render.banner` | `true` | "maintained from code" info panel. **Never contains a date or sha** (would churn the hash daily) |
| `render.codeLanguages` | curated list¹ | allowlist for the code macro `language` param; miss ⇒ omit the param |
| `sync.onRemoteEdit` | `"block"` | live version ≠ ours: `block` (warn, skip page, no state mutation) or `overwrite` |
| `sync.adoptExisting` | `false` | may an untracked local page adopt a same-titled remote page (also per-run `--adopt`) |
| `sync.retireMode` | `"banner"` | what `status: retired` does: `banner` \| `archive` \| `trash` \| `leave` |
| `sync.maxUpdatesPerRun` | `25` | circuit breaker: abort before any write if the pass would UPDATE (not create) more pages; bypass `--force` |

¹ `render.codeLanguages` default: `["bash","css","html","java","javascript","json","kotlin","python","ruby","sql","typescript","xml","yaml","go","rust","php","c","cpp","csharp","swift","text"]`

Credential resolution = jira3's `loadCredentials` verbatim (env-file gap-fill → `config.email ||
env[emailEnv]` → `env[tokenEnv]`; missing ⇒ warn naming the exact vars + exit 3).

## 3. Kinds

Same philosophy as jira3's `types`: the tool knows only structural properties; the project
owns names. Default bank (config `kinds` is spread OVER this, so projects extend/override):

```json
{
  "index":         { "label": "index",         "requireSources": false, "allowCodeBlocks": false, "requiredSections": [] },
  "overview":      { "label": "overview",      "requireSources": true,  "allowCodeBlocks": false, "requiredSections": ["What it is", "Who it's for"] },
  "feature":       { "label": "feature",       "requireSources": true,  "allowCodeBlocks": false, "requiredSections": ["What it does", "How it behaves", "Limits & known gaps"] },
  "capabilities":  { "label": "capabilities",  "requireSources": true,  "allowCodeBlocks": false, "requiredSections": ["What it can do today", "What it cannot do yet"] },
  "glossary":      { "label": "glossary",      "requireSources": false, "allowCodeBlocks": false, "requiredSections": [] },
  "release-notes": { "label": "release-notes", "requireSources": false, "allowCodeBlocks": false, "requiredSections": [] },
  "observations":  { "label": "observations",  "requireSources": false, "allowCodeBlocks": false, "requiredSections": [] },
  "reference":     { "label": "reference",     "requireSources": true,  "allowCodeBlocks": true,  "requiredSections": [] }
}
```

`requiredSections` are exact `## <name>` headings that must exist in the publish body.
An unknown `kind:` in a page is that page's error (not a whole-pass abort).
`resolveKinds(config)` (exported by docs-sync.mjs) returns the merged bank.

## 4. Page file format

### Frontmatter

Parser: jira3's `parseTaskFile` strict tiny-YAML subset (`^---\n`, LF-only, `key: value`,
`[a, b]` arrays, bare `true`/`false` booleans, `#` comments, unrecognized line ⇒ throw)
**plus one extension**: a fully-wrapping pair of `"` or `'` on a scalar value is stripped
(doc titles contain `:` and `[`). Quote-stripping happens BEFORE array/boolean detection,
so `title: "[Beta] Checkout"` is the string `[Beta] Checkout`.

| Field | Type | Written by | Purpose |
|---|---|---|---|
| `title` | string | model | Confluence title (prefix applied at push). Unique per space — enforced by lint across the suite |
| `kind` | kind key | model | selects structural rules + kind label |
| `parent` | slug or empty | model | empty ⇒ mount under `config.parentPageId`/homepage. Cycles = per-page error naming the cycle |
| `order` | int, default 100 | model | sibling sort in generated index tables only |
| `sources` | [pathspecs] | model | the code this page documents; git pathspecs, globs allowed |
| `unanchored` | bool | model | explicit opt-out of `requireSources` |
| `status` | `draft` \| `published` \| `retired` | model | only `published` pushes; `retired` needs `approved` |
| `approved` | bool | **human's explicit word only** | required `=== true` for FIRST publish (create) and for retire; content updates don't check it |
| `labels` | [strings] | model | extra Confluence labels for this page |
| `owner` | string | model/human | informational; rendered into banner; never used for logic |
| `reviewedRev` | sha | human | optional staleness-baseline override |
| `pageId` | string | **CLI writeback only** | authoritative over state (operator can adopt by pasting an id) |

Writeback uses jira3's byte-preserving `setFrontmatterKey`.

### Body

- **No `#` H1** (lint error — the frontmatter title is the page heading). Sections start at `##`.
- First block should be a single 20–60-word paragraph (lint **warn**) — it becomes the
  summary cell in the parent index table.
- Two **local-only** sections, split at `/^## (Editorial|Rework)\s*$/m` (jira3 `splitBody`
  shape): everything above the first special heading is the publish body. `## Editorial`
  holds the audience-gate trail (`Audience-check:` line) and review notes; `## Rework`
  holds confirmed findings. **Neither ever reaches Confluence in any form** and neither
  participates in the content hash. Convention: they come last, Editorial before Rework.
- Cross-links: `[text](other-slug.md)` → Confluence page link by title; `#anchor` suffix
  supported. Lint: error if no matching page file; warn if target is not `status: published`.

## 5. State file `.sync-state.json`

```jsonc
{
  "spaceId": "65758",
  "renderVersion": 1,               // render.mjs RENDER_VERSION at last pass (logging only)
  "pages": {
    "<slug>": {
      "pageId": "98765",
      "title": "Checkout",          // effective (prefixed) title we last wrote
      "parentId": "12300",          // parent id we last wrote ("" = homepage mount)
      "hash": "1a2b3c4d",           // FNV-1a hex of the generated STORAGE we last pushed
      "version": 8,                 // Confluence version.number after our last write — the drift oracle
      "labels": ["acme","feature","hb-acme-checkout"],   // labels WE wrote (ownership set)
      "retired": false
    }
  },
  "orphans": { "<slug>": { "pageId": "5150", "title": "Coupons" } }
}
```

Gitignored. Saved once per pass even when some pages failed (durable partial progress);
re-read fresh inside the rerun loop. Every field recoverable: `pageId` from frontmatter,
`hash` via `--force`, `version`/`title`/`parentId` via one GET, `spaceId` by re-resolution.

Hash = `fnv1a(storage)` — over the **generated storage XML** (furniture included), NOT the
markdown: a renderer fix must reach Confluence. `RENDER_VERSION` changes make that wave
visible in logs; `sync.maxUpdatesPerRun` keeps it from silently emailing a whole space.

## 6. The CLI — `bin/docs-sync.mjs`

```
node bin/docs-sync.mjs <init|sync|pull|stale|lint|render> [--repo <dir>] [flags]
  sync   [--dry-run] [--force] [--adopt]
  stale  [--brief] [--exit-code]
  lint   [<slug>]
  render <slug>
```

Arg parsing, `--repo` resolution, ISO-stamped `log`/`warn` (prefix `[handbook]`), dual
CLI/library guard, exit codes — all jira3 verbatim: `0` ok / nothing to do / lock held +
rerun queued / report commands; `1` ≥1 page failed; `2` config or usage error; `3`
credentials missing.

Exported (side-effect-free imports): `parsePageFile`, `setFrontmatterKey`, `splitBody`,
`resolveKinds`, `parseEnvFile`, `fnv1a`, `loadPages`.

**Per-file parse errors do not abort the pass** (divergence from jira3, deliberate): a
malformed page file is that page's counted failure; the other pages proceed.

### Page loading

`loadPages(config)`: read `confluence/pages/*.md` sorted; slug = stem; parse; resolve kind.
Order for sync: **topological, parents first** (memoized depth over `parent:`, cycle ⇒ that
page + its descendants fail with a named error; stable filename order within a depth).

### `sync` per-page flow (sequential, writes serialized)

```
status draft            → log "draft — not published"; zero network
status retired          → approved !== true ⇒ warn, skip
                          else per sync.retireMode (see below); entry.retired = true
status published:
  gate = publishGateReason(page, lintPage(page, suite, config))     # §8
  if gate: warn "<slug>: NOT publishing — <gate>"; NO state mutation; continue
  storage  = renderStorage(page, ctx)     # RenderError ⇒ counted page failure
  byteLen > 5_000_000 ⇒ page failure ("Confluence rejects bodies over 5 MB")
  hash     = fnv1a(storage);  title = titlePrefix + fields.title
  parentId = fields.parent ? (parent page's fields.pageId || state) : config.parentPageId || ""

  CREATE (no pageId in frontmatter or state):
    approved !== true ⇒ warn "first publish is the human's call — set approved: true"; skip
    if (--adopt or sync.adoptExisting):
      GET /wiki/api/v2/pages?space-id=<sid>&title=<t>&status=current&limit=250   (follow _links.next)
      client-side EXACT title match ⇒ adopt (log loudly), fall through to UPDATE path
    POST /wiki/api/v2/pages {spaceId, status:"current", title, parentId?, body:{representation:"storage", value}}
      400 mentioning "already exists" ⇒ page failure with remedies message
        ("another page owns this title — set titlePrefix, rename, or run with --adopt");
        NEVER auto-resolved, NEVER blindly retried
    writeback pageId; state entry {pageId, title, parentId, hash, version: <from response, else 1>, labels: []}

  UPDATE (pageId known):
    changed = state.hash !== hash;  renamed = state.title !== title;  moved = state.parentId !== parentId
    none of the three ⇒ ZERO api calls (the load-bearing no-op)
    GET /wiki/api/v2/pages/{id}                      # version/title/parentId, no body-format
    live.version.number !== state.version ⇒ remote edit:
        onRemoteEdit block ⇒ warn (name page, both versions), skip, no state mutation
        overwrite ⇒ log and proceed
    renamed && !changed && !moved ⇒ PUT /wiki/api/v2/pages/{id}/title {status:"current", title}
        (no version object; then one GET to refresh state.version)
    else ⇒ PUT /wiki/api/v2/pages/{id} {id, status:"current", title, parentId?, body, version:{number: live+1, message}}
        400|409 ⇒ re-GET once, retry once with fresh number, then page failure
    state.{title,parentId,hash,version} updated

  LABELS (declarative over what we own):
    desired = config.labels ∪ kind.label ∪ fields.labels ∪ marker
    marker  = config.labels.length ? `hb-${config.labels[0]}-${slug}` : `hb-${slug}`
    add     = desired − state.labels   → POST /wiki/rest/api/content/{id}/label [{prefix:"global", name}...]
    remove  = state.labels − desired   → DELETE /wiki/rest/api/content/{id}/label?name=<n>  (per label)
    never touches labels not in state.labels (hand-added labels survive forever)
    state.labels = desired
    (after any label write, one GET /pages/{id} refreshes state.version in case label
     writes bump it — cheap insurance for the drift oracle)
```

`version.message` (provenance, the only writable version metadata): 
`handbook: confluence/pages/<slug>.md @ <git short sha of repo HEAD>` (omit ` @ ...` when not a git repo).

**Circuit breaker:** before executing, a no-network planning loop counts pages whose
update leg would fire (changed/renamed/moved with known pageId). Count >
`sync.maxUpdatesPerRun` and no `--force` ⇒ abort the pass before ANY write:
`"this pass would update N pages (max 25) — run --dry-run to inspect, --force to proceed"`, exit 1.
Creates don't count (each is individually human-approved).

**Retire modes** (`status: retired` + `approved: true`; skipped when `entry.retired`):
- `banner` (default): re-render with a leading `warning` panel *"This page is no longer
  maintained and may be out of date."* prepended to the body, one final content PUT.
- `archive`: v1 `POST /wiki/rest/api/content/archive` body `{"pages":[{"id":<id>}]}`.
- `trash`: `DELETE /wiki/api/v2/pages/{id}` (never `?purge=true`).
- `leave`: log only.
Retired pages drop out of index tables (§7 ctx excludes them).

**Orphans:** file deleted while state has an entry ⇒ move entry to `state.orphans`, warn
EVERY pass: `orphan <slug> → page <id> "<title>" is still live in Confluence — restore the
file or retire it deliberately`. Never auto-delete.

**Locking:** jira3's lock + rerun contract (`openSync 'wx'`, pid inside, 120 s mtime steal,
loser touches `.sync.rerun` + exits 0, winner loops clearing the flag before each pass)
with three fixes: (1) `statSync` in the acquire-catch wrapped in try (ENOENT race), and a
module-level `iOwnLock` flag guards `releaseLock()`; (2) every `fetch` gets
`signal: AbortSignal.timeout(30_000)`; (3) stale-steal attempts bounded at 2, then queue
rerun + exit 0. `pull`/`stale`/`lint`/`render` take no lock.

### HTTP client

Base = `process.env.CONFLUENCE_BASE_URL_OVERRIDE || config.apiBase || https://${config.site}`.
All paths carry their family prefix: `/wiki/api/v2/...` (v2), `/wiki/rest/api/...` (v1
labels + archive). Basic auth header built once. Non-2xx ⇒ throw
`` `${method} ${path} → ${status} ${body.slice(0,300)}` ``; 204 ⇒ null.

Retry policy: **429** ⇒ honour `Retry-After` as floor, else backoff 5 s → 30 s cap,
jitter ×[0.7,1.3], max 4 attempts (all verbs — a 429'd POST was not executed). **5xx /
timeout** ⇒ 2 retries on GET/PUT/DELETE only; **POST /pages is NEVER retried** after a
sent-then-unknown failure (duplicate-title trap; the next pass re-queries). 401 message:
`token rejected — expired (all Atlassian tokens expire ≤365 days) or a scoped token that
needs config.apiBase = https://api.atlassian.com/ex/confluence/<cloudId>`. 403: permission.
404 on space/page: `does not exist OR you lack permission (the API conflates them)`.

### `pull` (read-only drift report; no lock; exit 0)

Per page with a `pageId`: `GET /wiki/api/v2/pages/{id}`; compare `version.number` vs
state.version (⇒ "edited in Confluence (v9, we wrote v7)"), title (⇒ "renamed"), parentId
(⇒ "moved"). No pageId ⇒ "not yet published". Terminal line `no drift` or
`N drift item(s) — local files remain authoritative; reconcile by editing them`.

### `stale` (read-only; no lock; no network; exit 0, or 1 with `--exit-code` when STALE/MISSING-SOURCE exist)

Delegates to `gitinfo.mjs` (§9). Default output: sections STALE (with the commit list and
the exact `git log --stat` review command), MISSING-SOURCE, UNANCHORED, GAP, DIRTY.
`--brief`: ≤5 lines total, e.g. `handbook: 3 stale, 1 gap — run /handbook:refresh`, silent
when everything is fresh. No git repo / shallow clone ⇒ warn once, exit 0.

### `lint [<slug>]` — lintPage + a render attempt (RenderErrors reported as errors) for one
or all pages; exit 1 on any error. `render <slug>` — print the storage XML to stdout.

### `init` — scaffold `confluence/{config.json, .gitignore, pages/_example.md.txt}` from
templates (resolved relative to `import.meta.url`, jira3-style); never overwrites existing
files; prints next steps. Runs before any config/credential/lock code.

## 7. Renderer — `bin/render.mjs`

```js
export const RENDER_VERSION = 1;
export class RenderError extends Error {}    // .line (1-based), .construct
export function renderStorage(page, ctx) → string   // throws RenderError
export function firstParagraph(publishBody) → string | null
export function escapeXml(text, { attr = false } = {}) → string
```

`page` = `{ slug, fields, publishBody }`. `ctx` = `{ config, kind, resolveTitle(slug) →
effectiveTitle|null, children }` where `children` (index kinds only) is the ordered array
`[{ slug, title /* effective */, kindLabel, firstParagraph }]` of **published, non-retired**
direct children sorted by `order` then slug; docs-sync builds ctx.

**Fail closed:** anything outside the subset throws `RenderError` with the 1-based source
line — never a silent drop. A final internal **tag-balance check** (push/pop over emitted
tags) throws on unbalanced output before returning.

Output order: banner panel (if `render.banner`) → TOC macro (per `render.toc`; `auto` = ≥3
`##` headings; `type=list, minLevel=2, maxLevel=3, printable=true`) → rendered body → index
table for `kind: index` (at the `<!-- children -->` marker if present, else appended).

Banner (info macro, rich-text body — NO dates, NO shas):
`Maintained from code — edits made here are overwritten by the next sync. Source: confluence/pages/<slug>.md[ · Owner: <owner>][ · <a href=repoUrl>Repository</a>]`

Index table columns: Page (`ac:link` by title) | Summary (child firstParagraph, plain text) | Kind (status lozenge, colour `Blue`, title = kindLabel).

### Supported subset → storage mapping

| Markdown | Storage |
|---|---|
| `##`–`######` | `<h2>`–`<h6>` (`#` H1 ⇒ RenderError "don't repeat the title") |
| paragraph | `<p>…</p>` |
| `**b**` / `*i*` or `_i_` / `` `c` `` / `~~s~~` | `<strong>` / `<em>` / `<code>` / `<span style="text-decoration: line-through;">` |
| `-`/`*`/`+` and `1.` lists, 2-space nesting, mixed | `<ul>`/`<ol>`, child list INSIDE the parent `<li>` |
| `- [ ]` / `- [x]` | `ac:task-list` / `ac:task` / `ac:task-status` `incomplete\|complete` / `ac:task-body` |
| `> quote` (single level) | `<blockquote><p>…</p></blockquote>` (nested ⇒ RenderError) |
| `> [!NOTE\|INFO\|TIP\|IMPORTANT\|WARNING\|CAUTION] Optional Title` + `> body` lines | `ac:structured-macro` info\|info\|tip\|note\|warning\|warning, optional `title` param, `ac:rich-text-body` with block-level children |
| `:::expand Title` … `:::` | expand macro, `title` param, rich-text body |
| ` ```lang ` fence | code macro; `ac:plain-text-body` CDATA; `]]>` split as `]]]]><![CDATA[>`; lang not in `render.codeLanguages` ⇒ omit the param. (Fences on a kind with `allowCodeBlocks: false` are caught by lint, not the renderer) |
| GFM pipe table + alignment row | `<table><tbody>`, `<th>` first row, `<td style="text-align: center\|right;">` |
| `---` | `<hr />` |
| `[t](https://… \| http://… \| mailto:…)` | `<a href="…">t</a>` |
| `[t](slug.md)` / `[t](slug.md#Some Heading)` | `<ac:link[ ac:anchor="Some Heading"]><ri:page ri:content-title="<effective title>" /><ac:plain-text-link-body><![CDATA[t]]></ac:plain-text-link-body></ac:link>`; unknown slug ⇒ RenderError |
| `![alt](https://…)` | `<ac:image ac:alt="alt"><ri:url ri:value="…" /></ac:image>` |
| `![alt](anything local)` | RenderError — attachments are deferred (v0.3) |
| `[[status:Colour\|Text]]` | status macro, `colour` ∈ `Grey\|Red\|Yellow\|Green\|Blue` (exact, capitalized — else RenderError), `title` param; wrapped in `<p>` when standalone |
| two-trailing-space line break | `<br />` |
| `<!-- children -->` | index-table placement marker (index kinds; elsewhere ⇒ RenderError) |

**Explicitly unsupported ⇒ RenderError:** raw HTML tags, footnotes, reference-style links,
autolinks `<http…>`, setext headings, definition lists, HTML entities beyond the XML five.

**Escaping:** storage is XML. One `escapeXml` for every text node and attribute (`&` `<`
`>`, plus `"` when `attr`). Only numeric character refs ever emitted. Void elements
self-closed. `ac:macro-id` omitted; `ac:schema-version="1"` on every macro. Never emit
`<script>`/`<style>`.

## 8. Lint & gate — `bin/lint.mjs`

```js
export function lintPage(page, suite, config) → { errors: Finding[], warns: Finding[] }
   // Finding = { rule, line /* 1-based or null */, message }
export function publishGateReason(page, lintResult) → string | null
```

`suite` = `{ pages: Map<slug, page> }` for cross-page rules. lint.mjs may import
`firstParagraph` from `./render.mjs`; it must NOT import docs-sync.mjs (cycle).
Rules run over the **markdown source** (line numbers must be real). Lint findings for
`## Editorial`/`## Rework` content are skipped except the secret scan (which covers the
whole file).

**ERROR rules** (block publish):
- *identifier shapes*: camelCase (≥2 humps or ≥8 chars), `snake_case`, `SCREAMING_SNAKE`
  (≥5 chars), `word()` call syntax, `::`, `->`, `=>` outside code spans… minus
  `audience.allow` literals and `audience.allowPattern` regexes
- *path shapes*: tokens containing `/` and ending in a code extension
  (`.ts .tsx .js .jsx .mjs .py .go .rb .rs .java .kt .sql .ya?ml .json .sh .css .html`), `src/…`, `./…`
- *command shapes*: line-initial or backticked `git|npm|pnpm|yarn|docker|kubectl|psql|curl ` invocations
- *protocol shapes*: HTTP verbs adjacent to a `/path`, 3-digit status codes preceded by
  "returns/return/responds", `SELECT … FROM`-shaped SQL
- *banned jargon*: `audience.banned` (defaults²) minus `audience.allow`, whole-word,
  case-insensitive
- *code fence on a kind with `allowCodeBlocks: false`*
- *secrets* (NEVER waivable, whole file, message NEVER echoes the match): `AKIA[0-9A-Z]{16}`,
  `ghp_\w{20,}`, `xox[baprs]-`, `sk-[A-Za-z0-9]{16,}`, `-----BEGIN … PRIVATE KEY`,
  `password\s*=`, URLs with userinfo, `Bearer <20+ chars>`, RFC1918 literals,
  `localhost:\d+`, `*.internal`/`*.local` hosts, ≥32-char base64/hex runs adjacent to
  `key|token|secret`, and every KEY NAME found in the repo's `.env` (names only, values never read into messages)
- *structure*: `#` H1; missing `requiredSections` for the kind; duplicate effective titles
  across the suite; `parent:` slug not found; parent cycle; `.md` cross-link target not
  found; `requireSources` unsatisfied without `unanchored: true`; unknown `kind`;
  `status: retired` present while file still linked from an index page

**WARN rules:** FK grade > `audience.maxGrade` (~15-line syllable heuristic); words >
`audience.maxWords`; first block not a 20–60-word paragraph; a required "Limits"-style
section that is empty or just "None"; `.md` link target not `status: published`.

² Default banned bank: endpoint, middleware, refactor, schema, migration, mutex, async,
idempotent, deserialize, serialize, stack trace, null, boolean, regex, cron, daemon, repo,
backend, frontend, API, SDK, CLI, JSON, YAML, SQL, database index, race condition, memory
leak, dependency injection, microservice, kubernetes, docker, webhook payload.

**Gate** (jira3 `reviewGateReason` idiom — pure, returns the failure as a string):

```js
export function publishGateReason(page, lint) {
  if (lint.errors.length) return `lint: ${e0.rule} at line ${e0.line} (+${n-1} more)`;
  const ed = page.editorial;
  if (!ed)                          return 'no ## Editorial section';
  if (/^\(optional\b/i.test(ed))    return 'the ## Editorial section is still the template placeholder';
  if (!/^audience-check:/im.test(ed)) return 'missing its "Audience-check:" trail line';
  return null;
}
```

## 9. Staleness — `bin/gitinfo.mjs`

All git via `execFileSync('git', [...], { cwd: repoRoot })`; every function degrades
gracefully (no git / not a repo / shallow ⇒ `noGit: true`, empty results).

```js
export function gitAvailable(repoRoot) → boolean
export function headSha(repoRoot) → string | null            // short sha
export function lastCommitTouching(repoRoot, pathspecs) → sha | null
export function commitsSince(repoRoot, baseSha, pathspecs) → [{ sha, date, subject }]
export function trackedFilesUnder(repoRoot, pathspecs) → string[]        // git ls-files
export function dirtyPaths(repoRoot, pathspecs) → string[]               // status --porcelain
export function staleReport(pages, config, repoRoot) →
  { noGit, stale: [{slug, title, sources, baseSha, commits, reviewCmd}],
    missingSource: [{slug, path}], unanchored: [slug],
    gaps: [path], dirty: [{slug, paths}] }
```

Core relation: baseSha = `fields.reviewedRev || lastCommitTouching(repo, [confluence/pages/<slug>.md])`;
page is **STALE** iff `commitsSince(baseSha, sources ∪ ':(exclude)' staleness.ignore)` is
non-empty. Never-committed page file ⇒ fresh (it's new). **MISSING-SOURCE**: a `sources:`
pathspec matching zero tracked files at HEAD. **UNANCHORED**: kind requires sources, page
has none and no `unanchored: true` (also a lint error; repeated here so `stale` is
self-contained). **GAP**: a tracked file under `staleness.watch` claimed by no page's
`sources:`, aggregated to the deepest directory that groups them. **DIRTY**: sources with
uncommitted changes — reported, never counted as stale.

## 10. Hooks

`hooks/hooks.json` (identical shape to jira3's):

```json
{
  "description": "handbook — fire-and-forget local→Confluence mirror. Page writes spawn the detached sync CLI; session start reports doc staleness and reconciles.",
  "hooks": {
    "PostToolUse":  [{ "matcher": "Edit|Write",
                       "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/on-page-write.sh" }] }],
    "SessionStart": [{ "matcher": "startup",
                       "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/on-session-start.sh" }] }]
  }
}
```

`on-page-write.sh` = jira3's `on-task-write.sh` with the glob `*/confluence/pages/*.md`
and marker file `confluence/config.json`; everything else verbatim (`set -u`, never `-e`;
stdin JSON; `node -e` extraction of `tool_input.file_path`; parent-dir walk;
`nohup node "${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs" sync --repo "$REPO" >> "$REPO/confluence/.sync.log" 2>&1 &`;
unconditional `exit 0`).

`on-session-start.sh`: gated on `${CLAUDE_PROJECT_DIR}/confluence/config.json`; then
(1) `timeout 5 node "${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs" stale --brief --repo "$CLAUDE_PROJECT_DIR" 2>/dev/null || true`
to stdout (pure git, ≤5 lines of context); (2) the same detached reconcile sync as jira3;
unconditional `exit 0`.

**No hook on source-file writes, ever** — staleness is derived from git on demand.

## 11. Plugin components

```
handbook/
  .claude-plugin/plugin.json    { "name": "handbook", "description": …, "version": "0.1.0",
                                  "author": { "name": "Mickey Malotte" } }
  README.md
  docs/design.md                (this file)
  commands/  init.md  scaffold.md  new.md  refresh.md  status.md  publish.md  retire.md
  skills/handbook-docs/SKILL.md  + references/voice.md  references/markdown.md
  agents/  audience-reviewer.md  claim-checker.md
  hooks/   hooks.json  on-page-write.sh  on-session-start.sh          (scripts 100755)
  bin/     docs-sync.mjs  render.mjs  lint.mjs  gitinfo.mjs           (docs-sync 100755)
  templates/  config.json  page.md
              kinds/ index.md overview.md feature.md capabilities.md glossary.md release-notes.md observations.md
  test/    mock-confluence.mjs  run.sh                                 (run.sh 100755)
```

### Commands (each `commands/<name>.md`, jira3 command-file shape)

- **init** — run `docs-sync.mjs init`; fill config WITH the user (never guess spaceKey;
  token stays in env, never in a file; probe: on 401 explain scoped-token `apiBase`);
  verify one round trip; hand off to the skill.
- **scaffold** — survey the repo for every human-facing surface, **every audience**
  (customers AND admins/operators/internal staff — admin dashboards are features
  whose user is the admin); create the default suite from `templates/kinds/*` with
  customer pages (`feature-*`) under a `features` index and admin/internal pages
  (`admin-*`) under a separate `admin` index — the two branches never mix;
  `sources:` filled from the actual survey, `staleness.watch` set to the source
  roots so undocumented surfaces become GAP reports, a closing `stale` run with
  every GAP either paged or explicitly excluded with a reason, incidental
  observations recorded (v0.2.0, below), all `status: draft`, `approved: false`.
- **new <feature>** — one page from its kind template; wire `parent:`/`order:`; propose
  `sources:` by locating the feature's code.
- **refresh** — the main loop: `stale` → read the listed commits/diffs → judge per page
  (cosmetic ⇒ `## Editorial` note only; behavioral ⇒ rewrite affected sections) → audience
  gate → publish. MISSING-SOURCE ⇒ propose retire; GAP ⇒ propose `new`; never silently.
- **status** — one health table from `stale` + `lint` + `pull`: fresh / stale / gaps /
  gate-blocked / drifted / orphaned / unpublished.
- **publish** — force a foreground `sync` and report every action and refusal with its
  reason; for questions about a PAST sync, read `confluence/.sync.log` instead.
- **retire <slug>** — explain the modes, get the human's explicit word, then flip
  `status: retired` + `approved: true` in one write.

### Skill (`skills/handbook-docs/SKILL.md`)

Description: *"How this repo's non-technical product documentation reaches Confluence via
local page files (confluence/pages/*.md) — writing for a PM audience, keeping pages fresh
against the code, and the publish gate. Load whenever a project has confluence/config.json
and you are writing, refreshing, or publishing product docs. You NEVER call the Confluence
API or MCP — you edit local files; a hook syncs them."*

Must cover: file-format table (who writes each field; `pageId` is the CLI's); the audience
(a PM who will never read the code); voice rules (user's-eye view; every claim traceable to
code actually read; limits stated as plainly as capabilities); the fixed feature-page
skeleton; lifecycle (`draft` → gate → `published`; first publish and retire are the human's
explicit word via `approved: true`; content refreshes autonomous); **the gate sequence**:
1) `lint` clean → 2) dispatch `audience-reviewer` → 3) extract load-bearing claims, one
`claim-checker` per claim in parallel, default UNSUPPORTED, drop/rewrite unsupported claims
→ 4) clean ⇒ **ONE write** with the `## Editorial` trail
(`Audience-check: clean — N claims verified, reviewer clean`) AND `status: published`;
findings ⇒ ONE write filling `## Rework` + `status: draft`; fresh full pass after fixes;
5) dead agent ⇒ retry once then surface. Single-write rule stated literally (two writes =
two hook syncs = a half-finished publish). Staleness obligations (run `stale` when doc work
starts; `sources:` mandatory per kind). Never-list: never call Confluence; never write
`pageId`; never edit `.sync-state.json`; never wait on `.sync.log`; never delete a page
file to remove a page; never paste code/identifiers/internal names into a body; never set
`approved: true` yourself — it is the human's word, per page, explicitly.

### Agents

- `audience-reviewer.md` — `model: opus`, read-only (`disallowedTools: Write, Edit`).
  Input: page path + its `sources:`. Judges exactly: (1) accuracy against the code as it is
  today, (2) audience fit (jargon, code leakage, internal names), (3) missing limitations
  the code plainly implies. Every finding: `file:line` anchor + concrete consequence.
  Fixed raw output: `VERDICT: CLEAN|FINDINGS`, `COVERAGE:`, `FINDINGS:`. Calibration: a
  clean pass on a clean page is a first-class success.
- `claim-checker.md` — `model: sonnet`, read-only. Input: ONE claim + the page's sources.
  **Default verdict UNSUPPORTED**; a claim survives only by citing the specific code and
  restating the mechanism in its own words. Fixed output:
  `VERDICT: SUPPORTED|UNSUPPORTED`, `EVIDENCE: <file:line + one-sentence mechanism>`.

## 12. Tests

### `test/mock-confluence.mjs` — jira3 `mock-jira.mjs` shape

Plain `node:http`, `127.0.0.1`, port `argv[2]` (run.sh uses **8299**), in-memory Maps,
`GET /__state` auth-free `{ spaces, pages, labels, counters }`; everything else requires
`Authorization: Basic ` prefix; catch-all `404 {"err":"unhandled METHOD path"}`.
Counters: `spaceLookup createPage updatePage titleUpdate deletePage getPage findPage
labelAdd labelRemove archive`.

| Endpoint | Deliberate realism |
|---|---|
| `GET /wiki/api/v2/spaces?keys=&limit=` | one result `{id:"65758", key, homepageId:"1"}` |
| `GET /wiki/api/v2/pages?space-id=&title=&status=&limit=` | **substring** title match (forces client-side exact verification); `_links.next` cursor pagination when >2 results |
| `POST /wiki/api/v2/pages` | 200; **400 `"A page already exists with the title …"` on duplicate title in the space** |
| `GET /wiki/api/v2/pages/{id}` | body ONLY when `body-format` passed; always `version:{number,message}` |
| `PUT /wiki/api/v2/pages/{id}` | **409 unless `version.number === current + 1`**; stores body/title/parentId/message |
| `PUT /wiki/api/v2/pages/{id}/title` | **rejects any request carrying a `version` object** (asserts the cheap path) |
| `DELETE /wiki/api/v2/pages/{id}` | 204, marks trashed |
| `GET /wiki/api/v2/pages/{id}/labels` | current set |
| `POST /wiki/rest/api/content/{id}/label` | additive, accepts array |
| `DELETE /wiki/rest/api/content/{id}/label?name=` | 204 |
| `POST /wiki/rest/api/content/archive` | marks archived |
| `POST /__chaos` | `{status: 429|409|500, times: N, retryAfter: 0}` arms the next N responses |

### `test/run.sh` — jira3 `run.sh` shape

`set -euo pipefail`; `mktemp -d` repo, **`git init` + `git config user.email/name`** (staleness
scenarios need real history); mock backgrounded, `trap` cleanup, `sleep 0.4`;
`CONFLUENCE_BASE_URL_OVERRIDE=http://127.0.0.1:8299`, `CONFLUENCE_EMAIL`,
`CONFLUENCE_API_TOKEN` exported; `fail()`/`state()` helpers; `grep -q || fail` and
`grep -q && fail` assertions; counters via inline `node -e`; `|| true` around
expected-failure invocations; secret-scan fixtures **assembled at runtime by string
concatenation** (a committed literal would fail the repo's gitleaks gate); final
`echo "ALL PASS"`.

Scenario list (in order): 1 init scaffolds + is idempotent (no overwrite) · 2 renderer
golden tests via `node -e` imports — headings, nested mixed lists, task list, aligned
table, code fence allowed/disallowed language, `> [!WARNING]`, expand, status lozenge,
page link + anchor, external link/image, escaping `&<>"`, CDATA `]]>` split, `<br />` ·
3 renderer refusals — H1, raw HTML, local image, nested blockquote, autolink, unknown
status colour, each naming the line · 4 lint refusals — camelCase, file path, banned term,
`audience.allow` exemption honored, code fence on `feature` kind, missing required
section, duplicate titles, missing parent, cycle, secret (assembled; message does NOT
echo it) · 5 gate refusals — no `## Editorial`, placeholder, missing `Audience-check:` ·
6 create — 3-page tree in one sync: topological order (grandchild slug sorting before
parent still created after), `pageId` writebacks, child `parentId` = parent's id,
`createPage == 3`; unapproved new page refused ("first publish"), approved succeeds ·
7 **idempotent re-run: every counter unchanged (zero GETs)** · 8 content update — one
`updatePage`, version 2, `version.message` has the file path · 9 rename-only —
`titleUpdate` +1, `updatePage` unchanged · 10 move-only — one `updatePage`, new parentId ·
11 duplicate-title create without `--adopt` ⇒ named conflict failure, no auto-resolve;
with `--adopt` ⇒ adopts (createPage unchanged, pageId written back) · 12 chaos 409 ⇒
re-GET + retry-once succeeds · 13 chaos 429 (Retry-After: 0) ⇒ succeeds · 14 remote-edit
drift with `block` ⇒ refused + named; with `overwrite` ⇒ proceeds · 15 labels —
create stamps config+kind+marker; removing a config label removes exactly it; a mock-side
hand-added label survives; idempotent · 16 retire — unapproved refused; `banner` mode ⇒
one update containing the warning panel, no delete; `trash` mode ⇒ deletePage 1;
re-run: no repeat · 17 orphan — deleted file ⇒ warn, no delete, entry in state.orphans ·
18 draft page ⇒ zero calls · 19 `--dry-run` ⇒ zero mutating counters · 20 `--force` ⇒
republish, then idempotent · 21 circuit breaker — 26+ pending updates without `--force` ⇒
abort before any write · 22 `pull` drift report — mutates nothing, exit 0 ·
23 staleness — commit page+source ⇒ fresh; commit source change ⇒ STALE with commit list;
commit page edit ⇒ fresh; delete source ⇒ MISSING-SOURCE; `--exit-code` semantics;
GAP via `staleness.watch`; `--brief` ≤5 lines · 24 malformed page file among good ones ⇒
that page fails, others sync (counters prove it) · 25 lock/rerun — fresh foreign lock ⇒
exit 0, `.sync.rerun` created, zero network · 26 credentials — missing ⇒ exit 3 zero
calls; `envFile` + custom `emailEnv`/`tokenEnv` under `env -u …` ⇒ succeeds ·
`echo "ALL PASS"`.

## 13. Repo integration & quality gates

- `.claude-plugin/marketplace.json` gains `{ "name": "handbook", "source": "./handbook",
  "description": "Non-technical product docs in Confluence, derived from the codebase: page
  files in the repo are the source of truth; a zero-dependency CLI mirrors them via
  detached hooks. Git-derived staleness detection; an audience gate blocks jargon, code,
  secrets, and unverified claims from publishing." }` — plus a row in the root README table.
- Gates: `claude plugin validate` must pass; hook scripts + `run.sh` committed **100755**;
  nothing runtime-required may be gitignored; version starts 0.1.0 (new-plugin exemption);
  gitleaks must stay green (hence runtime-assembled fixtures).

## 14. Changes in 0.2.0

- **`observations` kind + passive capture.** While reading sources for doc work,
  the model records anything that looks wrong as one dated line and moves on —
  the skill forbids spending any extra tool call investigating or reading code
  the doc work didn't already require ("capture, never hunt"). At the end of a
  scaffold/refresh pass the lines land in `observations.md` (draft by default,
  so first publish stays the human's word). Entries are hedged as observations
  to investigate, never stated as confirmed findings.
- **Audience coverage + separation.** "User-facing" explicitly means every human
  the product faces: customers AND admins/operators/internal staff (dashboards,
  back-office tooling, emails, jobs with observable effects). Customer pages
  (`feature-*`, under the `features` index) and admin/internal pages (`admin-*`,
  under a separate `admin` index) are kept in clearly separated branches that
  never mix. Scaffold arms `staleness.watch` with the source roots and must end
  with a `stale` run where every GAP is either paged or explicitly excluded with
  a reason — coverage is verified mechanically, not assumed. (Motivating
  incident: a 0.1.0 scaffold on a real app skipped the admin dashboard because
  the prose said "user-facing … not internal plumbing" and `watch` shipped
  empty, so GAP detection was disarmed.)

## 15. Deliberately out of scope

Attachments/local images (v1 multipart + `X-Atlassian-Token: nocheck`; designed, deferred
to 0.2) · Confluence folders (no list/update endpoints) · sibling ordering in the
Confluence sidebar (index tables are the navigation surface) · bidirectional merge ·
`?purge=true` · ADF / `wiki` representations · server-side conversion APIs.
