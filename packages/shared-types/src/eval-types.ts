/**
 * Record of a single evaluation run for historical tracking.
 */
export interface EvalRun {
  id: string;
  suiteId: string;
  userId: string;
  twinVersion: number;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  regressions: string[];
  improvements: string[];
  runAt: Date;
  /** Per-scenario pass/fail results, stored for regression comparison. */
  scenarioResults?: Array<{ scenarioId: string; passed: boolean }>;
}

/**
 * Trend analysis computed from a sequence of eval runs.
 */
export interface EvalTrend {
  userId: string;
  suiteId: string;
  dataPoints: Array<{
    twinVersion: number;
    passRate: number;
    timestamp: Date;
  }>;
  trend: 'improving' | 'stable' | 'degrading';
  confidenceInTrend: number;
}

/**
 * Accuracy metric computed from real decision feedback.
 */
export interface AccuracyMetric {
  id: string;
  userId: string;
  domain: string;
  totalDecisions: number;
  autoExecuted: number;
  approvedByUser: number;
  rejectedByUser: number;
  correctedByUser: number;
  accuracyRate: number;
  periodStart: Date;
  periodEnd: Date;
}
