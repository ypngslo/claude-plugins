# ypng-tools — Claude Code plugin marketplace

Claude Code plugins for local-first Jira tracking and product-management judgment.

## Install

```
/plugin marketplace add ypngslo/claude-plugins
/plugin install jira3@ypng-tools
```

| Plugin | Description |
| --- | --- |
| `jira3` | Local-first Jira tracking: task files in the repo are the source of truth; detached hooks mirror them to Jira with zero model cost. Done requires human approval. |
| `jira` | Jira commands, skills, and agents (predecessor of jira3). |
| `product-brain` | Gives Claude the context-awareness and judgment of a seasoned product manager. |

## Development

One-time setup after cloning — enables the git hooks:

```bash
git config core.hooksPath .githooks
```

The hooks and CI run the same scripts (`scripts/check-*.sh`), so green locally
means green in CI:

| Check | pre-commit | pre-push | CI |
| --- | --- | --- | --- |
| `check-secrets.sh` (gitleaks) | staged | | full history |
| `check-validate.sh` (`claude plugin validate`) | ✓ | | ✓ |
| `check-static.sh` (shellcheck, `node --check`, hook targets) | ✓ | | ✓ |
| `check-tests.sh` (plugin test suites) | | ✓ | ✓ |
| `check-versions.sh` (version-bump guard) | | ✓ | ✓ (PRs) |
| `check-install.sh` (fresh install smoke test) | | | ✓ |

Local prerequisites: the `claude` CLI, `jq`, plus [gitleaks](https://github.com/gitleaks/gitleaks/releases)
and optionally [shellcheck](https://github.com/koalaman/shellcheck/releases)
(single binaries; drop them in `~/.local/bin`).

Plugin versions are pinned by `version` in each plugin's
`.claude-plugin/plugin.json` — users only receive an update when that string
changes, so every change to a plugin must bump its version
(`check-versions.sh` enforces this).
