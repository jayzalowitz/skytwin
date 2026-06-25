import { describe, expect, it } from 'vitest';
import {
  EXECUTION_RUNTIME_VERSION_CHECKED_AT,
  EXECUTION_RUNTIME_VERSIONS,
  getExecutionRuntimeVersionInfo,
  getExecutionRuntimeVersionSummary,
} from '../execution-runtime-versions.js';

describe('execution runtime versions', () => {
  it('tracks the latest known stable IronClaw release from the canonical NEAR AI repo', () => {
    expect(EXECUTION_RUNTIME_VERSIONS.ironclaw).toMatchObject({
      runtime: 'ironclaw',
      stableVersion: '0.29.1',
      stableSource: 'github-release',
      stableUrl: 'https://github.com/nearai/ironclaw/releases/tag/ironclaw-v0.29.1',
      checkedAt: EXECUTION_RUNTIME_VERSION_CHECKED_AT,
    });
    expect(EXECUTION_RUNTIME_VERSIONS.ironclaw.installHint).toContain('not the unrelated npm ironclaw package');
  });

  it('tracks stable OpenClaw and records the newer beta separately', () => {
    expect(getExecutionRuntimeVersionInfo('openclaw')).toMatchObject({
      runtime: 'openclaw',
      stableVersion: '2026.6.10',
      stableSource: 'npm-dist-tag',
      prerelease: {
        version: '2026.6.11-beta.1',
      },
    });
  });

  it('builds compact summaries for action opportunities and status payloads', () => {
    expect(getExecutionRuntimeVersionSummary('openclaw')).toEqual({
      runtime: 'openclaw',
      displayName: 'OpenClaw',
      stableVersion: '2026.6.10',
      stableUrl: 'https://www.npmjs.com/package/openclaw/v/2026.6.10',
      checkedAt: '2026-06-25',
      prereleaseVersion: '2026.6.11-beta.1',
    });
  });
});
