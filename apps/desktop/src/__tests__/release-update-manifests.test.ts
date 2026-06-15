import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * release-update-manifests.test.ts — #370 regression guard.
 *
 * The desktop auto-update feed is GitHub Releases via electron-updater's
 * `github` provider (apps/desktop/package.json#build.publish). For an
 * installed app's `checkForUpdates()` to discover a new version, every
 * GitHub Release MUST carry the electron-updater update manifests:
 *
 *   - latest-mac.yml     (macOS, zip channel)
 *   - latest.yml         (Windows, NSIS channel)
 *   - latest-linux.yml   (Linux, AppImage channel)
 *
 * electron-builder writes these into dist-electron/ during packaging even
 * under `--publish never` (that flag only suppresses the upload, not the
 * manifest generation). `.github/workflows/build.yml` collects them as
 * artifacts in the per-OS desktop jobs and attaches them in the `release`
 * job. This test pins that wiring so a future workflow edit can't silently
 * drop a manifest and re-break auto-update — the failure mode #370 fixed.
 *
 * It also pins AC#2: the `release` job verifies the GitHub Releases endpoint
 * is reachable (curl, fail on non-2xx) before publishing.
 *
 * This is a string-level guard, not a YAML-semantics check — it intentionally
 * mirrors the existing "README badge must stay dynamic (#380)" grep guard
 * pattern in build.yml: cheap, deterministic, and it catches the exact
 * regression (a removed manifest glob or a dropped curl gate) without needing
 * to run electron-builder.
 */

const here = dirname(fileURLToPath(import.meta.url));
// apps/desktop/src/__tests__ -> repo root -> .github/workflows/build.yml
const WORKFLOW_PATH = resolve(here, '../../../../.github/workflows/build.yml');

describe('build.yml — #370 auto-update release wiring', () => {
  let workflow: string;

  beforeAll(() => {
    expect(
      existsSync(WORKFLOW_PATH),
      `expected build.yml at ${WORKFLOW_PATH}`,
    ).toBe(true);
    workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  });

  it('uploads the macOS update manifest (latest-mac.yml) as an artifact', () => {
    expect(workflow).toContain('dist-electron/latest-mac.yml');
    expect(workflow).toContain('SkyTwin-macOS-update-manifest');
  });

  it('uploads the Windows update manifest (latest.yml) as an artifact', () => {
    expect(workflow).toContain('dist-electron/latest.yml');
    expect(workflow).toContain('SkyTwin-Windows-update-manifest');
  });

  it('uploads the Linux update manifest (latest-linux.yml) as an artifact', () => {
    expect(workflow).toContain('dist-electron/latest-linux.yml');
    expect(workflow).toContain('SkyTwin-Linux-update-manifest');
  });

  it('attaches all three update manifests to the GitHub Release', () => {
    expect(workflow).toContain('artifacts/SkyTwin-macOS-update-manifest/*');
    expect(workflow).toContain('artifacts/SkyTwin-Windows-update-manifest/*');
    expect(workflow).toContain('artifacts/SkyTwin-Linux-update-manifest/*');
  });

  it('does not weaken the existing --publish never semantics on the package steps (#370 CAUTION)', () => {
    // All three desktop package steps must still pass `--publish never` so the
    // validation jobs never auto-publish without a GH_TOKEN. The dedicated
    // `release` job (softprops) is the only publisher.
    const publishNeverCount = (workflow.match(/--publish never/g) ?? []).length;
    // mac + win + linux package steps == 3 invocations (a 4th match exists in
    // a historical comment about --publish arg forwarding, hence >= 3).
    expect(publishNeverCount).toBeGreaterThanOrEqual(3);
  });

  it('verifies the GitHub Releases feed is reachable before publishing (AC#2: fail on non-2xx)', () => {
    expect(workflow).toContain('Verify update feed reachable');
    // `curl -f` exits non-zero on HTTP >= 400, which fails the workflow step.
    // The curl invocation and the releases/latest URL span continuation
    // lines (`\`), so match `-f` and the URL independently rather than on a
    // single line.
    expect(workflow).toMatch(/curl -f\S*/);
    expect(workflow).toContain('/releases/latest"');
  });

  it('keeps the verify-feed step inside the tag-only release job', () => {
    // The feed-reachability gate must live in the `release` job, which is
    // guarded by `if: startsWith(github.ref, 'refs/tags/v')` — it must not
    // run on every PR/main push (that would fail before the first release
    // exists and would not be a meaningful pre-publish gate otherwise).
    const releaseJobIndex = workflow.indexOf('  release:');
    const verifyStepIndex = workflow.indexOf('Verify update feed reachable');
    expect(releaseJobIndex).toBeGreaterThan(-1);
    expect(verifyStepIndex).toBeGreaterThan(releaseJobIndex);
  });
});
