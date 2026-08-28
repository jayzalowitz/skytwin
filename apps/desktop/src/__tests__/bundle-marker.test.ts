import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBundleMarker } from '../bundle-marker.js';

/**
 * bundle-marker.test.ts — the extracted-bundle cache key.
 *
 * The bug this guards: `ServiceManager.ensureEmbeddedRoot()` used
 * `app.getVersion()` as the marker for the extracted `<userData>/embedded/`
 * tree, and the desktop package.json version was frozen at `0.3.0`. A user who
 * upgraded by downloading a newer `.dmg` got a marker match, so the new
 * Electron shell silently ran the STALE extracted api/worker/web backend.
 */

let dir: string;
let manifestPath: string;
let tarPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skytwin-bundle-marker-'));
  mkdirSync(join(dir, 'embedded'), { recursive: true });
  manifestPath = join(dir, 'embedded', 'bundle-manifest.json');
  tarPath = join(dir, 'embedded', 'apps.tar.gz');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeManifest(value: unknown): void {
  writeFileSync(manifestPath, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('computeBundleMarker', () => {
  it('prefers the bundle content hash from bundle-manifest.json', () => {
    writeManifest({ bundleId: 'a'.repeat(64), bundledAt: '2026-08-27T00:00:00Z' });
    const result = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' });
    expect(result.source).toBe('bundleId');
    expect(result.marker).toBe(`bundle:${'a'.repeat(64)}`);
  });

  it('changes when the bundle changes even though the app version does not', () => {
    // This is the regression: same frozen 0.3.0 version, different bundle.
    writeManifest({ bundleId: 'a'.repeat(64) });
    const before = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' }).marker;
    writeManifest({ bundleId: 'b'.repeat(64) });
    const after = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' }).marker;
    expect(after).not.toBe(before);
  });

  it('is stable across launches for an unchanged bundle (no needless re-extract)', () => {
    writeManifest({ bundleId: 'c'.repeat(64) });
    const first = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' });
    const second = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.6.10100' });
    // Even an app-version change must not invalidate an identical bundle.
    expect(second.marker).toBe(first.marker);
  });

  it('falls back to bundledAt when the manifest predates bundleId', () => {
    writeManifest({ bundledAt: '2026-08-27T12:00:00Z', components: ['api'] });
    const result = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' });
    expect(result.source).toBe('bundledAt');
    expect(result.marker).toBe('bundledAt:2026-08-27T12:00:00Z');
  });

  it('ignores blank/non-string manifest fields rather than letting them shadow', () => {
    writeManifest({ bundleId: '   ', bundledAt: 42 });
    writeFileSync(tarPath, 'tarball');
    const result = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' });
    expect(result.source).toBe('tarStat');
  });

  it('falls back to tarball size + mtime when the manifest is missing', () => {
    const contents = 'tarball-contents';
    writeFileSync(tarPath, contents);
    const result = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' });
    expect(result.source).toBe('tarStat');
    expect(result.marker).toMatch(new RegExp(`^tar:${Buffer.byteLength(contents)}:\\d+$`));
  });

  it('changes the tarStat marker when the tarball is replaced', () => {
    writeFileSync(tarPath, 'tarball-contents');
    const before = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' }).marker;
    writeFileSync(tarPath, 'different-tarball-contents');
    // Force a distinct mtime — same-millisecond writes are plausible in tests.
    const later = new Date(Date.now() + 5000);
    utimesSync(tarPath, later, later);
    const after = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' }).marker;
    expect(after).not.toBe(before);
  });

  it('survives a malformed manifest without throwing', () => {
    writeManifest('{ not json');
    writeFileSync(tarPath, 'tarball');
    expect(() =>
      computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' }),
    ).not.toThrow();
    expect(computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' }).source).toBe(
      'tarStat',
    );
  });

  it('falls back to the app version only when nothing else is readable', () => {
    const result = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.6.10100' });
    expect(result.source).toBe('appVersion');
    expect(result.marker).toBe('app-version:0.6.10100');
  });

  it('namespaces each source so markers from different sources never collide', () => {
    writeManifest({ bundleId: 'x' });
    const byId = computeBundleMarker({ manifestPath, tarPath, appVersion: 'x' }).marker;
    writeManifest({ bundledAt: 'x' });
    const byDate = computeBundleMarker({ manifestPath, tarPath, appVersion: 'x' }).marker;
    rmSync(manifestPath);
    const byVersion = computeBundleMarker({ manifestPath, tarPath, appVersion: 'x' }).marker;
    expect(new Set([byId, byDate, byVersion]).size).toBe(3);
  });

  it('never equals a legacy bare-version marker, so old installs re-extract once', () => {
    writeManifest({ bundleId: 'd'.repeat(64) });
    const result = computeBundleMarker({ manifestPath, tarPath, appVersion: '0.3.0' });
    expect(result.marker).not.toBe('0.3.0');
  });
});
