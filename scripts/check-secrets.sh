#!/usr/bin/env bash
# Secret scan. `staged` mode gates commits (stops a secret before it enters
# history — CI can only find it after it's already public); `history` mode
# scans the full repo history in CI.
#
# Usage: check-secrets.sh [staged|history]   (default: history)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! command -v gitleaks >/dev/null; then
  echo "check-secrets: gitleaks not installed." >&2
  echo "  install: https://github.com/gitleaks/gitleaks/releases (single binary, drop in ~/.local/bin)" >&2
  exit 1
fi

mode=${1:-history}
case $mode in
  staged) gitleaks git --pre-commit --staged --no-banner --redact ;;
  history) gitleaks git --no-banner --redact ;;
  *) echo "check-secrets: unknown mode '$mode'" >&2; exit 2 ;;
esac

echo "check-secrets: OK ($mode)"
