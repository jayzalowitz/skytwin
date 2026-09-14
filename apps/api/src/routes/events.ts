import { Router } from 'express';
import {
  SituationInterpreter,
  DecisionMaker,
  LlmSituationStrategy,
  LlmCandidateGenerator,
  FallbackSituationStrategy,
  FallbackCandidateGenerator,
  RuleBasedCandidateGenerator,
  SenderAwareCandidateGenerator,
  CompositeCandidateGenerator,
} from '@skytwin/decision-engine';
import { buildDraftEmailGenerator } from '../draft-email-setup.js';
import { serializeApprovalCandidate } from './approval-candidate.js';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { ExplanationGenerator } from '@skytwin/explanations';
import {
  approvalRepository,
  executionRepository,
  userRepository,
  emailLabelRepository,
  mempalaceRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  decisionRepositoryAdapter,
  explanationRepositoryAdapter,
  policyRepositoryAdapter,
  getPolicyAuthorityRevision,
  inferenceReceiptRepository,
  executionAdmissionRepository,
} from '@skytwin/db';
import type {
  DecisionContext,
  DecisionOutcome,
  CandidateAction,
  ExecutionEvent,
  ExplanationRecord,
  RiskAssessment,
  EpisodicMemory,
} from '@skytwin/shared-types';
import {
  normalizeExecutionEventPayload,
  normalizeExecutionEventType,
  normalizeExecutionError,
  parseAutonomySettings,
  SituationType,
  TrustTier,
} from '@skytwin/shared-types';
import { emitInferenceReceipt, snapshotInferenceTrace } from '@skytwin/llm-client';
import type { InferenceTrace, ReceiptSigningKey } from '@skytwin/llm-client';
import { createLogger } from '@skytwin/core';
import { NoRequestExecutionError } from '@skytwin/execution-router';
import { generateKeyPairSync } from 'node:crypto';

const log = createLogger('api:events');
import { WorkflowHandlerRegistry } from '../workflows/registry.js';
import { processCalendarConflict } from '../workflows/calendar-conflict.js';
import { processSubscriptionRenewal } from '../workflows/subscription-renewal.js';
import { processGroceryReorder } from '../workflows/grocery-reorder.js';
import { processTravelDecision } from '../workflows/travel-decision.js';
import { getExecutionRouter } from '../execution-setup.js';
import {
  isAwarenessOnly,
  awarenessDispositionGateEnabled,
} from '../services/awareness-disposition.js';
import { recordMcpActionSpend } from '../mcp-action-spend.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';
import { sseManager } from '../sse.js';
import { validateEventIngest } from '../validators/event-ingest.js';
import { getMemoryPortForUser } from '../memory-setup.js';
import type { DecisionObject as _DecisionObject } from '@skytwin/shared-types';
import {
  annotateEmailAttributionPreview,
  isOutboundEmailAction,
  prepareEmailActionForExecution,
} from '../email-attribution.js';
import { resolveUserLlmClient } from '../lib/user-llm-client.js';

/**
 * Best-effort: write an inbound raw event into the user's MemoryPort as a
 * RawSignal so future searchSemantic queries can recover it. The default
 * gbrain backend stores it in brain_pages with a vector + tsvector index;
 * mempalace and the stub no-op silently. Errors are caller-swallowed.
 *
 * Why we don't reuse `mempalaceRepository.createSignal` directly: the
 * MemoryPort is the contract every backend implements, and a future swap
 * (e.g. to a remote gbrain MCP server) shouldn't require touching
 * events.ts. Calling MemoryPort.recordSignal preserves that swap point.
 */
async function recordSignalToMemory(
  userId: string,
  decision: _DecisionObject,
  rawEvent: Record<string, unknown>,
): Promise<void> {
  const resolved = await getMemoryPortForUser(userId);
  // Build a stable id deterministic in `decision.id` so the same event
  // can't double-write on retry.
  const data = (rawEvent['data'] as Record<string, unknown> | undefined) ?? rawEvent;
  await resolved.port.recordSignal({
    id: `sig_${decision.id}`,
    source: String(rawEvent['source'] ?? 'unknown'),
    type: String(rawEvent['type'] ?? decision.situationType),
    timestamp: decision.interpretedAt,
    data,
  });
}

/**
 * Create the events router for ingesting raw events.
 */
/**
 * Build an LlmClient from the user's enabled AI provider settings.
 * Returns null if the user has no enabled providers.
 */
let receiptSigningKey: ReceiptSigningKey | undefined;

