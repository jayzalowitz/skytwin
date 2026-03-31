import type {
  DecisionObject,
  DecisionOutcome,
  DecisionContext,
  ExplanationRecord,
  EvidenceReference,
  PreferenceReference,
} from '@skytwin/shared-types';
import { ConfidenceLevel, RiskTier } from '@skytwin/shared-types';

/**
 * Port interface for explanation persistence.
 *
 * Business logic depends on this interface, not on a concrete database
 * implementation. Adapters (e.g., wrapping @skytwin/db's explanationRepository)
 * satisfy this contract at composition time.
 */
export interface ExplanationRepositoryPort {
  save(record: ExplanationRecord): Promise<ExplanationRecord>;
  getByDecisionId(decisionId: string): Promise<ExplanationRecord | null>;
  getByUserId(userId: string, limit?: number): Promise<ExplanationRecord[]>;
}

/**
 * Structured audit format for compliance and review.
 */
export interface AuditRecord {
  decisionId: string;
  userId: string;
  timestamp: string;
  summary: string;
  riskTier: RiskTier;
  confidence: ConfidenceLevel;
  evidenceCount: number;
  preferencesCount: number;
  autoExecuted: boolean;
  actionTaken: string | null;
  fullExplanation: ExplanationRecord;
}

/**
 * The ExplanationGenerator produces human-readable and audit-ready
 * explanations for every decision SkyTwin makes. Transparency is a
 * core value: the user should always be able to understand why an
 * action was taken or escalated.
 */
export class ExplanationGenerator {
  constructor(private readonly repository: ExplanationRepositoryPort) {}

