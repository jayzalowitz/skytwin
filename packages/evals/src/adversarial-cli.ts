#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildAdversarialEvidence,
  canonicalJson,
  loadAdversarialCatalog,
} from './adversarial-evidence.js';
import { executeMappedAdversarialTests } from './adversarial-test-executor.js';

function git(args: string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

function gitRef(): string {
  const result = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return 'DETACHED';
}

function outputArgument(args: string[]): string | null {
  const index = args.indexOf('--output');
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--output requires a path');
  if (args.length !== 2) throw new Error('only --output <path> is supported');
  return value;
}

export function runAdversarialCli(args: string[] = process.argv.slice(2)): number {
  const repoRoot = git(['rev-parse', '--show-toplevel']);
  const requestedOutput = outputArgument(args);
  const outputPath = requestedOutput
    ? (isAbsolute(requestedOutput) ? requestedOutput : join(repoRoot, requestedOutput))
    : join(repoRoot, 'artifacts', 'adversarial-evidence.json');
  const { catalog, fixtureSha256 } = loadAdversarialCatalog();
  const executableTests = executeMappedAdversarialTests(catalog, repoRoot);
  // Capture identity after tests so a mapped test that mutates the checkout
  // cannot inherit a stale pre-test clean-tree claim.
  const source = {
    commit: git(['rev-parse', 'HEAD']),
    ref: gitRef(),
    cleanTree: git(['status', '--porcelain', '--untracked-files=all']) === '',
  };
  const report = buildAdversarialEvidence(catalog, fixtureSha256, source, executableTests);
  const bytes = `${canonicalJson(report)}\n`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const checksumPath = `${outputPath}.sha256`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes, { encoding: 'utf8', flag: 'w' });
  writeFileSync(checksumPath, `${digest}  ${basename(outputPath)}\n`, {
    encoding: 'utf8',
    flag: 'w',
  });
  process.stdout.write(
    `adversarial evidence: ${report.testSummary.passed} passed, ` +
    `${report.testSummary.failed} failed, ${report.testSummary.uncovered} scenario checks uncovered\n` +
    `structural runtime entry paths: ${report.structuralCoverage.runtimeEntryPaths.covered}/` +
    `${report.structuralCoverage.runtimeEntryPaths.total} cataloged\n` +
    `development status: ${report.developmentStatus} (incomplete evidence allowed; not a release gate)\n` +
    `report: ${outputPath}\nchecksum: ${checksumPath}\n`,
  );
  return report.testSummary.failed === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = runAdversarialCli();
  } catch (error) {
    process.stderr.write(`adversarial evidence failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
