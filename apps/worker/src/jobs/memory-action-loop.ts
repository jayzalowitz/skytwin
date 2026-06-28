import { loadConfig } from '@skytwin/config';
import { createLogger } from '@skytwin/core';
import { RiskAssessor } from '@skytwin/decision-engine';
import {
  ActionHandlerRegistry,
  CalendarActionHandler,
  DbCredentialProvider,
  DirectExecutionAdapter,
  DocumentActionHandler,
  EmailActionHandler,
  FinanceActionHandler,
  HealthActionHandler,
  MockIronClawAdapter,
  RealIronClawAdapter,
  SmartHomeActionHandler,
  SocialActionHandler,
  TaskActionHandler,
  type IronClawAdapter,
} from '@skytwin/ironclaw-adapter';
import { PolicyEvaluator, type PolicyDecision } from '@skytwin/policy-engine';
import {
  AdapterRegistry,
  DIRECT_TRUST_PROFILE,
  ExecutionRouter,
  IRONCLAW_TRUST_PROFILE,
  NoAdapterError,
  OPENCLAW_SKILLS,
  OPENCLAW_TRUST_PROFILE,
  OpenClawAdapter,
} from '@skytwin/execution-router';
import {
  approvalRepository,
  credentialRequirementRepository,
  decisionRepository,
  decisionRepositoryAdapter,
  executionRepository,
  explanationRepository,
  memoryActionOpportunityRepository,
  policyRepositoryAdapter,
  serviceCredentialRepository,
  skillGapRepository,
  userRepository,
} from '@skytwin/db';
import {
  awarenessDispositionGateEnabled,
  buildMemoryActionFingerprint,
  classifyActionSeverity,
  ConfidenceLevel,
  isPassiveAwarenessShape,
  RiskTier,
  SituationType,
  TrustTier,
  resolveActionProvenance,
  type ActionPolicy,
  type ActionProvenance,
  type AutonomySettings,
  type CandidateAction,
  type DailyMemorySuggestion,
  type DailyMemorySuggestionPage,
  type MemoryActionLoopReport,
  type MemoryActionOpportunitySnapshot,
  type MemoryActionOpportunityStatus,
  type RiskAssessment,
} from '@skytwin/shared-types';
import {
  fetchDailyMemorySuggestionBundle,
  getUsersWithRecentMemory,
  type DailyMemorySuggestionBundle,
} from './memory-suggestions.js';

const log = createLogger('worker:memory-action-loop');

const DEFAULT_AUTONOMY: AutonomySettings = {
  maxSpendPerActionCents: 0,
  maxDailySpendCents: 0,
  allowedDomains: [],
  blockedDomains: [],
  requireApprovalForIrreversible: true,
};

const VERIFIED_ZERO_MEMORY_ACTION_TYPES = new Set([
  'create_task',
  'set_reminder',
  'create_note',
  'create_document',
  'draft_email',
]);

export interface MemoryActionLoopSummary {
  users: number;
  opportunitiesUpserted: number;
  attempted: number;
  approvalsQueued: number;
  autoExecuted: number;
  notedAwareness: number;
  blocked: number;
  learningNeeded: number;
  executionFailed: number;
  skipped: number;
  reports: MemoryActionLoopReport[];
}

export interface MemoryActionLoopJobDeps {
  userIds?: string[];
  maxSuggestionsPerUser?: number;
  maxAttemptsPerUser?: number;
  now?: Date;
  fetchBundle?: (userId: string, maxSuggestions: number) => Promise<DailyMemorySuggestionBundle>;
  policyEvaluator?: Pick<PolicyEvaluator, 'evaluate'>;
  loadPolicies?: () => Promise<ActionPolicy[]>;
  getExecutionRouter?: () => Promise<Pick<ExecutionRouter, 'route' | 'executeWithRouting'>>;
}

let workerExecutionRouter: ExecutionRouter | null = null;

