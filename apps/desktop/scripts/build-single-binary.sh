#!/usr/bin/env bash
# build-single-binary.sh — Prepare the turnkey single-binary bundle for SkyTwin Desktop.
#
# This script builds the API, worker, and web sub-apps and copies their compiled
# outputs into apps/desktop/dist/embedded/ so that electron-builder can package
# them as bundled resources inside the single-file installer (.dmg / .exe /
# .AppImage).
#
# The desktop Electron process (service-manager.ts) spawns the embedded API and
# worker as child processes and serves the embedded web dashboard from disk.
#
# Usage:
#   bash apps/desktop/scripts/build-single-binary.sh
#
# Required: run from the monorepo root.
#   cd /path/to/kyiv-v2 && bash apps/desktop/scripts/build-single-binary.sh
#
# ----------------------------------------------------------------------------------
# Embedded SQLite / SQLite-vec NOTE (v1.1 follow-up — issue #197):
#   Single-user (offline) mode will eventually use SQLite + the sqlite-vec vector
#   extension instead of CockroachDB. That work is explicitly deferred to v1.1
#   because it requires pinning a SQLite-vec release, verifying its sha256 hash,
#   and bundling the platform-specific native addon for macOS/Windows/Linux in a
#   single installer.
#
#   For v1 the desktop app connects to a CockroachDB instance via the
#   CRDB_CONNECTION_STRING environment variable, which the installer asks the user
#   to supply (or pre-fills for self-hosted users). No SQLite is bundled here.
# ----------------------------------------------------------------------------------

set -e  # Exit immediately on any error

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DESKTOP_DIR="${MONOREPO_ROOT}/apps/desktop"
EMBEDDED_DIR="${DESKTOP_DIR}/dist/embedded"

echo "[build-single-binary] Monorepo root: ${MONOREPO_ROOT}"
echo "[build-single-binary] Embedded output: ${EMBEDDED_DIR}"

# ---------------------------------------------------------------------------
# Step 1: Build each app that will be embedded.
# ---------------------------------------------------------------------------

echo ""
echo "[build-single-binary] Building @skytwin/api..."
pnpm --filter @skytwin/api build

echo ""
echo "[build-single-binary] Building @skytwin/worker..."
pnpm --filter @skytwin/worker build

echo ""
echo "[build-single-binary] Building @skytwin/web..."
pnpm --filter @skytwin/web build

# ---------------------------------------------------------------------------
# Step 2: Lay out the embedded output directory.
# ---------------------------------------------------------------------------

echo ""
echo "[build-single-binary] Creating embedded directory layout..."
mkdir -p "${EMBEDDED_DIR}/api"
mkdir -p "${EMBEDDED_DIR}/worker"
mkdir -p "${EMBEDDED_DIR}/web"

# ---------------------------------------------------------------------------
# Step 3: Copy compiled outputs into the embedded tree.
#
# We copy dist/ (compiled JS) and node_modules/ (runtime deps) so the embedded
# API and worker can be launched with plain `node dist/index.js` without any
# additional install step inside the packaged app.
# ---------------------------------------------------------------------------

echo ""
echo "[build-single-binary] Copying API output..."
cp -R "${MONOREPO_ROOT}/apps/api/dist/"        "${EMBEDDED_DIR}/api/dist/"
cp    "${MONOREPO_ROOT}/apps/api/package.json"  "${EMBEDDED_DIR}/api/package.json"
if [ -d "${MONOREPO_ROOT}/apps/api/node_modules" ]; then
  cp -R "${MONOREPO_ROOT}/apps/api/node_modules/" "${EMBEDDED_DIR}/api/node_modules/"
fi

