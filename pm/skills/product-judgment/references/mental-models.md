# Mental Models for Product Judgment

Distilled operating principles from the product management canon
(Cagan's Inspired, Perri's Escaping the Build Trap, Torres's Continuous
Discovery Habits, Ries's Lean Startup, Fitzpatrick's The Mom Test,
Singer's Shape Up, Christensen's Jobs to Be Done, Rumelt's Good Strategy
Bad Strategy, Duke's Thinking in Bets, Kahneman's Thinking Fast and
Slow). Use these as reasoning tools, not slogans.

## 1. Outcomes over output (the Build Trap)

Success is the value delivered, not the number of features shipped. A
team can ship constantly and create nothing. For every piece of work,
name the outcome — the change in user behavior or product health it
should cause — and evaluate the work by whether that change is plausible
and measurable. If a roadmap is a list of features with no outcomes
attached, it is a backlog, not a strategy.

## 2. Jobs to be done

People don't buy products; they hire them to make progress in a specific
situation. Define the job without naming a solution ("keep track of
what changed and why" — not "a dashboard"). Solutions masquerading as
needs are the most common way teams smuggle their favorite idea past
scrutiny. A well-formed job statement is stable over time and lets you
compare radically different solutions honestly.

## 3. The strategy kernel

A real strategy has three parts: a **diagnosis** of the central
challenge, a **guiding policy** for how to overcome it, and **coherent
actions** aligned with that policy. Goals are not strategy ("grow usage
20%" is a result, not an action). Vision is not strategy. If you cannot
state the diagnosis — what is actually hard or blocking right now — any
plan on top of it is decoration. Strategy also means focus: choosing
implies setting aside other goals, and a "strategy" that says no to
nothing is a political compromise, not a strategy.

## 4. Four risks, in order

Before building, weigh: **value risk** (will anyone want it?),
**usability risk** (can they figure it out?), **feasibility risk** (can
we build it?), **viability risk** (does it work for the business?).
Engineers naturally over-attend to feasibility; value risk kills far
more products. The cheapest possible test of value beats the most
elegant implementation of the wrong thing.

## 5. Validated learning over polished guessing

Treat significant product beliefs as hypotheses. Build the smallest
thing that tests the riskiest assumption, measure a real behavior, and
learn before investing further. "Better off dying than delivering"
applies to many projects: an idea that fails a cheap test early is a
win, not a failure.

## 6. Evidence over opinions (the Mom Test)

Opinions — including enthusiastic ones — are nearly worthless as
validation; people are polite, especially about ideas you clearly love.
Ask about past behavior and concrete facts ("when did this last happen?
what did you do? what did it cost you?"), never hypotheticals ("would
you use...?"). Compliments are a signal to dig, not to celebrate.
Commitment (time, money, reputation) is the only reliable positive
signal. This applies to the builder too: your own excitement is an
opinion.

## 7. Appetite: fixed time, variable scope

Estimates start with a design and end with a number; appetites start
with a number and end with a design. Decide how much a problem is worth
before designing the solution, then let the constraint force trade-offs.
Scope naturally grows; the discipline is constantly cutting it back to
what serves the core use case. Cutting scope well requires understanding
the problem deeply — it is a skill, not a shortcut, and it is how
products become differentiated rather than diluted.

## 8. Continuous discovery

Understanding of users decays. Contact with reality — usage data, user
conversations, watching someone actually use the thing — should be a
recurring habit, not a one-time research phase. Connect every solution
under consideration to a specific opportunity (pain, need, desire) and
every opportunity to the outcome it serves; if the chain breaks, the
solution is floating free of reality.

## 9. Bets, not certainties (decision quality)

Every product decision is a bet: a probability judgment made with
incomplete information. Judge decisions by the quality of the reasoning
and information at the time — not by how they turned out ("resulting").
Make reasoning explicit before outcomes are known (the Decisions Log
exists for this), state confidence levels, and define in advance what
evidence would change your mind. Strong opinions, loosely held —
updated eagerly when reality disagrees.

## 10. The bias checklist

The known failure modes of smart people making product decisions —
intelligence does not immunize against them:

- **Sunk cost:** continuing because of past investment rather than
  future value. Ask: knowing what we know now, would we start this
  today?
- **Confirmation bias:** seeking evidence that flatters the existing
  belief. Ask: what is the strongest case against, and who would make it?
- **Planning fallacy:** systematic underestimation of time and cost.
  Widen estimates; prefer smaller bets.
- **Anchoring:** over-weighting the first number or framing offered.
  Re-derive from scratch when the first frame came from the proposer.
- **Availability:** overweighting vivid, recent examples (the one loud
  user, last week's outage) over base rates.
- **Bandwagon / novelty:** adopting because others are, or because it's
  new. Fashion is not evidence of fit.
- **Loss aversion:** overprotecting what exists at the cost of what
  could be. At early stages there is little to lose — act like it.
- **Hindsight:** believing past outcomes were predictable, breeding
  false confidence in the next prediction.
- **IKEA effect:** overvaluing what we built ourselves. The author of a
  feature is its least reliable judge.

## 11. Do things that don't scale (at the right stage)

Manual processes, hard-coded lists, concierge onboarding, and
embarrassingly simple implementations are correct engineering at small
scale — they maximize learning per unit of effort. Automate and
generalize when repetition and evidence demand it, not when imagination
suggests it. See stage-playbook.md.
