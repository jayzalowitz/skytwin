import type {
  DecisionContext,
  DecisionObject,
  DecisionOutcome,
  CandidateAction,
  RiskAssessment,
  ActionPolicy,
  TwinProfile,
  Preference,
  WhatWouldIDoRequest,
  WhatWouldIDoResponse,
} from '@skytwin/shared-types';
import {
  ConfidenceLevel,
  RiskTier,
  SituationType,
  TrustTier,
} from '@skytwin/shared-types';
import type { TwinService } from '@skytwin/twin-model';
import type { PolicyEvaluator } from '@skytwin/policy-engine';
import { RiskAssessor } from './risk-assessor.js';

/**
 * Port interface for decision persistence.
 *
 * Business logic depends on this interface, not on a concrete database
 * implementation. Adapters (e.g., wrapping @skytwin/db's decisionRepository)
 * satisfy this contract at composition time.
 */
export interface DecisionRepositoryPort {
  saveDecision(decision: DecisionObject): Promise<DecisionObject>;
  getDecision(decisionId: string): Promise<DecisionObject | null>;
  saveOutcome(outcome: DecisionOutcome): Promise<DecisionOutcome>;
  getOutcome(decisionId: string): Promise<DecisionOutcome | null>;
  saveCandidates(candidates: CandidateAction[]): Promise<CandidateAction[]>;
  getCandidates(decisionId: string): Promise<CandidateAction[]>;
  saveRiskAssessment(assessment: RiskAssessment): Promise<RiskAssessment>;
  getRiskAssessment(actionId: string): Promise<RiskAssessment | null>;
  getRecentDecisions(userId: string, limit?: number): Promise<DecisionObject[]>;
}

/**
 * The DecisionMaker is the central orchestrator. Given a decision context,
 * it consults the twin for preferences, generates candidate actions,
 * assesses risk, checks policies, and selects the best action.
 */
export class DecisionMaker {
  private readonly riskAssessor: RiskAssessor;

  constructor(
    private readonly twinService: TwinService,
    private readonly policyEvaluator: PolicyEvaluator,
    private readonly decisionRepository: DecisionRepositoryPort,
  ) {
    this.riskAssessor = new RiskAssessor();
  }

