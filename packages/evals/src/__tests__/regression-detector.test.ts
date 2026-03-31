import { describe, it, expect } from 'vitest';
import { RegressionDetector } from '../regression-detector.js';
import type { EvalResult } from '../scenario.js';
import { RiskTier } from '@skytwin/shared-types';

function makeResult(id: string, passed: boolean): EvalResult {
  return {
    scenarioId: id,
    passed,
    actual: {
      id: 'out1',
      decisionId: 'dec1',
      selectedAction: null,
      allCandidates: [],
      riskAssessment: null,
      autoExecute: false,
      requiresApproval: true,
      reasoning: '',
      decidedAt: new Date(),
    },
    expected: {
      shouldAutoExecute: false,
      maxRiskTier: RiskTier.LOW,
      shouldEscalate: true,
    },
    discrepancies: passed ? [] : ['something failed'],
  };
}

describe('RegressionDetector', () => {
  const detector = new RegressionDetector();

  it('detects regressions (passed before, fails now)', () => {
    const previous = [makeResult('s1', true), makeResult('s2', true)];
    const current = [makeResult('s1', true), makeResult('s2', false)];

    const result = detector.detect(current, previous);
    expect(result.regressions).toContain('s2');
    expect(result.improvements).toHaveLength(0);
  });

  it('detects improvements (failed before, passes now)', () => {
    const previous = [makeResult('s1', false), makeResult('s2', true)];
    const current = [makeResult('s1', true), makeResult('s2', true)];

    const result = detector.detect(current, previous);
    expect(result.improvements).toContain('s1');
    expect(result.regressions).toHaveLength(0);
  });

  it('handles new scenarios gracefully', () => {
    const previous = [makeResult('s1', true)];
    const current = [makeResult('s1', true), makeResult('s_new', false)];

    const result = detector.detect(current, previous);
    // s_new is new, not a regression
    expect(result.regressions).toHaveLength(0);
    expect(result.improvements).toHaveLength(0);
  });

  it('identifies safety regressions', () => {
    const scenarios = [
      { id: 's1', name: 'test', description: '', setupTwin: {}, event: {}, expectedOutcome: { shouldAutoExecute: false, maxRiskTier: RiskTier.LOW, shouldEscalate: false }, tags: ['safety'] },
      { id: 's2', name: 'test2', description: '', setupTwin: {}, event: {}, expectedOutcome: { shouldAutoExecute: false, maxRiskTier: RiskTier.LOW, shouldEscalate: false }, tags: ['feature'] },
    ];

    expect(detector.isSafetyRegression('s1', scenarios)).toBe(true);
    expect(detector.isSafetyRegression('s2', scenarios)).toBe(false);
  });
});
