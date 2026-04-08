import type { DecisionContext, DecisionOutcome, TwinProfile, Preference } from '@skytwin/shared-types';
import { TrustTier, RiskTier } from '@skytwin/shared-types';
import type { DecisionMaker } from '@skytwin/decision-engine';
import type { EvalScenario, EvalResult, EvalReport, ExpectedOutcome } from './scenario.js';
import { SituationInterpreter } from '@skytwin/decision-engine';

/**
 * The EvalRunner executes evaluation scenarios against the decision engine
 * and reports on whether the outcomes match expectations.
 */
export class EvalRunner {
  private readonly interpreter: SituationInterpreter;

  constructor(
    private readonly decisionMaker: DecisionMaker,
  ) {
    this.interpreter = new SituationInterpreter();
  }

  /**
   * Run a single evaluation scenario and produce a result.
   */
  async runScenario(scenario: EvalScenario): Promise<EvalResult> {
    // Set up twin profile from scenario
    const twinProfile: TwinProfile = {
      id: `eval_twin_${scenario.id}`,
      userId: `eval_user_${scenario.id}`,
      version: 1,
      preferences: (scenario.setupTwin.preferences ?? []) as Preference[],
      inferences: scenario.setupTwin.inferences ?? [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Interpret the raw event
    const decision = await this.interpreter.interpret(scenario.event);

    // Build decision context
    const context: DecisionContext = {
      userId: twinProfile.userId,
      decision,
      trustTier: (scenario.event['trustTier'] as TrustTier) ?? TrustTier.MODERATE_AUTONOMY,
      relevantPreferences: twinProfile.preferences,
      timestamp: new Date(),
    };

    // Evaluate
    const outcome = await this.decisionMaker.evaluate(context);

    // Compare against expected outcome
    const discrepancies = this.findDiscrepancies(outcome, scenario.expectedOutcome);

    return {
      scenarioId: scenario.id,
      passed: discrepancies.length === 0,
      actual: outcome,
      expected: scenario.expectedOutcome,
      discrepancies,
    };
  }

  /**
   * Run all scenarios in a suite and produce results.
   */
  async runSuite(scenarios: EvalScenario[]): Promise<EvalResult[]> {
    const results: EvalResult[] = [];

    for (const scenario of scenarios) {
      const result = await this.runScenario(scenario);
      results.push(result);
    }

    return results;
  }

  /**
   * Generate an aggregate report from eval results.
   */
  generateReport(results: EvalResult[]): EvalReport {
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    const failures = results
      .filter((r) => !r.passed)
      .map((r) => ({
        scenarioId: r.scenarioId,
        scenarioName: r.scenarioId, // The runner doesn't have scenario names; caller can enrich
        discrepancies: r.discrepancies,
      }));

    return {
      total: results.length,
      passed,
      failed,
      passRate: results.length > 0 ? (passed / results.length) * 100 : 0,
      results,
      failures,
      generatedAt: new Date(),
    };
  }

  // ── Private helpers ──────────────────────────────────────────

  private findDiscrepancies(
    actual: DecisionOutcome,
    expected: ExpectedOutcome,
  ): string[] {
    const discrepancies: string[] = [];

    // Check auto-execute
    if (actual.autoExecute !== expected.shouldAutoExecute) {
      discrepancies.push(
        `Auto-execute: expected ${expected.shouldAutoExecute}, got ${actual.autoExecute}`,
      );
    }

    // Check escalation
    if (expected.shouldEscalate && !actual.requiresApproval && !actual.autoExecute) {
      // If we expected escalation but got neither approval required nor auto-execute,
      // the action was likely blocked entirely -- which could be a valid escalation
      if (actual.selectedAction !== null) {
        discrepancies.push(
          `Escalation: expected escalation but action was not escalated`,
        );
      }
    }

    if (!expected.shouldEscalate && actual.requiresApproval) {
      discrepancies.push(
        `Escalation: did not expect escalation but approval was required`,
      );
    }

    // Check action type
    if (expected.expectedActionType && actual.selectedAction) {
      if (actual.selectedAction.actionType !== expected.expectedActionType) {
        discrepancies.push(
          `Action type: expected "${expected.expectedActionType}", got "${actual.selectedAction.actionType}"`,
        );
      }
    }

    // Check risk tier
    if (actual.riskAssessment) {
      const actualRiskRank = this.riskTierRank(actual.riskAssessment.overallTier);
      const maxRiskRank = this.riskTierRank(expected.maxRiskTier);
      if (actualRiskRank > maxRiskRank) {
        discrepancies.push(
          `Risk tier: actual ${actual.riskAssessment.overallTier} exceeds max ${expected.maxRiskTier}`,
        );
      }
    }

    return discrepancies;
  }

  private riskTierRank(tier: RiskTier): number {
    const ranks: Record<RiskTier, number> = {
      [RiskTier.NEGLIGIBLE]: 0,
      [RiskTier.LOW]: 1,
      [RiskTier.MODERATE]: 2,
      [RiskTier.HIGH]: 3,
      [RiskTier.CRITICAL]: 4,
    };
    return ranks[tier];
  }
}
