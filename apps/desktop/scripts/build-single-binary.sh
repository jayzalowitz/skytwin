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
# Step 0: Bundled CockroachDB binaries.
#
# Until v0.6.55 the desktop app shelled out to a Docker-launched CRDB. That
# meant grandma had to install Docker Desktop (massive download, license,
# "open it once" gotcha) before the app could even start. We now ship the
# official CRDB binary inside the bundle, one per target platform, under:
#
#   dist/embedded/cockroach/<platform-arch>/cockroach[.exe]
#
# The Electron main process (apps/desktop/src/cockroach-manager.ts)
# resolves the right binary at runtime by checking
# `${process.platform}-${process.arch}`. extraResources in
# package.json's electron-builder block ships the whole tree.
#
# Hashes are verified against the published .sha256sum sidecar to prevent
# supply-chain tampering. If the hash doesn't match, the build fails —
# never extract a binary we can't vouch for.
# ---------------------------------------------------------------------------

CRDB_VERSION="${SKYTWIN_CRDB_VERSION:-23.2.30}"
CRDB_CACHE_DIR="${HOME}/.cache/skytwin/crdb-binaries"
mkdir -p "${CRDB_CACHE_DIR}"

# Format: <platform-arch>|<url>|<expected sha256>|<archive type>
# Keep this list in sync with bin/skytwin-db's binary_sha256() table —
# both consume the same release set, just via different paths (dev vs
# packaged bundle).
CRDB_TARGETS=(
  "darwin-arm64|https://binaries.cockroachdb.com/cockroach-v${CRDB_VERSION}.darwin-11.0-arm64.tgz|83203c19fde34a718fee121afc1810c11b7e22ccad6fd060fc99f77d690036c2|tgz"
  "darwin-x64|https://binaries.cockroachdb.com/cockroach-v${CRDB_VERSION}.darwin-10.9-amd64.tgz|d4ffbfb51bfbf751b412c5abbcefa3d0bcc1a28ea80eefe73cea53eb491e8345|tgz"
  "linux-x64|https://binaries.cockroachdb.com/cockroach-v${CRDB_VERSION}.linux-amd64.tgz|de0feb06aac76c530710fbd2c5cdb8c274b05b598c4257ce5bc5f3b6c4302251|tgz"
  "linux-arm64|https://binaries.cockroachdb.com/cockroach-v${CRDB_VERSION}.linux-arm64.tgz|196936e94587a145c1326a8b0fe9a048475cca8e3d8ad60a70c7728c8b402474|tgz"
  "win32-x64|https://binaries.cockroachdb.com/cockroach-v${CRDB_VERSION}.windows-6.2-amd64.zip|4ac0441885dcb2260130b90aba4d638b303ad0ccb8dddc2581d50477e764effa|zip"
)

sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

bundle_crdb_binary() {
  local entry="$1"
  IFS='|' read -r platform url expected_sha archive_type <<< "$entry"

  local bin_name="cockroach"
  if [[ "$platform" == win32-* ]]; then bin_name="cockroach.exe"; fi

  local dest_dir="${EMBEDDED_DIR}/cockroach/${platform}"
  local dest_bin="${dest_dir}/${bin_name}"
  if [ -x "${dest_bin}" ]; then
    echo "  [crdb] ${platform}: already bundled, skipping."
    return
  fi

  local archive_name
  archive_name="$(basename "$url")"
  local cache_archive="${CRDB_CACHE_DIR}/${archive_name}"

  if [ ! -f "${cache_archive}" ]; then
    echo "  [crdb] ${platform}: downloading ${archive_name}"
    if ! curl -fsSL --connect-timeout 30 --max-time 600 -o "${cache_archive}" "${url}"; then
      echo "  [crdb] ERROR: download failed for ${url}" >&2
      exit 1
    fi
  else
    echo "  [crdb] ${platform}: using cached ${archive_name}"
  fi

  local actual_sha
  actual_sha="$(sha256_of "${cache_archive}")"
  if [ "${actual_sha}" != "${expected_sha}" ]; then
    echo "  [crdb] ERROR: sha256 mismatch for ${archive_name}" >&2
    echo "    expected: ${expected_sha}" >&2
    echo "    actual:   ${actual_sha}" >&2
    echo "    Refusing to bundle. Refresh the hash in this script or investigate tampering." >&2
    rm -f "${cache_archive}"
    exit 3
  fi

  mkdir -p "${dest_dir}"
  local tmp_extract
  tmp_extract="$(mktemp -d)"
  trap "rm -rf '${tmp_extract}'" RETURN

  case "${archive_type}" in
    tgz) tar -xzf "${cache_archive}" -C "${tmp_extract}" ;;
    zip) unzip -q -d "${tmp_extract}" "${cache_archive}" ;;
    *)   echo "  [crdb] ERROR: unknown archive type ${archive_type}" >&2; exit 1 ;;
  esac

  local extracted
  extracted="$(find "${tmp_extract}" -maxdepth 3 -type f \( -name 'cockroach' -o -name 'cockroach.exe' \) | head -1)"
  if [ -z "${extracted}" ]; then
    echo "  [crdb] ERROR: could not locate cockroach binary inside ${archive_name}" >&2
    exit 1
  fi
  mv "${extracted}" "${dest_bin}"
  chmod +x "${dest_bin}"
  rm -rf "${tmp_extract}"
  echo "  [crdb] ${platform}: bundled at ${dest_bin}"
}

