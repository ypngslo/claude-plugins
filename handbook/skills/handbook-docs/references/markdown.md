# The supported markdown subset

The renderer converts a page body to Confluence storage XML. It supports exactly
what is listed here and **fails closed**: anything else raises a render error
naming the 1-based source line and the construct. Nothing is ever silently
dropped, so a render failure is a page you must fix, not a warning you can carry.

Only the body above `## Editorial` is rendered. Frontmatter is not markdown.

## Headings

```markdown
## What it does
### A sub-point
```

`##` through `######` become Confluence headings. **`#` is an error** — the page
title comes from frontmatter; repeating it as an H1 is the single most common
render failure.

## Paragraphs and inline marks

```markdown
Ordinary text becomes a paragraph. **Bold**, *italic* (or _italic_), `inline
code`, and ~~struck-through~~ text all work inline.
```

Inline code renders as code, but remember the audience rules: a body should
rarely contain any. A line ending in two spaces becomes a line break.

## Lists

```markdown
- One
- Two
  - Nested under two
  1. And a numbered child
- Three

1. First
2. Second
```

`-`, `*`, and `+` all start bullets; `1.` starts a numbered list. Nesting is
**two spaces** per level and list types may be mixed. A nested list renders
inside its parent item.

## Task lists

```markdown
- [ ] Not done yet
- [x] Done
```

Renders as a real Confluence task list with checkable boxes.

## Blockquote

```markdown
> A single level of quoting, which becomes a Confluence blockquote.
```

**Nested blockquotes are an error.** A `>` line that starts with `[!...]` is a
callout instead (below).

## Callouts (panels)

```markdown
> [!WARNING] Data loss
> Deleting a workspace removes every item in it. This cannot be undone.

> [!NOTE]
> The title is optional; without one, the panel renders untitled.
```

Six types map to four Confluence panels:

| Marker | Panel |
| ------ | ----- |
| `[!NOTE]`, `[!INFO]` | info |
| `[!TIP]` | tip |
| `[!IMPORTANT]` | note |
| `[!WARNING]`, `[!CAUTION]` | warning |

Everything on the following `>` lines is the panel body and may contain
paragraphs and lists.

## Expand

```markdown
:::expand What happens to items already in flight
Items that were already being processed finish normally. Nothing is cancelled
mid-run.
:::
```

`:::expand <Title>` … `:::` becomes a collapsed expand macro. The title is
required; the body may contain block content.

## Code blocks

````markdown
```bash
handbook status
```
````

Fenced code becomes a Confluence code macro. The language is only passed through
when it is in the configured `render.codeLanguages` allowlist; otherwise the
block still renders, without syntax highlighting.

**Most kinds forbid code blocks entirely** (`allowCodeBlocks: false`) and lint
reports a fence on such a page as an error. Code belongs on `reference` pages, if
anywhere. This is an audience rule, not a technical one.

## Tables

```markdown
| Plan | Members | Storage |
| ---- | :-----: | ------: |
| Free | 3 | 1 GB |
| Team | 50 | 100 GB |
```

GFM pipe tables. The first row is the header. The alignment row controls column
alignment (`:---:` centre, `---:` right, anything else left).

## Horizontal rule

```markdown
---
```

A `---` on its own line (not at the top of the file, where it opens the
frontmatter) becomes a divider.

## Links

```markdown
[Atlassian status page](https://status.atlassian.com)
[email the team](mailto:team@example.com)
```

External links must be `https://`, `http://`, or `mailto:`.

## Cross-links between pages

```markdown
See [Team invitations](feature-invites.md) for how membership works.
Jump straight to [the limits](feature-invites.md#Limits & known gaps).
```

The target is another page's **filename**, and it renders as a real Confluence
page link that survives renames. An optional `#Heading` suffix anchors to a
heading on that page. A link to a slug with no page file is an error.

## Images

```markdown
![The team settings screen](https://example.com/shots/team-settings.png)
```

Only remotely-hosted images. **A local image path is an error** — attachments are
deferred to a later version, so a screenshot must live at a URL Confluence can
reach.

## Status lozenges

```markdown
[[status:Green|Available now]]
[[status:Yellow|In beta]]
```

The colour must be one of `Grey`, `Red`, `Yellow`, `Green`, `Blue`, spelled
exactly like that (capitalized, British `Grey`). Anything else is an error.

## The children marker

```markdown
<!-- children -->
```

On an `index` page, this is where the generated table of child pages goes (page
title, summary paragraph, kind). Without the marker, the table is appended at the
end. On any other kind, the marker is an error. Only published, non-retired
children appear, sorted by `order` then slug.

## Not supported — every one of these is a render error

- **Raw HTML tags** of any kind (`<div>`, `<br>`, `<b>`, …). Use the constructs
  above; there is no escape hatch into storage XML.
- **Footnotes** (`[^1]`).
- **Reference-style links** (`[text][ref]` with a `[ref]:` definition).
- **Autolinks** (`<https://example.com>`) — write `[text](https://example.com)`.
- **Setext headings** (a line underlined with `===` or `---`).
- **Definition lists**.
- **HTML entities** beyond the five XML ones (`&amp;` `&lt;` `&gt;` `&quot;`
  `&apos;`). Write the character itself; escaping is handled for you.
- **`#` H1 headings**, **nested blockquotes**, and **local image paths**, as
  noted above.

When you need something outside the subset, the answer is almost always that the
page is trying to be a technical document. Rewrite it for the reader instead.
