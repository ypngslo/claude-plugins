# Voice — writing the same truth for a PM

The reader is a product manager who will never read the code and cannot ask a
follow-up question. Every "before" below is technically accurate and still
useless to them; most of the "before" lines are also lint errors. The rewrite is
never vaguer than the original — it is the same fact, stated from the user's
side.

Read the code first. You cannot do these rewrites from the "before" sentence
alone: the rewrite needs to know what actually happens to the person using the
product, and only the code tells you that.

## 1. Identifiers — name the behavior, not the symbol

> **Before:** The `CheckoutService.validateCart()` method runs before
> `submitOrder` is dispatched, and rejects carts where `items.length === 0`.

> **After:** Before an order is submitted, the cart is checked. An empty cart
> can't be submitted — the customer is told to add something first.

The class, the method, and the field are the repo's private vocabulary. The
reader needs the moment ("before an order is submitted") and the outcome ("can't
be submitted"). If the rewrite loses a fact you needed, it is because the fact
was about the code, not the product.

## 2. Flows — describe what the person does, in order

> **Before:** The invite endpoint creates a pending row, enqueues a job on the
> mailer worker, and flips `status` to `active` on the token callback.

> **After:** When someone invites a teammate, the teammate appears on the team
> list as **Invited** and gets an email with a join link. They become a full
> member the moment they open that link.

Flows are where docs leak hardest, because the implementation *is* a sequence and
it is tempting to just relabel the steps. Write the sequence the user can
observe: what they do, what they see, what changes.

## 3. Errors — say what the person sees and what to do

> **Before:** Returns 409 when the slug collides; the client surfaces the raw
> error from the API response body.

> **After:** If the name is already taken, saving fails and the form asks for a
> different name. Nothing else on the page is lost.

Status codes, exception names, and log strings are invisible to the reader. What
they need: the trigger, what the product shows them, and whether their work
survives.

## 4. Limits — state them as plainly as capabilities

> **Before:** Bulk import is capped by `MAX_BATCH = 500` per request; larger
> payloads are rejected upstream by the gateway.

> **After:** You can import up to 500 records at a time. A bigger file is
> refused outright — split it and import the parts.

> **Before:** Search is currently a naive `LIKE` query with no fuzzy matching.

> **After:** Search matches on exact wording only. A misspelled name won't find
> the record, and there are no suggestions yet.

The second pair is the one that gets skipped. "It doesn't do X yet" is the most
valuable sentence a PM can read, and the honest version of a limit never mentions
why the code is that way.

## 5. Settings — what it changes for the user, and who can change it

> **Before:** `retention_days` (default 30) is read from the workspace config at
> request time; set it via the admin API.

> **After:** Workspace admins choose how long deleted items stay recoverable.
> The default is 30 days; after that, deleted items are gone for good.

A setting is documented by its consequence and its audience. The key name, the
default's location, and how it is read are all implementation.

## 6. Numbers over adjectives

> **Before:** The sync is fast and handles large workspaces efficiently thanks to
> incremental hashing.

> **After:** A sync moves only the pages that changed, so a routine run finishes
> in seconds even for a few hundred pages. A first run of a large space takes a
> few minutes.

"Fast", "robust", "seamless", and "efficient" carry no information and cannot be
verified by a claim-checker. If you have a number from the code, use it; if you
don't, describe the shape of the behavior instead.

---

# The feature-page skeleton (fixed)

Every `feature` page uses exactly these sections, in this order. The three `##`
headings are required by the kind and the page cannot publish without them.

```markdown
---
title: Team invitations
kind: feature
parent: features
order: 20
sources: [src/invites, src/team/members]
status: draft
approved: false
---

One paragraph, 20–60 words, no heading above it: what this feature lets someone
do and why they'd want it. This paragraph becomes the summary line for this page
in the Features index, so it has to stand alone.

## What it does

The capability in the user's terms — what becomes possible, for whom. Two to
five short paragraphs or a short list. No sequence yet.

## How it behaves

The observable behavior: the steps someone takes, what they see at each one,
what happens on the unhappy paths (already taken, not permitted, nothing found).
Use a bulleted list or a small table when the behavior is conditional.

## Limits & known gaps

What it does not do, the ceilings, and the situations where it behaves in a way
that would surprise someone. Written as plainly as the capabilities above.
"None" is almost never true — if you truly believe there are no limits, you have
not read enough of the code.

## Editorial

(local only, never published) The gate trail plus any notes for the next person
who refreshes this page.

Audience-check: clean — 6 claims verified, reviewer clean

## Rework

(local only, never published) Confirmed gate findings, verbatim, when the page
was sent back to draft.
```

Optional extras between the required sections, when the feature earns them:

- `## Who it's for` — when the audience is narrower than "everyone".
- `## What changes for you` — on pages that document a change in behavior.
- a callout (`> [!NOTE]`) for the single most surprising thing on the page.

`index` pages are the exception: they carry the opening paragraph and a
`<!-- children -->` marker where the generated child table goes, and little else.