  /**
   * Generate a complete explanation record for a decision.
   */
  async generate(
    decision: DecisionObject,
    outcome: DecisionOutcome,
    context: DecisionContext,
  ): Promise<ExplanationRecord> {
    const evidenceUsed = this.gatherEvidenceReferences(context);
    const preferencesInvoked = this.gatherPreferenceReferences(context);
    const confidenceReasoning = this.buildConfidenceReasoning(outcome, context);
    const actionRationale = this.buildActionRationale(outcome);
    const escalationRationale = outcome.requiresApproval
      ? this.buildEscalationRationale(outcome)
      : undefined;
    const correctionGuidance = this.buildCorrectionGuidance(outcome);

    const overallConfidence = outcome.selectedAction
      ? outcome.selectedAction.confidence
      : ConfidenceLevel.SPECULATIVE;

    const riskTier = outcome.riskAssessment
      ? outcome.riskAssessment.overallTier
      : RiskTier.NEGLIGIBLE;

    const record: ExplanationRecord = {
      id: `expl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      decisionId: decision.id,
      userId: context.userId,
      summary: this.buildSummary(decision, outcome),
      evidenceUsed,
      preferencesInvoked,
      confidenceReasoning,
      actionRationale,
      escalationRationale,
      correctionGuidance,
      riskTier,
      overallConfidence,
      createdAt: new Date(),
    };

    await this.repository.save(record);
    return record;
  }

  /**
   * Format an explanation record into a human-readable string suitable
   * for showing to the user.
   */
  formatForUser(record: ExplanationRecord): string {
    const lines: string[] = [];

    lines.push(`--- Decision Explanation ---`);
    lines.push('');
    lines.push(record.summary);
    lines.push('');

    // What happened
    lines.push(`What happened: ${record.actionRationale}`);
    lines.push('');

    // Confidence
    lines.push(`Confidence: ${record.overallConfidence}`);
    lines.push(record.confidenceReasoning);
    lines.push('');

    // Risk
    lines.push(`Risk level: ${record.riskTier}`);
    lines.push('');

    // Escalation
    if (record.escalationRationale) {
      lines.push(`Why approval was needed: ${record.escalationRationale}`);
      lines.push('');
    }

    // Evidence
    if (record.evidenceUsed.length > 0) {
      lines.push('Evidence used:');
      for (const ev of record.evidenceUsed) {
        lines.push(`  - [${ev.source}] ${ev.summary} (${ev.relevance})`);
      }
      lines.push('');
    }

    // Preferences
    if (record.preferencesInvoked.length > 0) {
      lines.push('Your preferences applied:');
      for (const pref of record.preferencesInvoked) {
        lines.push(`  - ${pref.domain}/${pref.key} (confidence: ${pref.confidence}): ${pref.howUsed}`);
      }
      lines.push('');
    }

    // Correction guidance
    lines.push('How to correct this:');
    lines.push(record.correctionGuidance);
    lines.push('');

    lines.push('---');

    return lines.join('\n');
  }

  /**
   * Format an explanation record into a structured audit format for
   * compliance and logging.
   */
  formatForAudit(record: ExplanationRecord): AuditRecord {
    return {
      decisionId: record.decisionId,
      userId: record.userId,
      timestamp: record.createdAt.toISOString(),
      summary: record.summary,
      riskTier: record.riskTier,
      confidence: record.overallConfidence,
      evidenceCount: record.evidenceUsed.length,
      preferencesCount: record.preferencesInvoked.length,
      autoExecuted: !record.escalationRationale,
      actionTaken: record.actionRationale,
      fullExplanation: record,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private buildSummary(
    decision: DecisionObject,
    outcome: DecisionOutcome,
  ): string {
    if (!outcome.selectedAction) {
      return (
        `SkyTwin encountered a ${decision.situationType} situation ` +
        `("${decision.summary}") but could not determine a safe action. ` +
        `The decision has been escalated for your review.`
      );
    }

    if (outcome.autoExecute) {
      return (
        `SkyTwin automatically handled a ${decision.situationType} situation: ` +
        `${decision.summary} ` +
        `Action taken: "${outcome.selectedAction.description}".`
      );
    }

    if (outcome.requiresApproval) {
      return (
        `SkyTwin analyzed a ${decision.situationType} situation: ` +
        `${decision.summary} ` +
        `Recommended action: "${outcome.selectedAction.description}". ` +
        `Your approval is needed before execution.`
      );
    }

    return (
      `SkyTwin processed a ${decision.situationType} situation: ` +
      `${decision.summary} ` +
      `Selected action: "${outcome.selectedAction.description}".`
    );
  }

  private gatherEvidenceReferences(
    context: DecisionContext,
  ): EvidenceReference[] {
    const references: EvidenceReference[] = [];

    // Create evidence references from the raw decision data
    const rawData = context.decision.rawData;
    if (rawData['source']) {
      references.push({
        evidenceId: `raw_${context.decision.id}`,
        source: String(rawData['source']),
        summary: `Original signal from ${String(rawData['source'])}`,
        relevance: 'Primary trigger for this decision.',
      });
    }

    // References from preferences' evidence
    for (const pref of context.relevantPreferences) {
      for (const evidenceId of pref.evidenceIds.slice(0, 3)) {
        references.push({
          evidenceId,
          source: pref.source,
          summary: `Evidence supporting preference "${pref.key}" in domain "${pref.domain}"`,
          relevance: `Supports the "${pref.key}" preference with ${pref.confidence} confidence.`,
        });
      }
    }

    return references;
  }

  private gatherPreferenceReferences(
    context: DecisionContext,
  ): PreferenceReference[] {
    return context.relevantPreferences.map((pref) => ({
      preferenceId: pref.id,
      domain: pref.domain,
      key: pref.key,
      confidence: pref.confidence,
      howUsed: `Applied "${pref.key}" preference (value: ${String(pref.value)}) ` +
        `to guide action selection in the "${pref.domain}" domain.`,
    }));
  }

  private buildConfidenceReasoning(
    outcome: DecisionOutcome,
    context: DecisionContext,
  ): string {
    const parts: string[] = [];

    if (outcome.selectedAction) {
      parts.push(
        `The selected action has ${outcome.selectedAction.confidence} confidence.`,
      );
    }

    const highConfPrefs = context.relevantPreferences.filter(
      (p) =>
        p.confidence === ConfidenceLevel.HIGH ||
        p.confidence === ConfidenceLevel.CONFIRMED,
    );
    const lowConfPrefs = context.relevantPreferences.filter(
      (p) =>
        p.confidence === ConfidenceLevel.SPECULATIVE ||
        p.confidence === ConfidenceLevel.LOW,
    );

    if (highConfPrefs.length > 0) {
      parts.push(
        `${highConfPrefs.length} high-confidence preference(s) were available to guide the decision.`,
      );
    }

    if (lowConfPrefs.length > 0) {
      parts.push(
        `${lowConfPrefs.length} low-confidence preference(s) added uncertainty.`,
      );
    }

    if (context.relevantPreferences.length === 0) {
      parts.push(
        'No relevant preferences were found. The decision was made with minimal personalization.',
      );
    }

    if (outcome.allCandidates.length > 1) {
      parts.push(
        `${outcome.allCandidates.length} candidate actions were evaluated.`,
      );
    }

    return parts.join(' ');
  }

  private buildActionRationale(outcome: DecisionOutcome): string {
    if (!outcome.selectedAction) {
      return (
        'No action was selected. ' + outcome.reasoning
      );
    }

    return (
      `Selected "${outcome.selectedAction.description}" ` +
      `(type: ${outcome.selectedAction.actionType}). ` +
      outcome.selectedAction.reasoning +
      (outcome.autoExecute
        ? ' This action was auto-executed based on your trust tier and risk assessment.'
        : '')
    );
  }

  private buildEscalationRationale(outcome: DecisionOutcome): string {
    return outcome.reasoning;
  }

  private buildCorrectionGuidance(
    outcome: DecisionOutcome,
  ): string {
    const parts: string[] = [];

    if (outcome.autoExecute && outcome.selectedAction) {
      parts.push(
        'This action was auto-executed. If this was wrong, you can:',
      );
      if (outcome.selectedAction.reversible) {
        parts.push('  1. Undo this action (it is reversible).');
      }
      parts.push(
        '  ' +
          (outcome.selectedAction.reversible ? '2' : '1') +
          '. Provide feedback to improve future decisions.',
      );
      parts.push(
        '  ' +
          (outcome.selectedAction.reversible ? '3' : '2') +
          '. Adjust your autonomy settings to require approval for similar actions.',
      );
    } else {
      parts.push('You can:');
      parts.push('  1. Approve the recommended action.');
      parts.push('  2. Choose a different action from the candidates.');
      parts.push('  3. Dismiss this decision.');
      parts.push(
        '  4. Provide feedback so SkyTwin learns from this interaction.',
      );
    }

    return parts.join('\n');
  }
}
