# handbook — product docs in Confluence, derived from the code

Product documentation goes stale because the people who know what changed write
in one place and the docs live in another, behind a rich-text editor nobody opens
on the way to a merge. handbook inverts that: the docs live in the repo, next to
the code they describe, and Confluence becomes a rendering target rather than a
system of record.

> **The session writes local page files from the code. A deterministic CLI
> mirrors them one-way to Confluence, spawned detached by hooks. The model never
> talks to Confluence at all.**

## How it works

```
confluence/pages/<slug>.md  ──(model derives/updates from code)──▶  PostToolUse hook
                                                                        │ spawns detached
                                                                        ▼
                                                       bin/docs-sync.mjs  ──REST──▶ Confluence
                                                       (diff vs .sync-state.json:
                                                        create / update / rename /
                                                        move / retire / labels)
```

- **Zero model cost per push** — writing the page file is the entire obligation.
  The hook returns immediately, sync runs in the background, failures retry on the
  next write (lockfile + rerun-flag collapse concurrent spawns).
- **The codebase is the source of truth for the content** — pages carry
  `sources:` pathspecs, and staleness is computed from git: a page whose sources
  have moved on is reported with the exact commits to review.
- **One-way by design** — local files are authoritative. `pull` produces a drift
  *report* only (someone edited the page in Confluence); reconcile by editing the
  local file. Bidirectional merge is deliberately out of scope.
- **Nothing ships that a PM can't read** — an audience gate blocks jargon, code
  leakage, secrets, and unverified claims from ever reaching the space.
- **The load-bearing no-op** — a page whose rendered output, title, and parent are
  unchanged makes **zero** API calls. A whole-suite sync on an unchanged repo is
  free.
- **No MCP, no dependencies** — direct REST (v2 for pages, v1 for labels and
  archive) with an API token from env; works in hooks, cron, and headless runs.
  Node ≥ 20, zero npm deps.

## Per-repo setup

Run `/handbook:init` (or `node bin/docs-sync.mjs init` in the repo). It scaffolds:

```
confluence/
  config.json      ← THE per-project Confluence space: site, spaceKey, email,
                     parent page, title prefix, labels, audience/staleness/render
                     policy. Committed; contains no secrets.
  pages/<slug>.md  ← one file per page, FLAT. Frontmatter = identity + lifecycle,
                     body = the published content. The filename stem is the
                     page's permanent id; the tree lives in `parent:`, so moving
                     a page is a one-line edit, not a directory move.
  .gitignore       ← ignores .sync-state.json / .sync.lock / .sync.rerun / .sync.log
```

Credentials never live in `confluence/` and are never committed. They resolve from
the process environment — `CONFLUENCE_API_TOKEN` (and `CONFLUENCE_EMAIL` unless
`email` is in config), var names overridable via `tokenEnv`/`emailEnv` — and, when
`envFile` is set, from that repo-relative env file as a fallback: the file only
fills gaps, the ambient environment always wins. Scoped Atlassian tokens don't
work against the site host; point `apiBase` at
`https://api.atlassian.com/ex/confluence/<cloudId>` and they do.

Several repos can share ONE space: give each repo a `labels` list (e.g.
`"labels": ["acme"]`) and every page that repo creates is stamped with it, and the
first label namespaces the per-page `hb-acme-<slug>` marker label so identical
slugs in two repos can't collide. Labels are reconciled declaratively over the set
handbook itself wrote — hand-added labels survive forever. `titlePrefix` is the
escape hatch for Confluence's space-wide title uniqueness.

Pages are typed by **kind** (`index`, `overview`, `feature`, `capabilities`,
`glossary`, `release-notes`, `reference`). The tool knows only structural
properties — required sections, whether sources are mandatory, whether code
blocks are allowed — and the project owns the vocabulary: `kinds` in config is
spread over the defaults, so a repo can add or override kinds freely.

## Lifecycle contract (enforced by `skills/handbook-docs`)

| Local status | In Confluence | Flipped when |
| ------------ | ------------- | ------------ |
| `draft`      | nothing — zero network | the page exists and is being written |
| `published`  | created / updated | the audience gate came back clean. **First** publish (create) needs `approved: true` — **the human's explicit, per-page word.** Later content updates are autonomous |
| `retired`    | banner / archive / trash / leave, per `sync.retireMode` | the page's subject is gone. Also needs `approved: true` — the human's word again |

