import type { EvalRun, EvalTrend, AccuracyMetric } from '@skytwin/shared-types';
import type { EvalScenario, EvalResult } from './scenario.js';
import type { EvalRunner } from './runner.js';
import { RegressionDetector } from './regression-detector.js';
import { AccuracyTracker } from './accuracy-tracker.js';
import { EscalationCorrectnessTracker } from './metrics/escalation-correctness.js';
import { CalibrationErrorTracker } from './metrics/calibration-error.js';
import { DecisionLatencyTracker } from './metrics/decision-latency.js';

/**
 * Port interface for persisting eval history.
 */
export interface EvalRepositoryPort {
  saveRun(run: EvalRun): Promise<EvalRun>;
  getLatestRun(userId: string, suiteId: string): Promise<EvalRun | null>;
  getRunHistory(userId: string, suiteId: string, limit: number): Promise<EvalRun[]>;
  saveAccuracyMetric(metric: AccuracyMetric): Promise<AccuracyMetric>;
  getAccuracyHistory(userId: string, domain: string, limit: number): Promise<AccuracyMetric[]>;
}

/**
 * A named collection of eval scenarios.
 */
export interface EvalSuite {
  id: string;
  name: string;
  scenarios: EvalScenario[];
  tags: string[];
}

/**
 * Orchestrates continuous evaluation: runs suites, compares with history,
 * detects regressions, tracks accuracy, and computes trends.
 */
export class ContinuousEvalRunner {
  private readonly regressionDetector = new RegressionDetector();
  readonly escalationTracker = new EscalationCorrectnessTracker();
  readonly calibrationTracker = new CalibrationErrorTracker();
  readonly latencyTracker = new DecisionLatencyTracker();

  constructor(
    private readonly evalRunner: EvalRunner,
    private readonly repository: EvalRepositoryPort,
    private readonly accuracyTracker: AccuracyTracker,
  ) {}

  /**
   * Run a suite, compare with the previous run, detect regressions, and store results.
   */
  async runAndCompare(
    suite: EvalSuite,
    userId: string,
    twinVersion: number,
  ): Promise<EvalRun> {
    // Run all scenarios
    const results = await this.evalRunner.runSuite(suite.scenarios);
    const report = this.evalRunner.generateReport(results);

    // Get previous run for comparison
    const previousRun = await this.repository.getLatestRun(userId, suite.id);
    let regressions: string[] = [];
    let improvements: string[] = [];

    if (previousRun) {
      // We need the previous results to compare; reconstruct from stored data
      const previousResults = this.reconstructResults(previousRun);
      const comparison = this.regressionDetector.detect(results, previousResults);
      regressions = comparison.regressions;
      improvements = comparison.improvements;

      // Warn about safety regressions
      for (const regId of regressions) {
        if (this.regressionDetector.isSafetyRegression(regId, suite.scenarios)) {
          console.warn(`[eval] SAFETY REGRESSION detected in scenario: ${regId}`);
        }
      }
    }

    const run: EvalRun = {
      id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      suiteId: suite.id,
      userId,
      twinVersion,
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      passRate: report.passRate,
      regressions,
      improvements,
      runAt: new Date(),
    };

    return this.repository.saveRun(run);
  }

  /**
   * Calculate trend from a sequence of eval runs.
   */
  calculateTrend(runs: EvalRun[]): EvalTrend {
    if (runs.length === 0) {
      return {
        userId: '',
        suiteId: '',
        dataPoints: [],
        trend: 'stable',
        confidenceInTrend: 0,
      };
    }

    const sorted = [...runs].sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
    const dataPoints = sorted.map((r) => ({
      twinVersion: r.twinVersion,
      passRate: r.passRate,
      timestamp: r.runAt,
    }));

    // Calculate trend using simple linear regression on pass rates
    let trend: 'improving' | 'stable' | 'degrading' = 'stable';
    let confidenceInTrend = 0;

    if (dataPoints.length >= 3) {
      const rates = dataPoints.map((d) => d.passRate);
      const n = rates.length;
      const xMean = (n - 1) / 2;
      const yMean = rates.reduce((s, r) => s + r, 0) / n;

      let numerator = 0;
      let denominator = 0;
      for (let i = 0; i < n; i++) {
        numerator += (i - xMean) * (rates[i]! - yMean);
        denominator += (i - xMean) ** 2;
      }

      const slope = denominator > 0 ? numerator / denominator : 0;

      if (slope > 1) {
        trend = 'improving';
      } else if (slope < -1) {
        trend = 'degrading';
      }

      // Confidence based on consistency of the trend
      confidenceInTrend = Math.min(Math.abs(slope) / 5, 1);
    }

    return {
      userId: sorted[0]!.userId,
      suiteId: sorted[0]!.suiteId,
      dataPoints,
      trend,
      confidenceInTrend,
    };
  }

  /**
   * Process a feedback event for accuracy tracking.
   */
  onFeedback(
    userId: string,
    domain: string,
    decisionId: string,
    feedbackType: string,
    autoExecuted: boolean,
  ): void {
    this.accuracyTracker.recordOutcome({
      decisionId,
      userId,
      domain,
      autoExecuted,
      feedbackType: feedbackType as 'approve' | 'reject' | 'correct' | 'ignore',
      timestamp: new Date(),
    });
  }

  /**
   * Get current accuracy metrics for a user.
   */
  async getAccuracy(
    userId: string,
    domain: string,
    days: number,
  ): Promise<AccuracyMetric> {
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - days * 24 * 60 * 60 * 1000);
    return this.accuracyTracker.calculateAccuracy(userId, domain, periodStart, periodEnd);
  }

  private reconstructResults(_run: EvalRun): EvalResult[] {
    // Full result reconstruction requires storing per-scenario results in the run.
    // For now, return empty — regression detection will compare whatever
    // results are available from the current run against this baseline.
    return [];
  }
}
