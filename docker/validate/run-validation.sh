#!/usr/bin/env bash
#
# Runs inside a validation container. Drives `install.sh` end-to-end and
# asserts the dashboard responds. Exits 0 on success, non-zero on failure.
#
# The orchestrator (bin/validate-installs) mounts a snapshot tarball of
# the working tree at /tmp/skytwin-source.tar. We untar it into
# $HOME/skytwin and run install.sh from there. Anything install.sh writes
# (.env, .logs, node_modules, the CRDB binary under
# ~/.local/share/skytwin) lands in the container's writable layer — the
# host filesystem is never touched.

set -euo pipefail

REPO_DIR="${SKYTWIN_INSTALL_DIR:-$HOME/skytwin}"
SOURCE_TAR="/tmp/skytwin-source.tar"
DASHBOARD_URL="http://localhost:3200"
API_URL="http://localhost:3100/api/health"

echo "=== validation start: $(uname -s) $(uname -m) ==="
echo "HOME=$HOME"
echo "REPO_DIR=$REPO_DIR"
echo "SOURCE_TAR=$SOURCE_TAR"
echo "USER=$(id -un) ($(id -u):$(id -g))"

if [ ! -f "$SOURCE_TAR" ]; then
  echo "FAIL: $SOURCE_TAR not mounted (orchestrator didn't supply --volume)?" >&2
  exit 1
fi

echo "==> Unpacking source tarball into $REPO_DIR"
mkdir -p "$REPO_DIR"
tar -xf "$SOURCE_TAR" -C "$REPO_DIR"

# Run the installer pointed at the bind-mounted repo. SKYTWIN_BRANCH stays
# at default since install.sh tolerates offline fetch gracefully now.
export SKYTWIN_INSTALL_DIR="$REPO_DIR"
echo "==> Running install.sh"
# Unbuffered sed: without --unbuffered, the docker logs don't flush during
# multi-minute installs (pnpm install / pnpm build), making it look like
# the container has hung when it's actually progressing fine. GNU sed has
# this flag; the alpine/busybox sed in the validation images supports it
# too via the same name.
"$REPO_DIR/install.sh" 2>&1 | sed --unbuffered 's/^/  install.sh | /'

# install.sh waits for the dashboard itself, but re-check to be sure and
# to give a clear "validated" signal in the log.
echo "==> Probing dashboard at $DASHBOARD_URL"
ok=0
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "$DASHBOARD_URL"; then
    ok=1
    break
  fi
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "FAIL: dashboard did not respond at $DASHBOARD_URL within 60s" >&2
  echo "--- skytwin-dev log (tail 60) ---"
  tail -n 60 "$REPO_DIR/.logs/skytwin-dev.log" 2>/dev/null || echo "(no log)"
  echo "--- api log (tail 40) ---"
  tail -n 40 "$REPO_DIR/.logs/skytwin-api.log" 2>/dev/null || echo "(no log)"
  echo "--- web log (tail 20) ---"
  tail -n 20 "$REPO_DIR/.logs/skytwin-web.log" 2>/dev/null || echo "(no log)"
  exit 1
fi

echo "==> Probing API health"
if ! curl -sf "$API_URL" >/dev/null; then
  echo "FAIL: API not healthy at $API_URL" >&2
  exit 1
fi

# Quick sanity: verify the native CRDB binary is actually being used,
# not Docker. The validation harness ought to prove the grandma path.
CRDB_BIN="$HOME/.local/share/skytwin/bin/cockroach"
if [ ! -x "$CRDB_BIN" ]; then
  echo "FAIL: expected native cockroach at $CRDB_BIN — was Docker silently used?" >&2
  exit 1
fi
echo "==> Native CockroachDB at $CRDB_BIN: $($CRDB_BIN version --build-tag 2>/dev/null || echo unknown)"

echo "=== validation PASSED ==="

# Tear down so the container exits cleanly. If install.sh's processes
# (skytwin-dev, cockroach) stay alive they'll block container exit.
"$REPO_DIR/bin/skytwin-dev" --stop 2>&1 | sed 's/^/  stop | /' || true
"$REPO_DIR/bin/skytwin-db" stop 2>&1 | sed 's/^/  stop | /' || true
