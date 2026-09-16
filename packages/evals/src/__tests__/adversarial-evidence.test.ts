import { describe, expect, it } from 'vitest';
import {
  buildAdversarialEvidence,
  canonicalJson,
  collectDispatchCalls,
  evaluateAdversarialScenario,
  loadAdversarialCatalog,
} from '../adversarial-evidence.js';
import type { ExecutableTestResult } from '../adversarial-test-executor.js';

const loaded = loadAdversarialCatalog();
const policyScenarios = loaded.catalog.scenarios.filter(
  ({ evidenceMode }) => evidenceMode === 'deterministic_policy',
);
const passingTests = new Map<string, ExecutableTestResult>(loaded.catalog.scenarios.map((scenario) =>
  [scenario.executableTestId, {
    executableTestId: scenario.executableTestId,
    status: 'passed' as const,
    reason: 'test fixture',
    assertionSha256: scenario.assertionSha256,
  }],
));

describe('adversarial evidence catalog', () => {
  it.each(policyScenarios)('evaluates $id', (scenario) => {
    expect(evaluateAdversarialScenario(scenario, passingTests.get(scenario.executableTestId)!)).toMatchObject({
      id: scenario.id,
      status: 'passed',
      expectedDisposition: scenario.expectedDisposition,
      expectedConfirmation: scenario.expectedConfirmation,
    });
  });

  it('contains every required shape and origin with stable unique IDs', () => {
    const scenarios = loaded.catalog.scenarios;
    expect(new Set(scenarios.map(({ id }) => id)).size).toBe(scenarios.length);
    expect(new Set(scenarios.map(({ criticalShape }) => criticalShape))).toEqual(new Set([
      'send', 'delete', 'purchase', 'credential', 'account', 'shell', 'filesystem', 'database',
    ]));
    expect(new Set(scenarios.map(({ origin }) => origin.kind))).toEqual(new Set([
      'email', 'calendar', 'file', 'web', 'mcp', 'missing', 'user',
    ]));
  });

  it('counts exact mapped regressions while keeping release incompleteness explicit', () => {
    const report = buildAdversarialEvidence(loaded.catalog, loaded.fixtureSha256, {
      commit: `b2db6ea${'0'.repeat(33)}`,
      ref: 'feature/adversarial-eval-evidence',
      cleanTree: true,
    }, passingTests);
    const mapped = report.results.filter(({ evidenceMode }) => evidenceMode === 'mapped_regression');
    expect(mapped).toHaveLength(12);
    expect(mapped.every(({ status, executableTestStatus }) =>
      status === 'passed' && executableTestStatus === 'passed')).toBe(true);
    expect(report.structuralCoverage).toMatchObject({
      scenarios: { covered: 21, total: 21 },
      runtimeEntryPaths: { covered: 10, total: 10 },
      adapters: { covered: 4, total: 4 },
      criticalShapes: { covered: 8, total: 8 },
      origins: { covered: 7, total: 7 },
    });
    expect(report.testSummary).toEqual({
      passed: 21,
      failed: 0,
      uncovered: 0,
    });
    expect(report.developmentStatus).toBe('incomplete');
    expect(report.allowIncomplete).toBe(true);
    expect(report.evidenceClass).toBe('source_checkout');
    expect(report.releaseSubject).toBeNull();
    expect(report.attestation).toBeNull();
    expect(report.releaseReadiness).toBeNull();
    expect(report.zeroBypassesClaimed).toBe(false);
  });

  it('fails a scenario when its exact mapped executable fails', () => {
    const scenario = loaded.catalog.scenarios.find(({ evidenceMode }) =>
      evidenceMode === 'mapped_regression')!;
    expect(evaluateAdversarialScenario(scenario, {
      executableTestId: scenario.executableTestId,
      status: 'failed',
      reason: 'injected regression',
      assertionSha256: scenario.assertionSha256,
    })).toMatchObject({
      id: scenario.id,
      status: 'failed',
      executableTestStatus: 'failed',
    });
  });

  it('keeps structural coverage independent from failed test outcomes', () => {
    const failing = new Map(passingTests);
    const scenario = loaded.catalog.scenarios.find(({ evidenceMode }) =>
      evidenceMode === 'mapped_regression')!;
    failing.set(scenario.executableTestId, {
      executableTestId: scenario.executableTestId,
      status: 'failed',
      reason: 'injected regression',
      assertionSha256: scenario.assertionSha256,
    });
    const report = buildAdversarialEvidence(loaded.catalog, loaded.fixtureSha256, {
      commit: `b2db6ea${'0'.repeat(33)}`,
      ref: 'test',
      cleanTree: true,
    }, failing);
    expect(report.structuralCoverage.scenarios).toEqual({ covered: 21, total: 21 });
    expect(report.testSummary).toEqual({ passed: 20, failed: 1, uncovered: 0 });
    expect(report.developmentStatus).toBe('incomplete');
  });

  it('keeps mapped expectations separate from unavailable semantic actuals', () => {
    const scenario = loaded.catalog.scenarios.find(({ evidenceMode }) =>
      evidenceMode === 'mapped_regression')!;
    expect(evaluateAdversarialScenario(
      scenario,
      passingTests.get(scenario.executableTestId)!,
    )).toMatchObject({
      status: 'passed',
      executableTestStatus: 'passed',
      expectedDisposition: scenario.expectedDisposition,
      actualDisposition: null,
      actualConfirmation: null,
      actualSeverity: null,
      assertionSha256: scenario.assertionSha256,
      reason: 'exact mapped regression assertion passed with integrity-bound source',
    });
  });

  it('serializes canonically regardless of object insertion order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it('inventories TypeScript dispatch calls without matching comments or strings', () => {
    expect(collectDispatchCalls('route.ts', `
      // router.rollback(plan);
      const example = 'adapter.createRoutine(routine)';
      router.executePrepared(plan);
      router['executePreparedStreaming'](plan);
    `)).toEqual(['executePrepared', 'executePreparedStreaming']);
  });
});
