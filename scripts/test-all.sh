#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ ! -f .tmp/dev-store-runtime.json ]] || { echo "Stop the demo first: npm run dev:down" >&2; exit 1; }
export INTERFACER_DB_CONTAINER="${INTERFACER_DB_CONTAINER:-interfacer-medusa-p6b-test-db}"
export INTERFACER_DB_PORT="${INTERFACER_DB_PORT:-55438}"
export DATABASE_URL="${DATABASE_URL:-postgres://medusa:medusa_local@127.0.0.1:$INTERFACER_DB_PORT/interfacer_medusa}"
if docker inspect "$INTERFACER_DB_CONTAINER" >/dev/null 2>&1; then
  owner=$(docker inspect --format '{{index .Config.Labels "interfacer.medusa.root"}}' "$INTERFACER_DB_CONTAINER")
  [[ "$owner" == "$PWD" ]] || { echo "Refusing a container not created for this project" >&2; exit 1; }
fi
mkdir -p .tmp
# Each harness stops its own PID sessions and this DB, even when it fails.
for suite in test test:http test:p1 test:p2 test:p3 test:p4 test:p5 test:p6a test:p6b; do
  echo "=== $suite ==="
  npm run "$suite" 2>&1 | tee ".tmp/all-${suite//:/-}.log"
done
echo "ALL HARNESS SUITES PASSED (9/9); no owned server or database left running."