  /**
   * Evaluate a decision context and produce an outcome.
   *
   * This is the main entry point for the decision pipeline:
   * 1. Get relevant preferences from the twin
   * 2. Generate candidate actions
   * 3. Assess risk for each candidate
   * 4. Check policies
   * 5. Select the best action
   * 6. Determine if auto-execution is allowed
   * 7. Generate explanation
   */
  async evaluate(context: DecisionContext): Promise<DecisionOutcome> {
    // Step 1: Get relevant preferences
    const preferences = await this.twinService.getRelevantPreferences(
      context.userId,
      context.decision.domain,
      context.decision.summary,
    );

    // Build an enriched context with preferences
    const enrichedContext: DecisionContext = {
      ...context,
      relevantPreferences: preferences,
    };

    // Step 2: Get profile for candidate generation
    const profile = await this.twinService.getOrCreateProfile(context.userId);

    // Step 3: Generate candidate actions
    const candidates = this.generateCandidates(context.decision, profile);

    if (candidates.length === 0) {
      const outcome: DecisionOutcome = {
        id: `outcome_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        decisionId: context.decision.id,
        selectedAction: null,
        allCandidates: [],
        riskAssessment: null,
        autoExecute: false,
        requiresApproval: true,
        reasoning: 'No candidate actions could be generated. Escalating to user.',
        decidedAt: new Date(),
      };
      await this.decisionRepository.saveOutcome(outcome);
      return outcome;
    }

    // Step 4: Assess risk for each candidate
    const assessments = new Map<string, RiskAssessment>();
    for (const candidate of candidates) {
      const assessment = this.assessRisk(candidate);
      assessments.set(candidate.id, assessment);
      await this.decisionRepository.saveRiskAssessment(assessment);
    }

    // Step 5: Load policies
    const policies = await this.policyEvaluator.loadPolicies();

    // Step 6: Score and rank candidates
    const scoredCandidates = candidates
      .map((candidate) => ({
        candidate,
        score: this.scoreCandidate(candidate, enrichedContext, assessments.get(candidate.id)!),
        assessment: assessments.get(candidate.id)!,
      }))
      .sort((a, b) => b.score - a.score);

    // Step 7: Find the best action that passes policy checks
    let selectedAction: CandidateAction | null = null;
    let selectedAssessment: RiskAssessment | null = null;
    let autoExecute = false;
    let requiresApproval = true;
    let reasoning = '';

    for (const { candidate, assessment } of scoredCandidates) {
      const policyDecision = await this.policyEvaluator.evaluate(
        candidate,
        policies,
        context.trustTier,
        assessment,
      );

      if (policyDecision.allowed) {
        selectedAction = candidate;
        selectedAssessment = assessment;
        requiresApproval = policyDecision.requiresApproval;
        autoExecute = !policyDecision.requiresApproval &&
          this.shouldAutoExecute(candidate, context.trustTier, policies);
        reasoning = autoExecute
          ? `Selected "${candidate.description}" for auto-execution. ${policyDecision.reason}`
          : policyDecision.requiresApproval
            ? `Selected "${candidate.description}" but requires approval. ${policyDecision.reason}`
            : `Selected "${candidate.description}". ${policyDecision.reason}`;
        break;
      } else {
        reasoning = `Candidate "${candidate.description}" blocked: ${policyDecision.reason}`;
      }
    }

    if (!selectedAction) {
      reasoning = `All ${candidates.length} candidate(s) were blocked by policies. ` + reasoning;
    }

    const outcome: DecisionOutcome = {
      id: `outcome_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      decisionId: context.decision.id,
      selectedAction,
      allCandidates: candidates,
      riskAssessment: selectedAssessment,
      autoExecute,
      requiresApproval: selectedAction ? requiresApproval : true,
      reasoning,
      decidedAt: new Date(),
    };

    await this.decisionRepository.saveOutcome(outcome);
    await this.decisionRepository.saveCandidates(candidates);

    return outcome;
  }

  /**
   * Predict what the twin would do in a hypothetical situation without
   * persisting any state. This is a read-only query against the decision
   * pipeline.
   */
  async whatWouldIDo(
    userId: string,
    request: WhatWouldIDoRequest,
    twinService: {
      getOrCreateProfile: (userId: string) => Promise<TwinProfile>;
      getRelevantPreferences: (userId: string, domain: string, situation: string) => Promise<Preference[]>;
      getPatterns: (userId: string) => Promise<unknown[]>;
      getTraits: (userId: string) => Promise<unknown[]>;
      getTemporalProfile: (userId: string) => Promise<unknown>;
    },
    userTrustTier: TrustTier,
  ): Promise<WhatWouldIDoResponse> {
    // Step 1: Create a synthetic DecisionObject from the request
    const situationType = this.inferSituationType(request.domain);
    const decision: DecisionObject = {
      id: `query_${Date.now()}`,
      situationType,
      domain: request.domain ?? 'general',
      urgency: request.urgency ?? 'medium',
      summary: request.situation,
      rawData: { query: true, situation: request.situation },
      interpretedAt: new Date(),
    };

    // Step 2: Build a DecisionContext
    const relevantPreferences = await twinService.getRelevantPreferences(
      userId,
      decision.domain,
      decision.summary,
    );
    const patterns = await twinService.getPatterns(userId);
    const traits = await twinService.getTraits(userId);
    const temporalProfile = await twinService.getTemporalProfile(userId);

    const context: DecisionContext = {
      userId,
      decision,
      trustTier: userTrustTier,
      relevantPreferences,
      timestamp: new Date(),
      patterns: patterns as DecisionContext['patterns'],
      traits: traits as DecisionContext['traits'],
      temporalProfile: temporalProfile as DecisionContext['temporalProfile'],
    };

    // Step 3: Evaluate through the standard pipeline
    const outcome = await this.evaluate(context);

    // Step 4: Build WhatWouldIDoResponse
    return {
      predictedAction: outcome.selectedAction,
      confidence: outcome.selectedAction?.confidence ?? ConfidenceLevel.SPECULATIVE,
      reasoning: outcome.reasoning,
      wouldAutoExecute: outcome.autoExecute,
      policyNotes: outcome.requiresApproval ? outcome.reasoning : undefined,
      alternativeActions: outcome.allCandidates.filter(
        (c) => c !== outcome.selectedAction,
      ),
      predictionId: `pred_${Date.now()}`,
    };
  }

  /**
   * Infer a SituationType from a domain string.
   */
  private inferSituationType(domain?: string): SituationType {
    if (!domain) return SituationType.GENERIC;

    const domainMap: Record<string, SituationType> = {
      email: SituationType.EMAIL_TRIAGE,
      calendar: SituationType.CALENDAR_CONFLICT,
      subscriptions: SituationType.SUBSCRIPTION_RENEWAL,
      shopping: SituationType.GROCERY_REORDER,
      travel: SituationType.TRAVEL_DECISION,
    };

    return domainMap[domain.toLowerCase()] ?? SituationType.GENERIC;
  }

  /**
   * Generate candidate actions for a decision based on the situation type
   * and the user's twin profile.
   */
  generateCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    switch (decision.situationType) {
      case SituationType.EMAIL_TRIAGE:
        return this.generateEmailTriageCandidates(decision, profile);
      case SituationType.CALENDAR_CONFLICT:
        return this.generateCalendarCandidates(decision, profile);
      case SituationType.SUBSCRIPTION_RENEWAL:
        return this.generateSubscriptionCandidates(decision, profile);
      case SituationType.GROCERY_REORDER:
        return this.generateGroceryCandidates(decision, profile);
      case SituationType.TRAVEL_DECISION:
        return this.generateTravelCandidates(decision, profile);
      case SituationType.GENERIC:
      default:
        return this.generateGenericCandidates(decision, profile);
    }
  }

