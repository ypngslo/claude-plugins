---
name: handbook-docs
description: How this repo's non-technical product documentation reaches Confluence via local page files (confluence/pages/*.md) — writing for a PM audience, keeping pages fresh against the code, and the publish gate. Load whenever a project has confluence/config.json and you are writing, refreshing, or publishing product docs. You NEVER call the Confluence API or MCP — you edit local files; a hook syncs them.
---

# handbook-docs — the product-documentation contract

The `confluence/pages/*.md` files are the source of truth. A detached CLI
(`handbook`'s `bin/docs-sync.mjs`, spawned by hooks on every page-file write and
at session start) mirrors them one-way to Confluence: creates pages, pushes
content updates, renames, moves, retires, and reconciles labels. **Your entire
Confluence obligation is to keep the local files truthful and publishable.**
Never call the Confluence REST API or an Atlassian MCP tool yourself; never wait
for a sync.

The codebase is the source of truth for the *content*. Every sentence in a page
is a claim about code that exists right now, and you are the only thing standing
between a PM and a confidently wrong page.

## File format

One file per page: `confluence/pages/<slug>.md`. The directory is FLAT — the
filename stem is the slug, and the slug is the page's permanent identity (state
key, marker label, `parent:` target, cross-link target). The tree shape lives in
frontmatter, never in directories: moving a page is a one-line `parent:` edit.

| Key | Values | Who writes it |
| --- | ------ | ------------- |
| `title` | the page title a PM would recognize; unique across the suite | you, at creation |
| `kind` | a key of config's `kinds` (`index`, `overview`, `feature`, `capabilities`, `glossary`, `release-notes`, `observations`, `reference`) | you, at creation — the kind picks the required sections and the page's label |
| `parent` | slug of the parent page; empty = mounts at the configured root | you |
| `order` | integer, default 100 — sibling sort in generated index tables | you |
| `sources` | `[pathspecs]` — the code this page documents | you, from code you actually read |
| `unanchored` | `true` = explicit opt-out of the `sources:` requirement | you, deliberately and rarely |
| `status` | `draft` → `published` → `retired` | you, at the lifecycle moments below |
| `approved` | `false` until the human's explicit word | you, ONLY on that word |
| `labels` | `[strings]` — extra Confluence labels for this page | you |
| `owner` | a name; rendered into the page banner, never used for logic | you or the human |
| `reviewedRev` | a commit sha — optional staleness baseline override | the human |
| `pageId` | leave blank | **the sync CLI** (never invent or copy one) |

Body rules:

- **No `#` H1** — the frontmatter `title` is the page heading. Sections start at
  `##`. An H1 is a lint error.
- The first block is a single **20–60 word paragraph**. It becomes this page's
  summary cell in its parent's index table, so write it as a standalone answer to
  "what is this page?".
- Load-bearing claims carry an inline **`[^N]`** marker (N is 1–99) directly after
  the sentence they anchor, and one matching definition line in a `## Claims`
  section: `[^N]: path/to/file.ext:88 @ 9f3ac21 — one sentence on the mechanism`.
  `## Claims` **is published** — it renders after the body as a collapsed panel
  titled "Where these claims come from (technical)", the one deliberately
  technical block on the page (the audience rules are skipped inside it; the
  secret scan is not). File order is body … `## Claims` … `## Editorial` …
  `## Rework`. A marker with no definition is a lint error, a repeated number is a
  lint error, and a definition nothing points at is a warning. **The gate writes
  this section** (steps 3–4 below); you never hand-maintain it.
- `## Editorial` and `## Rework` are **local-only**: everything above the first of
  them is the published body. Neither ever reaches Confluence in any form, and
  neither affects the content hash — so editing them alone never republishes a
  page. Convention: they come last, Editorial before Rework, both after `## Claims`.
- Cross-links are `[text](other-slug.md)` (with an optional `#Heading` suffix) and
  resolve to Confluence page links. A link to a slug with no page file is a lint
  error; a link to a page that is not `published` is a warning.
