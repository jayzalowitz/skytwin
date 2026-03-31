import type { DecisionOutcome, TwinProfile } from '@skytwin/shared-types';
import { RiskTier } from '@skytwin/shared-types';

/**
 * An evaluation scenario describes a situation, the twin state to use,
 * and the expected outcome from the decision engine.
 */
export interface EvalScenario {
  /** Unique identifier for this scenario */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this scenario tests */
  description: string;
  /** Twin profile state to set up before running */
  setupTwin: Partial<TwinProfile>;
  /** Raw event data to feed into the decision pipeline */
  event: Record<string, unknown>;
  /** Expected outcome to validate against */
  expectedOutcome: ExpectedOutcome;
  /** Tags for filtering and grouping scenarios */
  tags: string[];
}

/**
 * Expected outcome from a decision evaluation.
 */
export interface ExpectedOutcome {
  /** Whether the action should be auto-executed */
  shouldAutoExecute: boolean;
  /** Expected action type (if any) */
  expectedActionType?: string;
  /** Maximum acceptable risk tier */
  maxRiskTier: RiskTier;
  /** Whether the decision should be escalated to the user */
  shouldEscalate: boolean;
}

/**
 * Result of running a single eval scenario.
 */
export interface EvalResult {
  /** ID of the scenario that was run */
  scenarioId: string;
  /** Whether the scenario passed all checks */
  passed: boolean;
  /** The actual outcome from the decision engine */
  actual: DecisionOutcome;
  /** The expected outcome from the scenario */
  expected: ExpectedOutcome;
  /** List of discrepancies between actual and expected */
  discrepancies: string[];
}

/**
 * Aggregate report from running multiple eval scenarios.
 */
export interface EvalReport {
  /** Total number of scenarios run */
  total: number;
  /** Number that passed */
  passed: number;
  /** Number that failed */
  failed: number;
  /** Pass rate as a percentage */
  passRate: number;
  /** Individual results */
  results: EvalResult[];
  /** Details about failures */
  failures: Array<{
    scenarioId: string;
    scenarioName: string;
    discrepancies: string[];
  }>;
  /** Timestamp when the report was generated */
  generatedAt: Date;
}
