# Product Brain

A Claude Code plugin that makes Claude reason about your project like a
seasoned product manager instead of a context-free engineer.

## What it fixes

- **Assumed stakes:** Claude treating a zero-user prototype like a
  production system (or vice versa), because it infers importance from
  surface signals instead of facts.
- **Mistimed work:** cool-but-speculative features getting built while
  current-user value sits unaddressed, because nobody is holding the
  line on purpose and priorities.

## How it works

- Each project gets a one-page `PRODUCT.md` (created via a short,
  investigation-first interview) recording what the product is, its
  honest stage and usage, current priorities, a not-now list, and a
  decisions log.
- The **product-context** skill auto-loads that reality whenever
  planning or risk assessment happens, and calibrates advice to the
  product's actual stage.
- The **product-judgment** skill evaluates proposals — anyone's,
  including Claude's own — against purpose, priorities, outcomes, and a
  cognitive-bias checklist distilled from the PM canon.
- `/product-review [proposal]` runs a structured PM review;
  `/product-update` keeps PRODUCT.md honest as the project evolves;
  `@product-brain:pm-reviewer` gives an independent deep review.

## Install

Add this plugin's marketplace/repo per the Claude Code plugins docs,
then enable `product-brain`. On first planning conversation in a repo
without PRODUCT.md, Claude will offer to run the setup interview.
