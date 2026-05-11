#!/usr/bin/env bash
#
# Spin up a local CockroachDB single-node instance via Docker, apply the
# brain_* migration, create a test user row, run the DB-gated integration
# tests, then tear everything down.
#
# Usage:
#   ./scripts/run-crdb-integration.sh
#
# Requirements:
#   - docker installed and running
#   - psql client on PATH (brew install libpq && brew link --force libpq)
#   - pnpm + node 20+ (same as the rest of the repo)
#
# Why it exists: the integration-crdb.test.ts suite is skipped unless
# RUN_DB_TESTS=1 is set. This script provides the "set it + run it"
# experience so the SQL paths in repository.ts get exercised against a
# real CRDB before merge. Hermetic — leaves no Docker container behind.

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-skytwin-gbrain-crdb-test}"
PORT="${PORT:-26259}"  # non-default so it doesn't collide with a dev cluster
PG_PORT="$PORT"
DB_NAME="skytwin_test"

cleanup() {
  echo "[harness] tearing down $CONTAINER_NAME"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[harness] starting cockroachdb container on port $PORT"
docker run -d --name "$CONTAINER_NAME" \
  -p "${PORT}:26257" \
  cockroachdb/cockroach:latest-v23.2 \
  start-single-node --insecure --listen-addr=0.0.0.0 >/dev/null

echo "[harness] waiting for cockroach to accept connections"
for i in {1..30}; do
  if PGPASSWORD= psql "postgres://root@localhost:${PG_PORT}/defaultdb?sslmode=disable" \
    -c "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[harness] creating test database and user"
psql "postgres://root@localhost:${PG_PORT}/defaultdb?sslmode=disable" -c \
  "CREATE DATABASE IF NOT EXISTS $DB_NAME" >/dev/null
psql "postgres://root@localhost:${PG_PORT}/defaultdb?sslmode=disable" -c \
  "CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email STRING NOT NULL UNIQUE, name STRING NOT NULL DEFAULT '', trust_tier STRING NOT NULL DEFAULT 'observer', autonomy_settings JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())" >/dev/null
# Note: in production the users table is created via the main schema; we
# inline a minimal version here so the brain_* FKs resolve.

echo "[harness] applying brain_* migration"
psql "postgres://root@localhost:${PG_PORT}/${DB_NAME}?sslmode=disable" \
  -f packages/db/src/migrations/040-gbrain-memory.sql >/dev/null
# users table is in defaultdb; brain_* are in skytwin_test → FK won't
# cross databases. Inline the users table into skytwin_test too.
psql "postgres://root@localhost:${PG_PORT}/${DB_NAME}?sslmode=disable" -c \
  "CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email STRING NOT NULL UNIQUE, name STRING NOT NULL DEFAULT '', trust_tier STRING NOT NULL DEFAULT 'observer', autonomy_settings JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())" >/dev/null
psql "postgres://root@localhost:${PG_PORT}/${DB_NAME}?sslmode=disable" \
  -f packages/db/src/migrations/040-gbrain-memory.sql >/dev/null

echo "[harness] seeding test user"
TEST_USER_ID=$(psql -t "postgres://root@localhost:${PG_PORT}/${DB_NAME}?sslmode=disable" -c \
  "INSERT INTO users (email, name) VALUES ('test@example.com', 'Test') RETURNING id" | tr -d ' \n')
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