echo ""
echo "[build-single-binary] Bundling CockroachDB v${CRDB_VERSION} for ${#CRDB_TARGETS[@]} platforms..."
for entry in "${CRDB_TARGETS[@]}"; do
  bundle_crdb_binary "${entry}"
done

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
# Step 3: Use `pnpm deploy` to produce self-contained API and worker
# directories with hoisted node_modules (no pnpm symlinks dangling into
# .pnpm/). Naive `cp -R` of `apps/*/node_modules` would preserve the
# symlinks but not chase them, so electron-builder later fails with
# "ENOENT … bonjour-service". Naive `cp -RL` follows every symlink and
# produces ~14GB of duplicated transitive deps because pnpm's store is
# heavily deduplicated.
#
# `pnpm deploy --filter <pkg> --prod <dir>` is the pnpm-native answer:
# it walks the workspace dependency graph, copies dist + package.json +
# every prod dependency into <dir>/node_modules as a flat hoisted tree.
# Self-contained, electron-builder-friendly, and respects --prod so dev
# deps don't ship.
# ---------------------------------------------------------------------------

echo ""
echo "[build-single-binary] Deploying API into embedded tree..."
rm -rf "${EMBEDDED_DIR}/api"
pnpm --filter @skytwin/api deploy --prod "${EMBEDDED_DIR}/api"

echo ""
echo "[build-single-binary] Deploying worker into embedded tree..."
rm -rf "${EMBEDDED_DIR}/worker"
pnpm --filter @skytwin/worker deploy --prod "${EMBEDDED_DIR}/worker"

echo ""
echo "[build-single-binary] Deploying web into embedded tree..."
rm -rf "${EMBEDDED_DIR}/web"
pnpm --filter @skytwin/web deploy --prod "${EMBEDDED_DIR}/web"

# Post-process the deploy output. `pnpm deploy` leaves a back-symlink at
# <bundle>/node_modules/.pnpm/node_modules/@skytwin/<self-pkg> that points
# 8 levels up at the source workspace (../../../../../../../../<pkg>).
# Inside an .app's Resources/ tree, that target doesn't exist — and
# electron-builder traverses every symlink and fails ENOENT. The real
# package content is already inlined elsewhere in .pnpm/, so we can
# safely delete these dangling self-references.
#
# These symlinks have one identifying feature: they live under
# `.pnpm/node_modules/@skytwin/` and their target starts with `../../`.
# Anything pointing OUTSIDE the deploy bundle is dangling.
strip_dangling_self_symlinks() {
  local deploy_dir="$1"
  local stripped=0
  while IFS= read -r symlink; do
    target="$(readlink "$symlink")"
    # If the target is purely relative `../`s ending in a single dir name,
    # it's the self-reference pnpm-deploy leaves behind.
    case "$target" in
      ../../../../../../../../*) rm -f "$symlink"; stripped=$((stripped + 1)) ;;
    esac
  done < <(find "$deploy_dir/node_modules/.pnpm/node_modules/@skytwin" -maxdepth 1 -type l 2>/dev/null)
  echo "  [post-deploy] stripped $stripped self-symlink(s) from $deploy_dir"
}

strip_dangling_self_symlinks "${EMBEDDED_DIR}/api"
strip_dangling_self_symlinks "${EMBEDDED_DIR}/worker"
strip_dangling_self_symlinks "${EMBEDDED_DIR}/web"

# Web is now a full deployed Express app (see deploy above). Its static
# assets ship inside the deployed tree via the package's `files` field.

# ---------------------------------------------------------------------------
# Step 4: Copy workspace package dist/ outputs.
#
# The embedded API and worker import @skytwin/* packages by resolved path at
# runtime. Copy all package dist/ directories so they are available inside the
# bundle without requiring the full node_modules symlink tree from pnpm.
# ---------------------------------------------------------------------------

# Workspace packages are now bundled into api/node_modules and
# worker/node_modules by `pnpm deploy`. The standalone
# `${EMBEDDED_DIR}/packages` tree from previous versions is no longer
# needed — runtime imports resolve via the hoisted node_modules under
# api/ and worker/.

# ---------------------------------------------------------------------------
# Step 5: Write a manifest file so the Electron main process can verify the
# bundle contents at startup.
# ---------------------------------------------------------------------------

MANIFEST_FILE="${EMBEDDED_DIR}/bundle-manifest.json"
cat > "${MANIFEST_FILE}" <<MANIFEST
{
  "bundledAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "components": ["api", "worker", "web", "cockroach"],
  "cockroachVersion": "v${CRDB_VERSION}",
  "cockroachPlatforms": ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"],
  "sqliteVecStatus": "deferred-v1.1-issue-197",
  "crdbConnectionRequired": false
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