- Only the markdown subset in `references/markdown.md` renders. Anything outside
  it fails the render with the source line — it is never silently dropped.

## Who you are writing for

**A product manager who will never read the code, never open a terminal, and
cannot ask a follow-up question.** They are smart and they know the product
domain. They do not know your repo's nouns, your file layout, your function
names, or your stack. If a sentence only makes sense to someone who has read the
code, it is not documentation — it is a leak.

## Every audience is documented — and kept clearly separate

"User-facing" means **every human the product faces**, not just customers: admin
dashboards, back-office and support tooling, configuration UIs, emails and
notifications, and scheduled jobs with observable effects are all documentable
surfaces — the admin's screen is a feature whose user is the admin. When the
suite covers more than one audience, the branches stay **clearly separated**:
customer-facing pages under the `features` index (`feature-*` slugs), admin and
internal-operations pages under the `admin` index (`admin-*` slugs). Never file
an admin capability under `features` or a customer capability under `admin` — a
reader must be able to trust that everything under "Features" is what customers
get. `staleness.watch` in config should cover ALL these surfaces' code, so an
undocumented one surfaces as a GAP instead of vanishing.

## Voice rules

1. **User's-eye view.** Describe what the product does and what the person using
   it experiences. Not how it is built, not which component does it.
2. **Every claim traceable to code you actually read this session.** If you cannot
   name the file that makes a sentence true, delete the sentence. Inference from a
   plausible-sounding name is not reading.
3. **Limits as plainly as capabilities.** "It cannot do X yet" is the most
   valuable sentence on the page. A page that only lists what works is a sales
   page, and the gate treats an empty limits section as a warning for that reason.
4. **No identifiers, no paths, no commands, no status codes, no jargon.** Not in
   prose, not in backticks, not "just this once" for precision. The linter enforces
   this and it does not negotiate; `audience.allow` in config is the escape hatch
   for genuine product vocabulary, and it is the human's call to add to it.
5. **Numbers over adjectives.** "Up to 50 items per import" beats "handles large
   imports".
6. **Present tense, active voice, short sentences.** No roadmap language, no
   dates, no "we plan to".

`references/voice.md` has before/after pairs for the six situations that leak most
(identifiers, flows, errors, limits, settings, config) plus the **fixed
feature-page skeleton** — read it before writing or rewriting a feature page. Its
sections (`## What it does`, `## How it behaves`, `## Limits & known gaps`) are
required by the `feature` kind and the page cannot publish without them.

Those sections have a **shape**, not just a name:

- `## How it behaves` is a **numbered list**: one line per step of the main flow,
  in the order the person experiences it, with the unhappy paths as sub-bullets
  under the step where they happen. A small table when the behavior is
  conditional. Prose paragraphs only for what a list genuinely cannot say.
- `## Limits & known gaps` is a **bulleted list**: one limit per line, crisp fact
  first ("Exports are capped at 500 rows — bigger requests are split"). Optionally
  ONE `> [!WARNING]` callout, for the limit most likely to burn someone.

Being thorough is not the same as writing paragraphs. A surveyed feature produces
*more points*, not longer prose — a section that runs three paragraphs in a row
earns a `wall-of-text` lint warning, and the fix is steps, bullets, or a table.

## Lifecycle — when to flip status

- **`draft`** — the page exists and is being written. Zero network: drafts never
  reach Confluence.
- **`published`** — the audience gate below has come back clean. For a page's
  **first** publish (no `pageId` yet), `approved: true` is required, and that is
  **the human's explicit, per-page word** ("publish the checkout page"). A bare
  "ok" / "thanks" / silence is NOT approval. The CLI refuses the create without
  it, but the real rule is yours.
- **content refreshes are autonomous** — once a page is published, updating it
  after a code change needs no new approval. Gate it, write it, done. That is the
  whole point: the docs keep up without a human in the loop for every sentence.
