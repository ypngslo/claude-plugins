---
description: Survey this repo and create the initial handbook page suite as drafts — every human-facing surface (customer AND admin/internal), grouped into clearly separated branches, with sources filled in from what the survey actually found.
---

Create the initial page suite for this repo. Load the `handbook-docs` skill first —
the voice rules and the file format apply to every page you write here.

1. **Survey the code before writing anything.** Read the README, the package/build
   manifests, the entrypoints, the route/command/UI surfaces, and the config
   surface. You are looking for **every human-facing surface, for every
   audience** — not modules. Enumerate the audiences explicitly and sweep each
   one:
   - **Customers / end users** — the product's primary screens and flows.
   - **Admins and operators** — admin dashboards, back-office screens,
     moderation and support tooling, configuration UIs. **These are features
     too**; their user is a person with a screen. Look for them deliberately:
     admin surfaces often live apart from the main app (a separate route
     prefix, package, or app) and a survey that only walks the primary
     entrypoint will miss them.
   - **Indirect surfaces** — emails and notifications the product sends,
     scheduled jobs with effects a person can observe, exports and reports.
   Only plumbing with **no observable behavior for any audience** gets no page.
2. Draft the suite with the user before creating files: list the pages you intend
   to make, one line each, **grouped by audience** — so they can veto or add
   before anything is written. If you are deliberately not documenting a surface
   the survey found, say so here and say why; do not let it disappear silently.
   A repo with three real capabilities gets three feature pages, not seven.
3. Create the pages under `confluence/pages/` (FLAT — the filename stem is the
   slug and the page's stable identity; the tree lives in `parent:` frontmatter,
   never in directories). Copy the matching template from
   `${CLAUDE_PLUGIN_ROOT}/templates/kinds/` and fill it in.

   **Customer-facing and admin/internal pages are kept clearly separate**: two
   branches, two slug prefixes. Never mix an admin page into the `features`
   branch or vice versa — a PM reading "Features" must be able to trust that
   everything there is what customers get.

   | Slug | Kind | Parent | Purpose |
   | ---- | ---- | ------ | ------- |
   | `index` | `index` | *(empty)* | the suite's front door |
   | `overview` | `overview` | `index` | what the product is and who it is for |
   | `features` | `index` | `index` | index of the customer-facing feature pages |
   | `feature-<name>` | `feature` | `features` | one per customer-facing capability |
   | `admin` | `index` | `index` | index of the admin & operations pages — **only when the survey found admin/internal surfaces** |
   | `admin-<name>` | `feature` | `admin` | one per admin/operator capability (same skeleton as a feature page; the user is the admin) |
   | `capabilities` | `capabilities` | `index` | what it can and cannot do today, both audiences |
   | `glossary` | `glossary` | `index` | the product's words, in the user's terms |
   | `release-notes` | `release-notes` | `index` | changes a person would notice |
4. Fill `sources:` from the survey, not from guesswork — every pathspec must match
   files that actually exist (`git ls-files <pathspec>` to confirm). Kinds with
   `requireSources: true` cannot publish without them, and a `sources:` entry that
   matches nothing at HEAD is reported forever as MISSING-SOURCE.
5. **Arm coverage detection.** Set `staleness.watch` in `confluence/config.json`
   to the repo's top-level source directories (the roots that contain the code
   the survey walked — admin code included). This is what makes an undocumented
   surface a mechanical GAP report instead of a silent omission.
6. Set `order:` so siblings sort sensibly in the generated index tables, and give
   every page a 20–60-word opening paragraph — it becomes that page's summary cell
   in its parent's index table.
7. Every page ships `status: draft` and `approved: false`. Nothing publishes from
   this command. Do not write `pageId` — that field is the CLI's.
8. Run `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs lint --repo .` and fix what it
   reports (jargon, code leakage, missing required sections, broken `parent:` or
   cross-links) until it is clean.
9. **Verify coverage before reporting.** Run
   `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs stale --repo .` and look at the
   GAP section: every gap is either a page you forgot (create it now) or a
   deliberate exclusion (name it in your report, with the reason, for the user to
   veto). Do not finish with unexplained gaps.
10. **Write down what you noticed.** If the survey put anything in front of you
    that looks wrong — behavior that seems broken, inconsistent, or surprising —
    record it now in `observations.md` (kind `observations`, parent `index`,
    `status: draft`), one dated line per item, phrased as what a user would
    experience. Capture only; the skill's observations rule applies — **you never
    investigate, and you never go looking.**
11. Report the tree to the user grouped by audience, list any deliberate
    exclusions and any observations captured, and tell them what happens next:
    `/handbook:refresh` runs the audience gate page by page, and the first publish
    of each page needs their explicit word (`approved: true`).
