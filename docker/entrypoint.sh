#!/bin/sh
# start: apply pending migrations, make sure the commerce context exists, serve.
# Anything else runs as a command in the image (e.g. `exec <script>`).
set -e
case "$1" in
  start)
    npx medusa db:migrate
    npx medusa exec ./src/scripts/pilot-bootstrap.js
    exec npx medusa start --host 0.0.0.0 --port "${PORT:-9000}"
    ;;
  exec)
    shift
    exec npx medusa exec "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