  /**
   * Assess risk for a candidate action.
   */
  assessRisk(action: CandidateAction): RiskAssessment {
    return this.riskAssessor.assess(action);
  }

  /**
   * Determine if an action should be auto-executed based on trust tier,
   * risk level, and policies.
   */
  shouldAutoExecute(
    action: CandidateAction,
    trustTier: TrustTier,
    _policies: ActionPolicy[],
  ): boolean {
    // Observer and suggest tiers never auto-execute
    if (trustTier === TrustTier.OBSERVER || trustTier === TrustTier.SUGGEST) {
      return false;
    }

    // Must have at least moderate confidence
    const confidenceRank = this.confidenceRank(action.confidence);
    if (confidenceRank < this.confidenceRank(ConfidenceLevel.MODERATE)) {
      return false;
    }

    // Assess risk
    const assessment = this.riskAssessor.assess(action);
    const riskRank = this.riskTierRank(assessment.overallTier);

    // Auto-execute thresholds by trust tier
    switch (trustTier) {
      case TrustTier.LOW_AUTONOMY:
        return riskRank <= this.riskTierRank(RiskTier.LOW);

      case TrustTier.MODERATE_AUTONOMY:
        return riskRank <= this.riskTierRank(RiskTier.MODERATE);

      case TrustTier.HIGH_AUTONOMY:
        return riskRank <= this.riskTierRank(RiskTier.HIGH);

      default:
        return false;
    }
  }

  // ── Candidate generators ─────────────────────────────────────────

  private generateEmailTriageCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    const baseId = `cand_${Date.now()}`;

