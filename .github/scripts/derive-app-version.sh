#!/usr/bin/env bash
#
# derive-app-version.sh — map SkyTwin's four-segment `VERSION` onto the
# three-segment semver that electron-builder / electron-updater require.
#
# WHY THIS EXISTS
# ---------------
# The repo versions itself as `major.minor.patch.build` (e.g. `0.6.101.0`).
# electron-builder REJECTS a four-segment version outright, which is why
# `apps/desktop/package.json` was pinned to a hand-written `0.3.0` in PR #31
# and then never touched again. Consequence: every packaged artifact and every
# `latest*.yml` update manifest was stamped `0.3.0` forever, so
# electron-updater's semver comparison against an installed `0.3.0` always
# answered "no update available" — auto-update could never fire.
#
# Fix: derive a real three-segment version at package time and inject it with
# `--config.extraMetadata.version=...`. The checked-in `0.3.0` stays as-is so
# local `pnpm --filter skytwin-desktop package:mac` keeps working with no env
# setup.
#
# THE MAPPING
# -----------
#   major.minor.patch.build  ->  major.minor.(patch * 100 + build)
#
#   0.1.0.0    -> 0.1.0
#   0.3.3.1    -> 0.3.301
#   0.6.23.2   -> 0.6.2302
#   0.6.99.0   -> 0.6.9900
#   0.6.101.0  -> 0.6.10100
#
# Two properties this MUST have, or auto-update breaks in a subtler way than
# the bug it fixes:
#
#   1. INJECTIVE — no two `VERSION`s may collide, or a real release would look
#      identical to the previous one and clients would skip it. Holds because
#      `patch * 100 + build` is base-100 positional encoding, given build < 100.
#   2. MONOTONIC — the derived version must increase whenever `VERSION`
#      increases, or clients would see a *downgrade* and refuse the update.
#      Holds for the same reason: major/minor pass through untouched and
#      `patch * 100 + build` is strictly increasing in (patch, build)
#      lexicographic order, given build < 100.
#
# Both properties depend on `build < 100`, so the script hard-fails when the
# fourth segment reaches 100 rather than silently emitting a colliding
# version. Every VERSION in this repo's history has had build <= 2
# (`0.6.23.2` is the high-water mark), so the headroom is ample — but the
# failure mode if it were ever exceeded is silent and user-visible, hence the
# explicit gate.
#
# USAGE
#   bash .github/scripts/derive-app-version.sh            # reads ./VERSION
#   bash .github/scripts/derive-app-version.sh 0.6.101.0  # explicit input
#
# Prints the derived version on stdout (and nothing else, so callers can
# capture it). Under GitHub Actions it also appends `APP_VERSION=<derived>` to
# $GITHUB_ENV and `version=<derived>` to $GITHUB_OUTPUT.
#
# Invalid input is a hard failure (exit 1) — never a fallback. A silently
# wrong version is exactly the class of bug this script exists to kill. The
# strict validation is also what makes it safe to interpolate the result into
# a workflow `run:` line: the output is guaranteed to match [0-9.]+, so it
# cannot carry shell metacharacters even if `VERSION` is attacker-controlled
# (e.g. a fork PR).

set -euo pipefail

# Base of the positional encoding — i.e. the exclusive upper bound on the
# fourth ("build") segment. Changing this changes the derived version of every
# future release; it must only ever grow, never shrink (shrinking would break
# monotonicity across the change).
BUILD_SCALE=100

# Upper bound on the third ("patch") segment, so the derived patch segment
# stays comfortably inside the 32-bit range semver parsers assume.
MAX_PATCH=999999

fail() {
  echo "derive-app-version: $*" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

raw="${1:-}"
if [ -z "${raw}" ]; then
  version_file="${repo_root}/VERSION"
  [ -f "${version_file}" ] || fail "VERSION file not found at ${version_file}"
  # Strip whitespace/CRLF; the file is a single line.
  raw="$(tr -d ' \t\r\n' < "${version_file}")"
fi

# Reject leading zeros too (`08` would be parsed as invalid octal by bash
# arithmetic, and `0.6.08.0` is not a version anyone means to write).
if ! printf '%s' "${raw}" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  fail "VERSION '${raw}' is not a four-segment numeric version (expected major.minor.patch.build, no leading zeros)."
fi

IFS='.' read -r major minor patch build <<EOF
${raw}
EOF

# Bound the DECIMAL LENGTH of every segment before any arithmetic touches it.
#
# Without this, an oversized-but-well-formed segment is catastrophic AND
# silent. `[ "${patch}" -gt "${MAX_PATCH}" ]` does not evaluate to false for a
# value outside bash's signed-64-bit range — it ERRORS ("integer expression
# expected"). Because that test sits inside an `if`, `set -e` does not fire,
# the guard is skipped, and `$(( patch * BUILD_SCALE + build ))` then wraps:
#
#   0.6.9223372036854775808.0    -> 0.6.0                    (exit 0!)
#   0.6.99999999999999999999.0   -> 0.6.1864712049423024028  (exit 0!)
#
# The first emits a version LOWER than the one already shipped, which
# electron-updater reads as "no update available" — permanently, and with no
# error anywhere. Reject on length first; every real segment is far shorter.
MAX_SEGMENT_DIGITS=9
for segment in "${major}" "${minor}" "${patch}" "${build}"; do
  if [ "${#segment}" -gt "${MAX_SEGMENT_DIGITS}" ]; then
    fail "VERSION '${raw}' has a segment with ${#segment} digits (max ${MAX_SEGMENT_DIGITS}). Oversized segments overflow bash arithmetic and would silently derive a LOWER version, which auto-update reads as 'no update available'."
  fi
done

if [ "${build}" -ge "${BUILD_SCALE}" ]; then
  fail "VERSION '${raw}' has build segment ${build} >= ${BUILD_SCALE}. The derived-version encoding would collide with a different VERSION and break auto-update. Bump the patch segment instead, or raise BUILD_SCALE here (and never lower it)."
fi

if [ "${patch}" -gt "${MAX_PATCH}" ]; then
  fail "VERSION '${raw}' has patch segment ${patch} > ${MAX_PATCH}; the derived version would overflow the range semver consumers assume."
fi

derived="${major}.${minor}.$(( patch * BUILD_SCALE + build ))"

printf '%s\n' "${derived}"

if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'APP_VERSION=%s\n' "${derived}" >> "${GITHUB_ENV}"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'version=%s\n' "${derived}" >> "${GITHUB_OUTPUT}"
fi
