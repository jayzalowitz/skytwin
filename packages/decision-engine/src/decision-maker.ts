import type {
  DecisionContext,
  DecisionObject,
  DecisionOutcome,
  CandidateAction,
  RiskAssessment,
  ActionPolicy,
  PolicyVerdict,
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
import { applyScopeGate } from '@skytwin/policy-engine';
import { normalizeSenderAddress } from '@skytwin/core';
import { RiskAssessor } from './risk-assessor.js';
import type { CandidateGenerator } from './strategies/candidate-strategy.js';

/**
 * Port interface for decision persistence.
 *
 * Business logic depends on this interface, not on a concrete database
 * implementation. Adapters (e.g., wrapping @skytwin/db's decisionRepository)
 * satisfy this contract at composition time.
 */
export interface DecisionRepositoryPort {
  /**
   * Persist a decision, or return the existing one on a re-ingestion of
   * the same `(user_id, signal_id)`. Returns `{ decision, created }` —
   * `created` is true only when this call inserted the row. Callers gate
   * downstream side-effects on `created` so a re-ingestion doesn't fire
   * them again. Today the `events.ts` route uses this to gate the
   * `decision:blocked-by-policy` SSE; a follow-up PR will also use it
   * to short-circuit the auto-execute path so the action doesn't run a
   * second time. Note: upstream observation side-effects (signal
   * recording into the memory backend, the `memory:page-indexed` SSE)
   * intentionally still fire per ingestion — they record observations,
   * not decisions.
   */
  saveDecision(decision: DecisionObject): Promise<{ decision: DecisionObject; created: boolean }>;
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
 * One observed (label, frequency) for a given sender or List-Id, fed to
 * `inferLabels()` so the decision engine suggests labels based on the user's
 * actual Gmail history rather than hardcoded subject keywords. Issue #122.
 */
export interface SenderLabelHint {
  label: string;
  count: number;
}

/**
 * Port interface for sender-based Gmail label prediction.
 *
 * The decision-maker pre-fetches hints during `evaluate()` and passes them
 * into the email-triage candidate generator so `inferLabels()` can prefer
 * labels the user has historically applied to mail from this sender (or
 * mailing list) before falling back to subject-keyword heuristics.
 *
 * The adapter is satisfied at composition time — production wires it to
 * `emailLabelRepository.topLabelsForSender` / `topLabelsForListId` from
 * `@skytwin/db`. Tests can stub it directly.
 */
export interface LabelInferencePort {
  topLabelsForSender(userId: string, sender: string, limit?: number): Promise<SenderLabelHint[]>;
  topLabelsForListId(userId: string, listId: string, limit?: number): Promise<SenderLabelHint[]>;
}

/**
 * The DecisionMaker is the central orchestrator. Given a decision context,
 * it consults the twin for preferences, generates candidate actions,
 * assesses risk, checks policies, and selects the best action.
 */
export class DecisionMaker {
  private readonly riskAssessor: RiskAssessor;
  private readonly candidateGenerator: CandidateGenerator | null;

  private readonly labelInferencePort: LabelInferencePort | null;

  constructor(
    private readonly twinService: TwinService,
    private readonly policyEvaluator: PolicyEvaluator,
    private readonly decisionRepository: DecisionRepositoryPort,
    candidateGenerator?: CandidateGenerator,
    labelInferencePort?: LabelInferencePort,
  ) {
    this.riskAssessor = new RiskAssessor();
    this.candidateGenerator = candidateGenerator ?? null;
    this.labelInferencePort = labelInferencePort ?? null;
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

    // Step 2b: Pre-fetch sender label hints for email decisions. Issue #122 —
    // we'd rather suggest a label the user has actually applied to mail from
    // this sender before than the hardcoded keyword fallback. Top-of-stack so
    // it's available to both built-in candidate generation and to LLM
    // strategies via the enriched context.
    const senderLabelHints = await this.fetchSenderLabelHints(
      context.userId,
      context.decision,
    );

    // Step 3: Generate candidate actions (LLM strategy or built-in rules)
    const candidates = this.candidateGenerator
      ? applyScopeGate(
          await this.candidateGenerator.generate(context.decision, profile, enrichedContext),
          context.grantedScopes ?? [],
        )
      : this.generateCandidates(context.decision, profile, {
          senderLabelHints,
          grantedScopes: context.grantedScopes,
        });

    // Stamp provenance onto every candidate from the originating decision so
    // the policy engine's injection guard can gate without re-deriving where
    // the action came from.
    //
    // This is an UNCONDITIONAL overwrite, not a default-only assignment.
    // Provenance is a trust boundary: candidate generators are fed untrusted
    // content (the LLM generator parses model JSON shaped by inbound email
    // bodies), so a generator must never be able to set its own provenance —
    // an injected "provenance: user_originated" in generated output would
    // otherwise survive. The originating decision is the only authority for
    // where the action came from. If the decision's provenance is somehow
    // unset, this assigns `undefined`, which the policy engine treats as
    // `untrusted_external` (fail safe).
    for (const candidate of candidates) {
      candidate.provenance = context.decision.provenance;
    }

    if (candidates.length === 0) {
      const outcome: DecisionOutcome = {
        id: crypto.randomUUID(),
        decisionId: context.decision.id,
        selectedAction: null,
        allCandidates: [],
        riskAssessment: null,
        allRiskAssessments: [],
        autoExecute: false,
        requiresApproval: true,
        reasoning: 'No candidate actions could be generated. Escalating to user.',
        decidedAt: new Date(),
      };
      await this.decisionRepository.saveOutcome(outcome);
      return outcome;
    }

    // Persist the candidate rows BEFORE assessing/saving their risk.
    // saveRiskAssessment UPDATEs candidate_actions by id, so the rows must
    // already exist — otherwise the UPDATE no-ops, the full RiskAssessment
    // (overallTier/dimensions) is lost, and only the thin placeholder
    // saveCandidates writes survives. That left the approve-time preflight
    // unable to find a parseable assessment → risk_assessment_missing → the
    // entire approve→execute path was blocked.
    await this.decisionRepository.saveCandidates(candidates);

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

    // Step 7: Evaluate every candidate against policy. We record a verdict for
    // each so downstream consumers (e.g. whatWouldIDo) can distinguish blocked
    // candidates from un-evaluated ones. Safety Invariant #1.
    const policyVerdicts: Record<string, PolicyVerdict> = {};
    let selectedAction: CandidateAction | null = null;
    let selectedAssessment: RiskAssessment | null = null;
    let autoExecute = false;
    let requiresApproval = true;
    let confirmationLevel: DecisionOutcome['confirmationLevel'];
    let reasoning = '';
    let lastBlockedReason = '';

    for (const { candidate, assessment } of scoredCandidates) {
      const policyDecision = await this.policyEvaluator.evaluate(
        candidate,
        policies,
        context.trustTier,
        assessment,
      );

      const verdict: PolicyVerdict = !policyDecision.allowed
        ? 'denied'
        : policyDecision.requiresApproval
          ? 'requires-approval'
          : 'allowed';
      policyVerdicts[candidate.id] = verdict;

      if (verdict === 'denied') {
        lastBlockedReason = `Candidate "${candidate.description}" blocked: ${policyDecision.reason}`;
        continue;
      }

      // First non-denied candidate wins. Lower-scored candidates still get
      // evaluated so verdicts are complete, but we don't switch winners.
      if (selectedAction === null) {
        selectedAction = candidate;
        selectedAssessment = assessment;
        requiresApproval = policyDecision.requiresApproval;
        confirmationLevel = policyDecision.confirmationLevel;
        autoExecute = !policyDecision.requiresApproval &&
          this.shouldAutoExecute(candidate, context.trustTier, policies);
        reasoning = autoExecute
          ? `Selected "${candidate.description}" for auto-execution. ${policyDecision.reason}`
          : policyDecision.requiresApproval
            ? `Selected "${candidate.description}" but requires approval. ${policyDecision.reason}`
            : `Selected "${candidate.description}". ${policyDecision.reason}`;
      }
    }

    if (!selectedAction) {
      reasoning = `All ${candidates.length} candidate(s) were blocked by policies. ` + lastBlockedReason;
    }

    const outcome: DecisionOutcome = {
      id: crypto.randomUUID(),
      decisionId: context.decision.id,
      selectedAction,
      allCandidates: candidates,
      riskAssessment: selectedAssessment,
      // #412 — carry every candidate's assessment on the outcome
      // (not just the selected one) so consumers that need a
      // specific candidate's risk can look it up by id without an
      // extra DB round-trip. The assessments map is already keyed by
      // candidate.id from step 4 — flatten it walking `allCandidates`
      // so we get a deterministic order. Missing assessments are
      // dropped: consumers MUST use `getAssessmentForAction(outcome,
      // id)` (an id-keyed lookup), not an index-correlated read
      // against `allCandidates`.
      allRiskAssessments: candidates
        .map((c) => assessments.get(c.id))
        .filter((a): a is RiskAssessment => a !== undefined),
      autoExecute,
      requiresApproval: selectedAction ? requiresApproval : true,
      reasoning,
      decidedAt: new Date(),
      policyVerdicts,
      // Only meaningful when the selected action requires approval; the
      // injection guard sets `dual` for extreme-severity actions.
      ...(selectedAction && requiresApproval && confirmationLevel
        ? { confirmationLevel }
        : {}),
    };

    // (candidates were persisted earlier, before risk assessment, so the
    // saveRiskAssessment UPDATEs above could land on existing rows.)
    await this.decisionRepository.saveOutcome(outcome);

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

    // Step 4: Build WhatWouldIDoResponse.
    // Filter alternatives to candidates that policy actually allowed (or
    // permitted under approval). Blocked candidates must NOT surface as
    // options — they would mislead the user about what their twin can do.
    // Safety Invariant #1.
    const verdicts = outcome.policyVerdicts ?? {};
    const alternativeActions = outcome.allCandidates.filter((c) => {
      if (c === outcome.selectedAction) return false;
      const verdict = verdicts[c.id];
      // Conservative default: if no verdict was recorded, drop the candidate.
      // Better to under-suggest than to leak a blocked one.
      return verdict === 'allowed' || verdict === 'requires-approval';
    });
    const policyNotes = outcome.requiresApproval || !outcome.selectedAction
      ? outcome.reasoning
      : undefined;

    return {
      predictedAction: outcome.selectedAction,
      confidence: outcome.selectedAction?.confidence ?? ConfidenceLevel.SPECULATIVE,
      reasoning: outcome.reasoning,
      wouldAutoExecute: outcome.autoExecute,
      policyNotes,
      alternativeActions,
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
      calendar: SituationType.CALENDAR_INVITE,
      subscriptions: SituationType.SUBSCRIPTION_RENEWAL,
      shopping: SituationType.GROCERY_REORDER,
      travel: SituationType.TRAVEL_DECISION,
      finance: SituationType.FINANCE_OPERATION,
      smart_home: SituationType.SMART_HOME,
      tasks: SituationType.TASK_MANAGEMENT,
      social_media: SituationType.SOCIAL_MEDIA,
      documents: SituationType.DOCUMENT_MANAGEMENT,
      health: SituationType.HEALTH_WELLNESS,
    };

    return domainMap[domain.toLowerCase()] ?? SituationType.GENERIC;
  }

  /**
   * Generate candidate actions for a decision based on the situation type
   * and the user's twin profile.
   *
   * `extras.senderLabelHints` flows from the pre-fetch in `evaluate()` and
   * is currently consumed only by `generateEmailTriageCandidates` — other
   * domains ignore it, so the parameter is optional and unmarshalled at the
   * one site that needs it.
   */
  generateCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
    extras?: { senderLabelHints?: SenderLabelHint[]; grantedScopes?: string[] },
  ): CandidateAction[] {
    const candidates = this.dispatchCandidates(decision, profile, extras);
    // Scope gate (spec 11, #485): never propose a write the user didn't grant.
    // Missing scopes are an empty grant set, so scoped writes fail safe to a
    // human-review "grant access" item.
    return applyScopeGate(candidates, extras?.grantedScopes ?? []);
  }

  private dispatchCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
    extras?: { senderLabelHints?: SenderLabelHint[]; grantedScopes?: string[] },
  ): CandidateAction[] {
    switch (decision.situationType) {
      case SituationType.EMAIL_TRIAGE:
        return this.generateEmailTriageCandidates(decision, profile, extras?.senderLabelHints);
      case SituationType.CALENDAR_INVITE:
        return this.generateCalendarInviteCandidates(decision, profile);
      case SituationType.CALENDAR_CONFLICT:
        return this.generateCalendarCandidates(decision, profile);
      case SituationType.CALENDAR_UPDATE:
        return this.generateCalendarUpdateCandidates(decision, profile);
      case SituationType.SUBSCRIPTION_RENEWAL:
        return this.generateSubscriptionCandidates(decision, profile);
      case SituationType.GROCERY_REORDER:
        return this.generateGroceryCandidates(decision, profile);
      case SituationType.TRAVEL_DECISION:
        return this.generateTravelCandidates(decision, profile);
      case SituationType.FINANCE_OPERATION:
        return this.generateFinanceCandidates(decision, profile);
      case SituationType.SMART_HOME:
        return this.generateSmartHomeCandidates(decision, profile);
      case SituationType.TASK_MANAGEMENT:
        return this.generateTaskManagementCandidates(decision, profile);
      case SituationType.SOCIAL_MEDIA:
        return this.generateSocialMediaCandidates(decision, profile);
      case SituationType.DOCUMENT_MANAGEMENT:
        return this.generateDocumentCandidates(decision, profile);
      case SituationType.HEALTH_WELLNESS:
        return this.generateHealthCandidates(decision, profile);
      case SituationType.SECURITY_ALERT:
        return this.generateSecurityAlertCandidates(decision);
      case SituationType.GENERIC:
      default:
        return this.generateGenericCandidates(decision, profile);
    }
  }

  /**
   * Escalate-only candidates for an inbound security alert (spec 06, #479).
   *
   * Safety invariant #8: a SECURITY_ALERT is inbound, untrusted, and a phishing
   * surface. The ONLY candidate is a human-review escalation that tells the user
   * to open the provider directly — NEVER an auto-executable action, and NEVER a
   * URL drawn from the (untrusted) message body. Parameters are deliberately
   * link-free.
   */
  private generateSecurityAlertCandidates(decision: DecisionObject): CandidateAction[] {
    return [
      {
        id: crypto.randomUUID(),
        decisionId: decision.id,
        actionType: 'escalate_to_user',
        description:
          "Review this security alert in the provider's official app or website. " +
          'Do not click links in the message.',
        domain: decision.domain,
        parameters: {
          summary: decision.summary,
          urgency: decision.urgency,
          safeAction: 'open_provider_directly',
        },
        estimatedCostCents: 0,
        reversible: true,
        confidence: ConfidenceLevel.HIGH,
        reasoning:
          'Security alerts are inbound and untrusted (phishing surface). Surfaced ' +
          'for human review only — never auto-executed, never via links in the message.',
      },
    ];
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
    senderLabelHints?: SenderLabelHint[],
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    // IDs generated inline via crypto.randomUUID()

    // Archive low-priority emails
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'archive_email',
      description: 'Archive this email for later review.',
      domain: 'email',
      parameters: { emailId: (decision.rawData['emailId'] ?? decision.rawData['messageId']), folder: 'archive' },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'email', 'auto_archive'),
      reasoning: 'Low-risk action to keep inbox clean.',
    });

    // Label and categorize
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'label_email',
      description: 'Apply appropriate labels to this email.',
      domain: 'email',
      parameters: {
        emailId: (decision.rawData['emailId'] ?? decision.rawData['messageId']),
        labels: this.inferLabels(decision, senderLabelHints),
      },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.labelConfidence(senderLabelHints),
      reasoning: this.labelReasoning(senderLabelHints),
    });

    // Reply with acknowledgment
    if (decision.rawData['requiresResponse']) {
      candidates.push({
        id: crypto.randomUUID(),
        decisionId: decision.id,
        actionType: 'send_reply',
        description: 'Send a brief acknowledgment reply.',
        domain: 'email',
        parameters: {
          emailId: (decision.rawData['emailId'] ?? decision.rawData['messageId']),
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
    // IDs generated inline via crypto.randomUUID()

    // Accept the meeting
    candidates.push({
      id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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

  private generateCalendarInviteCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];

    // Accept the invite
    candidates.push({
      id: crypto.randomUUID(),
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

    // Tentatively accept
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'tentative_accept',
      description: 'Tentatively accept this calendar invitation.',
      domain: 'calendar',
      parameters: { eventId: decision.rawData['eventId'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'calendar', 'default_response'),
      reasoning: 'Tentative acceptance signals interest without full commitment.',
    });

    // Decline the invite
    candidates.push({
      id: crypto.randomUUID(),
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

    return candidates;
  }

  private generateCalendarUpdateCandidates(
    decision: DecisionObject,
    _profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];

    // Acknowledge the update (no action needed)
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'acknowledge',
      description: 'Acknowledge this calendar update. No action required.',
      domain: 'calendar',
      parameters: { eventId: decision.rawData['eventId'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: ConfidenceLevel.HIGH,
      reasoning: 'Calendar updates are informational and rarely need action.',
    });

    // Dismiss (mark as seen)
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'dismiss',
      description: 'Dismiss this calendar notification.',
      domain: 'calendar',
      parameters: { eventId: decision.rawData['eventId'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: ConfidenceLevel.MODERATE,
      reasoning: 'Dismissing clears the notification without further action.',
    });

    return candidates;
  }

  private generateSubscriptionCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    // IDs generated inline via crypto.randomUUID()
    const rawAmount = Number(decision.rawData['amount'] ?? decision.rawData['costCents'] ?? 0);
    // If amount looks like dollars (has decimal or < 100), convert to cents; otherwise treat as cents
    const cost = rawAmount > 0 && rawAmount < 100 ? Math.round(rawAmount * 100) : Math.round(rawAmount);

    // Renew the subscription
    candidates.push({
      id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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
    // IDs generated inline via crypto.randomUUID()
    const items = (decision.rawData['items'] as Array<Record<string, unknown>>) ?? [];
    const estimatedCost = items.reduce(
      (sum, item) => sum + (Number(item['priceCents']) || 300),
      0,
    );

    // Reorder all items
    candidates.push({
      id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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
    // IDs generated inline via crypto.randomUUID()
    const cost = Number(decision.rawData['costCents'] ?? 0);

    // Book the travel
    candidates.push({
      id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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

  private generateFinanceCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    // IDs generated inline via crypto.randomUUID()
    const billCost = Number(decision.rawData['costCents'] ?? decision.rawData['amount'] ?? 0);

    // Categorize transaction
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'categorize_transaction',
      description: 'Categorize this transaction',
      domain: 'finance',
      parameters: { transactionId: decision.rawData['transactionId'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'finance', 'auto_categorize'),
      reasoning: 'Categorizing is zero-cost and fully reversible.',
    });

    // Pay bill
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'pay_bill',
      description: 'Pay this bill',
      domain: 'finance',
      parameters: { billId: decision.rawData['billId'], amount: billCost },
      estimatedCostCents: billCost,
      reversible: false,
      confidence: this.getPreferenceConfidence(profile, 'finance', 'auto_pay'),
      reasoning: 'Paying a bill is irreversible and involves spending.',
    });

    // Flag suspicious transaction
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'flag_suspicious_transaction',
      description: 'Flag this transaction for review',
      domain: 'finance',
      parameters: { transactionId: decision.rawData['transactionId'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'finance', 'auto_flag'),
      reasoning: 'Flagging is zero-cost and reversible, erring on the side of caution.',
    });

    // Record expense
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'record_expense',
      description: 'Record this expense',
      domain: 'finance',
      parameters: { transactionId: decision.rawData['transactionId'], amount: billCost },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'finance', 'auto_record'),
      reasoning: 'Recording an expense is zero-cost and reversible.',
    });

    return candidates;
  }

  private generateSmartHomeCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    // IDs generated inline via crypto.randomUUID()

    // Run routine
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'run_routine',
      description: 'Run the suggested routine',
      domain: 'smart_home',
      parameters: { routineId: decision.rawData['routineId'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'smart_home', 'auto_routine'),
      reasoning: 'Running a home routine is reversible and low-risk.',
    });

    // Set thermostat
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'set_thermostat',
      description: 'Adjust thermostat to recommended temperature',
      domain: 'smart_home',
      parameters: { temperature: decision.rawData['temperature'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'smart_home', 'auto_thermostat'),
      reasoning: 'Thermostat adjustments are reversible and zero-cost.',
    });

    // Escalate to user
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'escalate_to_user',
      description: 'Alert user about this home event',
      domain: 'smart_home',
      parameters: { eventType: decision.rawData['eventType'], summary: decision.summary },
      estimatedCostCents: 0,
      reversible: true,
      confidence: ConfidenceLevel.HIGH,
      reasoning: 'Alerting the user is the safest option for home events.',
    });

    return candidates;
  }

  private generateTaskManagementCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    // IDs generated inline via crypto.randomUUID()

    // Create task
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'create_task',
      description: 'Create a new task from this',
      domain: 'tasks',
      parameters: { title: decision.rawData['title'], summary: decision.summary },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'tasks', 'auto_create_task'),
      reasoning: 'Creating a task is zero-cost and reversible.',
    });

    // Set reminder
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'set_reminder',
      description: 'Set a reminder',
      domain: 'tasks',
      parameters: { taskId: decision.rawData['taskId'], reminderTime: decision.rawData['reminderTime'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'tasks', 'auto_reminder'),
      reasoning: 'Setting a reminder is zero-cost and reversible.',
    });

    // Complete task
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'complete_task',
      description: 'Mark this task as done',
      domain: 'tasks',
      parameters: { taskId: decision.rawData['taskId'] },
      estimatedCostCents: 0,
      reversible: false,
      confidence: this.getPreferenceConfidence(profile, 'tasks', 'auto_complete'),
      reasoning: 'Completing a task is irreversible and should match confirmed intent.',
    });

    return candidates;
  }

  private generateSocialMediaCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    // IDs generated inline via crypto.randomUUID()

    // Draft social post
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'draft_social_post',
      description: 'Draft a response',
      domain: 'social_media',
      parameters: { postId: decision.rawData['postId'], platform: decision.rawData['platform'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'social_media', 'auto_draft'),
      reasoning: 'Drafting a response is reversible and requires user review before posting.',
    });

    // Mute conversation
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'mute_conversation',
      description: 'Mute this conversation',
      domain: 'social_media',
      parameters: { conversationId: decision.rawData['conversationId'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'social_media', 'auto_mute'),
      reasoning: 'Muting is reversible and reduces notification noise.',
    });

    // Respond to mention
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'respond_to_mention',
      description: 'Reply to this mention',
      domain: 'social_media',
      parameters: { mentionId: decision.rawData['mentionId'], platform: decision.rawData['platform'] },
      estimatedCostCents: 0,
      reversible: false,
      confidence: this.getPreferenceConfidence(profile, 'social_media', 'auto_respond'),
      reasoning: 'Replying to a mention is irreversible and publicly visible.',
    });

    return candidates;
  }

  private generateDocumentCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    // IDs generated inline via crypto.randomUUID()

    // Organize file
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'organize_file',
      description: 'Move to appropriate folder',
      domain: 'documents',
      parameters: { documentId: decision.rawData['documentId'], targetFolder: decision.rawData['targetFolder'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'documents', 'auto_organize'),
      reasoning: 'Organizing files is reversible and keeps documents tidy.',
    });

    // Summarize document
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'summarize_document',
      description: 'Generate a summary',
      domain: 'documents',
      parameters: { documentId: decision.rawData['documentId'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'documents', 'auto_summarize'),
      reasoning: 'Generating a summary is zero-cost and reversible.',
    });

    // Share document
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'share_document',
      description: 'Share with relevant people',
      domain: 'documents',
      parameters: { documentId: decision.rawData['documentId'], recipients: decision.rawData['recipients'] },
      estimatedCostCents: 0,
      reversible: false,
      confidence: this.getPreferenceConfidence(profile, 'documents', 'auto_share'),
      reasoning: 'Sharing a document is irreversible and exposes content to others.',
    });

    return candidates;
  }

  private generateHealthCandidates(
    decision: DecisionObject,
    profile: TwinProfile,
  ): CandidateAction[] {
    const candidates: CandidateAction[] = [];
    // IDs generated inline via crypto.randomUUID()

    // Log health metric
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'log_health_metric',
      description: 'Log this health data',
      domain: 'health',
      parameters: { metricType: decision.rawData['metricType'], value: decision.rawData['value'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'health', 'auto_log'),
      reasoning: 'Logging health data is zero-cost and reversible.',
    });

    // Set medication reminder
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'set_medication_reminder',
      description: 'Set a medication reminder',
      domain: 'health',
      parameters: { medication: decision.rawData['medication'], schedule: decision.rawData['schedule'] },
      estimatedCostCents: 0,
      reversible: true,
      confidence: this.getPreferenceConfidence(profile, 'health', 'auto_medication_reminder'),
      reasoning: 'Setting a medication reminder is zero-cost and reversible.',
    });

    // Book appointment
    candidates.push({
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'book_appointment',
      description: 'Book an appointment',
      domain: 'health',
      parameters: { provider: decision.rawData['provider'], appointmentType: decision.rawData['appointmentType'] },
      estimatedCostCents: 0,
      reversible: false,
      confidence: this.getPreferenceConfidence(profile, 'health', 'auto_book_appointment'),
      reasoning: 'Booking an appointment is irreversible and may incur cancellation fees.',
    });

    return candidates;
  }

  private generateGenericCandidates(
    decision: DecisionObject,
    _profile: TwinProfile,
  ): CandidateAction[] {
    // IDs generated inline via crypto.randomUUID()

    // For generic situations, create a "note for review" action
    return [
      {
        id: crypto.randomUUID(),
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
        id: crypto.randomUUID(),
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

    // Episodic memory boost: past episodes with positive outcomes boost similar actions
    score += this.calculateEpisodicBoost(candidate, context);

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

  /**
   * Boost score based on episodic memories from the memory palace.
   * Past episodes where a similar action was approved get a positive boost.
   * Past episodes where a similar action was rejected get a penalty.
   */
  private calculateEpisodicBoost(
    candidate: CandidateAction,
    context: DecisionContext,
  ): number {
    if (!context.episodicMemories || context.episodicMemories.length === 0) return 0;

    let boost = 0;

    for (const episode of context.episodicMemories) {
      // Check domain match
      if (episode.domain !== candidate.domain) continue;

      // Check if the action type is similar
      const actionMatch = episode.actionTaken?.toLowerCase().includes(candidate.actionType.replace(/_/g, ' '));

      if (actionMatch || episode.situationType === context.decision.situationType) {
        // Positive feedback on similar action = boost
        if (episode.feedbackType === 'approve') {
          boost += 10 * episode.utilityScore;
        }
        // Negative feedback = penalty
        else if (episode.feedbackType === 'reject' || episode.feedbackType === 'undo') {
          boost -= 8 * (1 - episode.utilityScore);
        }
        // Correction = mild penalty for the original action
        else if (episode.feedbackType === 'correct') {
          boost -= 3;
        }
        // No feedback yet but was auto-executed = slight boost
        else if (!episode.feedbackType && episode.outcome?.success) {
          boost += 3;
        }
      }
    }

    return Math.max(-15, Math.min(boost, 20)); // Cap between -15 and +20
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

  /**
   * Gmail's reserved system labels. Suggesting these as "labels to apply"
   * is meaningless — they're set by Gmail itself and the user can't
   * meaningfully reuse them as a categorization. We still record them in
   * `email_label_signals` (because absence of INBOX is the "archived"
   * signal we want to mine later), but we filter them out before suggesting.
   */
  private static readonly GMAIL_SYSTEM_LABELS = new Set([
    'INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT',
    'SPAM', 'TRASH', 'CHAT',
  ]);

  /**
   * Minimum sightings before we trust a sender→label hint enough to suggest
   * it. One observation could be a misclick; two is a pattern. Tunable.
   */
  private static readonly LABEL_HINT_MIN_COUNT = 2;

  private inferLabels(
    decision: DecisionObject,
    senderLabelHints?: SenderLabelHint[],
  ): string[] {
    // Layer 1 (issue #122): consult the per-user sender→label model first.
    // If the user has consistently labelled mail from this sender, prefer
    // the most-frequent label they've applied. Filters Gmail system labels
    // and category labels (CATEGORY_PROMOTIONS etc.) — those are Gmail's
    // own classification, not the user's.
    const fromHints = (senderLabelHints ?? [])
      .filter((h) => h.count >= DecisionMaker.LABEL_HINT_MIN_COUNT)
      .filter((h) => !DecisionMaker.GMAIL_SYSTEM_LABELS.has(h.label))
      .filter((h) => !h.label.startsWith('CATEGORY_'));

    if (fromHints.length > 0) {
      // Up to 2 labels — top-1 is the strong suggestion, top-2 covers the
      // "I sometimes also tag this as X" case without spraying labels.
      return fromHints.slice(0, 2).map((h) => h.label);
    }

    // Layer 4 fallback: subject-keyword classifier. Demoted from primary
    // (was the only model pre-#122) to last-resort when we have no per-user
    // history for this sender.
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

  /**
   * Confidence for the `label_email` candidate. With a strong sender hint
   * (≥5 prior observations of the top label) we report HIGH; with a weaker
   * hint MODERATE; pure keyword fallback stays LOW so policy gates ask for
   * approval rather than auto-applying a guess.
   */
  private labelConfidence(senderLabelHints?: SenderLabelHint[]): ConfidenceLevel {
    const top = (senderLabelHints ?? [])
      .filter((h) => !DecisionMaker.GMAIL_SYSTEM_LABELS.has(h.label))
      .filter((h) => !h.label.startsWith('CATEGORY_'))
      .sort((a, b) => b.count - a.count)[0];
    if (!top) return ConfidenceLevel.LOW;
    if (top.count >= 5) return ConfidenceLevel.HIGH;
    if (top.count >= DecisionMaker.LABEL_HINT_MIN_COUNT) return ConfidenceLevel.MODERATE;
    return ConfidenceLevel.LOW;
  }

  private labelReasoning(senderLabelHints?: SenderLabelHint[]): string {
    const top = (senderLabelHints ?? [])
      .filter((h) => !DecisionMaker.GMAIL_SYSTEM_LABELS.has(h.label))
      .filter((h) => !h.label.startsWith('CATEGORY_'))
      .sort((a, b) => b.count - a.count)[0];
    if (top && top.count >= DecisionMaker.LABEL_HINT_MIN_COUNT) {
      return `Mail from this sender has been labelled "${top.label}" ${top.count} time(s) before.`;
    }
    return 'Organizing email with labels based on subject keywords (no sender history).';
  }

  /**
   * Pre-fetch sender / List-Id label hints from the LabelInferencePort.
   *
   * Returns an empty array when:
   *   - no port is configured (e.g. unit tests, early bring-up),
   *   - the decision isn't from an email signal (no `from` field), or
   *   - the port throws (we log and degrade — the keyword fallback in
   *     `inferLabels()` handles missing hints transparently).
   *
   * Sender lookup is preferred. List-Id is consulted as a secondary signal
   * (covers mailing-list traffic where the per-message `From` varies).
   */
  private async fetchSenderLabelHints(
    userId: string,
    decision: DecisionObject,
  ): Promise<SenderLabelHint[]> {
    if (!this.labelInferencePort) return [];
    const sender = this.normalizeSender(decision.rawData['from']);
    const listId = String(decision.rawData['listId'] ?? '').trim();
    if (!sender && !listId) return [];

    try {
      const senderHints = sender
        ? await this.labelInferencePort.topLabelsForSender(userId, sender, 5)
        : [];
      // Post-/review fix: previously we returned senderHints whenever the
      // array was non-empty, which suppressed the List-Id fallback even when
      // every sender hint was sub-threshold (count < MIN_COUNT). For
      // mailing-list traffic where the per-message From: rotates, a single
      // count=1 sender row would prevent the much richer List-Id model from
      // ever being consulted. Now we check whether sender hints would
      // actually produce a usable suggestion before short-circuiting.
      if (senderHints.some((h) => h.count >= DecisionMaker.LABEL_HINT_MIN_COUNT)) {
        return senderHints;
      }
      if (!listId) return senderHints;
      const listHints = await this.labelInferencePort.topLabelsForListId(userId, listId, 5);
      // Prefer List-Id hints if any of them clear the threshold; otherwise
      // surface the (sub-threshold) sender hints so `inferLabels` and
      // `labelConfidence` see the strongest available evidence.
      return listHints.some((h) => h.count >= DecisionMaker.LABEL_HINT_MIN_COUNT)
        ? listHints
        : senderHints;
    } catch (err) {
      // Don't fail the whole decision because the label model is offline.
      // The keyword fallback in inferLabels() still produces a valid (if
      // weaker) suggestion. Logged for ops visibility.
      console.warn(
        '[decision-maker] LabelInferencePort lookup failed, falling back to keywords:',
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  /**
   * Read-side sender normalization. Delegated to the canonical
   * implementation in `@skytwin/core` so write side (Gmail connector) and
   * read side (here) cannot drift. Issue #122 follow-up — previously
   * duplicated, with a comment that "they MUST stay in sync." Now they do
   * by construction.
   */
  private normalizeSender(raw: unknown): string {
    return normalizeSenderAddress(raw);
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
