#!/bin/sh
# skytwin docker entrypoint — picks which app to run.
#
# The image bundles api, worker, and web to keep build/cache simple and
# images small relative to triple-build. CMD selects the entry point.
#
# Usage:
#   docker run skytwin                  # defaults to api
#   docker run skytwin api
#   docker run skytwin worker
#   docker run skytwin web
#   docker run skytwin migrate          # run db migrations and exit
#   docker run skytwin sh               # drop into a shell for debugging

set -e

APP="${1:-api}"

case "$APP" in
  api)
    exec node apps/api/dist/index.js
    ;;
  worker)
    exec node apps/worker/dist/index.js
    ;;
  web)
    exec node apps/web/dist/index.js
    ;;
  openclaw-bridge|openclaw)
    # Plain JS, no transpile step. Bridge to a local Ollama instance.
    exec node apps/openclaw-bridge/server.mjs
    ;;
  migrate)
    # Run database migrations and exit. Run this once per deploy before
    # rolling out a new api/worker that depends on a schema change. Reads
    # `*.sql` files from packages/db/dist/migrations and applies them in
    # name order (the Dockerfile copies them there alongside the compiled
    # JS).
    exec node packages/db/dist/migrations/001-initial.js
    ;;
  sh|shell)
    exec /bin/sh
    ;;
  *)
    echo "skytwin: unknown app '$APP'" >&2
    echo "usage: skytwin [api|worker|web|openclaw-bridge|migrate|sh]" >&2
    exit 64
    ;;
esac