    // Archive low-priority emails
    candidates.push({
      id: `${baseId}_archive`,
      decisionId: decision.id,
      actionType: 'archive_email',
      description: 'Archive this email for later review.',
      domain: 'email',
      parameters: { emailId: decision.rawData['emailId'], folder: 'archive' },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'email', 'auto_archive'),
      reasoning: 'Low-risk action to keep inbox clean.',
    });

    // Label and categorize
    candidates.push({
      id: `${baseId}_label`,
      decisionId: decision.id,
      actionType: 'label_email',
      description: 'Apply appropriate labels to this email.',
      domain: 'email',
      parameters: {
        emailId: decision.rawData['emailId'],
        labels: this.inferLabels(decision),
      },
      estimatedCostCents: 0,
      reversible: true,
      confidence: ConfidenceLevel.MODERATE,
      reasoning: 'Organizing email with labels based on content analysis.',
    });

    // Reply with acknowledgment
    if (decision.rawData['requiresResponse']) {
      candidates.push({
        id: `${baseId}_reply`,
        decisionId: decision.id,
        actionType: 'send_reply',
        description: 'Send a brief acknowledgment reply.',
        domain: 'email',
        parameters: {
          emailId: decision.rawData['emailId'],
          replyType: 'acknowledgment',
        },
        estimatedCostCents: 0,
        reversible: false,
        confidence: ConfidenceLevel.LOW,
        reasoning: 'Sending a reply is irreversible but may be expected.',
      });
    }

    return candidates;
  }

  private generateCalendarCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    const baseId = `cand_${Date.now()}`;

    // Accept the meeting
    candidates.push({
      id: `${baseId}_accept`,
      decisionId: decision.id,
      actionType: 'accept_invite',
      description: 'Accept this calendar invitation.',
      domain: 'calendar',
      parameters: { eventId: decision.rawData['eventId'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'calendar', 'auto_accept'),
      reasoning: 'Accepting the invite commits time but can be changed later.',
    });

    // Decline the meeting
    candidates.push({
      id: `${baseId}_decline`,
      decisionId: decision.id,
      actionType: 'decline_invite',
      description: 'Decline this calendar invitation.',
      domain: 'calendar',
      parameters: { eventId: decision.rawData['eventId'] },
      estimatedCostCents: 0,
      reversible: false,
      confidence: this.getPreferenceConfidence(profile, 'calendar', 'auto_decline'),
      reasoning: 'Declining may affect the relationship with the organizer.',
    });

    // Propose alternative time
    candidates.push({
      id: `${baseId}_propose`,
      decisionId: decision.id,
      actionType: 'propose_alternative',
      description: 'Propose an alternative time for this meeting.',
      domain: 'calendar',
      parameters: {
        eventId: decision.rawData['eventId'],
        suggestedTimes: [],
      },
      estimatedCostCents: 0,
      reversible: true,
      confidence: ConfidenceLevel.LOW,
      reasoning: 'Proposing alternatives is collaborative but needs user input.',
    });

    return candidates;
  }

  private generateSubscriptionCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    const baseId = `cand_${Date.now()}`;
    const cost = Number(decision.rawData['amount'] ?? decision.rawData['costCents'] ?? 0);

    // Renew the subscription
    candidates.push({
      id: `${baseId}_renew`,
      decisionId: decision.id,
      actionType: 'renew_subscription',
      description: `Renew subscription for $${(cost / 100).toFixed(2)}.`,
      domain: 'subscriptions',
      parameters: {
        subscriptionId: decision.rawData['subscriptionId'],
        amount: cost,
      },
      estimatedCostCents: cost,
      reversible: false,
      confidence: this.getPreferenceConfidence(profile, 'subscriptions', 'auto_renew'),
      reasoning: 'Renewal maintains service continuity but involves spending.',
    });

    // Cancel the subscription
    candidates.push({
      id: `${baseId}_cancel`,
      decisionId: decision.id,
      actionType: 'cancel_subscription',
      description: 'Cancel this subscription.',
      domain: 'subscriptions',
      parameters: {
        subscriptionId: decision.rawData['subscriptionId'],
      },
      estimatedCostCents: 0,
      reversible: false,
      confidence: ConfidenceLevel.LOW,
      reasoning: 'Cancellation saves money but may lose access to the service.',
    });

    // Snooze / remind later
    candidates.push({
      id: `${baseId}_snooze`,
      decisionId: decision.id,
      actionType: 'snooze_reminder',
      description: 'Snooze this renewal reminder for 3 days.',
      domain: 'subscriptions',
      parameters: {
        subscriptionId: decision.rawData['subscriptionId'],
        snoozeDays: 3,
      },
      estimatedCostCents: 0,
      reversible: true,
      confidence: ConfidenceLevel.MODERATE,
      reasoning: 'Deferring the decision is low-risk if the deadline allows it.',
    });

    return candidates;
  }

  private generateGroceryCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    const baseId = `cand_${Date.now()}`;
    const items = (decision.rawData['items'] as Array<Record<string, unknown>>) ?? [];
    const estimatedCost = items.reduce(
      (sum, item) => sum + (Number(item['priceCents']) || 300),
      0,
    );

    // Reorder all items
    candidates.push({
      id: `${baseId}_reorder_all`,
      decisionId: decision.id,
      actionType: 'place_order',
      description: `Reorder ${items.length} grocery item(s).`,
      domain: 'shopping',
      parameters: { items, deliveryPreference: 'standard' },
      estimatedCostCents: estimatedCost,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'shopping', 'auto_reorder'),
      reasoning: 'Reordering familiar items is routine if preferences are established.',
    });

    // Add to shopping list only
    candidates.push({
      id: `${baseId}_add_list`,
      decisionId: decision.id,
      actionType: 'add_to_list',
      description: `Add ${items.length} item(s) to the shopping list.`,
      domain: 'shopping',
      parameters: { items },
      estimatedCostCents: 0,
      reversible: true,
      confidence: ConfidenceLevel.HIGH,
      reasoning: 'Adding to the list is zero-cost and fully reversible.',
    });

    return candidates;
  }

  private generateTravelCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    const baseId = `cand_${Date.now()}`;
    const cost = Number(decision.rawData['costCents'] ?? 0);

    // Book the travel
    candidates.push({
      id: `${baseId}_book`,
      decisionId: decision.id,
      actionType: 'book_travel',
      description: 'Book this travel arrangement.',
      domain: 'travel',
      parameters: {
        destination: decision.rawData['destination'],
        dates: decision.rawData['dates'],
        type: decision.rawData['travelType'],
      },
      estimatedCostCents: cost,
      reversible: false,
      confidence: this.getPreferenceConfidence(profile, 'travel', 'auto_book'),
      reasoning: 'Travel booking is typically high-cost and irreversible.',
    });

    // Save for later review
    candidates.push({
      id: `${baseId}_save`,
      decisionId: decision.id,
      actionType: 'save_option',
      description: 'Save this travel option for later review.',
      domain: 'travel',
      parameters: {
        destination: decision.rawData['destination'],
        details: decision.rawData,
      },
      estimatedCostCents: 0,
      reversible: true,
      confidence: ConfidenceLevel.HIGH,
      reasoning: 'Saving for review is zero-risk.',
    });

    return candidates;
  }

  private generateGenericCandidates(
    decision: DecisionObject,
    _profile: TwinProfile,
  ): CandidateAction[] {
    const baseId = `cand_${Date.now()}`;

    // For generic situations, create a "note for review" action
    return [
      {
        id: `${baseId}_note`,
        decisionId: decision.id,
        actionType: 'create_note',
        description: `Create a note about: ${decision.summary}`,
        domain: decision.domain,
        parameters: { summary: decision.summary, rawData: decision.rawData },
        estimatedCostCents: 0,
        reversible: true,
        confidence: ConfidenceLevel.MODERATE,
        reasoning: 'Creating a note is a safe default action for unrecognized situations.',
      },
      {
        id: `${baseId}_escalate`,
        decisionId: decision.id,
        actionType: 'escalate_to_user',
        description: `Escalate to user: ${decision.summary}`,
        domain: decision.domain,
        parameters: { summary: decision.summary, urgency: decision.urgency },
        estimatedCostCents: 0,
        reversible: true,
        confidence: ConfidenceLevel.HIGH,
        reasoning: 'Escalating unrecognized situations to the user is the safest option.',
      },
    ];
  }

  // ── Scoring helpers ──────────────────────────────────────────────

  private scoreCandidate(
    candidate: CandidateAction,
    context: DecisionContext,
    assessment: RiskAssessment,
  ): number {
    let score = 0;

    // Confidence contributes up to 40 points
    score += this.confidenceRank(candidate.confidence) * 10;

    // Lower risk is better, contributes up to 25 points
    score += (4 - this.riskTierRank(assessment.overallTier)) * 5;

    // Reversibility adds points
    if (candidate.reversible) {
      score += 15;
    }

    // Lower cost is better (normalized)
    if (candidate.estimatedCostCents === 0) {
      score += 10;
    } else if (candidate.estimatedCostCents <= 500) {
      score += 5;
    }

    // Preference alignment: boost score if the action aligns with known preferences
    const alignmentBoost = this.calculatePreferenceAlignment(
      candidate,
      context.relevantPreferences,
    );
    score += alignmentBoost;

    // Pattern alignment: boost if behavioral patterns match this action
    score += this.calculatePatternBoost(candidate, context);

    // Trait-based risk adjustment: cautious_spender increases scrutiny on costs
    score += this.calculateTraitAdjustment(candidate, context, assessment);

    return score;
  }

  /**
   * Boost score when detected behavioral patterns match this candidate action.
   */
  private calculatePatternBoost(
    candidate: CandidateAction,
    context: DecisionContext,
  ): number {
    if (!context.patterns || context.patterns.length === 0) return 0;

    let boost = 0;
    for (const pattern of context.patterns) {
      // Match by observed action type
      if (pattern.observedAction === candidate.actionType) {
        boost += Math.min(pattern.frequency, 10);
      }
      // Match by domain
      if (pattern.trigger.domain === candidate.domain) {
        boost += 3;
      }
    }

    return Math.min(boost, 20); // Cap at 20
  }

  /**
   * Adjust score based on cross-domain traits.
   */
  private calculateTraitAdjustment(
    candidate: CandidateAction,
    context: DecisionContext,
    _assessment: RiskAssessment,
  ): number {
    if (!context.traits || context.traits.length === 0) return 0;

    let adjustment = 0;
    for (const trait of context.traits) {
      switch (trait.traitName) {
        case 'cautious_spender':
          // Penalize high-cost actions more
          if (candidate.estimatedCostCents > 1000) {
            adjustment -= 10;
          }
          break;
        case 'quick_responder':
          // Boost actions that respond quickly (accept, reply)
          if (['accept_invite', 'send_reply'].includes(candidate.actionType)) {
            adjustment += 5;
          }
          break;
        case 'delegation_averse':
          // Penalize auto-execution for users who prefer manual control
          if (!candidate.reversible) {
            adjustment -= 5;
          }
          break;
        case 'routine_driven':
          // Boost actions matching established routines
          adjustment += 3;
          break;
        case 'privacy_conscious':
          // Penalize actions that share data
          if (['send_reply', 'accept_invite'].includes(candidate.actionType)) {
            adjustment -= 3;
          }
          break;
      }
    }

    return adjustment;
  }

  private calculatePreferenceAlignment(
    candidate: CandidateAction,
    preferences: Preference[],
  ): number {
    let boost = 0;

    for (const pref of preferences) {
      // Check if the candidate's action type or domain matches the preference
      if (
        pref.domain === candidate.domain ||
        pref.key.includes(candidate.actionType)
      ) {
        boost += this.confidenceRank(pref.confidence) * 3;
      }
    }

    return Math.min(boost, 20); // Cap at 20 points
  }

  private getPreferenceConfidence(
    profile: TwinProfile,
    domain: string,
    key: string,
  ): ConfidenceLevel {
    const pref = profile.preferences.find(
      (p) => p.domain === domain && p.key === key,
    );
    if (pref) return pref.confidence;

    const inference = profile.inferences.find(
      (i) => i.domain === domain && i.key === key,
    );
    if (inference) return inference.confidence;

    return ConfidenceLevel.SPECULATIVE;
  }

  private inferLabels(decision: DecisionObject): string[] {
    const labels: string[] = [];
    const subject = String(decision.rawData['subject'] ?? '').toLowerCase();

    if (subject.includes('invoice') || subject.includes('receipt')) labels.push('finance');
    if (subject.includes('meeting') || subject.includes('invite')) labels.push('meetings');
    if (subject.includes('newsletter') || subject.includes('digest')) labels.push('newsletters');
    if (subject.includes('update') || subject.includes('notification')) labels.push('notifications');
    if (subject.includes('urgent') || subject.includes('asap')) labels.push('urgent');

    if (labels.length === 0) labels.push('inbox');

    return labels;
  }

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
