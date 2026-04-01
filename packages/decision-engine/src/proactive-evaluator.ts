import type {
  BriefingItem,
  ProactiveScanResult,
  DecisionOutcome,
  WhatWouldIDoRequest,
  WhatWouldIDoResponse,
  TwinProfile,
  Preference,
} from '@skytwin/shared-types';
import { ConfidenceLevel, TrustTier } from '@skytwin/shared-types';
import { DecisionMaker } from './decision-maker.js';

/**
 * Signal input for proactive scanning.
 */
interface ProactiveSignal {
  source: string;
  type: string;
  domain: string;
  data: Record<string, unknown>;
}

/**
 * TwinService subset required by the proactive evaluator.
 */
interface ProactiveTwinService {
  getOrCreateProfile: (userId: string) => Promise<TwinProfile>;
  getRelevantPreferences: (userId: string, domain: string, situation: string) => Promise<Preference[]>;
  getPatterns: (userId: string) => Promise<unknown[]>;
  getTraits: (userId: string) => Promise<unknown[]>;
  getTemporalProfile: (userId: string) => Promise<unknown>;
}

/**
 * The ProactiveEvaluator scans pending signals for a user and predicts
 * what the twin would do for each one. It partitions results into
 * auto-actions (high confidence), items needing approval, and briefing items.
 */
export class ProactiveEvaluator {
  constructor(private readonly decisionMaker: DecisionMaker) {}

  /**
   * Scan a set of signals for a user and produce a ProactiveScanResult.
   */
  async scanUser(
    userId: string,
    signals: ProactiveSignal[],
    twinService: ProactiveTwinService,
    userTrustTier: TrustTier,
  ): Promise<ProactiveScanResult> {
    const startedAt = new Date();
    const autoActions: DecisionOutcome[] = [];
    const approvalNeeded: DecisionOutcome[] = [];
    const briefingItems: BriefingItem[] = [];
    const responses: WhatWouldIDoResponse[] = [];

    for (const signal of signals) {
      const request: WhatWouldIDoRequest = {
        situation: `${signal.type} from ${signal.source}: ${JSON.stringify(signal.data)}`,
        domain: signal.domain,
        urgency: (signal.data['urgency'] as WhatWouldIDoRequest['urgency']) ?? 'medium',
      };

      const response = await this.decisionMaker.whatWouldIDo(
        userId,
        request,
        twinService,
        userTrustTier,
      );

      responses.push(response);

      const confidenceRank = this.confidenceRank(response.confidence);
      const highOrConfirmed = confidenceRank >= this.confidenceRank(ConfidenceLevel.HIGH);
      const moderateOrAbove = confidenceRank >= this.confidenceRank(ConfidenceLevel.MODERATE);

      // Build a synthetic DecisionOutcome for partitioning
      const outcome: DecisionOutcome = {
        id: `outcome_${response.predictionId}`,
        decisionId: response.predictionId,
        selectedAction: response.predictedAction,
        allCandidates: [
          ...(response.predictedAction ? [response.predictedAction] : []),
          ...response.alternativeActions,
        ],
        riskAssessment: null,
        autoExecute: response.wouldAutoExecute,
        requiresApproval: !response.wouldAutoExecute,
        reasoning: response.reasoning,
        decidedAt: new Date(),
      };

      if (highOrConfirmed && response.wouldAutoExecute) {
        autoActions.push(outcome);
      } else if (moderateOrAbove) {
        approvalNeeded.push(outcome);
      }

      // Build a BriefingItem for every signal
      briefingItems.push({
        actionDescription: response.predictedAction?.description ?? 'No action predicted',
        domain: signal.domain,
        confidence: response.confidence,
        urgency: request.urgency ?? 'medium',
        reasoning: response.reasoning,
        wouldAutoExecute: response.wouldAutoExecute,
        decisionId: response.predictionId,
      });
    }

    return {
      scanId: `scan_${Date.now()}`,
      userId,
      scanType: 'manual',
      autoActions,
      approvalNeeded,
      briefingItems,
      startedAt,
      completedAt: new Date(),
    };
  }

  /**
   * Generate a sorted briefing from a scan result.
   * Items are sorted by urgency (critical > high > medium > low),
   * then by confidence (confirmed > high > moderate > low > speculative).
   */
  generateBriefing(scanResult: ProactiveScanResult): BriefingItem[] {
    const items = [...scanResult.briefingItems];

    items.sort((a, b) => {
      const urgencyDiff = this.urgencyRank(b.urgency) - this.urgencyRank(a.urgency);
      if (urgencyDiff !== 0) return urgencyDiff;
      return this.confidenceRank(b.confidence) - this.confidenceRank(a.confidence);
    });

    return items;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private confidenceRank(level: ConfidenceLevel): number {
    const ranks: Record<ConfidenceLevel, number> = {
      [ConfidenceLevel.SPECULATIVE]: 0,
      [ConfidenceLevel.LOW]: 1,
      [ConfidenceLevel.MODERATE]: 2,
      [ConfidenceLevel.HIGH]: 3,
      [ConfidenceLevel.CONFIRMED]: 4,
    };
    return ranks[level];
  }

  private urgencyRank(urgency: string): number {
    const ranks: Record<string, number> = {
      low: 0,
      medium: 1,
      high: 2,
      critical: 3,
    };
    return ranks[urgency] ?? 0;
  }
}
