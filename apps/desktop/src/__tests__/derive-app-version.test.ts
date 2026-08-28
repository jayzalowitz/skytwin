import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * derive-app-version.test.ts — guards the four-segment → three-segment version
 * mapping that makes desktop auto-update possible at all.
 *
 * Background: `apps/desktop/package.json` is pinned to `0.3.0` because
 * electron-builder rejects the repo's four-segment `VERSION` (`0.6.101.0`).
 * electron-builder stamps artifact filenames AND the `latest*.yml` update
 * manifests from that version, so every release published `0.3.0` and
 * electron-updater's semver compare against an installed `0.3.0` answered
 * "no update available" forever.
 *
 * `.github/scripts/derive-app-version.sh` derives a real three-segment version
 * that CI injects via `--config.extraMetadata.version`. The mapping must be
 * INJECTIVE (no two VERSIONs collide, or a release looks like its predecessor
 * and clients skip it) and MONOTONIC (or clients see a downgrade and refuse).
 * These tests pin both properties against this repo's actual VERSION history.
 */

const here = dirname(fileURLToPath(import.meta.url));
// apps/desktop/src/__tests__ -> repo root
const REPO_ROOT = resolve(here, '../../../..');
const SCRIPT = join(REPO_ROOT, '.github/scripts/derive-app-version.sh');

/** Run the script with an explicit version argument. Returns trimmed stdout. */
function derive(version: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [SCRIPT, version], {
    encoding: 'utf8',
    // Strip the ambient GitHub Actions vars so a local run inside CI doesn't
    // append to the real $GITHUB_ENV.
    env: { ...process.env, GITHUB_ENV: '', GITHUB_OUTPUT: '', ...env },
  }).trim();
}

interface DeriveFailure {
  status: number;
  stderr: string;
}

/** Run the script expecting a non-zero exit. */
function deriveExpectingFailure(version: string): DeriveFailure {
  try {
    execFileSync('bash', [SCRIPT, version], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GITHUB_ENV: '', GITHUB_OUTPUT: '' },
    });
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? -1, stderr: e.stderr ?? '' };
  }
  throw new Error(`expected derive-app-version.sh to fail for '${version}' but it succeeded`);
}

/**
 * Every VERSION this repo has ever published, oldest → newest, straight out of
 * `git log -p -- VERSION`. Used to prove injectivity + monotonicity against
 * real inputs rather than invented ones.
 */
const VERSION_HISTORY = [
  '0.1.0.0', '0.2.0.0', '0.3.0.0', '0.3.1.0', '0.3.1.1', '0.3.2.0', '0.3.2.1',
  '0.3.3.0', '0.3.3.1', '0.4.0.0', '0.4.1.0', '0.5.0.0', '0.5.1.0', '0.5.2.0',
  '0.5.3.0', '0.5.4.0', '0.5.5.0', '0.5.6.0', '0.6.0.0', '0.6.1.0', '0.6.2.0',
  '0.6.3.0', '0.6.4.0', '0.6.5.0', '0.6.6.0', '0.6.7.0', '0.6.8.0', '0.6.9.0',
  '0.6.10.0', '0.6.11.0', '0.6.12.0', '0.6.13.0', '0.6.14.0', '0.6.15.0',
  '0.6.16.0', '0.6.17.0', '0.6.18.0', '0.6.19.0', '0.6.20.0', '0.6.21.0',
  '0.6.22.0', '0.6.23.0', '0.6.23.1', '0.6.23.2', '0.6.24.0', '0.6.25.0',
  '0.6.27.0', '0.6.28.0', '0.6.29.0', '0.6.30.0', '0.6.31.0', '0.6.33.0',
  '0.6.34.0', '0.6.35.0', '0.6.37.0', '0.6.38.1', '0.6.40.0', '0.6.41.0',
  '0.6.50.0', '0.6.60.0', '0.6.70.0', '0.6.80.0', '0.6.90.0', '0.6.99.0',
  '0.6.101.0',
];

