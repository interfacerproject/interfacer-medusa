#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
mkdir -p .cache/npm .cache/config .tmp
export npm_config_cache="$ROOT/.cache/npm"
export XDG_CONFIG_HOME="$ROOT/.cache/config"
export TMPDIR="$ROOT/.tmp"
export MEDUSA_DISABLE_TELEMETRY=true
export DATABASE_URL="${DATABASE_URL:-postgres://medusa:medusa_local@127.0.0.1:55432/interfacer_medusa}"
export INTERFACER_DB_CONTAINER="${INTERFACER_DB_CONTAINER:-interfacer-medusa-spike-db}"
DB="$INTERFACER_DB_CONTAINER"

check_owned() {
  local label
  label=$(docker inspect --format '{{index .Config.Labels "interfacer.medusa.spike"}}' "$DB")
  [[ "$label" == true ]] || { echo "Refusing to touch an unowned container: $DB" >&2; return 1; }
}
db_up() {
  if docker container inspect "$DB" >/dev/null 2>&1; then
    check_owned
    docker start "$DB" >/dev/null
  else
    docker run -d --name "$DB" --label interfacer.medusa.spike=true \
      -e POSTGRES_USER=medusa -e POSTGRES_PASSWORD=medusa_local -e POSTGRES_DB=interfacer_medusa \
      -p "127.0.0.1:${INTERFACER_DB_PORT:-55432}:5432" postgres:15-alpine >/dev/null
  fi
  for _ in {1..45}; do
    if docker exec "$DB" pg_isready -U medusa -d interfacer_medusa >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo "Postgres did not become ready" >&2; return 1
}
db_stop() {
  if docker container inspect "$DB" >/dev/null 2>&1; then
    check_owned
    docker stop "$DB" >/dev/null
  fi
}
setup() {
  db_up
  [[ -f medusa/.env ]] || cp medusa/.env.example medusa/.env
  local hash
  hash=$(node -e 'const f=require("fs"),c=require("crypto");console.log(c.createHash("sha256").update(f.readFileSync("medusa/package-lock.json")).update(f.readFileSync("medusa/package.json")).digest("hex"))')
  if [[ ! -x medusa/node_modules/.bin/medusa ]] || [[ ! -f .tmp/dependencies.hash ]] || [[ "$(< .tmp/dependencies.hash)" != "$hash" ]]; then
    npm ci --prefix medusa --no-audit --no-fund
    printf '%s' "$hash" > .tmp/dependencies.hash
  fi
  npm --prefix medusa run typecheck
  npm --prefix medusa run db:migrate
}
fixture_env() {
  export INTERFACER_AUTH_MODE=fixture-controller-stub
  export INTERFACER_FIXTURE_PERSON="${INTERFACER_FIXTURE_PERSON:-01JTESTPERSON00000000000001}"
}
case "${1:-test}" in
  setup) setup ;;
  test)
    # This command owns the brief server and stops only this labeled DB.
    trap db_stop EXIT
    setup
    fixture_env
    npm --prefix medusa run verify
    python3 scripts/probe.py
    echo "PASS finished; HTTP server and spike DB stopped (data retained)."
    ;;
  test:http)
    trap db_stop EXIT
    setup
    fixture_env
    python3 scripts/http-probe.py
    ;;
  test:p5)
    trap db_stop EXIT
    setup
    fixture_env
    (cd medusa && ./node_modules/.bin/medusa exec ./src/scripts/seed-matching.ts)
    python3 scripts/p5-probe.py
    echo "PASS P5 finished; HTTP server and spike DB stopped (data retained)."
    ;;
  test:p4)
    trap db_stop EXIT
    setup
    (cd medusa && ./node_modules/.bin/ts-node src/tests/matching.test.ts)
    fixture_env
    (cd medusa && ./node_modules/.bin/medusa exec ./src/scripts/seed-matching.ts)
    python3 scripts/p4-probe.py
    (cd medusa && ./node_modules/.bin/medusa exec ./src/scripts/verify-p4.ts)
    echo "PASS P4 finished; HTTP server and spike DB stopped (data retained)."
    ;;
  seed:matching)
    trap db_stop EXIT
    setup
    fixture_env
    (cd medusa && ./node_modules/.bin/medusa exec ./src/scripts/seed-matching.ts)
    ;;
  test:p3)
    trap db_stop EXIT
    setup
    fixture_env
    python3 scripts/p3-probe.py
    echo "PASS P3 finished; HTTP server and spike DB stopped (data retained)."
    ;;
  test:p2)
    trap db_stop EXIT
    setup
    fixture_env
    python3 scripts/p2-probe.py
    echo "PASS P2 finished; HTTP server and spike DB stopped (data retained)."
    ;;
  test:p1)
    trap db_stop EXIT
    setup
    fixture_env
    python3 scripts/p1-probe.py
    echo "PASS P1 finished; HTTP server and spike DB stopped (data retained)."
    ;;
  seed:commerce|publish)
    trap db_stop EXIT
    setup
    fixture_env
    npm --prefix medusa run "$1"
    ;;
  start)
    # develop may normalize NODE_ENV; reject production before launching it.
    [[ "${NODE_ENV:-}" != production ]] || { echo "Refusing local fixture API in production" >&2; exit 1; }
    db_up
    fixture_env
    # Foreground; Ctrl-C stops the app. Run 'stop' separately for the DB.
    cd medusa
    exec ./node_modules/.bin/medusa develop --host 127.0.0.1 --port 9000 --no-types
    ;;
  project)
    db_up
    fixture_env
    npm --prefix medusa run project
    ;;
  inspect)
    db_up
    npm --prefix medusa run inspect
    ;;
  stop) db_stop ;;
  *) echo "Usage: bash scripts/spike.sh {test|test:http|test:p1|test:p2|test:p3|test:p4|test:p5|seed:matching|seed:commerce|publish|setup|start|project|inspect|stop}" >&2; exit 2 ;;
esac