- **`retired`** — also needs `approved: true`, also the human's explicit word, per
  page. Use `/handbook:retire`, which explains the modes first. **Never delete a
  page file to remove a page** — that orphans the live Confluence page.

## The audience gate — before any page flips to `published`

No page publishes without a clean pass. Run this in order, per page:

1. **`lint` clean.** `node <plugin>/bin/docs-sync.mjs lint <slug> --repo .`. Fix
   every error — jargon, identifiers, paths, commands, missing required sections,
   broken links, secrets. Secret findings are never waivable. Do not proceed with
   errors outstanding; the sync would refuse the page anyway.
2. **Dispatch `handbook:audience-reviewer`** (one per page) with the page path and
   its `sources:`. It judges accuracy against the code as it is today, audience
   fit, and missing limitations the code plainly implies. Discard any finding
   without a `file:line` anchor and a concrete consequence — malformed, don't act
   on it.
3. **Verify the load-bearing claims — and number them.** Extract every sentence a
   PM would make a decision on (a capability, a limit, a number, a behavior under
   failure) and mark each one in the body with `[^N]`, numbered in order of
   appearance. **Number only decision-bearing claims** — typically **3–10 per
   page**, never every sentence; a marker on "the list is sorted alphabetically"
   is noise. Dispatch one **`handbook:claim-checker`** per claim, **in parallel**,
   with the claim verbatim and the page's `sources:`. **The default verdict is
   UNSUPPORTED**: a claim survives only if the checker cites specific code and
   restates the mechanism. Its `EVIDENCE:` line comes back as three fields —
   repo-relative path, line number, one-sentence mechanism — and you **keep** them:
   they become that claim's published citation. Drop or rewrite every UNSUPPORTED
   claim, taking its marker with it — rewriting to what the code actually does is
   usually the right move, deleting is always allowed. Renumber so the surviving
   markers run 1..N in order of appearance.
4. **One write, either way.**
   - **Clean** (reviewer clean, all claims supported): **ONE** Edit/Write that
     carries all three of — the rebuilt `## Claims` section, the `## Editorial`
     trail line (`Audience-check: clean — N claims verified, reviewer clean`), and
     `status: published`.
     Rebuild `## Claims` from the surviving checkers' evidence, one line per
     surviving marker, in order:
     `[^1]: src/invites/service.ts:88 @ 9f3ac21 — an invite is created with a 14-day expiry and refused after it`
     The sha is the repo's HEAD short sha at verification time
     (`git rev-parse --short HEAD`), and **every definition the gate writes carries
     one**: a pinned link shows the code exactly as it was verified, so the line
     numbers never rot. Rebuild the whole section from this pass's evidence rather
     than patching last pass's lines.
   - **Findings**: **ONE** Edit/Write that fills `## Rework` with the confirmed
     findings verbatim (file:line, the defect, the consequence) AND sets
     `status: draft`.
   **"Single write" is literal: ONE tool call.** Two writes — even batched in one
   message — fire two hook syncs, and the first one publishes a half-finished
   page to the whole space. In practice: one `Write` of the whole file, or one
   `Edit` whose `old_string` spans from the `status:` line through the section you
   are filling. The gate trail is load-bearing: the sync refuses to publish a page
   whose `## Editorial` is missing, still the template placeholder, or has no
   `Audience-check:` line.
   After fixing findings, the next attempt is a **fresh full pass** — new
   reviewer, new claim-checkers, no memory of the prior round. The clean write
   drops the stale `## Rework` section.
5. **A dead agent means the gate did not run.** A reviewer or checker that dies or
   returns garbage: retry it once, then stop and surface it to the human. Never
   publish on a pass that did not complete.

## Staleness obligations

- **Run `stale` when doc work starts**, before touching a page:
  `node <plugin>/bin/docs-sync.mjs stale --repo .`. It is pure git, no network,
  and it tells you which pages the code has moved out from under. The session-start
  hook prints the brief version; the full report names the commits and the exact
  `git log --stat` command to review each one.
