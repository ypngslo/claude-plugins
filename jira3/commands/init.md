---
description: Set up jira3 local-first Jira tracking in the current repo (scaffolds jira/config.json + tasks dir, then walks the user through the config values).
---

Set up jira3 tracking in this repository:

1. Run `node ${CLAUDE_PLUGIN_ROOT}/bin/jira-sync.mjs init` from the repo root.
2. Open `jira/config.json` and fill it in WITH the user: `site`
   (`<org>.atlassian.net`), `projectKey`, `email` (their Atlassian login),
   and the `statusMap` — ask them for the exact status names in the target
   project's workflow (the defaults assume To Do / In Progress / Testing /
   Done). Do not guess status names; a wrong name makes every transition
   fail. If the Jira project is shared by several repos, set `labels` to a
   short repo slug (e.g. `["my-repo"]`) so this repo's issues stay
   distinguishable and filterable (`labels = my-repo`); leave it `[]` when
   the project serves only this repo.
3. Confirm the token: `JIRA_API_TOKEN` must be set in their environment
   (created at id.atlassian.com → API tokens). Check with
   `[ -n "$JIRA_API_TOKEN" ] && echo set`. Never write the token to any file.
4. Verify the round trip: create one real task file from
   `jira/tasks/_example.md.txt` describing something true, run
   `node ${CLAUDE_PLUGIN_ROOT}/bin/jira-sync.mjs sync --repo .`, and confirm
   the issue exists in Jira and the file gained its `jiraKey`.
5. Load the `jira-tasks` skill and follow its lifecycle contract from now on.
