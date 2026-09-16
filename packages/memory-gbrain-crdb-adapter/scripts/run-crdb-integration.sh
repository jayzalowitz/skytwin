#!/usr/bin/env bash
#
# Spin up a local CockroachDB single-node instance via Docker, apply the
# brain_* migrations, create a test user row, run the DB-gated integration
# tests, then tear everything down.
#
# Usage:
#   ./scripts/run-crdb-integration.sh
#
# Requirements:
#   - docker installed and running
#   - pnpm + node 20+ (same as the rest of the repo)
#
# Why it exists: the integration-crdb.test.ts suite is skipped unless
# RUN_DB_TESTS=1 is set. This script provides the "set it + run it"
# experience so the SQL paths in repository.ts get exercised against a
# real CRDB before merge. Hermetic — leaves no Docker container behind.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

CONTAINER_NAME="${CONTAINER_NAME:-skytwin-gbrain-crdb-test}"
PORT="${PORT:-26259}"  # non-default so it doesn't collide with a dev cluster
PG_PORT="$PORT"
DB_NAME="skytwin_test"
COCKROACH_IMAGE="${COCKROACH_IMAGE:-cockroachdb/cockroach:latest-v23.2}"
COCKROACH_BIN="/cockroach/cockroach"
BRAIN_MIGRATIONS=(
  packages/db/src/migrations/040-gbrain-memory.sql
  packages/db/src/migrations/043-brain-tier-weighting.sql
  packages/db/src/migrations/044-brain-tier-weighting-default-on.sql
  packages/db/src/migrations/052-brain-pages-metadata-index.sql
)
CONTAINER_ID=""

crdb_sql() {
  docker exec "$CONTAINER_NAME" "$COCKROACH_BIN" sql \
    --insecure --host=127.0.0.1:26257 "$@"
}

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "[harness] container name already exists: $CONTAINER_NAME" >&2
  echo "[harness] choose a unique CONTAINER_NAME; the existing container was not modified" >&2
  exit 1
fi

cleanup() {
  if [ -z "$CONTAINER_ID" ]; then
    return
  fi
  echo "[harness] tearing down $CONTAINER_ID ($CONTAINER_NAME)"
  docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[harness] starting cockroachdb container on port $PORT"
CONTAINER_ID=$(docker run -d --name "$CONTAINER_NAME" \
  -p "127.0.0.1:${PORT}:26257" \
  --entrypoint "$COCKROACH_BIN" \
  "$COCKROACH_IMAGE" \
  start-single-node --insecure --listen-addr=0.0.0.0:26257)
if [ -z "$CONTAINER_ID" ]; then
  echo "[harness] docker did not return a container id; aborting" >&2
  exit 1
fi

echo "[harness] waiting for cockroach to accept connections"
ready=0
for i in {1..30}; do
  if crdb_sql --execute "SELECT 1" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" = "0" ]; then
  echo "[harness] cockroach failed to accept connections within 30s; aborting"
  docker logs "$CONTAINER_ID" 2>&1 | tail -20 || true
  exit 1
fi

echo "[harness] creating test database"
crdb_sql --execute "CREATE DATABASE IF NOT EXISTS $DB_NAME" >/dev/null

# brain_* tables reference users(id) via FK. CRDB FKs cannot cross databases,
# so inline a minimal users table into skytwin_test BEFORE applying the
# migration. In production the users table is created via the main schema.
echo "[harness] inlining minimal users table for FK resolution"
crdb_sql --database "$DB_NAME" --execute \
  "CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email STRING NOT NULL UNIQUE, name STRING NOT NULL DEFAULT '', trust_tier STRING NOT NULL DEFAULT 'observer', autonomy_settings JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())" >/dev/null

echo "[harness] applying brain_* migrations"
for migration in "${BRAIN_MIGRATIONS[@]}"; do
  echo "[harness]   $(basename "$migration")"
  docker exec -i "$CONTAINER_NAME" "$COCKROACH_BIN" sql \
    --insecure --host=127.0.0.1:26257 --database "$DB_NAME" \
    < "$migration" >/dev/null
done

echo "[harness] seeding test user"
TEST_USER_ID=$(crdb_sql --database "$DB_NAME" --format=tsv --execute \
  "INSERT INTO users (email, name) VALUES ('test@example.com', 'Test') RETURNING id" | tail -n 1 | tr -d '[:space:]')
if [ -z "$TEST_USER_ID" ]; then
  echo "[harness] failed to seed test user; aborting"
  exit 1
fi
echo "[harness] test user id: $TEST_USER_ID"

echo "[harness] running RUN_DB_TESTS=1 integration suite"
export DATABASE_HOST=localhost
export DATABASE_PORT="$PG_PORT"
export DATABASE_NAME="$DB_NAME"
export DATABASE_USER=root
export DATABASE_SSL=false
export RUN_DB_TESTS=1
export TEST_USER_ID

pnpm --filter @skytwin/memory-gbrain-crdb-adapter test
