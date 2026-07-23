# Stage Playbook — Calibrating Work to Reality

The most common cause of startup failure is premature scaling: acting as
if the product is at a later stage than it actually is — scaling the
team, infrastructure, or feature surface before the core value is
validated. The same mismatch, miniaturized, is the most common cause of
miscalibrated engineering advice: treating a prototype like a production
system, or (rarer but real) a production system like a prototype. Every
recommendation should pass the question: "is this action matched to the
stage this product is actually at?"

## prototype — zero users

- Goal: learn whether the core idea has value, as fast as possible.
- Deploys are free. Breakage is free. There is nothing to protect yet.
- Schema changes: just change it. Drop and recreate. No migrations.
- Hard-code, stub, fake, and shortcut anything not on the critical
  learning path. YAGNI is the law: speculative generality (plugin
  systems, multi-tenancy, config layers "for later") is the main way
  prototypes die of old age.
- The main risk is NOT technical failure — it is building the wrong
  thing longer. Optimize for iteration speed and honest feedback.
- Caution theater (backups, staged rollouts, feature flags) is
  actively harmful here: it slows learning to protect nothing.

## early — a handful of known users

- Goal: find out what these specific users actually do and need.
- Ship fast, but tell users when things break or change. They are
  usually forgiving IF communicated with — early users signed up for a
  moving product.
- Keep a path to recover their data; losing an early believer's data
  burns trust you can't yet afford.
- Talk to them. A five-minute conversation with a real user outweighs
  a week of speculation. Ask about behavior, not opinions.
- Manual/concierge solutions are still correct. Automate only what
  repetition has proven necessary.

## live — real users depend on this

- Goal: deliver value reliably while continuing to learn.
- NOW migrations, backwards compatibility, rollout strategy, and
  monitoring genuinely matter. This is the stage all that caution was
  designed for.
- Prefer reversible releases: flags, gradual rollout, quick rollback.
- Weigh every new feature against added complexity for existing users;
  the product's clarity is now an asset with real value.
- Breaking changes need a communication plan, not just a code plan.

## mature — established, reputation at stake

- Goal: protect and compound existing value; change deliberately.
- Stability, performance, and trust are product features.
- New bets should be isolated from the core (separate surfaces,
  experiments) until proven.
- The main bias risk flips: loss aversion and incumbency thinking can
  smother necessary evolution. Distinguish "risky to users" from
  "uncomfortable to us."

## The direction of error

When stage is uncertain, note which error is worse in context:
treating prototype as live wastes speed on protecting nothing; treating
live as prototype burns real users. But do not resolve the uncertainty
by silently picking the cautious side — resolve it by ASKING. The
entire failure mode this plugin exists to fix is substituting assumed
stakes for actual ones.
