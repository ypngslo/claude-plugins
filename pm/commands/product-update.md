---
description: Refresh PRODUCT.md against the current reality of the repo
  and the founder's head
---

Update this project's PRODUCT.md:

1. If PRODUCT.md doesn't exist, run the creation interview from the
   product-context skill instead.
2. Run the Step 1 investigation from
   skills/product-context/references/interview.md and diff findings
   against the current PRODUCT.md.
3. Lead with discrepancies as confirmations, not open questions:
   "The file says prototype/0 users, but auth + analytics landed last
   month — has anyone started using it?" "Priorities list X, but the
   last 30 commits are all Y — have priorities shifted?"
4. Ask about anything time-based: stale not-now items whose
   revisit-triggers may have fired, priorities older than ~60 days.
5. Write the updated file, bump last-updated, and append any newly
   surfaced decisions to the Decisions Log. Keep it under a page —
   move superseded content to the log or delete it.
