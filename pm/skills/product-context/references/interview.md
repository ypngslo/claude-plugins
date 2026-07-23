# Creating PRODUCT.md — Interview Guide

## Step 1: Investigate first (don't ask what you can see)

Before asking anything, gather from the repo itself:

- README, package.json / pyproject, recent commit history → what this is,
  how active development is, how many contributors
- Deploy configs, CI files, env references → whether and where it's deployed
- Auth, billing, analytics code → hints about whether real users are expected
- TODOs, roadmap files, open branches, recent PRs → what's in flight

Form a draft picture. Present it to the user as a short summary to confirm
or correct — people correct a wrong guess far more easily than they answer
a blank question. Demonstrating that you've actually looked also builds
trust in the whole system.

## Step 2: Ask only what the repo can't tell you

These usually can't be inferred, so ask directly — a few at a time,
conversationally, not as a form:

1. **Stage & usage:** "Is anyone using this today? Roughly how many, and
   who are they?" — push for a real number. "Some people" is not an
   answer; "zero" is a perfectly good one. If the user is vague, offer
   the stage definitions (prototype / early / live / mature) and ask
   them to pick.
2. **Purpose:** "In one or two sentences, what is this for and who is it
   for?" — if the user answers with a feature list, ask what problem
   those features solve and for whom. Push toward a job-to-be-done
   phrasing: what does someone *hire* this product to do?
3. **Priorities:** "What are the 1–3 things that matter most right now?"
   — if they list five, ask which they'd drop. Three is the ceiling.
4. **Not-now list:** "Anything you've explicitly decided NOT to do yet,
   or ideas floating around that you're deferring?" — capture the
   reasoning and, ideally, the trigger that would revisit it ("revisit
   when core workflow is stable"). This list is what later catches
   well-meaning but mistimed proposals.
5. **Collaborators:** "Anyone else working on this?" — matters for whose
   proposals will be evaluated against this file, and for whether the
   file needs to persuade someone who didn't write it.

## Step 3: Write and confirm

Draft PRODUCT.md from `templates/PRODUCT.md.template`, show it to the
user, and adjust. Set `last-updated` to today. Keep the whole file under
a page — if it's longer, cut.

## Reuse for updates

/product-update reuses this guide: run the same Step 1 investigation, but
diff findings against the existing PRODUCT.md and lead with discrepancies
("the file says prototype, but you've added Stripe and analytics since —
still true?"). Only ask about sections that changed.

## Style

- Short interview. Five questions is the ceiling, not the floor — skip
  anything already answered by investigation or conversation.
- Record honest, unflattering facts plainly. "0 users" written down is
  the entire point of this file.
- No aspirational language the repo can't back up. The file records what
  IS, not what the founder hopes.
