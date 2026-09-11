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
  AmbiguousExecutionError,
  DIRECT_TRUST_PROFILE,
  EXECUTION_FAILURE_CODES,
  ExecutionRouter,
  IRONCLAW_TRUST_PROFILE,
  NoAdapterError,
  OPENCLAW_SKILLS,
  OPENCLAW_TRUST_PROFILE,
  OpenClawAdapter,
  executionFailureCode,
  type PreparedExecution,
} from '@skytwin/execution-router';
import {
  approvalRepository,
  credentialRequirementRepository,
  decisionRepository,
  decisionRepositoryAdapter,
  executionRepository,
  explanationRepositoryAdapter,
  memoryActionOpportunityRepository,
  preEffectBarrierRepository,
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
  parseAutonomySettings,
  SituationType,
  TrustTier,
  resolveActionProvenance,
  type ActionPolicy,
  type ActionProvenance,
  type AutonomySettings,
  type CandidateAction,
  type DailyMemorySuggestion,
  type DailyMemorySuggestionPage,
  type DecisionOutcome,
  type ExplanationRecord,
  type ExecutionResult,
  type MemoryActionLoopReport,
  type MemoryActionOpportunitySnapshot,
  type MemoryActionOpportunityStatus,
  type RiskAssessment,
  type RoutingDecision,
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
  executionUnknown: number;
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
  loadPolicies?: (userId: string) => Promise<ActionPolicy[]>;
  getExecutionRouter?: () => Promise<Pick<ExecutionRouter, 'route' | 'prepareExecution' | 'executePrepared'>>;
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
    executionUnknown: 0,
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
        else if (report.status === 'execution_unknown') summary.executionUnknown++;
      }
    } catch {
      log.warn('Memory action loop failed for user; continuing', {
        userId,
        errorCode: 'memory_action_loop_failed',
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
    await memoryActionOpportunityRepository.markStatus({ id: attempted.id, userId, status: 'skipped', report });
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
    parameters: {
      ...candidate.parameters,
      domain: candidate.domain,
      costZeroIntent: candidate.costZeroIntent,
      provenance: candidate.provenance,
    },
    predictedUserPreference: candidate.confidence,
    riskAssessment: { reasoning: candidate.reasoning },
    reversible: candidate.reversible,
    estimatedCost: candidate.estimatedCostCents,
  });
  await decisionRepositoryAdapter.saveRiskAssessment(riskAssessment);

  if (attempted.actionPlan.readiness === 'learn_or_connect') {
    await recordOutcomeAndExplanation(userId, candidate, riskAssessment, {
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
      userId,
      status: 'learning_needed',
      report,
      decisionId: decision.id,
      routeReason: attempted.actionPlan.adapterRationale,
      nextStep: report.nextStep,
    });
    return report;
  }

  const policyEvaluator = deps.policyEvaluator ?? new PolicyEvaluator(policyRepositoryAdapter);
  const policies = deps.loadPolicies
    ? await deps.loadPolicies(userId)
    : await policyRepositoryAdapter.getEnabledPolicies(userId);
  const policyDecision = await policyEvaluator.evaluate(
    candidate,
    policies,
    parseTrustTier(user.trust_tier),
    riskAssessment,
    readAutonomy(user.autonomy_settings),
  );

  if (!policyDecision.allowed) {
    await recordOutcomeAndExplanation(userId, candidate, riskAssessment, {
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
      userId,
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
    await recordOutcomeAndExplanation(userId, candidate, riskAssessment, {
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
      userId,
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
  const { row: barrier, created } = await preEffectBarrierRepository.reserve({
    userId,
    effectType: 'memory_execution',
    idempotencyKey: opportunity.id,
  });
  if (!created) {
    const report = buildReport(
      opportunity,
      barrier.status === 'succeeded'
        ? 'auto_executed'
        : barrier.status === 'in_progress' || barrier.status === 'unknown'
          ? 'execution_unknown'
          : 'execution_failed',
      barrier.status === 'succeeded'
        ? 'This memory action was already executed; the duplicate attempt was suppressed.'
        : 'A prior execution attempt has an unresolved or terminal result; the duplicate attempt was suppressed.',
      barrier.status === 'succeeded'
        ? 'No action required.'
        : 'Reconcile the adapter state manually before creating a new opportunity.',
      deps.now,
      { decisionId: barrier.decision_id ?? candidate.decisionId },
    );
    await memoryActionOpportunityRepository.markStatus({
      id: opportunity.id,
      userId,
      status: report.status,
      report,
      decisionId: report.decisionId,
      routeReason: `Pre-effect barrier is ${barrier.status}; automatic replay is disabled.`,
      nextStep: report.nextStep,
    });
    return report;
  }

  let preparedBarrier = false;
  let effectiveRisk = riskAssessment;
  let admittedCandidate = candidate;
  let router: Awaited<ReturnType<typeof getRouter>>;
  let routing: RoutingDecision;
  let preparedExecution: PreparedExecution;
  let finalPolicy: PolicyDecision;
  try {
    router = await getRouter();
    routing = await router.route(candidate, riskAssessment, userId);
    preparedExecution = await router.prepareExecution(candidate, routing, userId);
    // From this point forward, policy and persistence use the exact deep-frozen
    // copies carried by the router-issued capability, not caller-owned inputs.
    routing = preparedExecution.routingDecision;
    admittedCandidate = preparedExecution.plan.action;
    effectiveRisk = routing.modifiedRiskAssessment;
    await decisionRepositoryAdapter.saveRiskAssessment(effectiveRisk);

    // Reload mutable policy inputs and evaluate again at the last safe moment.
    const freshUser = await userRepository.findById(userId);
    if (!freshUser) throw new Error('User disappeared before execution.');
    const evaluator = deps.policyEvaluator ?? new PolicyEvaluator(policyRepositoryAdapter);
    const freshPolicies = deps.loadPolicies
      ? await deps.loadPolicies(userId)
      : await policyRepositoryAdapter.getEnabledPolicies(userId);
    finalPolicy = await evaluator.evaluate(
      admittedCandidate,
      freshPolicies,
      parseTrustTier(freshUser.trust_tier),
      effectiveRisk,
      readAutonomy(freshUser.autonomy_settings),
    );
    if (!finalPolicy.allowed || finalPolicy.requiresApproval) {
      const terminalExplanation = await recordOutcomeAndExplanation(userId, admittedCandidate, effectiveRisk, {
        autoExecuted: false,
        requiresApproval: finalPolicy.requiresApproval,
        reason: `Final pre-execution policy check stopped the action. ${finalPolicy.reason}`,
        policyDecision: finalPolicy,
        phase: 'terminal',
      });
      await preEffectBarrierRepository.markPrepared({
        id: barrier.id,
        userId,
        decisionId: admittedCandidate.decisionId,
        actionId: admittedCandidate.id,
        explanationId: terminalExplanation.id,
        policySnapshot: serializePolicySnapshot(finalPolicy, admittedCandidate, effectiveRisk, routing),
      });
      preparedBarrier = true;
      await preEffectBarrierRepository.markTerminal(
        userId,
        barrier.id,
        'blocked',
        { finalPolicy: serializePolicySnapshot(finalPolicy, admittedCandidate, effectiveRisk, routing) },
        finalPolicy.reason,
      );
      const report = buildReport(
        opportunity,
        'blocked_by_policy',
        `Policy changed before execution: ${finalPolicy.reason}`,
        'Review the current policy and autonomy settings.',
        deps.now,
        { decisionId: admittedCandidate.decisionId, policyReason: finalPolicy.reason },
      );
      await memoryActionOpportunityRepository.markStatus({
        id: opportunity.id,
        userId,
        status: 'blocked_by_policy',
        report,
        decisionId: admittedCandidate.decisionId,
        policyReason: finalPolicy.reason,
        nextStep: report.nextStep,
      });
      return report;
    }

    const intendedExplanation = await recordOutcomeAndExplanation(
      userId,
      admittedCandidate,
      effectiveRisk,
      {
        autoExecuted: true,
        requiresApproval: false,
        reason: `Final policy permits automatic execution through ${routing.selectedAdapter}. ${finalPolicy.reason}`,
        policyDecision: finalPolicy,
        phase: 'intended',
      },
    );
    await preEffectBarrierRepository.markPrepared({
      id: barrier.id,
      userId,
      decisionId: admittedCandidate.decisionId,
      actionId: admittedCandidate.id,
      explanationId: intendedExplanation.id,
      policySnapshot: serializePolicySnapshot(finalPolicy, admittedCandidate, effectiveRisk, routing),
    });
    preparedBarrier = true;
    const claim = await preEffectBarrierRepository.claimPrepared(userId, barrier.id);
    if (!claim) throw new Error('Pre-effect barrier could not be claimed.');
  } catch (err) {
    return recordPreDispatchFailure(
      userId,
      opportunity,
      admittedCandidate,
      effectiveRisk,
      policyDecision,
      barrier.id,
      preparedBarrier,
      err,
      deps.now,
    );
  }

  let result: ExecutionResult;
  try {
    // This is the only ambiguous boundary. Nothing after this catch may
    // reinterpret a known adapter result as unknown.
    result = await router.executePrepared(preparedExecution, userId);
  } catch (err) {
    if (!(err instanceof AmbiguousExecutionError)) {
      return recordPreDispatchFailure(
        userId,
        opportunity,
        admittedCandidate,
        effectiveRisk,
        policyDecision,
        barrier.id,
        true,
        err,
        deps.now,
      );
    }
    return recordAmbiguousDispatchFailure(
      userId,
      opportunity,
      admittedCandidate,
      effectiveRisk,
      barrier.id,
      err,
      deps.now,
    );
  }

  const adapterName = adapterUsedFromResult(result.output) ?? routing.selectedAdapter;
  const resultFailureCode = result.status === 'completed'
    ? undefined
    : EXECUTION_FAILURE_CODES.adapterFailed;
  // Persist the known adapter result first. Any later audit-ledger failure may
  // leave secondary records incomplete, but it must never downgrade this
  // durable succeeded/failed fact to unknown or trigger a replay.
  await preEffectBarrierRepository.markTerminal(
    userId,
    barrier.id,
    result.status === 'completed' ? 'succeeded' : 'failed',
    { planId: result.planId, adapterName, status: result.status },
    resultFailureCode,
  );
  await recordOutcomeAndExplanation(userId, admittedCandidate, effectiveRisk, {
    autoExecuted: result.status === 'completed',
    requiresApproval: false,
    reason: result.status === 'completed'
      ? `Auto-executed after policy passed. ${finalPolicy.reason}`
      : `Execution did not complete (${resultFailureCode}).`,
    phase: 'terminal',
  });
  const plan = await executionRepository.createPlan({
    decisionId: admittedCandidate.decisionId,
    actionId: admittedCandidate.id,
    status: result.status === 'completed' ? 'completed' : 'failed',
    steps: [{ type: admittedCandidate.actionType, status: result.status, adapterPlanId: result.planId }],
  });
  await executionRepository.createResult({
    planId: plan.id,
    success: result.status === 'completed',
    outputs: { ...(result.output ?? {}), adapter_plan_id: result.planId },
    error: resultFailureCode,
    rollbackAvailable: admittedCandidate.reversible,
  });

  const status: MemoryActionOpportunityStatus =
    result.status === 'completed' ? 'auto_executed' : 'execution_failed';
  const report = buildReport(
    opportunity,
    status,
    result.status === 'completed'
      ? `SkyTwin executed this memory action through ${adapterName}.`
      : `SkyTwin tried ${adapterName}, but execution failed (${resultFailureCode}).`,
    result.status === 'completed'
      ? 'Monitor feedback and keep the memory pattern available for future opportunities.'
      : 'Inspect adapter state and create a new opportunity only after the failure is reconciled.',
    deps.now,
    {
      decisionId: admittedCandidate.decisionId,
      executionPlanId: plan.id,
      adapterName,
      routeReason: routing.reasoning,
    },
  );
  await memoryActionOpportunityRepository.markStatus({
    id: opportunity.id,
    userId,
    status,
    report,
    decisionId: admittedCandidate.decisionId,
    executionPlanId: plan.id,
    adapterName,
    routeReason: routing.reasoning,
    nextStep: report.nextStep,
  });
  return report;
}

async function recordPreDispatchFailure(
  userId: string,
  opportunity: MemoryActionOpportunitySnapshot,
  candidate: CandidateAction,
  riskAssessment: RiskAssessment,
  policyDecision: PolicyDecision,
  barrierId: string,
  preparedBarrier: boolean,
  err: unknown,
  now: Date | undefined,
): Promise<MemoryActionLoopReport> {
  const isGap = err instanceof NoAdapterError;
  const failureCode = executionFailureCode(err);
  const terminalExplanation = await recordOutcomeAndExplanation(userId, candidate, riskAssessment, {
    autoExecuted: false,
    requiresApproval: false,
    reason: isGap
      ? `No configured adapter can handle ${candidate.actionType} (${failureCode}).`
      : `Execution failed before dispatch (${failureCode}).`,
    phase: 'terminal',
  });
  if (!preparedBarrier) {
    await preEffectBarrierRepository.markPrepared({
      id: barrierId,
      userId,
      decisionId: candidate.decisionId,
      actionId: candidate.id,
      explanationId: terminalExplanation.id,
      policySnapshot: serializePolicySnapshot(policyDecision, candidate, riskAssessment),
    });
  }
  await preEffectBarrierRepository.markTerminal(
    userId,
    barrierId,
    'failed',
    {},
    failureCode,
  );
  const status: MemoryActionOpportunityStatus = isGap ? 'learning_needed' : 'execution_failed';
  if (isGap) await logMemorySkillGap(userId, opportunity, candidate.decisionId, failureCode);
  const report = buildReport(
    opportunity,
    status,
    isGap
      ? `No configured adapter can handle ${candidate.actionType} yet.`
      : `Execution failed before dispatch (${failureCode}).`,
    isGap
      ? `Connect or teach an OpenClaw/IronClaw skill for ${candidate.actionType}, then retry.`
      : 'Review the local preparation or persistence error before creating a new opportunity.',
    now,
    { decisionId: candidate.decisionId, routeReason: failureCode },
  );
  await memoryActionOpportunityRepository.markStatus({
    id: opportunity.id,
    userId,
    status,
    report,
    decisionId: candidate.decisionId,
    routeReason: report.routeReason,
    nextStep: report.nextStep,
  });
  return report;
}

async function recordAmbiguousDispatchFailure(
  userId: string,
  opportunity: MemoryActionOpportunitySnapshot,
  candidate: CandidateAction,
  riskAssessment: RiskAssessment,
  barrierId: string,
  err: unknown,
  now: Date | undefined,
): Promise<MemoryActionLoopReport> {
  const reason = executionFailureCode(err);
  await preEffectBarrierRepository.markTerminal(userId, barrierId, 'unknown', {}, reason);
  try {
    await recordOutcomeAndExplanation(userId, candidate, riskAssessment, {
      autoExecuted: false,
      requiresApproval: false,
      reason: `Execution began, but its final result is unknown: ${reason}`,
      phase: 'terminal',
    });
  } catch {
    log.warn('Failed to append terminal explanation for ambiguous memory execution', {
      userId,
      opportunityId: opportunity.id,
      errorCode: 'ambiguous_execution_explanation_failed',
    });
  }
  const report = buildReport(
    opportunity,
    'execution_unknown',
    'Execution began, but its final adapter result is unknown; automatic replay is disabled.',
    'Reconcile the adapter state manually before creating a new opportunity.',
    now,
    { decisionId: candidate.decisionId, routeReason: reason },
  );
  await memoryActionOpportunityRepository.markStatus({
    id: opportunity.id,
    userId,
    status: 'execution_unknown',
    report,
    decisionId: candidate.decisionId,
    routeReason: reason,
    nextStep: report.nextStep,
  });
  return report;
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
  } catch {
    log.warn('Failed to log memory action skill gap; continuing', {
      userId,
      opportunityId: opportunity.id,
      actionType: opportunity.actionType,
      errorCode: 'memory_skill_gap_logging_failed',
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
  await recordOutcomeAndExplanation(opportunity.userId, candidate, riskAssessment, {
    autoExecuted: false,
    requiresApproval: false,
    reason:
      'Awareness-only memory note (passive, reversible, free, from an untrusted source, ' +
      'not injection-escalated): recorded as FYI, not queued for approval, and not executed. ' +
      'Turn off the awareness gate to receive these as approvals.',
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
    userId: opportunity.userId,
    status: 'noted_awareness',
    report,
    decisionId,
    nextStep: report.nextStep,
  });
  return report;
}

async function recordOutcomeAndExplanation(
  userId: string,
  candidate: CandidateAction,
  riskAssessment: RiskAssessment,
  outcome: {
    autoExecuted: boolean;
    requiresApproval: boolean;
    reason: string;
    policyDecision?: PolicyDecision;
    phase?: 'intended' | 'terminal';
  },
): Promise<ExplanationRecord> {
  const decisionOutcome: DecisionOutcome = {
    id: crypto.randomUUID(),
    decisionId: candidate.decisionId,
    selectedAction: candidate,
    allCandidates: [candidate],
    riskAssessment,
    allRiskAssessments: [riskAssessment],
    autoExecute: outcome.autoExecuted,
    requiresApproval: outcome.requiresApproval,
    reasoning: outcome.reason,
    decidedAt: new Date(),
    policyVerdicts: {
      [candidate.id]: outcome.policyDecision
        ? outcome.policyDecision.allowed
          ? outcome.policyDecision.requiresApproval ? 'requires-approval' : 'allowed'
          : 'denied'
        : outcome.requiresApproval ? 'requires-approval' : 'denied',
    },
    confirmationLevel: outcome.policyDecision?.confirmationLevel,
  };
  await decisionRepositoryAdapter.saveOutcome(decisionOutcome);

  const explanation: ExplanationRecord = {
    id: crypto.randomUUID(),
    decisionId: candidate.decisionId,
    userId,
    summary: outcome.phase === 'intended'
      ? 'SkyTwin durably recorded its intent to execute a memory-derived action.'
      : outcome.autoExecuted
        ? 'SkyTwin executed a memory-derived action opportunity.'
      : outcome.requiresApproval
        ? 'SkyTwin prepared a memory-derived action and queued it for approval.'
        : 'SkyTwin evaluated a memory-derived action and did not execute it.',
    evidenceUsed: [
      {
        evidenceId: String(candidate.parameters['opportunityId'] ?? candidate.decisionId),
        source: 'memory_action_loop',
        summary: `Memory refs: ${JSON.stringify(candidate.parameters['memoryRefs'] ?? [])}; source refs: ${JSON.stringify(candidate.parameters['sourceRefs'] ?? [])}`,
        relevance: 'The persisted memory opportunity directly produced this candidate action.',
      },
    ],
    preferencesInvoked: [],
    confidenceReasoning: riskAssessment.reasoning,
    actionRationale: candidate.reasoning,
    escalationRationale: outcome.requiresApproval ? outcome.reason : undefined,
    correctionGuidance:
      'Approve, reject, or edit the resulting approval when present. ' +
      'Hide the underlying memory if this opportunity should not resurface.',
    riskTier: riskAssessment.overallTier,
    overallConfidence: candidate.confidence,
    capabilityProvenanceNodeId: candidate.capabilityProvenanceNodeId,
    createdAt: new Date(),
  };
  return explanationRepositoryAdapter.save(explanation);
}

function serializePolicySnapshot(
  policyDecision: PolicyDecision,
  candidate: CandidateAction,
  riskAssessment: RiskAssessment,
  routing?: {
    selectedAdapter: string;
    riskModifierApplied: number;
    reasoning: string;
    fallbackChain: string[];
  },
): Record<string, unknown> {
  return {
    allowed: policyDecision.allowed,
    requiresApproval: policyDecision.requiresApproval,
    reason: policyDecision.reason,
    confirmationLevel: policyDecision.confirmationLevel,
    candidate: serializeCandidate(candidate),
    riskAssessment: {
      ...riskAssessment,
      assessedAt: riskAssessment.assessedAt.toISOString(),
    },
    routing: routing ? {
      selectedAdapter: routing.selectedAdapter,
      riskModifierApplied: routing.riskModifierApplied,
      reasoning: routing.reasoning,
      fallbackChain: [...routing.fallbackChain],
    } : null,
  };
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

/**
 * Read a user row's persisted autonomy settings.
 *
 * Delegates to the shared `parseAutonomySettings` parser in
 * `@skytwin/shared-types` so the worker, the API cost gate, and the
 * decision pipeline all narrow the JSONB column identically. Previously
 * this was one of two divergent hand-rolled readers; the API copy dropped
 * the pause kill switch and quiet-hours fields entirely.
 */
function readAutonomy(raw: unknown): AutonomySettings {
  return parseAutonomySettings(raw, DEFAULT_AUTONOMY);
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
