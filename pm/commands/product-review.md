---
description: Evaluate a proposal or piece of in-flight work against the
  product's purpose, stage, and priorities
argument-hint: [proposal or feature to review]
---

Act as the product's PM and review the following proposal: $ARGUMENTS
(If no argument was given, review the most recently discussed change or
the current branch's diff against main.)

1. Load PRODUCT.md via the product-context skill (create it first via
   the interview if missing).
2. Run the full evaluation sequence from the product-judgment skill,
   including the bias self-checks.
3. Return a verdict in this shape:
   - **Problem being solved** (stated solution-free)
   - **Who it serves, and whether they exist today**
   - **Outcome if it works** (observable change)
   - **Priority fit** (which priority / not-now conflict / unlisted)
   - **Stage fit** (matched to actual stage, or premature/overdue)
   - **Recommendation:** build now / build smaller version now (specify
     it) / defer with revisit-trigger / drop — with the one or two
     reasons that matter most, and the strongest counter-argument to
     your own recommendation.
4. If the human overrides, offer to record the decision and reasoning
   in PRODUCT.md's Decisions Log.