echo ""
echo "[build-single-binary] Copying worker output..."
cp -R "${MONOREPO_ROOT}/apps/worker/dist/"        "${EMBEDDED_DIR}/worker/dist/"
cp    "${MONOREPO_ROOT}/apps/worker/package.json"  "${EMBEDDED_DIR}/worker/package.json"
if [ -d "${MONOREPO_ROOT}/apps/worker/node_modules" ]; then
  cp -R "${MONOREPO_ROOT}/apps/worker/node_modules/" "${EMBEDDED_DIR}/worker/node_modules/"
fi

echo ""
echo "[build-single-binary] Copying web output..."
if [ -d "${MONOREPO_ROOT}/apps/web/public" ]; then
  cp -R "${MONOREPO_ROOT}/apps/web/public/" "${EMBEDDED_DIR}/web/"
elif [ -d "${MONOREPO_ROOT}/apps/web/dist" ]; then
  cp -R "${MONOREPO_ROOT}/apps/web/dist/" "${EMBEDDED_DIR}/web/"
else
  echo "[build-single-binary] WARNING: No built web output found at apps/web/public or apps/web/dist."
fi

# ---------------------------------------------------------------------------
# Step 4: Copy workspace package dist/ outputs.
#
# The embedded API and worker import @skytwin/* packages by resolved path at
# runtime. Copy all package dist/ directories so they are available inside the
# bundle without requiring the full node_modules symlink tree from pnpm.
# ---------------------------------------------------------------------------

echo ""
echo "[build-single-binary] Copying workspace package dist outputs..."
mkdir -p "${EMBEDDED_DIR}/packages"
for pkg_dir in "${MONOREPO_ROOT}/packages"/*/; do
  pkg_name="$(basename "${pkg_dir}")"
  if [ -d "${pkg_dir}dist" ]; then
    mkdir -p "${EMBEDDED_DIR}/packages/${pkg_name}"
    cp -R "${pkg_dir}dist/"        "${EMBEDDED_DIR}/packages/${pkg_name}/dist/"
    cp    "${pkg_dir}package.json" "${EMBEDDED_DIR}/packages/${pkg_name}/package.json" 2>/dev/null || true
  fi
done

# ---------------------------------------------------------------------------
# Step 5: Write a manifest file so the Electron main process can verify the
# bundle contents at startup.
# ---------------------------------------------------------------------------

MANIFEST_FILE="${EMBEDDED_DIR}/bundle-manifest.json"
cat > "${MANIFEST_FILE}" <<MANIFEST
{
  "bundledAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "components": ["api", "worker", "web"],
  "sqliteVecStatus": "deferred-v1.1-issue-197",
  "crdbConnectionRequired": true
}
MANIFEST

echo ""
echo "[build-single-binary] Bundle manifest written: ${MANIFEST_FILE}"

# ---------------------------------------------------------------------------
# TODO(#188 follow-up — issue #197): SQLite-vec embed
#
#   When single-user offline mode lands:
#     1. Pin a specific sqlite-vec release tag and sha256 hash.
#     2. Download the platform-specific prebuilt binary here.
#     3. Verify the sha256 before unpacking:
#          echo "<expected-sha256>  sqlite-vec-<version>-${PLATFORM}.tar.gz" | sha256sum -c
#     4. Place the native addon at:
#          ${EMBEDDED_DIR}/sqlite-vec/sqlite_vec.node
#     5. Update bundle-manifest.json to set sqliteVecStatus: "bundled".
#
#   Do NOT bundle SQLite-vec without hash verification — supply-chain safety.
# ---------------------------------------------------------------------------

echo ""
echo "[build-single-binary] Single-binary build prepared."
echo "  Output: ${EMBEDDED_DIR}"
echo ""
echo "  Next steps:"
echo "    1. Run electron-builder to produce the final installer:"
echo "       pnpm --filter @skytwin/desktop package:mac   # or :win / :linux / :all"
echo "    2. For signed builds, set SKYTWIN_SIGN_RELEASE=true and all required"
echo "       signing env vars, then run:"
echo "       npx ts-node apps/desktop/scripts/sign-and-notarize.ts -- --mac --win --linux"
echo ""