- **`sources:` is mandatory** for every kind whose rules require it (`overview`,
  `feature`, `capabilities`, `reference`). It is what makes staleness detectable
  at all — a page with no anchor is a page nobody can ever tell is wrong.
  `unanchored: true` is a deliberate, explained exception, not a way past the lint
  error.
- A page is stale when its `sources:` have commits newer than the page file's last
  commit. Read those commits before editing: cosmetic changes earn one
  `## Editorial` line saying they were reviewed and changed nothing; behavioral
  changes earn a rewrite of the affected sections against the current code.
- MISSING-SOURCE means the code moved or died — repoint `sources:` or propose a
  retire. GAP means code nobody documents — propose a new page. Both are
  proposals to the human, never silent edits.

## Observations — capture what you notice, never hunt for it

While reading sources for doc work you will sometimes see something that looks
wrong: behavior that seems broken, an inconsistency between two flows, a feature
that appears dead. **Capture it; never chase it.**

- The moment you notice, add one line to a running note and go straight back to
  the doc work. **You never spend a single extra tool call investigating an
  observation, and you never read code the doc work did not already require.**
  An observation is something the work put in front of you — the instant you are
  reading a file *in order to find problems*, you have left this contract.
- At the **end** of the pass (scaffold or refresh), write the collected lines
  into `observations.md` (kind `observations`), dated, newest first, under
  `## Open observations` — each phrased as what a person using the product would
  experience, naming the feature or flow, never a file. If nothing was noticed,
  touch nothing.
- Entries are **observations to investigate, not confirmed findings** — write
  them with that hedge, because unverified claims must not read as facts.
- The page follows the normal lifecycle: it stays `draft` until the human's
  explicit word first publishes it, so whether this page belongs in Confluence
  at all is their call.

**A limit is not an observation.** A line in `## Limits & known gaps` is a
gate-verified fact: you read the code, a claim-checker confirmed it, and it
publishes with its citation. An observation is the opposite — unverified, hedged,
dated, and parked in an inbox until a human looks. Never let one drift into the
other: something you merely suspect goes on the observations page, never into a
feature page's limits, and an observation becomes a limit only after a human
investigation establishes it and a normal gate pass verifies it (the alternatives
being that the thing gets fixed, or is resolved as a non-issue and the line is
removed).

## What you never do

- **Never call Confluence** — no REST, no MCP, no curl. The CLI owns all
  Confluence I/O.
- **Never write `pageId`** yourself; it is the CLI's writeback.
- **Never edit `confluence/.sync-state.json`**.
- **Never wait on `confluence/.sync.log`** mid-task (read it only if the user asks
  whether something synced).
- **Never delete a page file to remove a page** — set `status: retired` with the
  human's approval instead.
- **Never paste code, identifiers, or internal names into a body** — not in prose,
  not in a code fence, not in backticks.
- **Never set `approved: true` yourself** — it is the human's word, per page,
  explicitly.

## Manual controls

- `/handbook:refresh` — the main loop: stale → read the commits → update → gate →
  publish.
- `/handbook:status` — one health table (fresh / stale / gaps / gate-blocked /
  drifted / orphaned / unpublished).
- `/handbook:publish` — force a foreground sync and report every action and
  refusal.
- `/handbook:new <feature>` · `/handbook:retire <slug>` — add or retire one page.
- `/handbook:restyle` — one-time whole-suite pass to the current section shapes +
  claim citations; facts unchanged, routine work stays with `/handbook:refresh`.
- `node <plugin>/bin/docs-sync.mjs pull --repo .` — read-only drift report
  (someone edited a page in Confluence). Local files stay authoritative;
  reconcile by editing them.
- `node <plugin>/bin/docs-sync.mjs render <slug>` — print the storage XML a page
  would push, without pushing it.