function getReceiptSigningKey(): ReceiptSigningKey {
  if (receiptSigningKey) return receiptSigningKey;
  const encodedPrivate = process.env['SKYTWIN_RECEIPT_PRIVATE_KEY_BASE64'];
  const encodedPublic = process.env['SKYTWIN_RECEIPT_PUBLIC_KEY_BASE64'];
  const configuredKeyId = process.env['SKYTWIN_RECEIPT_KEY_ID'];
  if ((encodedPrivate || encodedPublic || configuredKeyId) &&
      !(encodedPrivate && encodedPublic && configuredKeyId)) {
    throw new Error('Receipt signing configuration requires key ID, public key, and private key together');
  }
  if (encodedPrivate && encodedPublic && configuredKeyId) {
    receiptSigningKey = {
      keyId: configuredKeyId,
      privateKeyPem: Buffer.from(encodedPrivate, 'base64').toString('utf8'),
      publicKeyPem: Buffer.from(encodedPublic, 'base64').toString('utf8'),
    };
    return receiptSigningKey;
  }
  const pair = generateKeyPairSync('ed25519');
  receiptSigningKey = {
    keyId: `ephemeral-${crypto.randomUUID()}`,
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  return receiptSigningKey;
}

export function createEventsRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);

  /**
   * GET /api/events/stream/:userId
   *
   * Server-Sent Events stream for live notifications.
   * Sends: decision:executed, approval:new, twin:updated
   */
  router.get('/stream/:userId', (req, res) => {
    const { userId } = req.params;
    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
      return;
    }

    sseManager.addConnection(userId, res);

    req.on('close', () => {
      sseManager.removeConnection(userId, res);
    });
  });

  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());
  const policyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);
  const explanationGenerator = new ExplanationGenerator(explanationRepositoryAdapter);
  // Issue #122: per-user (sender, label) hints for the email-triage candidate
  // generator. Wraps emailLabelRepository in the LabelInferencePort shape so
  // the decision-engine doesn't depend on @skytwin/db directly.
  const labelInferencePort = {
    async topLabelsForSender(userId: string, sender: string, limit?: number) {
      return emailLabelRepository.topLabelsForSender(userId, sender, limit);
    },
    async topLabelsForListId(userId: string, listId: string, limit?: number) {
      return emailLabelRepository.topLabelsForListId(userId, listId, limit);
    },
  };
  // Rule-based fallbacks (always available). The DecisionMaker constructor
  // takes an optional CandidateGenerator — when an LLM client is not
  // configured we wrap the built-in rule-based generator with the
  // sender-aware safety pre-pass so board / investor / legal / CFO emails
  // never auto-archive even at MODERATE_AUTONOMY+ trust tiers. See
  // packages/decision-engine/src/strategies/sender-aware-candidates.ts.
  const ruleBasedInterpreter = new SituationInterpreter();
  const baseRuleBasedDecisionMaker = new DecisionMaker(
    twinService,
    policyEvaluator,
    decisionRepositoryAdapter,
    undefined,
    labelInferencePort,
  );
  const senderAwareGenerator = new SenderAwareCandidateGenerator(baseRuleBasedDecisionMaker);
  const ruleBasedDecisionMaker = new DecisionMaker(
    twinService,
    policyEvaluator,
    decisionRepositoryAdapter,
    senderAwareGenerator,
    labelInferencePort,
  );
  // Set up workflow registry
  const workflowRegistry = new WorkflowHandlerRegistry();
  workflowRegistry.register(SituationType.CALENDAR_CONFLICT, processCalendarConflict);
  workflowRegistry.register(SituationType.SUBSCRIPTION_RENEWAL, processSubscriptionRenewal);
  workflowRegistry.register(SituationType.GROCERY_REORDER, processGroceryReorder);
  workflowRegistry.register(SituationType.TRAVEL_DECISION, processTravelDecision);

  const getRouter = () => getExecutionRouter();

  /**
   * POST /api/events/ingest
   *
   * Receive a raw event, interpret it, run through the decision pipeline,
   * and return the outcome.
   */
  router.post('/ingest', async (req, res, next) => {
    try {
      // Validate the request body against the documented event-ingest contract
      // BEFORE handing it to the interpreter. Catches malformed payloads at
      // the boundary instead of failing later with a TypeError. Also blocks
      // caller-supplied trustTier (must come from the user record).
      const validation = validateEventIngest(req.body);
      if (!validation.ok) {
        res.status(400).json({
          error: 'Invalid event payload',
          details: validation.errors,
        });
        return;
      }
      const rawEvent = validation.event;
      const userId = validation.userId;

      // Resolve every known duplicate before interpretation. A finalized row
      // can resume only its durable continuation; an incomplete row cannot be
      // reconstructed from request-local traces and therefore fails closed.
      const signalId = typeof rawEvent['signalId'] === 'string' &&
        rawEvent['signalId'].trim().length > 0
        ? rawEvent['signalId']
        : null;
      let preExistingDecision: _DecisionObject | null = null;
      let preExistingIngestState: Awaited<ReturnType<
        typeof inferenceReceiptRepository.getContinuationForDecision
      >> = null;
      if (signalId && decisionRepositoryAdapter.findBySignalId) {
        const existing = await decisionRepositoryAdapter.findBySignalId(userId, signalId);
        if (existing) {
          preExistingDecision = existing;
          preExistingIngestState = await inferenceReceiptRepository.getContinuationForDecision(
            userId,
            existing.id,
          );
          // Completed inference traces exist only in request memory until the
          // atomic finalization transaction. If that attempt stopped after the
          // decision row was written, a retry cannot reconstruct the complete
          // causative batch and must not invent a new one from partial history.
          if (!preExistingIngestState?.receiptCaptureComplete) {
            res.status(409).json({
              code: 'INFERENCE_RECEIPT_RECOVERY_REQUIRED',
              error: 'Decision receipt capture is incomplete; recovery is required',
              decisionId: existing.id,
            });
            return;
          }
        }
      }

      // 0. The persisted mode and provider snapshot are resolved atomically by
      // the sole per-user composition root. Its trace callback observes every
      // completed call made by interpretation, candidate generation, or drafts.
      const traces: InferenceTrace[] = [];
      const llmResolution = preExistingDecision
        ? null
        : await resolveUserLlmClient(userId, {
            // Take ownership immediately. Returned response provenance and a
            // callback-visible trace must never share mutable receipt input.
            onInferenceTrace: (trace) => traces.push(snapshotInferenceTrace(trace)),
          });
      const receiptAwareLlm = llmResolution?.state === 'ready'
        ? { client: llmResolution.client, traces, mode: llmResolution.mode }
        : null;
      const llmClient = receiptAwareLlm?.client ?? null;

      let interpreter: SituationInterpreter;
      let decisionMaker: DecisionMaker;

      // Optional dark-deploy: the draft-email candidate generator (#283)
      // runs alongside the primary strategy when SKYTWIN_DRAFTS_ENABLED=true
      // AND the user has an LLM client. Returns null otherwise — no
      // construction cost, no memory roundtrip — so the default-off path
      // adds nothing to ingestion latency.
      const draftGen = await buildDraftEmailGenerator(userId, llmClient);

      if (llmClient && llmClient.hasProviders) {
        const llmSituation = new LlmSituationStrategy(llmClient);
        const llmCandidates = new LlmCandidateGenerator(llmClient);
        // The LLM fallback path uses the sender-aware rule-based generator
        // so if the LLM call fails (network / quota / parse error), the
        // safety pre-pass for protected senders still runs. RuleBasedCandidateGenerator
        // wraps a DecisionMaker; we pass the sender-aware-wrapped one.
        const ruleBasedCandidates = new RuleBasedCandidateGenerator(ruleBasedDecisionMaker);
        const situationStrategy = new FallbackSituationStrategy(llmSituation, ruleBasedInterpreter);
        const primaryCandidates = new FallbackCandidateGenerator(llmCandidates, ruleBasedCandidates);
        // Composite runs the primary strategy AND the draft generator (when
        // present) in parallel; the engine's scoring layer picks across the
        // merged candidate list. When draftGen is null the composite is a
        // single-generator passthrough.
        const candidateStrategy = draftGen
          ? new CompositeCandidateGenerator([primaryCandidates, draftGen])
          : primaryCandidates;
        interpreter = new SituationInterpreter(situationStrategy);
        decisionMaker = new DecisionMaker(
          twinService,
          policyEvaluator,
          decisionRepositoryAdapter,
          candidateStrategy,
          labelInferencePort,
        );
      } else {
        // Rule-based path: still compose with the draft generator when
        // active — draft generation does not depend on a primary LLM
        // strategy, only on the user having ANY LLM client (which
        // buildDraftEmailGenerator already checked). If draftGen is null
        // (no LLM client at all), this branch is exactly the prior
        // behaviour.
        interpreter = ruleBasedInterpreter;
        if (draftGen) {
          const ruleBasedCandidates = new RuleBasedCandidateGenerator(ruleBasedDecisionMaker);
          const candidateStrategy = new CompositeCandidateGenerator([
            ruleBasedCandidates,
            draftGen,
          ]);
          decisionMaker = new DecisionMaker(
            twinService,
            policyEvaluator,
            decisionRepositoryAdapter,
            candidateStrategy,
            labelInferencePort,
          );
        } else {
          decisionMaker = ruleBasedDecisionMaker;
        }
      }

      let decision: _DecisionObject;
      let decisionCreated: boolean;
      if (preExistingDecision) {
        decision = preExistingDecision;
        decisionCreated = false;
      } else {
        // 1. Interpret the raw event
        decision = await interpreter.interpret(rawEvent);

        // 1b. Persist the decision to DB so foreign keys (outcomes, candidates) work.
        // `decisionCreated` is false when the row was already persisted for this
        // (user_id, signal_id) — a re-ingestion. Callers gate side-effects on it
        // so duplicate ingests don't re-fire UI notifications etc.
        const saved = await decisionRepositoryAdapter.saveDecision(decision);
        decision = saved.decision;
        decisionCreated = saved.created;

        // A concurrent request can win between the preflight and INSERT. The
        // interpretation just completed against an unpersisted request-local
        // object, so it must not be attached to the winner's canonical row.
        // A finalized winner can follow the normal resume/suppress path; an
        // incomplete winner requires a fresh retry that starts at preflight.
        if (!decisionCreated) {
          const racedState = await inferenceReceiptRepository.getContinuationForDecision(
            userId,
            decision.id,
          );
          if (!racedState?.receiptCaptureComplete) {
            res.status(409).json({
              error: 'Decision ingestion is already in progress; retry the signal',
            });
            return;
          }
          preExistingIngestState = racedState;
        }
      }

      const canonicalRawEvent = decision.rawData ?? rawEvent;

      let resumedAfterReceiptCapture: {
        outcome: DecisionOutcome;
        explanation: ExplanationRecord;
      } | null = null;

      // 1c. Re-ingestion short-circuit. When `decisionCreated` is false the
      // (user_id, signal_id) was already evaluated on a prior ingest — the
      // decision row, candidate_actions, decision_outcome, and any approval
      // request already exist. Running the rest of the pipeline would:
      //
      //   - stack new candidate_actions rows (their UUIDs are fresh, so the
      //     unique-on-id guard doesn't dedupe them),
      //   - overwrite the prior `decision_outcomes` row via its
      //     ON CONFLICT (decision_id) DO UPDATE — losing the original
      //     audit trail if policy/patterns shifted between ingestions,
      //   - on the auto-execute path, run the action a SECOND time
      //     (a real send-the-email-twice bug for users at trust tiers
      //     that auto-execute; observer/suggest are already gated by the
      //     approval-row idempotency from #289).
      //
      // Only a finalized continuation can reach this branch. From it, resume
      // idempotent approval/informational work or a one-time ready→running
      // execution claim; never reconstruct a missing receipt batch.
      if (!decisionCreated) {
        const ingestState = preExistingDecision || preExistingIngestState
          ? preExistingIngestState
          : await inferenceReceiptRepository.getContinuationForDecision(userId, decision.id);
        // Outcome and explanation come only from the atomically persisted,
        // self-consistent continuation snapshot. Never combine guard authority
        // with mutable rows fetched independently after finalization.
        const previousOutcome = ingestState?.continuation?.outcome ?? null;
        const previousExplanation = ingestState?.continuation?.explanation ?? null;
        // An approval created by a fail-closed auto-execution escalation also
        // blocks a later ready-state resume, even though the stored outcome
        // itself still says autoExecute.
        const previousApproval = previousOutcome
          ? await approvalRepository.findByDecisionId(decision.id, userId)
          : null;
        const persistedDisposition = previousOutcome?.selectedAction
          ? await executionAdmissionRepository.findReceiptExecutionDisposition(
              userId,
              decision.id,
              previousOutcome.selectedAction.id,
            )
          : null;
        // Terminal truth comes only from the guard transition bound to the
        // exact owner/decision/action plan. A standalone execution_result may
        // have committed while terminalization's response was false or lost.
        const executionTerminal = persistedDisposition
          ? {
              status: persistedDisposition.status,
              planId: ingestState?.sourceExecutionPlanId ?? null,
              error: persistedDisposition.reason,
              explanationId: persistedDisposition.explanationId,
            }
          : ingestState?.sourceExecutionStatus && (
          ingestState.effectState === 'completed' ||
          ingestState.effectState === 'failed' ||
          ingestState.effectState === 'restored_non_replay'
        )
          ? { status: ingestState.sourceExecutionStatus, planId: ingestState.sourceExecutionPlanId }
          : ingestState?.effectState === 'running' || ingestState?.effectState === 'restored_non_replay'
            ? { status: 'ambiguous' as const, planId: ingestState.sourceExecutionPlanId }
            : null;
        const captured = ingestState?.receiptCaptureComplete === true;
        const resumeApproval = captured && previousOutcome?.requiresApproval &&
          previousApproval === null && previousExplanation !== null &&
          ingestState.continuationKind === 'approval' && ingestState.effectState === 'non_effect';
        const resumeExecution = captured && previousOutcome?.autoExecute &&
          previousApproval === null && previousExplanation !== null &&
          ingestState.continuationKind === 'auto_execute' &&
          ingestState.effectState === 'ready';
        const resumeNonEffect = captured && previousOutcome !== null &&
          !previousOutcome.requiresApproval && !previousOutcome.autoExecute &&
          previousExplanation !== null && ingestState.continuationKind === 'non_effect' &&
          ingestState.effectState === 'non_effect';

        if (resumeApproval || resumeExecution || resumeNonEffect) {
          resumedAfterReceiptCapture = {
            outcome: {
              ...previousOutcome,
              ...(resumeApproval
                ? { confirmationLevel: ingestState.confirmationLevel ?? 'dual' }
                : {}),
            },
            explanation: previousExplanation,
          };
          log.info('Resuming post-receipt work for re-ingested signal', {
            userId,
            decisionId: decision.id,
            effectState: ingestState.effectState,
            operation: resumeApproval ? 'approval' : resumeExecution ? 'execution_claim' : 'non_effect',
          });
        } else if (ingestState && (
          ingestState.effectState === 'restored_non_replay' ||
          ingestState.effectState === 'running' ||
          ingestState.effectState === 'completed' ||
          ingestState.effectState === 'failed' || captured
        )) {
          log.info('Suppressed pipeline for re-ingested signal', {
            userId,
            decisionId: decision.id,
            hadApproval: previousApproval !== null,
            hadExplanation: previousExplanation !== null,
            requiredApproval: previousOutcome?.requiresApproval ?? null,
            autoExecuted: previousOutcome?.autoExecute ?? null,
            effectState: ingestState.effectState,
            executionStatus: executionTerminal?.status ?? null,
          });
          res.json({
            decision: {
              id: decision.id,
              situationType: decision.situationType,
              domain: decision.domain,
              urgency: decision.urgency,
              summary: decision.summary,
            },
            outcome: previousOutcome ? {
              selectedAction: previousOutcome.selectedAction
                ? {
                    actionType: previousOutcome.selectedAction.actionType,
                    description: previousOutcome.selectedAction.description,
                  }
                : null,
              autoExecute: previousOutcome.autoExecute,
              requiresApproval: previousOutcome.requiresApproval,
              reasoning: persistedDisposition?.reason ?? previousOutcome.reasoning,
            } : null,
            explanation: previousExplanation
              ? {
                  summary: persistedDisposition?.summary ?? previousExplanation.summary,
                  riskTier: persistedDisposition?.riskTier ?? previousExplanation.riskTier,
                  confidence: previousExplanation.overallConfidence,
                }
              : null,
            // Execution surfaces the persisted terminal status when the
            // previous run was auto-execute. For non-autoExecute outcomes
            // there is no plan to reference, so it's null.
            execution: executionTerminal,
            approval: previousApproval
              ? { id: previousApproval.id, status: previousApproval.status }
              : null,
            reIngested: true,
            replaySuppressed: ingestState.effectState === 'restored_non_replay' ||
              ingestState.effectState === 'running' || persistedDisposition !== null,
          });
          return;
        } else {
          log.warn('Stopped re-ingestion without durable receipt completion', {
            userId,
            decisionId: decision.id,
            previousOutcomePresent: previousOutcome !== null,
            previousOutcomeAutoExecute: previousOutcome?.autoExecute ?? null,
            ingestState: ingestState?.effectState ?? null,
          });
          res.status(409).json({
            code: 'INFERENCE_RECEIPT_RECOVERY_REQUIRED',
            error: 'Decision receipt capture is incomplete; recovery is required',
            decisionId: decision.id,
          });
          return;
        }
      }

      // 2. Get user record (trust tier must come from DB, never from caller)
      const user = await userRepository.findById(userId);

      let outcome: DecisionOutcome;
      let explanation: ExplanationRecord;
      if (resumedAfterReceiptCapture) {
        outcome = resumedAfterReceiptCapture.outcome;
        explanation = resumedAfterReceiptCapture.explanation;
      } else {

      // 3. Get the twin profile (used internally for preferences)
      await twinService.getOrCreateProfile(userId);

      // 4. Get relevant preferences
      const preferences = await twinService.getRelevantPreferences(
        userId,
        decision.domain,
        decision.summary,
      );

      // 5. Fetch patterns, traits, temporal profile, and episodic memories
      // for richer scoring. Episodes seed the DecisionMaker.scoreCandidate
      // boost (decision-maker.ts:1285+) so past similar decisions with high
      // utility nudge their action up the rankings — closing the
      // memory-feeds-decisions loop. Episodes come from the mempalace table
      // which is the legacy backing store and remains valid regardless of
      // which gbrain backend the user has selected.
      const [patterns, traits, temporalProfile, episodeRows] = await Promise.all([
        twinService.getPatterns(userId),
        twinService.getTraits(userId),
        twinService.getTemporalProfile(userId),
        mempalaceRepository.getEpisodes(userId, {
          domain: decision.domain,
          situationType: decision.situationType,
          limit: 10,
        }).catch(() => []),
      ]);

      const episodicMemories: EpisodicMemory[] = episodeRows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        situationSummary: row.situation_summary,
        domain: row.domain,
        situationType: row.situation_type,
        contextSnapshot:
          typeof row.context_snapshot === 'string'
            ? (JSON.parse(row.context_snapshot) as EpisodicMemory['contextSnapshot'])
            : ((row.context_snapshot as EpisodicMemory['contextSnapshot']) ?? {}),
        actionTaken: row.action_taken ?? undefined,
        outcome: undefined,
        feedbackType: row.feedback_type as EpisodicMemory['feedbackType'],
        feedbackDetail: row.feedback_detail ?? undefined,
        decisionId: row.decision_id ?? undefined,
        signalIds: row.signal_ids ?? [],
        drawerIds: row.drawer_ids ?? [],
        utilityScore: typeof row.utility_score === 'number' ? row.utility_score : Number(row.utility_score),
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
      }));

      // 6. Build decision context
      const context: DecisionContext = {
        userId,
        decision,
        trustTier: user?.trust_tier as TrustTier ?? TrustTier.OBSERVER,
        relevantPreferences: preferences,
        timestamp: new Date(),
        patterns,
        traits,
        temporalProfile,
        episodicMemories,
        // Per-user autonomy settings must travel with the context: the
        // policy evaluator's pause kill switch (#379), domain allowlist,
        // per-action spend cap, cost-unknown escalation (#372),
        // requireApprovalForIrreversible, and quiet hours are all gated on
        // this argument being present. Missing user row → conservative
        // defaults (no spend, approval for irreversible), which matches the
        // OBSERVER tier we fall back to on the line above.
        autonomySettings: parseAutonomySettings(user?.autonomy_settings),
      };

      // 6b. Best-effort: write the inbound signal into the gbrain memory
      // backend so future searchSemantic queries can recover it. Without
      // this, brain_pages stays empty in production for every signal that
      // doesn't go through an explicit `MemoryPort.recordSignal` caller —
      // which is to say, all of them, since events.ts is the entry point.
      // This is the production path for the "twin remembers what happened"
      // promise. Failures are swallowed so a memory-layer hiccup never
      // blocks the decision pipeline.
      void recordSignalToMemory(userId, decision, canonicalRawEvent)
        .then(() => {
          // Tell the dashboard a page was indexed so it refreshes the
          // counts + recent-episodes block without polling.
          sseManager.emit(userId, 'memory:page-indexed', {
            decisionId: decision.id,
            source: canonicalRawEvent['source'] ?? 'unknown',
            type: canonicalRawEvent['type'] ?? decision.situationType,
          });
        })
        .catch((err) => {
          log.warn('Failed to record inbound signal into memory backend', {
            userId,
            decisionId: decision.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      // 7. Evaluate through decision maker
      outcome = await decisionMaker.evaluate(context);

      // Execution-time email semantics are materially different from a draft:
      // sending is irreversible, changes the action type, and appends visible
      // attribution. Prepare every possible outbound candidate and run the
      // complete risk/policy/ranking pass again before outcome persistence,
      // explanation generation, and receipt capture. Credentials are excluded
      // here and materialized inside the built-in handler only after the final
      // one-shot dispatch claim.
      if (outcome.autoExecute && outcome.selectedAction &&
          isOutboundEmailAction(outcome.selectedAction.actionType)) {
        for (const candidate of outcome.allCandidates) {
          if (isOutboundEmailAction(candidate.actionType)) {
            prepareEmailActionForExecution(candidate, user);
          }
        }
        outcome = await decisionMaker.reevaluatePreparedCandidates(
          context,
          outcome.allCandidates,
        );
      }

      // 8. Generate explanation
      explanation = await explanationGenerator.generate(
        decision,
        outcome,
        context,
      );

      const awarenessOnly = outcome.requiresApproval && !!outcome.selectedAction &&
        isAwarenessOnly(decision, outcome);
      if (awarenessOnly) {
        log.info('Awareness-disposition candidate', {
          decisionId: decision.id,
          situationType: decision.situationType,
          actionType: outcome.selectedAction?.actionType,
          gateEnabled: awarenessDispositionGateEnabled(),
        });
      }
      if (awarenessOnly && awarenessDispositionGateEnabled()) {
        outcome.requiresApproval = false;
        await decisionRepositoryAdapter.saveOutcome(outcome);
      }

      // An LLM-backed decision cannot proceed to approval or execution until
      // every completed inference has a receipt linked to its real explanation.
      // The repository inserts the batch atomically and derives ownership from
      // the decision. Raw bytes remain in transient request memory until their
      // references are released; the repository never persists them.
      {
        const signingKey = getReceiptSigningKey();
        const inputs = (receiptAwareLlm?.traces ?? []).map((trace) => {
          // Decision-event provider settings currently expose only conventional
          // cloud and local runtimes. Confidential mode must arrive through a
          // separately configured verifier + pinned trust-root integration;
          // never bootstrap trust from fields returned by the verifier itself.
          if (trace.execution.reasoningMode === 'verified_private_cloud' || trace.verification) {
            throw new Error('Confidential receipt emission is not configured for decision events');
          }
          const bundle = emitInferenceReceipt(trace, {
            userId,
            decisionId: decision.id,
            explanationId: explanation.id,
          }, signingKey);
          return {
            bundle,
            trustedRecorderKeys: new Map([[signingKey.keyId, signingKey.publicKeyPem]]),
          };
        });
        const persisted = await inferenceReceiptRepository.createManyForUser(userId, inputs, {
          decisionId: decision.id,
          explanationId: explanation.id,
          continuationKind: outcome.requiresApproval && outcome.selectedAction
            ? 'approval'
            : outcome.autoExecute && outcome.selectedAction ? 'auto_execute' : 'non_effect',
          confirmationLevel: outcome.requiresApproval && outcome.selectedAction
            ? outcome.confirmationLevel === 'dual' ? 'dual' : 'single'
            : null,
          continuation: { outcome, explanation },
        });
        if (!persisted || persisted.receipts.length !== inputs.length) {
          throw new Error('Inference receipts could not be persisted; decision execution stopped');
        }
        outcome = persisted.continuation.outcome;
        explanation = persisted.continuation.explanation;
      }
      }

      // 9. Handle outcome
      let executionResult = null;
      let approvalRequest = null;
      // `approvalNewlyCreated` distinguishes a first-time approval row from
      // one returned by ON CONFLICT (decision_id) DO NOTHING on a re-ingested
      // signal. Used downstream to gate the `approval:new` SSE emit so a
      // duplicate ingestion is silent end-to-end (DB no-op + UI no-op),
      // not just at the DB level.
      let approvalNewlyCreated = false;

      // Awareness disposition (#601). Routine awareness signals — newsletters,
      // automated notices, the user's own re-ingested sent mail, calendar
      // updates — select a passive, reversible, zero-cost action and at observer
      // tier would each become an approval card AND a "needs you" digest to-do.
      // When the gate is on we dispose them as awareness: the decision and
      // explanation are still persisted, but the outcome is flipped to
      // requires_approval=false so NO approval row + approval:new SSE is created
      // and the digest's needsYou() (which reads requires_approval) shows it
      // under FYI, not To-dos. Never gates an injection-guard escalation (see
      // isAwarenessOnly). Phase 0 logs the candidate with no behaviour change;
      // Phase 1 (AWARENESS_DISPOSITION_GATE=on, default off) does the suppression.
      if (outcome.requiresApproval && outcome.selectedAction) {
        // Create an approval request so the user can review it. We include
        // `parameters` here so the dashboard can render *what specifically*
        // is being proposed (e.g. which Gmail label, which calendar id, the
        // draft body) — without it the approval card asks the user to
        // approve a generic "Apply label to the email" with no way to know
        // what label the twin chose. Sensitive params are filtered:
        // `accessToken` is only injected at execute time and shouldn't be
        // round-tripped through the approval payload, and oversized free-
        // form fields like `rawData` echoed back from the original signal
        // are dropped to keep the JSONB row small.
        const {
          accessToken: _omitToken,
          rawData: _omitRawData,
          ...visibleParameters
        } = (outcome.selectedAction.parameters ?? {}) as Record<string, unknown>;
        const approvalVisibleParameters = isOutboundEmailAction(outcome.selectedAction.actionType)
          ? annotateEmailAttributionPreview(visibleParameters, user)
          : visibleParameters;

        const approvalResult = await approvalRepository.create({
          userId,
          decisionId: decision.id,
          // Single serializer (approval-candidate.ts) keeps the safety fields —
          // costZeroIntent / provenance / the #371 id linkage — from drifting.
          candidateAction: serializeApprovalCandidate(outcome.selectedAction, approvalVisibleParameters),
          reason: outcome.reasoning,
          urgency: decision.urgency,
          // The injection guard sets `dual` for extreme-severity actions —
          // the approval then needs two token-gated confirmations.
          confirmationLevel: outcome.confirmationLevel === 'dual' ? 'dual' : 'single',
        });
        approvalRequest = approvalResult.row;
        approvalNewlyCreated = approvalResult.created;
      } else if (outcome.autoExecute && outcome.selectedAction) {
        // Risk assessment for routing must be the one the decision-maker
        // actually computed (#371) — never a fresh synthetic one derived
        // from `explanation.riskTier`. The flat enum collapses every
        // dimension into a single tier and a candidate the decision-maker
        // assessed as HIGH on financial impact would have leaked through
        // routed as LOW. The decision-maker attached the selected
        // candidate's per-dimension assessment to `outcome.riskAssessment`
        // at packages/decision-engine/src/decision-maker.ts:263. Fall back
        // to the persisted-by-actionId record only if the in-memory field
        // is absent (defensive — shouldn't happen on the autoExecute path
        // since selectedAction implies a non-null assessment). If neither
        // is available, escalate to manual approval inside the if-null
        // branch below — never run with a fabricated LOW assessment.
        const riskAssessment: RiskAssessment | null = outcome.riskAssessment
          ?? await decisionRepositoryAdapter.getRiskAssessment(
            outcome.selectedAction.id,
          );

        if (!riskAssessment) {
          log.warn('Auto-execute blocked: no persisted risk assessment for selected action — escalating to approval (#371)', {
            decisionId: decision.id,
            actionId: outcome.selectedAction.id,
          });
          const {
            accessToken: _omitTokenEsc,
            rawData: _omitRawDataEsc,
            ...visibleParametersEsc
          } = (outcome.selectedAction.parameters ?? {}) as Record<string, unknown>;
          const approvalVisibleParametersEsc = isOutboundEmailAction(outcome.selectedAction.actionType)
            ? annotateEmailAttributionPreview(visibleParametersEsc, user)
            : visibleParametersEsc;
          const escalationResult = await inferenceReceiptRepository.escalateExecutionToApproval({
            userId,
            decisionId: decision.id,
            continuation: { outcome, explanation },
            candidateAction: serializeApprovalCandidate(outcome.selectedAction, approvalVisibleParametersEsc),
            reason: 'Auto-execute path could not verify a persisted risk assessment for this candidate. Escalated to manual approval to fail closed (#371).',
            urgency: decision.urgency,
            confirmationLevel: 'single',
          });
          if (escalationResult) {
            approvalRequest = escalationResult.row;
            approvalNewlyCreated = escalationResult.created;
          } else {
            const state = await inferenceReceiptRepository.getContinuationForDecision(userId, decision.id);
            executionResult = { status: 'ambiguous', planId: state?.sourceExecutionPlanId ?? null };
          }
        } else {
          const executionRouter = await getRouter();
          let prepared: Awaited<ReturnType<typeof executionRouter.prepareExecution>> | null = null;
          try {
            prepared = await executionRouter.prepareExecution(
              outcome.selectedAction,
              riskAssessment,
              userId,
              { streaming: true, ironclawChannel: user?.ironclaw_channel ?? undefined },
            );
          } catch (error) {
            const provenNoRequest = error instanceof NoRequestExecutionError;
            const disposition = await executionAdmissionRepository.recordReceiptPreparationDisposition({
              userId,
              decisionId: decision.id,
              actionId: outcome.selectedAction.id,
              ambiguous: !provenNoRequest,
              reason: provenNoRequest
                ? normalizeExecutionError(error)
                : 'Adapter preparation outcome could not be classified before dispatch.',
            });
            if (disposition) {
              executionResult = {
                status: disposition.status,
                planId: null,
                error: disposition.reason,
              };
            } else {
              const state = await inferenceReceiptRepository.getContinuationForDecision(userId, decision.id);
              executionResult = { status: 'ambiguous', planId: state?.sourceExecutionPlanId ?? null };
            }
          }
          if (prepared) {
          const executionRisk = prepared.riskAssessment;
          let currentAuthorityRevision: string | null = null;
          let currentPolicyAuthorityRevision: string | null = null;
          let currentIronclawChannel: string | null = null;
          const evaluateCurrentExecutionPolicy = async () => {
            currentAuthorityRevision = null;
            currentPolicyAuthorityRevision = null;
            currentIronclawChannel = null;
            const currentUser = await userRepository.findById(userId);
            if (!currentUser) return {
              allowed: false,
              requiresApproval: true,
              reason: 'Execution owner no longer exists.',
            };
            currentAuthorityRevision = currentUser.execution_authority_revision;
            currentIronclawChannel = currentUser.ironclaw_channel;
            currentPolicyAuthorityRevision = await getPolicyAuthorityRevision();
            const currentPolicies = await policyRepositoryAdapter.getAllPolicies();
            return new PolicyEvaluator(policyRepositoryAdapter).evaluate(
              outcome.selectedAction!,
              currentPolicies,
              currentUser.trust_tier as TrustTier,
              executionRisk,
              parseAutonomySettings(currentUser.autonomy_settings),
            );
          };

          // Receipt capture proves what policy said then; it is not a lease on
          // future authority. Re-evaluate current user/operator pause and all
          // current policies immediately before consuming ready authority.
          const claimPolicy = await evaluateCurrentExecutionPolicy();
          let preparedRiskSettledWithoutEffect = false;
          if (!claimPolicy.allowed) {
            const {
              accessToken: _omitDeniedToken,
              rawData: _omitDeniedRawData,
              ...deniedVisibleParameters
            } = outcome.selectedAction.parameters as Record<string, unknown>;
            const denial = await executionAdmissionRepository.recordPolicyDenial({
              scope: 'receipt',
              userId,
              decisionId: decision.id,
              actionId: outcome.selectedAction.id,
              adapterName: prepared.adapterName,
              actionSnapshot: {
                decisionId: decision.id,
                ...serializeApprovalCandidate(outcome.selectedAction, deniedVisibleParameters),
              },
              riskSnapshot: executionRisk as unknown as Record<string, unknown>,
              policySnapshot: claimPolicy as unknown as Record<string, unknown>,
              reason: claimPolicy.reason,
            });
            if (!denial) {
              throw new Error('Prepared execution denial evidence could not be persisted');
            }
            executionResult = {
              status: 'blocked',
              planId: null,
              error: typeof denial.evidence['reason'] === 'string'
                ? denial.evidence['reason']
                : 'The prepared execution path was blocked by current policy.',
            };
            preparedRiskSettledWithoutEffect = true;
          } else if (claimPolicy.requiresApproval) {
            const {
              accessToken: _omitPreparedToken,
              rawData: _omitPreparedRawData,
              ...preparedVisibleParameters
            } = outcome.selectedAction.parameters as Record<string, unknown>;
            const visibleParameters = isOutboundEmailAction(outcome.selectedAction.actionType)
              ? annotateEmailAttributionPreview(preparedVisibleParameters, user)
              : preparedVisibleParameters;
            const escalation = await inferenceReceiptRepository.escalateExecutionToApproval({
              userId,
              decisionId: decision.id,
              continuation: { outcome, explanation },
              candidateAction: serializeApprovalCandidate(outcome.selectedAction, visibleParameters),
              reason: `The prepared ${prepared.adapterName} execution path requires approval: ${claimPolicy.reason}`,
              urgency: decision.urgency,
              confirmationLevel: claimPolicy.confirmationLevel ?? 'single',
              dispatch: {
                adapterName: prepared.adapterName,
                riskSnapshot: executionRisk as unknown as Record<string, unknown>,
                policySnapshot: claimPolicy as unknown as Record<string, unknown>,
              },
            });
            if (escalation) {
              approvalRequest = escalation.row;
              approvalNewlyCreated = escalation.created;
              preparedRiskSettledWithoutEffect = true;
            }
          }
          // This compare-and-set is the only autonomous dispatch authority.
          // A lost commit response leaves `running`, which retries never replay.
          let savedPlan: { id: string; dispatchAuthorityUpdatedAt: Date } | null = null;
          const executionSteps = [{ type: outcome.selectedAction.actionType, status: 'pending' }];
          if (claimPolicy.allowed && !claimPolicy.requiresApproval) try {
            savedPlan = await inferenceReceiptRepository.claimExecutionForDecision(
              userId,
              decision.id,
              { outcome, explanation },
              executionSteps,
              claimPolicy as unknown as Record<string, unknown>,
              {
                executionPlanId: prepared.planId,
                adapterName: prepared.adapterName,
                riskSnapshot: executionRisk as unknown as Record<string, unknown>,
              },
            );
          } catch (error) {
            // A commit may have succeeded even when its response was lost.
            // Treat the claim as consumed until the persisted guard proves
            // otherwise; never dispatch on an exception.
            log.warn('Execution claim response was ambiguous', {
              userId,
              decisionId: decision.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          if (!savedPlan && !preparedRiskSettledWithoutEffect) {
            const state = await inferenceReceiptRepository.getContinuationForDecision(userId, decision.id);
            executionResult = { status: 'ambiguous', planId: state?.sourceExecutionPlanId ?? null };
          } else if (savedPlan) {

          // The claim transaction created and bound this exact DB plan before
          // dispatch, so every streamed event and terminal result has one
          // immutable execution identity.
          const executionAction: CandidateAction = {
            ...outcome.selectedAction,
            parameters: {
              ...outcome.selectedAction.parameters,
              executionPlanId: savedPlan.id,
              credentialAuthorityRevision: currentAuthorityRevision,
              credentialPolicyAuthorityRevision: currentPolicyAuthorityRevision,
              dispatchAuthorityId: decision.id,
              dispatchAuthorityUpdatedAt: savedPlan.dispatchAuthorityUpdatedAt.toISOString(),
            },
          };
          let terminalEvent: ExecutionEvent | null = null;
          let terminalStatus: 'completed' | 'failed' | null = null;
          let preDispatchClosed = false;
          const stepOutputs: Array<{ stepId?: string; eventType: string; payload: Record<string, unknown> }> = [];
          const admittedStepIds = executionSteps.map((_step, index) => `step-${index + 1}`);
          let nextAdmittedStepIndex = 0;
          let activeAdmittedStepId: string | null = null;
          let terminalPayload: Record<string, unknown> = {};

          let preDispatchFailure: string | null = null;
          try {
            const dispatchPolicy = await evaluateCurrentExecutionPolicy();
            if (!dispatchPolicy.allowed || dispatchPolicy.requiresApproval) {
              preDispatchFailure = `Current policy no longer permits automatic dispatch: ${dispatchPolicy.reason}`;
            } else if (!await inferenceReceiptRepository.isExecutionDispatchableForDecision(
              userId,
              decision.id,
              savedPlan.id,
              { outcome, explanation },
              executionSteps,
              dispatchPolicy as unknown as Record<string, unknown>,
              {
                executionPlanId: prepared.planId,
                adapterName: prepared.adapterName,
                riskSnapshot: executionRisk as unknown as Record<string, unknown>,
              },
            )) {
              preDispatchFailure = 'Execution owner or receipt authority was revoked before dispatch';
            }
          } catch (error) {
            preDispatchFailure = error instanceof Error ? error.message : String(error);
          }

          if (preDispatchFailure) {
            try {
              const recorded = await inferenceReceiptRepository
                .markExecutionFailedBeforeDispatchForDecision(
                  userId, decision.id, savedPlan.id, preDispatchFailure,
                );
              executionResult = recorded
                ? { status: 'failed', planId: savedPlan.id }
                : { status: 'ambiguous', planId: savedPlan.id };
            } catch {
              executionResult = { status: 'ambiguous', planId: savedPlan.id };
            }
            preDispatchClosed = true;
          } else try {
            for await (const event of executionRouter.executePreparedStreaming(
              prepared,
              executionAction,
              executionRisk,
              userId,
              { ironclawChannel: currentIronclawChannel ?? undefined },
            )) {
              if (event.planId !== savedPlan.id) {
                throw new Error('Execution event did not match the claimed plan');
              }
              const safeEventType = normalizeExecutionEventType(event.eventType);
              let safeStepId: string | undefined;
              if (safeEventType === 'step_started' || safeEventType === 'step_completed' ||
                  safeEventType === 'step_failed') {
                const expectedStepId = admittedStepIds[nextAdmittedStepIndex];
                if (!expectedStepId || event.stepId !== expectedStepId) {
                  throw new Error('Execution adapter emitted an unbound step identity');
                }
                safeStepId = expectedStepId;
                if (safeEventType === 'step_started') {
                  if (activeAdmittedStepId !== null) {
                    throw new Error('Execution adapter emitted overlapping step starts');
                  }
                  activeAdmittedStepId = expectedStepId;
                } else {
                  if (activeAdmittedStepId !== null && activeAdmittedStepId !== expectedStepId) {
                    throw new Error('Execution adapter emitted a result for another active step');
                  }
                  activeAdmittedStepId = null;
                  nextAdmittedStepIndex += 1;
                }
              } else if (event.stepId !== undefined) {
                throw new Error('Execution adapter attached a step identity to a plan event');
              }
              if (safeEventType === 'unknown' ||
                  !(event.timestamp instanceof Date) || Number.isNaN(event.timestamp.getTime())) {
                throw new Error('Execution adapter emitted malformed event identity');
              }
              if (terminalEvent) {
                throw new Error(`Execution stream emitted an event after ${terminalEvent.eventType}`);
              }
              const safePayload = normalizeExecutionEventPayload(event.payload ?? {});
              if (Object.keys(safePayload).length > 0) {
                stepOutputs.push({ stepId: safeStepId, eventType: safeEventType, payload: safePayload });
              }
              terminalPayload = safePayload;
              await executionRepository.createEvent({
                planId: savedPlan.id,
                stepId: safeStepId,
                eventType: safeEventType,
                payload: safePayload,
              });
              sseManager.emit(userId, 'decision:step', {
                decisionId: decision.id,
                actionType: outcome.selectedAction.actionType,
                description: outcome.selectedAction.description,
                planId: event.planId,
                stepId: safeStepId,
                eventType: safeEventType,
                timestamp: event.timestamp,
                payload: safePayload,
              });

              if (safeEventType === 'plan_completed' || safeEventType === 'plan_failed') {
                terminalEvent = { ...event, stepId: safeStepId, eventType: safeEventType };
                terminalStatus = safeEventType === 'plan_completed' ? 'completed' : 'failed';
              }
            }
          } catch (error) {
            terminalStatus = null;
            terminalEvent = null;
            terminalPayload = {
              error: normalizeExecutionError(error),
            };
            if (error instanceof NoRequestExecutionError) {
              try {
                const recorded = await inferenceReceiptRepository
                  .markExecutionFailedBeforeDispatchForDecision(
                    userId,
                    decision.id,
                    savedPlan.id,
                    terminalPayload['error'] as string,
                  );
                executionResult = recorded
                  ? { status: 'failed', planId: savedPlan.id }
                  : { status: 'ambiguous', planId: savedPlan.id };
              } catch {
                executionResult = { status: 'ambiguous', planId: savedPlan.id };
              }
              preDispatchClosed = true;
            }
            // The router's exported error classes are also available to
            // adapters, so an exception's type cannot prove it happened before
            // an effect. Leave the plan and guard running for reconciliation.
            if (!preDispatchClosed) {
              log.warn('Execution stream became ambiguous; reconciliation required', {
                userId,
                decisionId: decision.id,
                planId: savedPlan.id,
                error: terminalPayload['error'],
              });
            }
          }

          if (preDispatchClosed) {
            // The exact no-effect terminalization above owns the result.
          } else if (!terminalStatus) {
            executionResult = { status: 'ambiguous', planId: savedPlan.id };
          } else {
            await executionRepository.updatePlanStatus(savedPlan.id, terminalStatus);
            const fullOutputs: Record<string, unknown> = {
              ...terminalPayload,
              steps: stepOutputs,
            };
            await executionRepository.createResult({
              planId: savedPlan.id,
              success: terminalStatus === 'completed',
              outputs: fullOutputs,
              error: typeof terminalPayload['error'] === 'string' ? terminalPayload['error'] : undefined,
              rollbackAvailable: typeof terminalPayload['rollback_available'] === 'boolean'
                ? terminalPayload['rollback_available']
                : outcome.selectedAction.reversible,
            });

            let terminalGuardCommitted = false;
            try {
              terminalGuardCommitted = await inferenceReceiptRepository.markExecutionTerminalForDecision(
                userId,
                decision.id,
                terminalStatus,
                savedPlan.id,
              );
            } catch (error) {
              log.warn('Execution terminal guard response was ambiguous', {
                userId,
                decisionId: decision.id,
                planId: savedPlan.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            if (!terminalGuardCommitted) {
              executionResult = { status: 'ambiguous', planId: savedPlan.id };
            } else {
              executionResult = {
                status: terminalStatus,
                planId: savedPlan.id,
                adapterUsed: terminalPayload['adapter_used'] ?? 'unknown',
              };

              // Record post-execution spend tagged with the action's registry
              // source (#323 AC#3). Only on success — a failed execution
              // shouldn't charge the user's per-app budget. Best-effort: the
              // helper swallows its own errors so a ledger write can't break
              // the auto-execute response. The spend cap was already enforced
              // upstream by the policy engine before this action ran.
              if (terminalStatus === 'completed') {
                await recordMcpActionSpend({
                  userId,
                  decisionId: decision.id,
                  action: outcome.selectedAction,
                });
              }

              // Notify via SSE only after terminal guard authority is known.
              sseManager.emit(userId, 'decision:executed', {
                decisionId: decision.id,
                actionType: outcome.selectedAction.actionType,
                description: outcome.selectedAction.description,
                status: terminalStatus,
                eventType: terminalEvent?.eventType,
              });
            }
          }
          }
          }
        } // end if (riskAssessment) — escalation branch above handles null
      }

      // Emit `approval:new` ONLY when this call actually inserted a row.
      // A re-ingested signal hits ON CONFLICT (decision_id) DO NOTHING in
      // approvalRepository.create — the approval already exists, no row
      // was written, and a duplicate `approval:new` would re-flash the
      // dashboard badge / re-play the toast / re-bump the unread count
      // for an approval the user has already seen (or already resolved).
      // `approvalNewlyCreated` is false in that case, so the emit is
      // skipped. The DB-level idempotency from migration 046 + ON CONFLICT
      // is what makes this safe to gate on. Note: this gates the
      // `approval:new` SSE specifically — upstream signal-recording emits
      // (`memory:page-indexed` from the recordSignal path) are intended
      // to fire per-ingestion and are not affected. When the emit is
      // suppressed we leave an audit breadcrumb so an operator
      // investigating "why no notification?" can see the re-ingestion was
      // recognised and intentionally silenced.
      if (approvalRequest && approvalNewlyCreated) {
        sseManager.emit(userId, 'approval:new', {
          id: approvalRequest.id,
          decisionId: decision.id,
          reason: outcome.reasoning,
          urgency: decision.urgency,
        });
      } else if (approvalRequest && !approvalNewlyCreated) {
        log.info('Suppressed approval:new SSE for re-ingested signal', {
          userId,
          decisionId: decision.id,
          approvalId: approvalRequest.id,
        });
      }

      // Surface "no action taken" outcomes (every candidate blocked, or none
      // generated) so the user can see why nothing happened. Without this the
      // event ingest is silent and the policy decision is invisible — Safety
      // Invariant #1 (every auto-execute path went through a policy check) is
      // structurally enforced upstream, but the *result* of that check needs
      // to be observable.
      //
      // Note: the per-emit `decisionCreated` gate that this PR's predecessor
      // (v0.6.28.0) introduced is no longer needed — if a re-ingestion has a
      // recoverable previous outcome, the short-circuit at step 1c returns
      // before reaching this code, and if it doesn't (the first attempt
      // crashed before saving outcome), we WANT the SSE to fire because the
      // user never saw it the first time.
      if ((!outcome.selectedAction && !approvalRequest && !executionResult) ||
          executionResult?.status === 'blocked') {
        sseManager.emit(userId, 'decision:blocked-by-policy', {
          decisionId: decision.id,
          reason: executionResult?.status === 'blocked'
            ? executionResult.error
            : outcome.reasoning,
          domain: decision.domain,
          situationType: decision.situationType,
          urgency: decision.urgency,
        });
      }

      // 10. Return result
      res.json({
        decision: {
          id: decision.id,
          situationType: decision.situationType,
          domain: decision.domain,
          urgency: decision.urgency,
          summary: decision.summary,
        },
        outcome: {
          selectedAction: outcome.selectedAction
            ? {
                actionType: outcome.selectedAction.actionType,
                description: outcome.selectedAction.description,
              }
            : null,
          autoExecute: outcome.autoExecute,
          requiresApproval: outcome.requiresApproval,
          reasoning: outcome.reasoning,
        },
        explanation: {
          summary: explanation.summary,
          riskTier: explanation.riskTier,
          confidence: explanation.overallConfidence,
        },
        execution: executionResult,
        approval: approvalRequest
          ? {
              id: approvalRequest.id,
              status: approvalRequest.status,
            }
          : null,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