Deleting a page file is never how a page goes away: the live Confluence page
becomes an **orphan**, which the sync warns about on every pass and never
auto-deletes.

### The audience gate

Before any page may flip to `published`, the session runs a fixed sequence: `lint`
clean → a fresh critical reviewer (`agents/audience-reviewer.md`, opus, read-only)
that judges the page on accuracy against today's code, audience fit, and
limitations the code plainly implies → then every load-bearing claim extracted and
handed to its own `agents/claim-checker.md` (sonnet, read-only, one claim each, in
parallel), which **defaults to UNSUPPORTED** and lets a claim live only by citing
the code and restating the mechanism. A clean pass writes the page's `## Editorial`
trail and `status: published` in **one** write; findings write `## Rework` and
`status: draft` instead. The sync backstops it mechanically — a page whose
`## Editorial` is missing, still the template placeholder, or lacks its
`Audience-check:` line does not publish.

`lint` itself is the deterministic half of the gate: identifier and path shapes,
command and protocol shapes, a configurable banned-jargon bank, kind structure
(required sections, no `#` H1, duplicate titles, broken `parent:`/cross-links),
and a never-waivable secret scan that includes every key name found in the repo's
`.env` — and never echoes a match in its message.

`## Editorial` and `## Rework` are local-only: they never reach Confluence in any
form, and they don't participate in the content hash, so editing them never
republishes a page.

### Staleness

`stale` is pure git, no network. For each page, the baseline is the page file's
last commit (or `reviewedRev:`), and the page is STALE when its `sources:` have
commits since — reported with the commit list and the exact `git log --stat`
command to review them. The same pass reports MISSING-SOURCE (a pathspec matching
nothing at HEAD), UNANCHORED (a kind that needs sources on a page that has none),
GAP (tracked code under `staleness.watch` that no page claims), and DIRTY
(uncommitted source changes — never counted as stale). The session-start hook
prints the `--brief` form, silent when everything is fresh. **No hook ever fires
on a source-file write** — staleness is derived on demand, not maintained.

## Commands / CLI

- `/handbook:init` — scaffold + guided config in the current repo.
- `/handbook:scaffold` — survey the repo and create the initial page suite as drafts.
- `/handbook:new <feature>` — one new page from its kind template, sources located
  in the code.
- `/handbook:refresh` — the main loop: stale → read the commits → update → gate →
  publish.
- `/handbook:status` — one health table (fresh / stale / gaps / gate-blocked /
  drifted / orphaned / unpublished).
- `/handbook:publish` — force a foreground sync and report every action and refusal.
- `/handbook:retire <slug>` — explain the retire modes, then flip on the human's word.
- `bin/docs-sync.mjs sync --repo <dir> [--dry-run] [--force] [--adopt]` — the push
  reconcile. A circuit breaker aborts the pass before any write when more than
  `sync.maxUpdatesPerRun` pages would be updated, so a renderer change can't
  silently email a whole space.
- `bin/docs-sync.mjs pull --repo <dir>` — read-only drift report.
- `bin/docs-sync.mjs stale --repo <dir> [--brief] [--exit-code]` — git-derived
  freshness report.
- `bin/docs-sync.mjs lint [<slug>] --repo <dir>` — the audience/structure linter.
- `bin/docs-sync.mjs render <slug> --repo <dir>` — print the storage XML a page
  would push.

Page bodies use a small, explicit markdown subset (headings, lists, task lists,
tables, callout panels, expands, status lozenges, cross-page links, code macros
where the kind allows them). The renderer **fails closed**: anything outside the
subset raises an error naming the source line, never a silent drop.

**Deferred to 0.2:** attachments and local images. `![alt](https://…)` renders
today; a local image path is a deliberate render error rather than a broken page,
because the v1 multipart attachment upload is designed but not shipped.

## Testing

`test/mock-confluence.mjs` is an in-memory Confluence stand-in (v2 pages + v1
labels/archive) with deliberately realistic edges: substring title search, 409 on
a wrong version number, duplicate-title create rejection, and a `__chaos` endpoint
that arms 429/409/500 responses. `test/run.sh` drives the whole loop against it —
init, renderer golden tests and refusals, lint and gate refusals, topological
create, idempotent re-run with zero calls, updates/renames/moves, adoption,
retry/backoff, drift, labels, retire modes, orphans, dry-run, the circuit breaker,
git staleness scenarios, lock/rerun, and credential resolution. Run:
`bash test/run.sh`.
