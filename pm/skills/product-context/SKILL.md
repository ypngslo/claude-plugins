---
name: product-context
description: Use when planning features, proposing architectural or deployment
  changes, assessing risk or blast radius, estimating scope, or making any
  decision whose right answer depends on how mature the product is and who
  uses it. Loads the project's product reality (stage, usage, priorities)
  so decisions are calibrated to actual stakes, not assumed ones.
---

# Product Context

## Core rule

Never infer stakes from surface signals. A deployment config, a custom
domain, a polished UI, or a CI pipeline is NOT evidence of users. The only
sources of truth about stakes are: (a) PRODUCT.md, (b) the user telling you
directly. If neither is available, ask — do not assume.

## Procedure

Before planning or assessing any significant change:

1. **Read PRODUCT.md** at the repo root.
   - If it exists: load it fully and calibrate all subsequent reasoning to
     its stated stage, usage numbers, priorities, and not-now list.
   - If it does not exist: say so plainly, state that you will not assume
     stakes, and offer to create one by following
     `references/interview.md` and writing the result with
     `templates/PRODUCT.md.template`. If the user declines, ask the one
     essential question directly: "Is anyone using this today, and roughly
     how many?" — and proceed with that answer as your only stakes input.

2. **Calibrate to the stated stage** using `../product-judgment/references/stage-playbook.md`.
   The one-line version:
   - `prototype` — zero users. Deploys are free, breakage is free,
     migrations are trivial (drop the database if it's easier). Never
     treat the live URL as evidence of users. Optimize for learning speed.
   - `early` — a handful of known users. Ship fast, communicate breakage,
     keep a path to recover data. Reversibility matters more than polish.
   - `live` — real users depend on this. Migrations, backwards
     compatibility, rollout care, and communication now genuinely matter.
     This is the ONLY stage where "this is risky, lots of people use it"
     reasoning is valid.
   - `mature` — established product, reputation and reliability are
     assets. Bias toward stability; changes need stronger justification.

3. **Self-police staleness.** If PRODUCT.md's `last-updated` date is more
   than ~30 days old, OR its claims contradict what you observe in the
   repo (e.g., it says "no billing" but Stripe code exists; it says
   "prototype" but there's an analytics dashboard showing traffic), flag
   the discrepancy and ask whether the file is still accurate before
   relying on it. Suggest running /product-update.

4. **Surface the calibration, briefly.** When your stage-calibration
   changes what you'd otherwise say, name it in one line, e.g.:
   "Since this is a prototype with zero users, I'll just change the
   schema directly — no migration needed." This keeps the human aware of
   the assumption chain and able to correct it.

## Anti-patterns to avoid

- Treating deployment as usage. (The founding failure mode this plugin
  exists to fix.)
- Performing caution theater: long risk disclaimers about a product
  nobody uses yet.
- The reverse error: being cavalier at `live` stage because the codebase
  is small or scrappy-looking. Stage comes from the file, not vibes.
- Silently proceeding without stakes information when PRODUCT.md is
  missing and the change is significant.
