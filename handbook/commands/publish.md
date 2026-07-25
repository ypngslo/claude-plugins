---
description: Force a handbook sync now and report every action and refusal with its reason (normally unnecessary — hooks sync automatically on every page-file write).
---

Run `node ${CLAUDE_PLUGIN_ROOT}/bin/docs-sync.mjs sync --repo .` from the repo root
(foreground, so you see the output), then report to the user exactly what it did:
pages created, content updates, renames, moves, retires, label changes, and every
page it skipped **with the reason the CLI gave**. The refusals are the interesting
part — relay them verbatim, do not soften them:

- `NOT publishing — lint: <rule> at line N` — the audience gate blocks it; fix the
  page, don't argue with the linter.
- `first publish is the human's call — set approved: true` — ask the user for that
  page, explicitly, and set it only on their word.
- `draft — not published` — expected; the page is not ready.
- remote-edit drift (`live version N, we wrote M`) — someone edited the page in
  Confluence. Local files are authoritative; reconcile by editing the page file.
  Never flip `sync.onRemoteEdit` to `overwrite` without the user's say-so.
- `orphan <slug> → page <id> … is still live` — restore the file or retire it
  deliberately.
- the circuit breaker (`this pass would update N pages (max 25)`) — nothing was
  written. Inspect with `--dry-run` first; only pass `--force` once the user
  agrees the whole wave should go out.

The sync is idempotent and safe to rerun; a page that failed retries on the next
write or the next run. If the user asked about a PAST sync instead of a new one,
do not run anything — read `confluence/.sync.log` and summarize the relevant tail.
