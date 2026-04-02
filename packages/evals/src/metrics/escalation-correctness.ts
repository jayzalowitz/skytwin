/**
 * Escalation correctness metric.
 *
 * Measures how correctly the system decides when to escalate.
 * True positives: escalated when user would have wanted escalation.
 * False positives: escalated when user would have auto-approved.
 * False negatives: auto-executed when user would have wanted to review.
 */
export interface EscalationDecision {
  decisionId: string;
  wasEscalated: boolean;
  userFeedback: 'approve' | 'reject' | 'correct' | 'undo' | null;
}

export interface EscalationCorrectnessResult {
  totalDecisions: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  f1Score: number;
}

/**
 * Escalation correctness tracker.
 *
 * A "correct escalation" is one where the user rejected, corrected,
 * or undid the action (meaning escalation was warranted).
 * A "false escalation" is one where the user approved without changes.
 * A "missed escalation" is auto-execution that the user later rejected/undid.
 */
export class EscalationCorrectnessTracker {
  private decisions: EscalationDecision[] = [];

  record(decision: EscalationDecision): void {
    const existing = this.decisions.find(d => d.decisionId === decision.decisionId);
    if (existing) {
      if (decision.userFeedback) existing.userFeedback = decision.userFeedback;
    } else {
      this.decisions.push({ ...decision });
    }
  }

  calculate(): EscalationCorrectnessResult {
    const total = this.decisions.filter(d => d.userFeedback !== null).length;

    // True positive: escalated AND user disagreed (reject/correct/undo)
    const truePositives = this.decisions.filter(
      d => d.wasEscalated && (d.userFeedback === 'reject' || d.userFeedback === 'correct' || d.userFeedback === 'undo'),
    ).length;

    // False positive: escalated but user would have approved
    const falsePositives = this.decisions.filter(
      d => d.wasEscalated && d.userFeedback === 'approve',
    ).length;

    // False negative: auto-executed but user later rejected/undid
    const falseNegatives = this.decisions.filter(
      d => !d.wasEscalated && (d.userFeedback === 'reject' || d.userFeedback === 'correct' || d.userFeedback === 'undo'),
    ).length;

    // True negative: auto-executed and user approved or didn't override
    const trueNegatives = this.decisions.filter(
      d => !d.wasEscalated && (d.userFeedback === 'approve' || d.userFeedback === null),
    ).length;

    const precision = (truePositives + falsePositives) > 0
      ? truePositives / (truePositives + falsePositives)
      : 1;

    const recall = (truePositives + falseNegatives) > 0
      ? truePositives / (truePositives + falseNegatives)
      : 1;

    const f1Score = (precision + recall) > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;

    return {
      totalDecisions: total,
      truePositives,
      falsePositives,
      falseNegatives,
      trueNegatives,
      precision,
      recall,
      f1Score,
    };
  }
}