export async function runMemoryActionLoopJob(
  deps: MemoryActionLoopJobDeps = {},
): Promise<MemoryActionLoopSummary> {
  const userIds = deps.userIds ?? await getMemoryActionLoopUserIds();
  const summary: MemoryActionLoopSummary = {
    users: userIds.length,
    opportunitiesUpserted: 0,
    attempted: 0,
    approvalsQueued: 0,
    autoExecuted: 0,
    notedAwareness: 0,
    blocked: 0,
    learningNeeded: 0,
    executionFailed: 0,
    skipped: 0,
    reports: [],
  };
  if (userIds.length === 0) return summary;

  const maxSuggestions = deps.maxSuggestionsPerUser ?? 5;
  const maxAttempts = deps.maxAttemptsPerUser ?? 5;
  const fetchBundle = deps.fetchBundle ?? fetchDailyMemorySuggestionBundle;

  for (const userId of userIds) {
    try {
      const bundle = await fetchBundle(userId, maxSuggestions);
      for (const suggestion of bundle.suggestions) {
        const provenance = resolveSuggestionProvenance(suggestion, bundle.pagesById);
        await memoryActionOpportunityRepository.upsertFromSuggestion({
          userId,
          fingerprint: buildMemoryActionFingerprint(suggestion),
          suggestion,
          provenance,
        });
        summary.opportunitiesUpserted++;
      }

      const due = await memoryActionOpportunityRepository.claimDueForUser(userId, {
        limit: maxAttempts,
        retryAfterHours: 24,
      });

      for (const opportunity of due) {
        const report = await processOpportunity(userId, opportunity, deps);
        if (!report) {
          summary.skipped++;
          continue;
        }
        summary.attempted++;
        summary.reports.push(report);
        if (report.status === 'queued_approval') summary.approvalsQueued++;
        else if (report.status === 'auto_executed') summary.autoExecuted++;
        else if (report.status === 'noted_awareness') summary.notedAwareness++;
        else if (report.status === 'blocked_by_policy') summary.blocked++;
        else if (report.status === 'learning_needed') summary.learningNeeded++;
        else if (report.status === 'execution_failed') summary.executionFailed++;
      }
    } catch (err) {
      log.warn('Memory action loop failed for user; continuing', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

async function getMemoryActionLoopUserIds(): Promise<string[]> {
  const [recentMemoryUsers, dueOpportunityUsers] = await Promise.all([
    getUsersWithRecentMemory(),
    memoryActionOpportunityRepository.listUsersWithDue({
      limit: 500,
      retryAfterHours: 24,
    }),
  ]);
  return [...new Set([...recentMemoryUsers, ...dueOpportunityUsers])];
}

async function processOpportunity(
  userId: string,
  opportunity: MemoryActionOpportunitySnapshot,
  deps: MemoryActionLoopJobDeps,
): Promise<MemoryActionLoopReport | null> {
  const attempted = opportunity;

  const user = await userRepository.findById(userId);
  if (!user) {
    const report = buildReport(attempted, 'skipped', 'User no longer exists.', 'No action taken.', deps.now);
    await memoryActionOpportunityRepository.markStatus({ id: attempted.id, status: 'skipped', report });
    return report;
  }

  const decision = await createDecisionForOpportunity(userId, attempted);
  const candidate = buildCandidateForOpportunity(attempted, decision.id, user.ironclaw_channel ?? undefined);
  const riskAssessment = new RiskAssessor().assess(candidate);

  await decisionRepository.addCandidateAction({
    id: candidate.id,
    decisionId: candidate.decisionId,
    actionType: candidate.actionType,
    description: candidate.description,
    parameters: { ...candidate.parameters, domain: candidate.domain, costZeroIntent: candidate.costZeroIntent },
    predictedUserPreference: candidate.confidence,
    riskAssessment: { reasoning: candidate.reasoning },
    reversible: candidate.reversible,
    estimatedCost: candidate.estimatedCostCents,
  });
  await decisionRepositoryAdapter.saveRiskAssessment(riskAssessment);

  if (attempted.actionPlan.readiness === 'learn_or_connect') {
    await recordOutcomeAndExplanation(candidate, riskAssessment, {
      autoExecuted: false,
      requiresApproval: false,
      reason: attempted.actionPlan.learnTarget ?? 'A capability must be learned or connected before this can run.',
    });
    await logMemorySkillGap(userId, attempted, decision.id);
    const report = buildReport(
      attempted,
      'learning_needed',
      `SkyTwin found a memory opportunity but no known runtime skill is ready for ${attempted.actionType}.`,
      attempted.actionPlan.learnTarget ?? `Teach OpenClaw or install an MCP capability for ${attempted.actionType}.`,
      deps.now,
      { decisionId: decision.id, routeReason: attempted.actionPlan.adapterRationale },
    );
    await memoryActionOpportunityRepository.markStatus({
      id: attempted.id,
      status: 'learning_needed',
      report,
      decisionId: decision.id,
      routeReason: attempted.actionPlan.adapterRationale,
      nextStep: report.nextStep,
    });
    return report;
  }

  const policyEvaluator = deps.policyEvaluator ?? new PolicyEvaluator(policyRepositoryAdapter);
  const policies = deps.loadPolicies ? await deps.loadPolicies() : await policyRepositoryAdapter.getEnabledPolicies();
  const policyDecision = await policyEvaluator.evaluate(
    candidate,
    policies,
    parseTrustTier(user.trust_tier),
    riskAssessment,
    readAutonomy(user.autonomy_settings),
  );

  if (!policyDecision.allowed) {
    await recordOutcomeAndExplanation(candidate, riskAssessment, {
      autoExecuted: false,
      requiresApproval: false,
      reason: policyDecision.reason,
    });
    const report = buildReport(
      attempted,
      'blocked_by_policy',
      `Policy blocked this memory action before execution: ${policyDecision.reason}`,
      'Update policy/autonomy settings or ignore this opportunity.',
      deps.now,
      { decisionId: decision.id, policyReason: policyDecision.reason },
    );
    await memoryActionOpportunityRepository.markStatus({
      id: attempted.id,
      status: 'blocked_by_policy',
      report,
      decisionId: decision.id,
      policyReason: policyDecision.reason,
      nextStep: report.nextStep,
    });
    return report;
  }

  // Awareness disposition (#601): a passive, reversible, verified-free memory
  // note that the injection guard did NOT escalate is awareness, not a decision.
  // Record it as FYI (the digest still shows it) WITHOUT queuing an approval or
  // executing it — the same disposition the ingest route applies to newsletters,
  // so the two write paths stay consistent. Only intercepts the approval path;
  // when policy already allows auto-execution (higher tier) the note executes.
  if (
    policyDecision.requiresApproval &&
    awarenessDispositionGateEnabled() &&
    isAwarenessOnlyMemoryAction(candidate, policyDecision)
  ) {
    return recordAwarenessDisposition(attempted, candidate, riskAssessment, decision.id, deps.now);
  }

  if (policyDecision.requiresApproval) {
    await recordOutcomeAndExplanation(candidate, riskAssessment, {
      autoExecuted: false,
      requiresApproval: true,
      reason: policyDecision.reason,
      policyDecision,
    });
    const approval = await approvalRepository.create({
      userId,
      decisionId: decision.id,
      candidateAction: serializeCandidate(candidate),
      reason: policyDecision.reason,
      urgency: 'normal',
      confirmationLevel: policyDecision.confirmationLevel ?? 'single',
    });
    const report = buildReport(
      attempted,
      'queued_approval',
      `SkyTwin prepared this memory action and queued it for approval: ${policyDecision.reason}`,
      'Review the approval request; execution will use the persisted risk assessment after approval.',
      deps.now,
      {
        decisionId: decision.id,
        approvalRequestId: approval.row.id,
        policyReason: policyDecision.reason,
      },
    );
    await memoryActionOpportunityRepository.markStatus({
      id: attempted.id,
      status: 'queued_approval',
      report,
      decisionId: decision.id,
      approvalRequestId: approval.row.id,
      policyReason: policyDecision.reason,
      nextStep: report.nextStep,
    });
    return report;
  }

  return executeAllowedOpportunity(userId, attempted, candidate, riskAssessment, deps, policyDecision);
}

async function executeAllowedOpportunity(
  userId: string,
  opportunity: MemoryActionOpportunitySnapshot,
  candidate: CandidateAction,
  riskAssessment: RiskAssessment,
  deps: MemoryActionLoopJobDeps,
  policyDecision: PolicyDecision,
): Promise<MemoryActionLoopReport> {
  const getRouter = deps.getExecutionRouter ?? getWorkerExecutionRouter;
  try {
    const router = await getRouter();
    const routing = await router.route(candidate, riskAssessment, userId);
    const result = await router.executeWithRouting(candidate, riskAssessment, userId);
    const adapterName = adapterUsedFromResult(result.output) ?? routing.selectedAdapter;
    await recordOutcomeAndExplanation(candidate, riskAssessment, {
      autoExecuted: result.status === 'completed',
      requiresApproval: false,
      reason: result.status === 'completed'
        ? `Auto-executed after policy passed. ${policyDecision.reason}`
        : `Execution did not complete. ${result.error ?? 'Unknown adapter failure.'}`,
    });
    const plan = await executionRepository.createPlan({
      decisionId: candidate.decisionId,
      actionId: candidate.id,
      status: result.status === 'completed' ? 'completed' : 'failed',
      steps: [{ type: candidate.actionType, status: result.status, adapterPlanId: result.planId }],
    });
    await executionRepository.createResult({
      planId: plan.id,
      success: result.status === 'completed',
      outputs: { ...(result.output ?? {}), adapter_plan_id: result.planId },
      error: result.error,
      rollbackAvailable: candidate.reversible,
    });

    const status: MemoryActionOpportunityStatus =
      result.status === 'completed' ? 'auto_executed' : 'execution_failed';
    const report = buildReport(
      opportunity,
      status,
      result.status === 'completed'
        ? `SkyTwin executed this memory action through ${adapterName}.`
        : `SkyTwin tried ${adapterName}, but execution failed: ${result.error ?? 'unknown error'}.`,
      result.status === 'completed'
        ? 'Monitor feedback and keep the memory pattern available for future opportunities.'
        : 'Retry after adapter health or credentials are fixed.',
      deps.now,
      {
        decisionId: candidate.decisionId,
        executionPlanId: plan.id,
        adapterName,
        routeReason: routing.reasoning,
      },
    );
    await memoryActionOpportunityRepository.markStatus({
      id: opportunity.id,
      status,
      report,
      decisionId: candidate.decisionId,
      executionPlanId: plan.id,
      adapterName,
      routeReason: routing.reasoning,
      nextStep: report.nextStep,
    });
    return report;
  } catch (err) {
    const isGap = err instanceof NoAdapterError;
    await recordOutcomeAndExplanation(candidate, riskAssessment, {
      autoExecuted: false,
      requiresApproval: false,
      reason: isGap
        ? err.message
        : `Execution failed before completion: ${err instanceof Error ? err.message : String(err)}`,
    });
    const status: MemoryActionOpportunityStatus = isGap ? 'learning_needed' : 'execution_failed';
    if (isGap) {
      await logMemorySkillGap(userId, opportunity, candidate.decisionId, err.message);
    }
    const report = buildReport(
      opportunity,
      status,
      isGap
        ? `No configured adapter can handle ${candidate.actionType} yet.`
        : `Execution failed before completion: ${err instanceof Error ? err.message : String(err)}`,
      isGap
        ? `Connect or teach an OpenClaw/IronClaw skill for ${candidate.actionType}, then retry.`
        : 'Retry after the adapter error is resolved.',
      deps.now,
      {
        decisionId: candidate.decisionId,
        routeReason: err instanceof Error ? err.message : String(err),
      },
    );
    await memoryActionOpportunityRepository.markStatus({
      id: opportunity.id,
      status,
      report,
      decisionId: candidate.decisionId,
      routeReason: report.routeReason,
      nextStep: report.nextStep,
    });
    return report;
  }
}

function adapterUsedFromResult(output: Record<string, unknown> | undefined): string | undefined {
  const adapterUsed = output?.['adapter_used'];
  return typeof adapterUsed === 'string' && adapterUsed.length > 0 ? adapterUsed : undefined;
}

async function logMemorySkillGap(
  userId: string,
  opportunity: MemoryActionOpportunitySnapshot,
  decisionId: string,
  routeReason?: string,
): Promise<void> {
  if (opportunity.attemptCount > 1) return;
  try {
    await skillGapRepository.log({
      actionType: opportunity.actionType,
      actionDescription: [
        opportunity.actionLabel,
        opportunity.title,
        opportunity.actionPlan.learnTarget ?? opportunity.actionPlan.adapterRationale,
        routeReason,
      ].filter(Boolean).join(' — '),
      attemptedAdapters: [
        opportunity.actionPlan.primaryAdapter,
        ...opportunity.actionPlan.fallbackAdapters,
      ],
      userId,
      decisionId,
    });
  } catch (err) {
    log.warn('Failed to log memory action skill gap; continuing', {
      userId,
      opportunityId: opportunity.id,
      actionType: opportunity.actionType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function createDecisionForOpportunity(
  userId: string,
  opportunity: MemoryActionOpportunitySnapshot,
) {
  const signalId = `memory-action-loop:${opportunity.id}:${opportunity.attemptCount}`;
  const { row } = await decisionRepository.create({
    userId,
    situationType: inferSituationType(opportunity.actionType),
    rawEvent: {
      source: 'memory_action_loop',
      type: 'memory_opportunity',
      signalId,
      userId,
      opportunityId: opportunity.id,
      memoryRefs: opportunity.memoryRefs,
      sourceRefs: opportunity.sourceRefs,
    },
    interpretedSituation: {
      summary: opportunity.title,
      reason: opportunity.reason,
      suggestedAction: opportunity.suggestedAction,
    },
    domain: inferDomain(opportunity.actionType),
    urgency: 'medium',
    metadata: {
      memoryActionLoop: true,
      opportunityId: opportunity.id,
      fingerprint: opportunity.fingerprint,
      provenance: opportunity.provenance,
    },
  });
  return row;
}

function buildCandidateForOpportunity(
  opportunity: MemoryActionOpportunitySnapshot,
  decisionId: string,
  ironclawChannel?: string,
): CandidateAction {
  const actionType = opportunity.actionType;
  const parameters: Record<string, unknown> = {
    title: opportunity.actionLabel,
    summary: opportunity.title,
    reason: opportunity.reason,
    suggestedAction: opportunity.suggestedAction,
    memoryRefs: opportunity.memoryRefs,
    sourceRefs: opportunity.sourceRefs,
    opportunityId: opportunity.id,
    actionPlan: opportunity.actionPlan,
  };
  if (ironclawChannel) parameters['ironclawChannel'] = ironclawChannel;

  if (actionType === 'create_task' || actionType === 'set_reminder') {
    parameters['description'] = opportunity.reason;
    parameters['priority'] = opportunity.novelty === 'connection' ? 'high' : 'medium';
  }
  if (actionType === 'web_search') {
    parameters['query'] = opportunity.title;
  }
  if (actionType === 'create_document' || actionType === 'create_note') {
    parameters['contentPrompt'] = `${opportunity.title}\n\n${opportunity.reason}`;
  }

  return {
    id: crypto.randomUUID(),
    decisionId,
    actionType,
    description: opportunity.actionLabel,
    domain: inferDomain(actionType),
    parameters,
    estimatedCostCents: 0,
    costZeroIntent: VERIFIED_ZERO_MEMORY_ACTION_TYPES.has(actionType)
      ? 'verified_zero'
      : 'unknown',
    reversible: inferReversible(actionType),
    confidence: confidenceLevel(opportunity.confidence),
    reasoning:
      `Memory action loop selected this from ${opportunity.novelty} memory evidence. ` +
      opportunity.reason,
    provenance: opportunity.provenance,
  };
}

/**
 * True when a memory-loop candidate is pure awareness: a passive, reversible,
 * verified-free action (shared shape), from UNTRUSTED content, that the
 * injection guard did NOT escalate. Three guards, each a different safety axis:
 *
 *  - `policyDecision.confirmationLevel` is the injection-guard escalation marker.
 *    The policy evaluator sets it ONLY when the guard escalates (an irreversible
 *    / destructive / outbound action on untrusted content) and never strips it;
 *    a plain trust-tier approval leaves it undefined. A set confirmationLevel
 *    must always surface as an approval — the same security boundary the
 *    ingest-route gate uses (`outcome.confirmationLevel`).
 *  - `provenance === 'untrusted_external'` scopes disposition to newsletters /
 *    automated notices (the actual flood). A note derived from the user's own
 *    authored or trusted-context memory still surfaces as an approval — the same
 *    spirit as the ingest gate, which disposes only awareness-tier email +
 *    calendar updates, never human / self-authored correspondence.
 *  - `isPassiveAwarenessShape` requires a passive, reversible, verified-free
 *    action — no outward effect.
 *
 * This never EXECUTES anything (the caller records FYI without routing), so it
 * does not breach an operator pause / kill switch, whose contract is "no actions
 * without approval" — an FYI recording is not an action. Consistent with the
 * ingest gate, which likewise disposes awareness items regardless of pause.
 */
export function isAwarenessOnlyMemoryAction(
  candidate: Pick<CandidateAction, 'actionType' | 'reversible' | 'estimatedCostCents' | 'costZeroIntent' | 'provenance'>,
  policyDecision: Pick<PolicyDecision, 'confirmationLevel'>,
): boolean {
  if (policyDecision.confirmationLevel) return false;
  if (candidate.provenance !== 'untrusted_external') return false;
  return isPassiveAwarenessShape(candidate);
}

/**
 * Dispose a memory opportunity as awareness FYI: record the outcome as
 * not-requiring-approval (so the digest buckets it with awareness, not To-do)
 * and mark the opportunity terminal — WITHOUT creating an approval row or
 * executing the action. Mirrors the ingest route's awareness disposition.
 */
async function recordAwarenessDisposition(
  opportunity: MemoryActionOpportunitySnapshot,
  candidate: CandidateAction,
  riskAssessment: RiskAssessment,
  decisionId: string,
  now: Date | undefined,
): Promise<MemoryActionLoopReport> {
  await recordOutcomeAndExplanation(candidate, riskAssessment, {
    autoExecuted: false,
    requiresApproval: false,
    reason:
      'Awareness-only memory note (passive, reversible, free, not injection-escalated): ' +
      'recorded as FYI without an approval. Raise your trust tier to act on these automatically.',
  });
  const report = buildReport(
    opportunity,
    'noted_awareness',
    'SkyTwin noted this as awareness — no approval needed and nothing was executed.',
    'Nothing required. It appears in your digest as FYI; hide the underlying memory if it should not resurface.',
    now,
    { decisionId },
  );
  await memoryActionOpportunityRepository.markStatus({
    id: opportunity.id,
    status: 'noted_awareness',
    report,
    decisionId,
    nextStep: report.nextStep,
  });
  return report;
}

async function recordOutcomeAndExplanation(
  candidate: CandidateAction,
  riskAssessment: RiskAssessment,
  outcome: {
    autoExecuted: boolean;
    requiresApproval: boolean;
    reason: string;
    policyDecision?: PolicyDecision;
  },
): Promise<void> {
  await decisionRepository.recordOutcome({
    decisionId: candidate.decisionId,
    selectedActionId: candidate.id,
    autoExecuted: outcome.autoExecuted,
    requiresApproval: outcome.requiresApproval,
    escalationReason: outcome.requiresApproval ? outcome.reason : null,
    explanation: outcome.reason,
    confidence: riskTierToConfidence(riskAssessment.overallTier),
  });
  await explanationRepository.create({
    decisionId: candidate.decisionId,
    whatHappened: outcome.autoExecuted
      ? 'SkyTwin executed a memory-derived action opportunity.'
      : outcome.requiresApproval
        ? 'SkyTwin prepared a memory-derived action and queued it for approval.'
        : 'SkyTwin evaluated a memory-derived action and did not execute it.',
    evidenceUsed: [
      {
        memoryRefs: candidate.parameters['memoryRefs'],
        sourceRefs: candidate.parameters['sourceRefs'],
        opportunityId: candidate.parameters['opportunityId'],
      },
    ],
    preferencesInvoked: [],
    confidenceReasoning: riskAssessment.reasoning,
    actionRationale: candidate.reasoning,
    escalationRationale: outcome.requiresApproval ? outcome.reason : null,
    correctionGuidance:
      'Approve, reject, or edit the resulting approval when present. ' +
      'Hide the underlying memory if this opportunity should not resurface.',
  });
}

function serializeCandidate(candidate: CandidateAction): Record<string, unknown> {
  return {
    id: candidate.id,
    decisionId: candidate.decisionId,
    actionType: candidate.actionType,
    description: candidate.description,
    domain: candidate.domain,
    parameters: candidate.parameters,
    estimatedCostCents: candidate.estimatedCostCents,
    costZeroIntent: candidate.costZeroIntent,
    reversible: candidate.reversible,
    confidence: candidate.confidence,
    reasoning: candidate.reasoning,
    provenance: candidate.provenance,
  };
}

function resolveSuggestionProvenance(
  suggestion: DailyMemorySuggestion,
  pagesById: Map<string, DailyMemorySuggestionPage>,
): ActionProvenance {
  const provenances = suggestion.memoryRefs
    .map((id) => pagesById.get(id))
    .filter((page): page is DailyMemorySuggestionPage => Boolean(page))
    .map((page) => {
      const meta = page.metadata ?? {};
      const source =
        typeof meta['signalSource'] === 'string'
          ? meta['signalSource']
          : page.source;
      const authoringTier =
        typeof meta['authoringTier'] === 'string'
          ? meta['authoringTier']
          : undefined;
      return resolveActionProvenance(source, authoringTier);
    });
  if (provenances.length === 0) return 'untrusted_external';
  if (provenances.includes('untrusted_external')) return 'untrusted_external';
  if (provenances.includes('trusted_context')) return 'trusted_context';
  return 'user_originated';
}

function buildReport(
  opportunity: MemoryActionOpportunitySnapshot,
  status: MemoryActionOpportunityStatus,
  summary: string,
  nextStep: string,
  now: Date | undefined,
  extras: Partial<MemoryActionLoopReport> = {},
): MemoryActionLoopReport {
  return {
    opportunityId: opportunity.id,
    status,
    title: opportunity.title,
    actionType: opportunity.actionType,
    actionLabel: opportunity.actionLabel,
    summary,
    nextStep,
    attemptedAt: (now ?? new Date()).toISOString(),
    ...extras,
  };
}

async function getWorkerExecutionRouter(): Promise<ExecutionRouter> {
  if (!workerExecutionRouter) {
    workerExecutionRouter = await createWorkerExecutionRouter();
  }
  return workerExecutionRouter;
}

async function createWorkerExecutionRouter(): Promise<ExecutionRouter> {
  const config = loadConfig();
  const registry = new AdapterRegistry();
  const [ironclawCreds, openclawCreds] = await Promise.all([
    getStoredCredentials('ironclaw'),
    getStoredCredentials('openclaw'),
  ]);

  if (config.useMockIronclaw) {
    registry.register('ironclaw', new MockIronClawAdapter(), IRONCLAW_TRUST_PROFILE);
  } else {
    const apiUrl = ironclawCreds['api_url'] || config.ironclawApiUrl;
    const webhookSecret = ironclawCreds['webhook_secret'] || config.ironclawWebhookSecret;
    if (apiUrl && webhookSecret) {
      const adapter: IronClawAdapter = new RealIronClawAdapter({
        apiUrl,
        webhookSecret,
        gatewayToken: ironclawCreds['gateway_token'] || config.ironclawGatewayToken,
        ownerId: ironclawCreds['owner_id'] || config.ironclawOwnerId,
        defaultChannel: ironclawCreds['default_channel'] || config.ironclawDefaultChannel,
        preferChatCompletions: config.ironclawPreferChat,
      });
      registry.register('ironclaw', adapter, IRONCLAW_TRUST_PROFILE);
    }
  }

  const handlerRegistry = new ActionHandlerRegistry();
  const credentialProvider = new DbCredentialProvider();
  handlerRegistry.register(new EmailActionHandler(credentialProvider));
  handlerRegistry.register(new CalendarActionHandler(credentialProvider));
  handlerRegistry.register(new FinanceActionHandler());
  handlerRegistry.register(new TaskActionHandler());
  handlerRegistry.register(new SmartHomeActionHandler());
  handlerRegistry.register(new SocialActionHandler());
  handlerRegistry.register(new DocumentActionHandler());
  handlerRegistry.register(new HealthActionHandler());
  registry.register('direct', new DirectExecutionAdapter(handlerRegistry), DIRECT_TRUST_PROFILE);

  const openclawApiUrl = openclawCreds['api_url'] || config.openclawApiUrl;
  if (openclawApiUrl) {
    registry.register(
      'openclaw',
      new OpenClawAdapter({
        apiUrl: openclawApiUrl,
        apiKey: openclawCreds['api_key'] || config.openclawApiKey || undefined,
        onCredentialNeeded: async (req) => {
          for (const field of req.fields) {
            await credentialRequirementRepository.register({
              adapter: 'openclaw',
              integration: req.integration,
              integrationLabel: req.integrationLabel,
              description: req.description,
              fieldKey: field.key,
              fieldLabel: field.label,
              fieldPlaceholder: field.placeholder,
              isSecret: field.secret,
              isOptional: field.optional,
              skills: req.skills,
            });
          }
        },
      }),
      OPENCLAW_TRUST_PROFILE,
      OPENCLAW_SKILLS,
    );
  }

  return new ExecutionRouter(registry);
}

async function getStoredCredentials(service: string): Promise<Record<string, string>> {
  try {
    return await serviceCredentialRepository.getAsMap(service);
  } catch {
    return {};
  }
}

function readAutonomy(raw: unknown): AutonomySettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_AUTONOMY;
  const r = raw as Record<string, unknown>;
  return {
    maxSpendPerActionCents: typeof r['maxSpendPerActionCents'] === 'number'
      ? r['maxSpendPerActionCents']
      : DEFAULT_AUTONOMY.maxSpendPerActionCents,
    maxDailySpendCents: typeof r['maxDailySpendCents'] === 'number'
      ? r['maxDailySpendCents']
      : DEFAULT_AUTONOMY.maxDailySpendCents,
    allowedDomains: Array.isArray(r['allowedDomains']) ? r['allowedDomains'] as string[] : [],
    blockedDomains: Array.isArray(r['blockedDomains']) ? r['blockedDomains'] as string[] : [],
    requireApprovalForIrreversible:
      typeof r['requireApprovalForIrreversible'] === 'boolean'
        ? r['requireApprovalForIrreversible']
        : DEFAULT_AUTONOMY.requireApprovalForIrreversible,
    paused: typeof r['paused'] === 'boolean' ? r['paused'] : undefined,
    pausedAt: typeof r['pausedAt'] === 'string' ? r['pausedAt'] : undefined,
    pausedReason: typeof r['pausedReason'] === 'string' ? r['pausedReason'] : undefined,
    perAppOverrides:
      r['perAppOverrides'] && typeof r['perAppOverrides'] === 'object'
        ? r['perAppOverrides'] as AutonomySettings['perAppOverrides']
        : undefined,
  };
}

function parseTrustTier(value: string): TrustTier {
  return Object.values(TrustTier).includes(value as TrustTier)
    ? value as TrustTier
    : TrustTier.OBSERVER;
}

function inferDomain(actionType: string): string {
  const lower = actionType.toLowerCase();
  if (lower.includes('email') || lower.includes('reply')) return 'email';
  if (lower.includes('calendar') || lower.includes('meeting') || lower.includes('invite')) return 'calendar';
  if (lower.includes('transaction') || lower.includes('expense') || lower.includes('budget') || lower.includes('fund')) return 'finance';
  if (lower.includes('task') || lower.includes('reminder')) return 'tasks';
  if (lower.includes('document') || lower.includes('note') || lower.includes('file')) return 'documents';
  if (lower.includes('social') || lower.includes('post') || lower.includes('mention')) return 'social';
  if (lower.includes('health') || lower.includes('appointment') || lower.includes('medication')) return 'health';
  return 'general';
}

function inferSituationType(actionType: string): SituationType {
  const domain = inferDomain(actionType);
  const map: Record<string, SituationType> = {
    email: SituationType.EMAIL_TRIAGE,
    calendar: SituationType.CALENDAR_INVITE,
    finance: SituationType.FINANCE_OPERATION,
    tasks: SituationType.TASK_MANAGEMENT,
    documents: SituationType.DOCUMENT_MANAGEMENT,
    social: SituationType.SOCIAL_MEDIA,
    health: SituationType.HEALTH_WELLNESS,
  };
  return map[domain] ?? SituationType.GENERIC;
}

function inferReversible(actionType: string): boolean {
  if (classifyActionSeverity({ actionType }) !== 'none') return false;
  const lower = actionType.toLowerCase();
  if (isOutboundEmailActionType(lower)) return false;
  return ![
    'pay_',
    'transfer_',
    'place_order',
    'book_travel',
    'book_appointment',
    'schedule_social_post',
  ].some((marker) => lower.includes(marker));
}

function isOutboundEmailActionType(actionType: string): boolean {
  return [
    'draft_email',
    'reply_email',
    'send_reply',
    'send_email',
    'forward_email',
  ].some((marker) => actionType.includes(marker));
}

function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.8) return ConfidenceLevel.HIGH;
  if (confidence >= 0.65) return ConfidenceLevel.MODERATE;
  return ConfidenceLevel.LOW;
}

function riskTierToConfidence(tier: RiskTier): number {
  const map: Record<RiskTier, number> = {
    [RiskTier.NEGLIGIBLE]: 1,
    [RiskTier.LOW]: 0.8,
    [RiskTier.MODERATE]: 0.6,
    [RiskTier.HIGH]: 0.4,
    [RiskTier.CRITICAL]: 0.2,
  };
  return map[tier];
}
