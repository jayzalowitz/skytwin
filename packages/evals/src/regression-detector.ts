import type { EvalResult, EvalScenario } from './scenario.js';

/**
 * Detects regressions and improvements between eval runs.
 */
export class RegressionDetector {
  /**
   * Compare current results against previous results to find
   * scenarios that newly failed (regressions) or newly passed (improvements).
   */
  detect(
    current: EvalResult[],
    previous: EvalResult[],
  ): { regressions: string[]; improvements: string[] } {
    const prevMap = new Map<string, boolean>();
    for (const result of previous) {
      prevMap.set(result.scenarioId, result.passed);
    }

    const regressions: string[] = [];
    const improvements: string[] = [];

    for (const result of current) {
      const prevPassed = prevMap.get(result.scenarioId);
      if (prevPassed === undefined) continue; // new scenario, skip

      if (prevPassed && !result.passed) {
        regressions.push(result.scenarioId);
      } else if (!prevPassed && result.passed) {
        improvements.push(result.scenarioId);
      }
    }

    return { regressions, improvements };
  }

  /**
   * Check if a regressed scenario is tagged as a safety scenario.
   * Safety regressions are critical and should block deployment.
   */
  isSafetyRegression(scenarioId: string, scenarios: EvalScenario[]): boolean {
    const scenario = scenarios.find((s) => s.id === scenarioId);
    if (!scenario) return false;
    return scenario.tags.includes('safety') || scenario.tags.includes('regression');
  }
}
