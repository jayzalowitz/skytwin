export type ExecutionRuntimeName = 'ironclaw' | 'openclaw';

export type ExecutionRuntimeVersionSource = 'github-release' | 'npm-dist-tag';

export interface ExecutionRuntimePrerelease {
  version: string;
  source: ExecutionRuntimeVersionSource;
  url: string;
}

export interface ExecutionRuntimeVersionInfo {
  runtime: ExecutionRuntimeName;
  displayName: string;
  stableVersion: string;
  stableSource: ExecutionRuntimeVersionSource;
  stableUrl: string;
  checkedAt: string;
  installHint: string;
  prerelease?: ExecutionRuntimePrerelease;
}

export interface ExecutionRuntimeVersionSummary {
  runtime: ExecutionRuntimeName;
  displayName: string;
  stableVersion: string;
  stableUrl: string;
  checkedAt: string;
  prereleaseVersion?: string;
}

export const EXECUTION_RUNTIME_VERSION_CHECKED_AT = '2026-06-25';

export const EXECUTION_RUNTIME_VERSIONS = {
  ironclaw: {
    runtime: 'ironclaw',
    displayName: 'IronClaw',
    stableVersion: '0.29.1',
    stableSource: 'github-release',
    stableUrl: 'https://github.com/nearai/ironclaw/releases/tag/ironclaw-v0.29.1',
    checkedAt: EXECUTION_RUNTIME_VERSION_CHECKED_AT,
    installHint: 'Install from the NEAR AI IronClaw release artifacts, not the unrelated npm ironclaw package.',
  },
  openclaw: {
    runtime: 'openclaw',
    displayName: 'OpenClaw',
    stableVersion: '2026.6.10',
    stableSource: 'npm-dist-tag',
    stableUrl: 'https://www.npmjs.com/package/openclaw/v/2026.6.10',
    checkedAt: EXECUTION_RUNTIME_VERSION_CHECKED_AT,
    installHint: 'Install with npm install -g openclaw@2026.6.10 or use the OpenClaw installer.',
    prerelease: {
      version: '2026.6.11-beta.1',
      source: 'npm-dist-tag',
      url: 'https://www.npmjs.com/package/openclaw/v/2026.6.11-beta.1',
    },
  },
} as const satisfies Record<ExecutionRuntimeName, ExecutionRuntimeVersionInfo>;

export function getExecutionRuntimeVersionInfo(runtime: ExecutionRuntimeName): ExecutionRuntimeVersionInfo {
  return EXECUTION_RUNTIME_VERSIONS[runtime];
}

export function getExecutionRuntimeVersionSummary(runtime: ExecutionRuntimeName): ExecutionRuntimeVersionSummary {
  const info = getExecutionRuntimeVersionInfo(runtime);
  return {
    runtime: info.runtime,
    displayName: info.displayName,
    stableVersion: info.stableVersion,
    stableUrl: info.stableUrl,
    checkedAt: info.checkedAt,
    prereleaseVersion: info.prerelease?.version,
  };
}
