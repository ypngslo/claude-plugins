---
description: Create one new handbook page for a feature or topic from its kind template — wires parent/order and proposes sources by locating the feature's code.
---

Create one new page for: **$ARGUMENTS**

Load the `handbook-docs` skill first, then:

1. **Find the code first.** Locate the feature in the repo (grep for its
   visible strings, routes, commands, flags — admin and back-office surfaces
   count exactly like customer ones). If you cannot point at the code
   that implements it, stop and ask the user — a page with no anchor documents
   nothing, and `sources:` is not optional for `feature`/`overview`/
   `capabilities`/`reference` kinds.
2. Pick the kind (`feature` unless the user asked for something else) and copy the
   matching template from `${CLAUDE_PLUGIN_ROOT}/templates/kinds/` to
   `confluence/pages/<slug>.md`. The slug is a short kebab stem
   (e.g. `feature-checkout`) and is permanent: it is the state key, the marker
   label suffix, and how other pages link here. Check it is not already taken.
3. Fill the frontmatter:
   - `title` — what a PM would call the feature, not what the module is called.
     It must be unique across the suite (Confluence titles are unique per space).
   - `parent` — the slug of the index page this belongs under, **by audience**:
     customer-facing capabilities go under `features` (slug `feature-<name>`),
     admin/operator/internal capabilities go under `admin` (slug `admin-<name>`,
     created as an `index` page first if it does not exist yet). The two branches
     never mix — a reader must be able to trust that everything under "Features"
     is what customers get.
   - `order` — where it sorts among its siblings in that index table.
   - `sources` — the pathspecs you actually found in step 1, verified with
     `git ls-files`.
   - `status: draft`, `approved: false`. Never write `pageId`.
4. Write the body against the code you read, following the feature-page skeleton
   and voice rules in the skill (`references/voice.md`). Open with a single 20–60
   word paragraph; state limits as plainly as capabilities.
5. Add a cross-link from the parent index page if that page lists its children by
   hand (an `index` kind renders its children automatically — leave it alone).
6. Run `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs lint <slug> --repo .` and fix
   what it reports.
7. Tell the user the page exists as a draft, and that publishing it runs the
   audience gate (`/handbook:refresh`) and needs their explicit word.
