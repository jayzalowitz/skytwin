import { existsSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readStableRegularFile } from '../../../scripts/release-artifacts/file-integrity.mjs';
import type {
  AdversarialCatalog,
} from './adversarial-evidence.js';

export interface ExecutableTestResult {
  executableTestId: string;
  status: 'passed' | 'failed';
  reason: string;
  assertionSha256: string | null;
}

export type TestProcessRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    timeout: number;
    killSignal: 'SIGKILL';
    maxBuffer: number;
  },
) => SpawnSyncReturns<string>;

export const MAPPED_TEST_TIMEOUT_MS = 60_000;
const MAPPED_TEST_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

interface ParsedTestId {
  packageName: string;
  file: string;
  fullName: string;
  id: string;
  assertionFile: string | null;
  assertionSha256: string | null;
}

function parseTestId(
  id: string,
  assertionFile: string | null,
  assertionSha256: string | null,
): ParsedTestId {
  const parts = id.split('::');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2] ||
      !parts[1].startsWith('src/') || !parts[1].endsWith('.test.ts')) {
    throw new Error(`malformed executable test ID: ${id}`);
  }
  return {
    packageName: parts[0],
    file: parts[1],
    fullName: parts[2],
    id,
    assertionFile,
    assertionSha256,
  };
}

function workspacePackages(repoRoot: string): Map<string, string> {
  const packages = new Map<string, string>();
  for (const parent of ['packages', 'apps']) {
    const parentPath = join(repoRoot, parent);
    for (const child of readdirSync(parentPath, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const packagePath = join(parentPath, child.name);
      const manifestPath = join(packagePath, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(
        readStableRegularFile(repoRoot, manifestPath, { maxBytes: 64 * 1024 }).bytes.toString('utf8'),
      ) as { name?: unknown };
      if (typeof manifest.name === 'string') packages.set(manifest.name, packagePath);
    }
  }
  return packages;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function executeMappedAdversarialTests(
  catalog: AdversarialCatalog,
  repoRoot: string,
  run: TestProcessRunner = spawnSync,
): Map<string, ExecutableTestResult> {
  const parsed = catalog.scenarios.map(({
    executableTestId, assertionFile, assertionSha256,
  }) => parseTestId(executableTestId, assertionFile, assertionSha256));
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    throw new Error('duplicate executable test IDs are not allowed');
  }
  const mappedFiles = parsed.flatMap(({ assertionFile }) => assertionFile === null ? [] : [assertionFile]);
  if (new Set(mappedFiles).size !== mappedFiles.length) {
    throw new Error('each mapped regression must use a dedicated assertion file');
  }
  const packagePaths = workspacePackages(repoRoot);
  const groups = new Map<string, ParsedTestId[]>();
  for (const item of parsed) {
    const packagePath = packagePaths.get(item.packageName);
    if (!packagePath) throw new Error(`unknown workspace package in executable test ID: ${item.id}`);
    const testPath = resolve(packagePath, item.file);
    if (!testPath.startsWith(`${packagePath}${sep}`) || !existsSync(testPath)) {
      throw new Error(`missing executable test file: ${item.id}`);
    }
    if (item.assertionFile !== null) {
      const assertionPath = resolve(repoRoot, item.assertionFile);
      if (!assertionPath.startsWith(`${repoRoot}${sep}`) || assertionPath !== testPath) {
        throw new Error(`mapped assertion file does not match executable test ID: ${item.id}`);
      }
      const digest = readStableRegularFile(repoRoot, assertionPath, {
        maxBytes: 1024 * 1024,
      }).sha256;
      if (digest !== item.assertionSha256) {
        throw new Error(`mapped assertion source digest does not match: ${item.id}`);
      }
    }
    const groupKey = `${item.packageName}::${item.file}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), item]);
  }

  const results = new Map<string, ExecutableTestResult>();
  for (const items of groups.values()) {
    const first = items[0]!;
    const packagePath = packagePaths.get(first.packageName)!;
    const vitest = join(packagePath, 'node_modules', '.bin', 'vitest');
    if (!existsSync(vitest)) throw new Error(`vitest is unavailable for ${first.packageName}`);
    const namePattern = `^(?:${items.map(({ fullName }) => escapeRegex(fullName)).join('|')})$`;
    const trustedNodeDirectory = dirname(process.execPath);
    const child = run(vitest, ['run', first.file, '-t', namePattern, '--reporter=json'], {
      cwd: packagePath,
      encoding: 'utf8',
      env: {
        PATH: [trustedNodeDirectory, '/usr/bin', '/bin'].join(delimiter),
        CI: 'true',
        NO_COLOR: '1',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
      },
      timeout: MAPPED_TEST_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: MAPPED_TEST_MAX_BUFFER_BYTES,
    });
    if ((child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      throw new Error(`test subprocess timed out for ${first.packageName}`);
    }
    if (child.error) throw new Error(`test subprocess could not start for ${first.packageName}`);
    let report: unknown;
    try {
      report = JSON.parse(child.stdout);
    } catch {
      throw new Error(`test subprocess did not emit JSON for ${first.packageName}`);
    }
    if (report === null || typeof report !== 'object' || !Array.isArray((report as { testResults?: unknown }).testResults)) {
      throw new Error(`test subprocess emitted an invalid report for ${first.packageName}`);
    }
    const assertions = (report as { testResults: Array<{ assertionResults?: unknown }> }).testResults
      .flatMap(({ assertionResults }) => Array.isArray(assertionResults) ? assertionResults : []) as
      Array<{ fullName?: unknown; status?: unknown; failureMessages?: unknown }>;
    if (first.assertionFile !== null && (items.length !== 1 || assertions.length !== 1)) {
      throw new Error(`mapped assertion file must contain exactly one executable test: ${first.id}`);
    }
    for (const item of items) {
      const matches = assertions.filter(({ fullName }) => fullName === item.fullName);
      if (matches.length !== 1) {
        throw new Error(`executable test ID resolved ${matches.length} times: ${item.id}`);
      }
      const assertion = matches[0]!;
      const passed = assertion.status === 'passed';
      results.set(item.id, {
        executableTestId: item.id,
        status: passed ? 'passed' : 'failed',
        reason: passed ? 'exact mapped Vitest assertion passed' : 'exact mapped Vitest assertion failed',
        assertionSha256: item.assertionSha256,
      });
    }
    if (child.status !== 0 && items.every(({ id }) => results.get(id)?.status === 'passed')) {
      throw new Error(`test subprocess failed outside the mapped assertions for ${first.packageName}`);
    }
  }
  return results;
}
