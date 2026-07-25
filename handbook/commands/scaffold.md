---
description: Survey this repo and create the initial handbook page suite (index, overview, features, capabilities, glossary, release notes) as drafts with sources filled in from what the survey actually found.
---

Create the initial page suite for this repo. Load the `handbook-docs` skill first —
the voice rules and the file format apply to every page you write here.

1. **Survey the code before writing anything.** Read the README, the package/build
   manifests, the entrypoints, the route/command/UI surfaces, and the config
   surface. You are looking for **user-facing capabilities** — things a person
   using the product can do — not modules. Internal plumbing with no user-visible
   behavior gets no page.
2. Draft the suite with the user before creating files: list the feature pages you
   intend to make, one line each. A repo with three real capabilities gets three
   feature pages, not seven.
3. Create the pages under `confluence/pages/` (FLAT — the filename stem is the
   slug and the page's stable identity; the tree lives in `parent:` frontmatter,
   never in directories). Copy the matching template from
   `${CLAUDE_PLUGIN_ROOT}/templates/kinds/` and fill it in:

   | Slug | Kind | Parent | Purpose |
   | ---- | ---- | ------ | ------- |
   | `index` | `index` | *(empty)* | the suite's front door |
   | `overview` | `overview` | `index` | what the product is and who it is for |
   | `features` | `index` | `index` | index of the feature pages |
   | `feature-<name>` | `feature` | `features` | one per user-facing capability |
   | `capabilities` | `capabilities` | `index` | what it can and cannot do today |
   | `glossary` | `glossary` | `index` | the product's words, in the user's terms |
   | `release-notes` | `release-notes` | `index` | user-visible changes |

4. Fill `sources:` from the survey, not from guesswork — every pathspec must match
   files that actually exist (`git ls-files <pathspec>` to confirm). Kinds with
   `requireSources: true` cannot publish without them, and a `sources:` entry that
   matches nothing at HEAD is reported forever as MISSING-SOURCE.
5. Set `order:` so siblings sort sensibly in the generated index tables, and give
   every page a 20–60-word opening paragraph — it becomes that page's summary cell
   in its parent's index table.
6. Every page ships `status: draft` and `approved: false`. Nothing publishes from
   this command. Do not write `pageId` — that field is the CLI's.
7. Run `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs lint --repo .` and fix what it
   reports (jargon, code leakage, missing required sections, broken `parent:` or
   cross-links) until it is clean.
8. Report the tree to the user and tell them what happens next: `/handbook:refresh`
   runs the audience gate page by page, and the first publish of each page needs
   their explicit word (`approved: true`).
