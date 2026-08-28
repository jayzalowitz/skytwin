import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * app-version-injection.test.ts — CI guard for the desktop auto-update fix.
 *
 * electron-builder stamps artifact filenames AND the `latest*.yml` update
 * manifests from `apps/desktop/package.json#version`, which is deliberately
 * pinned to `0.3.0` (electron-builder rejects the repo's four-segment
 * `VERSION`). The real version is injected at package time with
 * `--config.extraMetadata.version=<derived>`. If a future workflow edit drops
 * that flag from even one platform, that platform's releases silently go back
 * to publishing `0.3.0` and auto-update dies again with no signal — the exact
 * failure mode this test exists to make loud.
 *
 * String-level guard on purpose: it mirrors the existing "README badge must
 * stay dynamic (#380)" grep guard and the #370 manifest test next door, and it
 * catches the regression without needing to run electron-builder. Assertions
 * are scoped per job (by slicing the file between job headers) so a flag on
 * the wrong job can't satisfy them.
 */

const here = dirname(fileURLToPath(import.meta.url));
// apps/desktop/src/__tests__ -> repo root
const REPO_ROOT = resolve(here, '../../../..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/build.yml');
const DERIVE_SCRIPT_PATH = resolve(REPO_ROOT, '.github/scripts/derive-app-version.sh');

const DESKTOP_JOBS = [
  { job: 'desktop-mac', script: 'package:mac' },
  { job: 'desktop-windows', script: 'package:win' },
  { job: 'desktop-linux', script: 'package:linux' },
] as const;

/** All job header lines, in file order, so a job's body can be sliced out. */
function jobSlice(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  expect(start, `job '${job}' not found in build.yml`).toBeGreaterThan(-1);
  const headerRe = /\n {2}[a-z0-9-]+:\n/g;
  headerRe.lastIndex = start + 1;
  const next = headerRe.exec(workflow);
  return workflow.slice(start, next ? next.index : workflow.length);
}

describe('build.yml — desktop app version injection', () => {
  let workflow: string;

  beforeAll(() => {
    expect(existsSync(WORKFLOW_PATH), `expected build.yml at ${WORKFLOW_PATH}`).toBe(true);
    workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  });

  it('ships the version-derivation script the workflow calls', () => {
    expect(
      existsSync(DERIVE_SCRIPT_PATH),
      `expected derive-app-version.sh at ${DERIVE_SCRIPT_PATH}`,
    ).toBe(true);
  });

  for (const { job, script } of DESKTOP_JOBS) {
    describe(job, () => {
      it('derives APP_VERSION before packaging', () => {
        const body = jobSlice(workflow, job);
        expect(body).toContain('bash .github/scripts/derive-app-version.sh');
        // Explicit `shell: bash` matters on windows-latest, whose default
        // shell is pwsh and would not run the script the same way.
        const deriveIdx = body.indexOf('bash .github/scripts/derive-app-version.sh');
        expect(body.slice(Math.max(0, deriveIdx - 200), deriveIdx)).toContain('shell: bash');
      });

      it(`passes --config.extraMetadata.version to ${script}`, () => {
        const body = jobSlice(workflow, job);
        const packageLine = body
          .split('\n')
          .find((line) => line.includes(`run: pnpm --filter skytwin-desktop run ${script}`));
        expect(packageLine, `no ${script} step found in ${job}`).toBeTruthy();
        expect(packageLine).toContain('--config.extraMetadata.version=${{ env.APP_VERSION }}');
      });

      it('derives the version before it is consumed', () => {
        const body = jobSlice(workflow, job);
        expect(body.indexOf('derive-app-version.sh')).toBeLessThan(
          body.indexOf('--config.extraMetadata.version'),
        );
      });

      it('still passes --publish never (does not weaken #370 semantics)', () => {
        const body = jobSlice(workflow, job);
        expect(body).toContain('--publish never');
      });
    });
  }

  it('injects the version on exactly the three desktop package steps', () => {
    const count = (workflow.match(/--config\.extraMetadata\.version=/g) ?? []).length;
    expect(count).toBe(3);
  });

  it('uses the ${{ env.… }} expression form, not a raw shell variable', () => {
    // A bare `${APP_VERSION}` expands to empty under pwsh (the Windows
    // runner's default shell), which would produce an empty version rather
    // than failing loudly. The workflow-expression form is substituted by the
    // runner before the shell sees it, so it is shell-agnostic.
    expect(workflow).not.toMatch(/extraMetadata\.version=\$\{?APP_VERSION/);
    expect(workflow).not.toMatch(/extraMetadata\.version=\$env:/);
  });
});
