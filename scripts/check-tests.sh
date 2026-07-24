#!/usr/bin/env bash
# Run every plugin's test suite (any plugin directory containing test/run.sh).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

ran=0
while IFS= read -r runner; do
  echo "check-tests: running $runner"
  (cd "$(dirname "$(dirname "$runner")")" && ./test/run.sh)
  ran=$((ran + 1))
done < <(git ls-files '*/test/run.sh')

echo "check-tests: OK ($ran suite(s))"
