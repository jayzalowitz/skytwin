import type { SpawnSyncReturns } from 'node:child_process';

interface TrustedGitSpawnOptions {
  maxBuffer?: number;
  timeout?: number;
}

export interface TrustedGit {
  repoRoot: string;
  gitDirectory: string;
  spawn(
    args: string[],
    options: TrustedGitSpawnOptions & { encoding: BufferEncoding },
  ): SpawnSyncReturns<string>;
  spawn(
    args: string[],
    options: TrustedGitSpawnOptions & { encoding: null },
  ): SpawnSyncReturns<Buffer>;
}

export function createTrustedGit(repoRoot: string): TrustedGit;
