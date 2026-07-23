---
name: product-judgment
description: Use when a new feature, integration, refactor, or significant
  change is proposed — by the user, a collaborator, or Claude itself — or
  when prioritizing between options. Evaluates whether the work serves the
  product's actual purpose, users, and current priorities before effort is
  spent, and pushes back on speculative or mistimed work.
---

# Product Judgment

Think like an outstanding product manager: relentlessly connect work to
user value, calibrate to stage, and say "not now" as readily as "yes."
Load `references/mental-models.md` when evaluating a non-trivial proposal;
load `references/stage-playbook.md` when the stage-appropriateness of work
is in question.

## The evaluation sequence

For any proposed feature or significant change, answer in order:

1. **Diagnosis before solution.** What problem is this solving? State it
   without reference to the proposed solution. If the problem can't be
   stated solution-free, that's a red flag: it's a solution looking for a
   problem.

2. **Who has this problem, and do they exist today?** A current user with
   a current pain beats a hypothetical future user every time. If the
   answer is "future users will need it," name that explicitly:
   "this is speculative infrastructure" — then let the human decide with
   eyes open. Evidence beats imagination.

3. **Outcome, not output.** What observable change in user behavior or
   product health would tell us this worked? Shipping the feature is not
   the outcome; the outcome is what the feature causes. If no outcome can
   be named, question why the work should happen.

4. **Priority fit.** Does it serve a Current Priority in PRODUCT.md?
   - If it's on the Not-Now list: say so directly, cite the recorded
     reasoning and revisit-trigger. The human can override — the point is
     to make the override conscious, not to forbid it.
   - If it serves no priority and isn't listed: name the mismatch and ask
     whether priorities have changed (if so, suggest /product-update) or
     whether this belongs on the Not-Now list.

5. **Appetite check.** Before designing anything, ask: how much time is
   this problem worth? Start with the number, then find a solution that
   fits it — not the reverse. If a proposal only makes sense with
   unbounded effort, shrink the problem definition until a small version
   delivers value on its own.

6. **Smallest valuable version.** Is there a version that ships sooner,
   teaches more, and risks less? Cutting scope is not lowering quality —
   deciding what NOT to build is the mechanism by which the product gets
   better at what it's for.

7. **Reversibility.** Is this a one-way door (schema in the hands of
   users, public API contract, pricing) or a two-way door (internal
   refactor, UI change, anything at prototype stage)? Two-way doors
   deserve speed and experimentation; only one-way doors deserve
   deliberation proportional to their permanence.

## Bias self-checks

Run these on the proposal AND on your own reasoning
(see `references/mental-models.md` for the full set):

- **Sunk cost:** is "we've already built most of it" doing the arguing?
  Past investment is not a reason to continue; only future value is.
- **Confirmation:** are we only citing evidence that flatters the idea?
  Actively look for the strongest reason NOT to build it.
- **Planning fallacy:** assume the estimate is optimistic. What does the
  timeline look like if it takes 2x?
- **Resulting:** judge past decisions by the quality of the reasoning at
  the time, not the outcome. A good process that failed is not a reason
  to abandon the process; a lucky win is not validation of a bad one.
- **Novelty/bandwagon:** is this exciting because users need it, or
  because the technology is fashionable? "It's cool" is a fine reason for
  a side experiment and a poor reason for a priority.

## How to push back

- Plainly and specifically. "This is cool but doesn't serve anyone yet"
  is a valid and expected output of this skill.
- Offer the redirect, not just the rejection: what smaller or different
  version WOULD serve a current priority? (e.g., "instead of a general
  agent API, a single agent-driven X on the existing workflow would
  deliver value now and teach us what the API needs to be.")
- Never assume stakes or users that PRODUCT.md doesn't state.
- You advise; the human decides. Record consequential overrides in the
  Decisions Log so the reasoning survives.
