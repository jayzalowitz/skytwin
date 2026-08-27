import { existsSync, readFileSync, statSync } from 'fs';

/**
 * Cache-invalidation marker for the extracted embedded api/worker/web tree.
 *
 * `ServiceManager.ensureEmbeddedRoot()` unpacks `<resources>/embedded/apps.tar.gz`
 * into `<userData>/embedded/` on first launch and writes a marker file so
 * subsequent launches no-op. The marker used to be `app.getVersion()`, which
 * was a latent data-corruption bug: the desktop app's package.json version has
 * been frozen at `0.3.0` since PR #31, so a user who upgraded by downloading a
 * newer `.dmg` kept the marker match and silently ran the NEW Electron shell
 * against the STALE extracted backend from the previous install.
 *
 * Injecting a real version at package time (see
 * `.github/scripts/derive-app-version.sh`) fixes the version-is-frozen half,
 * but keying the marker on the version alone is still the wrong invariant:
 * what must invalidate the cache is "the bundle contents changed", not "the
 * version string changed". Two builds of the same version (a re-run of a
 * tagged build, a locally packaged `.dmg` installed over a released one) carry
 * different bundles.
 *
 * So the marker keys off the bundle itself, in preference order:
 *
 *   1. `bundleId` from `bundle-manifest.json` — the sha256 of `apps.tar.gz`,
 *      written by `scripts/build-single-binary.sh`. Content-addressed: changes
 *      exactly when the bundle changes.
 *   2. `bundledAt` from the same manifest — the build timestamp. Present on
 *      bundles built before `bundleId` existed; changes on every build.
 *   3. The tarball's own size + mtime — if the manifest is missing/unreadable.
 *   4. `app-version:<version>` — last resort, preserving the old behaviour
 *      rather than skipping invalidation entirely.
 *
 * Each source is prefixed so markers produced by different sources can never
 * compare equal by coincidence. A marker that does not match forces a wipe +
 * re-extract, which is the safe direction: the cost is one extra unpack, the
 * cost of a false match is running mismatched backend code.
 */

/** Where a computed marker came from. Surfaced for logging and tests. */
export type BundleMarkerSource = 'bundleId' | 'bundledAt' | 'tarStat' | 'appVersion';

export interface BundleMarker {
  /** Opaque string persisted to `<userData>/embedded/.version`. */
  marker: string;
  source: BundleMarkerSource;
}

export interface BundleMarkerInput {
  /** Absolute path to `<resources>/embedded/bundle-manifest.json`. */
  manifestPath: string;
  /** Absolute path to `<resources>/embedded/apps.tar.gz`. */
  tarPath: string;
  /** `app.getVersion()` — the last-resort fallback. */
  appVersion: string;
}

interface BundleManifestShape {
  bundleId?: unknown;
  bundledAt?: unknown;
}

function readManifest(manifestPath: string): BundleManifestShape | null {
  try {
    if (!existsSync(manifestPath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as BundleManifestShape;
  } catch {
    // Unreadable or malformed manifest — fall through to the next source.
    return null;
  }
}

/** Non-empty strings only; a blank field must not shadow a later source. */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Compute the marker for the currently-shipped bundle. Never throws — every
 * source degrades to the next one, and the final fallback needs no I/O.
 */
export function computeBundleMarker(input: BundleMarkerInput): BundleMarker {
  const manifest = readManifest(input.manifestPath);

  if (manifest) {
    const bundleId = asNonEmptyString(manifest.bundleId);
    if (bundleId) return { marker: `bundle:${bundleId}`, source: 'bundleId' };

    const bundledAt = asNonEmptyString(manifest.bundledAt);
    if (bundledAt) return { marker: `bundledAt:${bundledAt}`, source: 'bundledAt' };
  }

  try {
    const stat = statSync(input.tarPath);
    return {
      marker: `tar:${stat.size}:${Math.trunc(stat.mtimeMs)}`,
      source: 'tarStat',
    };
  } catch {
    // Tarball missing — ensureEmbeddedRoot() raises its own explicit error
    // for that case; here we just fall through to the version fallback.
  }

  return { marker: `app-version:${input.appVersion}`, source: 'appVersion' };
}