/** Compare two three-segment versions numerically. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

describe('derive-app-version.sh', () => {
  it('exists and is executable from the repo root', () => {
    expect(existsSync(SCRIPT), `expected the script at ${SCRIPT}`).toBe(true);
  });

  it('maps major.minor.patch.build -> major.minor.(patch * 100 + build)', () => {
    expect(derive('0.1.0.0')).toBe('0.1.0');
    expect(derive('0.3.3.1')).toBe('0.3.301');
    expect(derive('0.6.23.2')).toBe('0.6.2302');
    expect(derive('0.6.99.0')).toBe('0.6.9900');
    expect(derive('0.6.101.0')).toBe('0.6.10100');
    expect(derive('1.0.0.0')).toBe('1.0.0');
  });

  it('emits a three-segment semver for every VERSION in this repo history', () => {
    for (const version of VERSION_HISTORY) {
      expect(derive(version), version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('is injective across this repo VERSION history (no two collide)', () => {
    const derived = VERSION_HISTORY.map((v) => derive(v));
    expect(new Set(derived).size).toBe(VERSION_HISTORY.length);
  });

  it('is strictly increasing across this repo VERSION history', () => {
    const derived = VERSION_HISTORY.map((v) => derive(v));
    for (let i = 1; i < derived.length; i++) {
      expect(
        compareSemver(derived[i], derived[i - 1]),
        `${VERSION_HISTORY[i - 1]} (${derived[i - 1]}) -> ${VERSION_HISTORY[i]} (${derived[i]}) must increase`,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps a build bump below the next patch bump (encoding stays ordered)', () => {
    // 0.6.23.0 < 0.6.23.1 < 0.6.23.2 < 0.6.24.0 must survive the mapping.
    const ordered = ['0.6.23.0', '0.6.23.1', '0.6.23.2', '0.6.24.0'].map((v) => derive(v));
    expect(ordered).toEqual(['0.6.2300', '0.6.2301', '0.6.2302', '0.6.2400']);
  });

  it('reads the repo VERSION file when given no argument', () => {
    const versionFile = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8').trim();
    const fromFile = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ENV: '', GITHUB_OUTPUT: '' },
    }).trim();
    expect(fromFile).toBe(derive(versionFile));
  });

  it('exports APP_VERSION to $GITHUB_ENV and version to $GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skytwin-appver-'));
    const envFile = join(dir, 'github_env');
    const outFile = join(dir, 'github_output');
    writeFileSync(envFile, '');
    writeFileSync(outFile, '');

    execFileSync('bash', [SCRIPT, '0.6.101.0'], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ENV: envFile, GITHUB_OUTPUT: outFile },
    });

    expect(readFileSync(envFile, 'utf8')).toContain('APP_VERSION=0.6.10100');
    expect(readFileSync(outFile, 'utf8')).toContain('version=0.6.10100');
  });

  describe('rejects input that would break the encoding', () => {
    it('fails when the build segment reaches the encoding base (would collide)', () => {
      // 0.6.99.100 would derive to 0.6.10000 — identical to 0.6.100.0.
      const failure = deriveExpectingFailure('0.6.99.100');
      expect(failure.status).toBe(1);
      expect(failure.stderr).toContain('collide');
      // and the version it would have collided with is a legal input:
      expect(derive('0.6.100.0')).toBe('0.6.10000');
    });

    it('fails on a three-segment version (silent non-monotonic passthrough)', () => {
      expect(deriveExpectingFailure('1.2.3').status).toBe(1);
    });

    it('fails on a five-segment version', () => {
      expect(deriveExpectingFailure('1.2.3.4.5').status).toBe(1);
    });

    it('fails on non-numeric segments', () => {
      expect(deriveExpectingFailure('1.2.3-rc1.0').status).toBe(1);
      expect(deriveExpectingFailure('v0.6.101.0').status).toBe(1);
      expect(deriveExpectingFailure('  ').status).toBe(1);
    });

    it('fails on an oversized segment instead of silently deriving a LOWER version (codex review [P2])', () => {
      // The nastiest failure mode this script has. An oversized-but-numeric
      // segment passes the regex, and `[ "$patch" -gt "$MAX_PATCH" ]` does
      // not return false for it — it ERRORS. Inside an `if`, `set -e` does
      // not fire, so the bound check is skipped and the arithmetic wraps:
      //
      //   0.6.9223372036854775808.0  -> 0.6.0                    exit 0
      //   0.6.99999999999999999999.0 -> 0.6.1864712049423024028  exit 0
      //
      // The first is LOWER than what is already shipped, so electron-updater
      // reports "no update available" forever, silently. Must be rejected.
      for (const oversized of [
        '0.6.9223372036854775808.0',
        '0.6.99999999999999999999.0',
        '0.6.1.9223372036854775808',
        '9223372036854775808.0.1.0',
      ]) {
        const failure = deriveExpectingFailure(oversized);
        expect(failure.status, oversized).toBe(1);
        expect(failure.stderr, oversized).toContain('digits');
      }
    });

    it('still accepts the largest in-range version', () => {
      // The guard bounds digit LENGTH, so it must not reject legitimate
      // large-but-sane versions.
      expect(derive('0.6.999999.99')).toBe('0.6.99999999');
    });

    it('fails on leading zeros rather than reinterpreting them', () => {
      expect(deriveExpectingFailure('0.6.08.0').status).toBe(1);
    });

    it('fails on shell metacharacters instead of interpolating them', () => {
      // The derived value is interpolated into a workflow `run:` line, so a
      // VERSION carrying shell syntax (fork PR) must never reach it.
      for (const hostile of ['0.6.1.0; echo pwned', '0.6.1.0 && whoami', '$(id).0.0.0', '0.6.1.0`id`']) {
        const failure = deriveExpectingFailure(hostile);
        expect(failure.status, hostile).toBe(1);
        expect(failure.stderr, hostile).toContain('four-segment');
      }
    });
  });
});
