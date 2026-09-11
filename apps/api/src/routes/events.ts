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
  oauthRepository,
  executionRepository,
  userRepository,
  emailLabelRepository,
  mempalaceRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  decisionRepositoryAdapter,
  explanationRepositoryAdapter,
  policyRepositoryAdapter,
  preEffectBarrierRepository,
  inferenceReceiptRepository,
  gmailMessageRefRepository,
} from '@skytwin/db';
import type {
  DecisionContext,
  DecisionOutcome,
  ExecutionResult,
  RiskAssessment,
  EpisodicMemory,
} from '@skytwin/shared-types';
import { parseAutonomySettings, SituationType, TrustTier } from '@skytwin/shared-types';
import {
  AmbiguousExecutionError,
  EXECUTION_FAILURE_CODES,
  executionFailureCode,
} from '@skytwin/execution-router';
import { emitInferenceReceipt } from '@skytwin/llm-client';
import type { InferenceTrace, ReceiptSigningKey } from '@skytwin/llm-client';
import { createLogger } from '@skytwin/core';
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
import {
  validateEventIngest,
  validateGmailConnectorEvidence,
} from '../validators/event-ingest.js';
import { getMemoryPortForUser } from '../memory-setup.js';
import type { DecisionObject as _DecisionObject } from '@skytwin/shared-types';
import {
  annotateEmailAttributionPreview,
  isOutboundEmailAction,
  prepareEmailActionForExecution,
} from '../email-attribution.js';
import { resolveUserLlmClient } from '../lib/user-llm-client.js';

const GMAIL_SIGNAL_DATA_KEYS = [
  'from',
  'to',
  'cc',
  'hasInReplyTo',
  'hasListUnsubscribe',
  'subject',
  'snippet',
  'labels',
  'listId',
  'authoringTier',
  'receivedAt',
  'observedAt',
  'requiresResponse',
] as const;
const GMAIL_INTERPRETATION_KEYS = new Set<string>([
  ...GMAIL_SIGNAL_DATA_KEYS,
  'userId',
  'source',
  'type',
  'signalId',
  'urgency',
]);
const UNTRUSTED_GMAIL_AUTHORITY_KEYS = new Set([
  'messageId',
  'emailId',
  'threadId',
  'messageRefId',
  'connectorAccountId',
  'providerMessageId',
  'providerThreadId',
  'sourceSignalId',
  'resourceRefId',
  'observedInInbox',
  'connectorEvidence',
  'authoringTier',
]);

/** Keep Watch evidence useful without persisting bodies, secrets, or raw responses. */
function sanitizedGmailSignalData(event: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of GMAIL_SIGNAL_DATA_KEYS) {
    if (event[key] !== undefined) data[key] = event[key];
  }
  return data;
}

function stripProviderTargetIds(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripProviderTargetIds(item, depth + 1));
  const clean: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!UNTRUSTED_GMAIL_AUTHORITY_KEYS.has(key)) {
      clean[key] = stripProviderTargetIds(child, depth + 1);
    }
  }
  return clean;
}

function eventPolicySnapshot(
  policy: { allowed: boolean; requiresApproval: boolean; reason: string },
  action: { actionType: string; reversible: boolean },
  risk: RiskAssessment,
  adapter: string,
): Record<string, unknown> {
  return {
    allowed: policy.allowed,
    requiresApproval: policy.requiresApproval,
    reason: policy.reason.slice(0, 500),
    actionType: action.actionType,
    reversible: action.reversible,
    riskTier: risk.overallTier,
    adapter,
  };
}

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
 * Return the durable response for a completed prior ingestion, or null when
 * the prior pipeline still needs recovery. This is safe to call before LLM
 * composition/interpretation, which prevents a duplicate signal from making
 * a new provider call whose trace could never be linked to a new decision.
 */
async function recoverCompletedIngest(
  userId: string,
  decision: _DecisionObject,
  raceLoserTraces: readonly InferenceTrace[] = [],
): Promise<Record<string, unknown> | null> {
  const [previousOutcome, receiptCaptureComplete] = await Promise.all([
    decisionRepositoryAdapter.getOutcome(decision.id),
    inferenceReceiptRepository.isCompleteForDecision(userId, decision.id),
  ]);
  let recoverable = previousOutcome !== null && receiptCaptureComplete;
  let executionTerminal: {
    status: 'completed' | 'failed' | 'unknown';
    planId: string | null;
  } | null = null;
  const previousApproval = previousOutcome?.requiresApproval
    ? await approvalRepository.findByDecisionId(decision.id, userId)
    : null;
  if (previousOutcome?.requiresApproval) recoverable = recoverable && previousApproval !== null;
  if (previousOutcome?.autoExecute) {
    const previousExec = await executionRepository.getByDecisionId(decision.id);
    if (!previousExec?.result) {
      // A durable auto-execute outcome without a known result has crossed the
      // dispatch boundary. Receipt repair may still be needed, but rerunning
      // the decision pipeline could duplicate an irreversible remote effect.
      executionTerminal = {
        status: 'unknown',
        planId: previousExec?.plan.id ?? null,
      };
      recoverable = true;
    } else {
      executionTerminal = {
        status: previousExec.result.success ? 'completed' : 'failed',
        planId: previousExec.plan.id,
      };
    }
  }
  if (!recoverable || !previousOutcome) return null;

  const previousExplanation = await explanationRepositoryAdapter.getByDecisionId(decision.id);
  if (raceLoserTraces.length > 0) {
    if (!previousExplanation) {
      throw new Error('Duplicate inference traces cannot be linked without a durable explanation');
    }
    await persistInferenceTraces(
      userId,
      decision.id,
      previousExplanation.id,
      raceLoserTraces,
    );
  }
  log.info('Suppressed pipeline for re-ingested signal', {
    userId,
    decisionId: decision.id,
    hadApproval: previousApproval !== null,
    hadExplanation: previousExplanation !== null,
    requiredApproval: previousOutcome.requiresApproval,
    autoExecuted: previousOutcome.autoExecute,
    executionStatus: executionTerminal?.status ?? null,
  });
  return {
    decision: {
      id: decision.id,
      situationType: decision.situationType,
      domain: decision.domain,
      urgency: decision.urgency,
      summary: decision.summary,
    },
    outcome: {
      selectedAction: previousOutcome.selectedAction
        ? {
            actionType: previousOutcome.selectedAction.actionType,
            description: previousOutcome.selectedAction.description,
          }
        : null,
      autoExecute: previousOutcome.autoExecute,
      requiresApproval: previousOutcome.requiresApproval,
      reasoning: previousOutcome.reasoning,
    },
    explanation: previousExplanation
      ? {
          summary: previousExplanation.summary,
          riskTier: previousExplanation.riskTier,
          confidence: previousExplanation.overallConfidence,
        }
      : null,
    execution: executionTerminal,
    approval: previousApproval
      ? { id: previousApproval.id, status: previousApproval.status }
      : null,
    reIngested: true,
  };
}

/**
 * Create the events router for ingesting raw events.
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

async function persistInferenceTraces(
  userId: string,
  decisionId: string,
  explanationId: string,
  traces: readonly InferenceTrace[],
): Promise<void> {
  const signingKey = getReceiptSigningKey();
  const inputs = traces.map((trace) => {
    // Confidential mode is currently fail-closed at the sole client
    // composition root until a verifier-owned adapter is configured.
    if (trace.execution.reasoningMode === 'verified_private_cloud' || trace.verification) {
      throw new Error('Confidential receipt emission is not configured for decision events');
    }
    const bundle = emitInferenceReceipt(trace, {
      userId,
      decisionId,
      explanationId,
    }, signingKey);
    return {
      bundle,
      trustedRecorderKeys: new Map([[signingKey.keyId, signingKey.publicKeyPem]]),
    };
  });
  const persisted = await inferenceReceiptRepository.createManyForUser(userId, inputs, {
    decisionId,
    explanationId,
  });
  if (!persisted || persisted.length !== inputs.length) {
    throw new Error('Inference receipts could not be persisted; decision execution stopped');
  }
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

      // connectorEvidence is authority-bearing only on the loopback service
      // credential path. A human session presenting the same JSON shape must
      // not be able to bind an arbitrary provider resource to their account.
      const presentedEvidence = rawEvent['connectorEvidence'];
      delete rawEvent['connectorEvidence'];
      // messageRefId is always repository-derived. Ignore any caller value so
      // it cannot survive into interpretation/candidate generation.
      delete rawEvent['messageRefId'];

      if (presentedEvidence !== undefined && req.serviceAuthenticated !== true) {
        res.status(400).json({ error: 'connectorEvidence is service-authenticated metadata' });
        return;
      }

      const normalizedSource = typeof rawEvent['source'] === 'string'
        ? rawEvent['source'].trim().toLowerCase()
        : '';
      if (req.serviceAuthenticated !== true) {
        // Connector-derived authoring tiers are authority-bearing regardless
        // of the source spelling. A normal session may still submit an event,
        // but it cannot promote itself by placing a user_sent_* tier at the
        // top level or in the envelope shape read by SituationInterpreter.
        delete rawEvent['authoringTier'];
        const nestedData = rawEvent['data'];
        if (nestedData && typeof nestedData === 'object' && !Array.isArray(nestedData)) {
          const cleanData = { ...(nestedData as Record<string, unknown>) };
          delete cleanData['authoringTier'];
          rawEvent['data'] = cleanData;
        }
      }

      if (req.serviceAuthenticated === true && normalizedSource === 'gmail') {
        const evidenceValidation = validateGmailConnectorEvidence(presentedEvidence);
        const sourceSignalId = rawEvent['signalId'];
        if (!evidenceValidation.ok) {
          res.status(400).json({ error: evidenceValidation.message });
          return;
        }
        if (
          typeof sourceSignalId !== 'string' ||
          sourceSignalId.length < 1 ||
          sourceSignalId.length > 2048
        ) {
          res.status(400).json({ error: 'Account-bound Gmail ingest requires a valid signalId' });
          return;
        }
        const evidence = evidenceValidation.evidence;
        rawEvent['source'] = 'gmail';
        // The signed service envelope is authoritative for provenance and
        // observation time. A conflicting flat payload cannot upgrade an
        // inbound message to a user-authored tier or skew Watch windows.
        rawEvent['authoringTier'] = evidence.authoringTier;
        rawEvent['receivedAt'] = evidence.messageTimestamp.toISOString();
        rawEvent['observedAt'] = evidence.observedAt.toISOString();
        for (const key of Object.keys(rawEvent)) {
          if (!GMAIL_INTERPRETATION_KEYS.has(key)) delete rawEvent[key];
        }
        const persisted = await gmailMessageRefRepository.persistEvidence({
          userId,
          connectorAccountId: evidence.connectorAccountId,
          sourceSignalId,
          providerMessageId: evidence.providerMessageId,
          providerThreadId: evidence.providerThreadId,
          authoringTier: evidence.authoringTier,
          observedInInbox: evidence.observedInInbox,
          observedAt: evidence.observedAt,
          signalTimestamp: evidence.messageTimestamp,
          signalType: typeof rawEvent['type'] === 'string' ? rawEvent['type'] : 'email',
          signalData: sanitizedGmailSignalData(rawEvent),
        });
        if (!persisted.ok) {
          res.status(409).json({ error: persisted.error });
          return;
        }
        // Interpretation always sees the immutable canonical signal row. On a
        // replay, modified request fields cannot alter the decision input even
        // though the request reached us before the idempotency lookup.
        for (const key of Object.keys(rawEvent)) delete rawEvent[key];
        Object.assign(rawEvent, sanitizedGmailSignalData(persisted.signal.data), {
          userId,
          source: 'gmail',
          type: persisted.signal.type,
          signalId: persisted.signal.source_signal_id,
          authoringTier: persisted.messageRef.authoring_tier,
          receivedAt: persisted.signal.timestamp.toISOString(),
          observedAt: persisted.messageRef.first_observed_at.toISOString(),
          messageRefId: persisted.messageRef.id,
        });
      } else if (presentedEvidence !== undefined) {
        res.status(400).json({ error: 'connectorEvidence is only valid for Gmail signals' });
        return;
      } else if (normalizedSource === 'gmail') {
        // Human/session callers cannot assert connector provenance. Preserve
        // the content event for backwards compatibility, but force the least-
        // trusted Gmail tier and recursively remove provider mutation targets.
        const stripped = stripProviderTargetIds(rawEvent) as Record<string, unknown>;
        for (const key of Object.keys(rawEvent)) delete rawEvent[key];
        Object.assign(rawEvent, stripped, { source: 'gmail', authoringTier: 'inbox_automated' });
      }

      // A completed duplicate must short-circuit before any LLM-backed
      // interpretation. The later saveDecision check remains the race-loser
      // backstop for concurrent first ingestions.
      const signalId = typeof rawEvent['signalId'] === 'string' &&
        rawEvent['signalId'].trim().length > 0
        ? rawEvent['signalId']
        : '';
      if (signalId && decisionRepositoryAdapter.findBySignalId) {
        const existingDecision = await decisionRepositoryAdapter.findBySignalId(userId, signalId);
        if (existingDecision) {
          const recovered = await recoverCompletedIngest(userId, existingDecision);
          if (recovered) {
            res.json(recovered);
            return;
          }
        }
      }

      // 0. Build per-user LLM client and strategies (or fall back to rule-based)
      const traces: InferenceTrace[] = [];
      const llmResolution = await resolveUserLlmClient(userId, {
        onInferenceTrace: (trace) => traces.push(trace),
      });
      const receiptAwareLlm = llmResolution.state === 'ready'
        ? { client: llmResolution.client, traces }
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

      // 1. Interpret the raw event
      const decision = await interpreter.interpret(rawEvent);

      // 1b. Persist the decision to DB so foreign keys (outcomes, candidates) work.
      // `decisionCreated` is false when the row was already persisted for this
      // (user_id, signal_id) — a re-ingestion. Callers gate side-effects on it
      // so duplicate ingests don't re-fire UI notifications etc.
      const { created: decisionCreated } = await decisionRepositoryAdapter.saveDecision(decision);

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
      // Three completeness checks decide whether the previous attempt is
      // recoverable enough to short-circuit:
      //
      //   1. Was an outcome row saved at all? (saveOutcome runs inside
      //      decisionMaker.evaluate.) If null, the first ingest crashed
      //      before even recording the verdict — fall through.
      //   2. Was the outcome an auto-execute one? If yes, also require a
      //      terminal `execution_result` row. The outcome is saved BEFORE
      //      the action runs (decision-maker → recordOutcome → events.ts
      //      → createPlan → execute → createResult), so a saved outcome
      //      with no execution_result means the action hung mid-flight
      //      or the process died between saveOutcome and createResult.
      //      Fall through so the re-ingestion finishes the work — short-
      //      circuiting here would leave the user thinking the email was
      //      sent when it wasn't.
      //   3. If `requiresApproval` is true, the approval row's existence
      //      is the durable record of completion — `approvalRepository.create`
      //      is idempotent and re-running it on a re-ingest would be a
      //      no-op anyway, so this case is always safe to short-circuit
      //      regardless of approval-row state.
      if (!decisionCreated) {
        const recovered = await recoverCompletedIngest(userId, decision, traces);
        if (recovered) {
          res.json(recovered);
          return;
        }
        log.info('Re-ingestion with incomplete previous attempt; running pipeline to completion', {
          userId,
          decisionId: decision.id,
        });
      }

      // 2. Get user record (trust tier must come from DB, never from caller)
      const user = await userRepository.findById(userId);

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
      void recordSignalToMemory(userId, decision, rawEvent)
        .then(() => {
          // Tell the dashboard a page was indexed so it refreshes the
          // counts + recent-episodes block without polling.
          sseManager.emit(userId, 'memory:page-indexed', {
            decisionId: decision.id,
            source: rawEvent['source'] ?? 'unknown',
            type: rawEvent['type'] ?? decision.situationType,
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
      const outcome = await decisionMaker.evaluate(context);

      // 8. Generate explanation
      const explanation = await explanationGenerator.generate(
        decision,
        outcome,
        context,
      );

      // An LLM-backed decision cannot proceed to approval or execution until
      // every completed inference has a receipt linked to its real explanation.
      // The repository inserts the batch atomically and derives ownership from
      // the decision; raw inference bytes are verified here but never stored.
      await persistInferenceTraces(
        userId,
        decision.id,
        explanation.id,
        receiptAwareLlm?.traces ?? [],
      );

      // 8b. Persist candidate actions so alternatives are available for approval UI
      if (outcome.allCandidates.length > 0) {
        try {
          await decisionRepositoryAdapter.saveCandidates(outcome.allCandidates);
        } catch (err: unknown) {
          // Duplicate key (PG 23505) is expected from prior runs or the engine itself.
          // Log anything else so real failures aren't silently swallowed.
          const code = (err as { code?: string }).code;
          if (code !== '23505') {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Failed to persist candidate actions', { error: msg });
          }
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
      const awarenessOnly =
        outcome.requiresApproval &&
        !!outcome.selectedAction &&
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
        // Phase 1: flip the PERSISTED outcome so the approval branch below is
        // skipped (no row, no approval:new SSE) and needsYou() buckets it as FYI.
        // selectedAction stays non-null, so decision:blocked-by-policy stays
        // silent. saveOutcome upserts the existing row (ON CONFLICT DO UPDATE).
        outcome.requiresApproval = false;
        await decisionRepositoryAdapter.saveOutcome(outcome);
      }

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
          const escalationResult = await approvalRepository.create({
            userId,
            decisionId: decision.id,
            candidateAction: serializeApprovalCandidate(outcome.selectedAction, approvalVisibleParametersEsc),
            reason: 'Auto-execute path could not verify a persisted risk assessment for this candidate. Escalated to manual approval to fail closed (#371).',
            urgency: decision.urgency,
            confirmationLevel: 'single',
          });
          approvalRequest = escalationResult.row;
          approvalNewlyCreated = escalationResult.created;
        } else {
          const barrier = await preEffectBarrierRepository.reserve({
            userId,
            effectType: 'event_execution',
            idempotencyKey: decision.id,
          });
          if (!barrier.created) {
            // A competing or crashed request owns this exact effect. None of
            // reserved/prepared/in_progress/unknown is safe to auto-replay.
            const known = barrier.row.status === 'succeeded' || barrier.row.status === 'failed';
            executionResult = {
              status: known
                ? (barrier.row.status === 'succeeded' ? 'completed' : 'failed')
                : 'unknown',
              planId: typeof barrier.row.effect_result['planId'] === 'string'
                ? barrier.row.effect_result['planId']
                : null,
              adapterUsed: typeof barrier.row.effect_result['adapterName'] === 'string'
                ? barrier.row.effect_result['adapterName']
                : 'unknown',
            };
          } else {
          let savedPlanId: string | null = null;
          try {
            // Secrets are attached only after the durable reservation exists.
            const tokenRow = await oauthRepository.getToken(userId, 'google');
            if (tokenRow) {
              outcome.selectedAction.parameters['accessToken'] = tokenRow.access_token;
            }
            prepareEmailActionForExecution(outcome.selectedAction, user);

            // Persist the DB execution plan before routing so streaming events can
            // reference it via execution_events.plan_id.
            const savedPlan = await executionRepository.createPlan({
              decisionId: decision.id,
              actionId: outcome.selectedAction.id,
              status: 'running',
              steps: [{ type: outcome.selectedAction.actionType, status: 'pending' }],
            });
            savedPlanId = savedPlan.id;
            outcome.selectedAction.parameters['executionPlanId'] = savedPlan.id;
            if (user?.ironclaw_channel) {
              outcome.selectedAction.parameters['ironclawChannel'] = user.ironclaw_channel;
            }

            // Route and prepare first. The router-issued object is an opaque,
            // user-bound capability; policy is then re-evaluated against its
            // adjusted risk and canonical action immediately before dispatch.
            const executionRouter = await getRouter();
            const route = await executionRouter.route(
              outcome.selectedAction,
              riskAssessment,
              userId,
            );
            const prepared = await executionRouter.prepareExecution(
              outcome.selectedAction,
              route,
              userId,
            );
            const admittedAction = prepared.plan.action;
            const effectiveRisk = prepared.routingDecision.modifiedRiskAssessment;
            await decisionRepositoryAdapter.saveRiskAssessment(effectiveRisk);

            const freshUser = await userRepository.findById(userId);
            if (!freshUser) throw new Error(EXECUTION_FAILURE_CODES.pipelineFailed);
            const freshPolicies = await policyRepositoryAdapter.getEnabledPolicies();
            const finalPolicy = await policyEvaluator.evaluate(
              admittedAction,
              freshPolicies,
              (freshUser.trust_tier as TrustTier) ?? TrustTier.OBSERVER,
              effectiveRisk,
              parseAutonomySettings(freshUser.autonomy_settings),
            );
            const policySnapshot = eventPolicySnapshot(
              finalPolicy,
              admittedAction,
              effectiveRisk,
              prepared.selectedAdapter,
            );
            const finalOutcome: DecisionOutcome = {
              ...outcome,
              selectedAction: admittedAction,
              riskAssessment: effectiveRisk,
              autoExecute: finalPolicy.allowed && !finalPolicy.requiresApproval,
              requiresApproval: finalPolicy.requiresApproval,
              reasoning: `Final pre-execution policy check: ${finalPolicy.reason}`,
            };
            await decisionRepositoryAdapter.saveOutcome(finalOutcome);
            outcome.autoExecute = finalOutcome.autoExecute;
            outcome.requiresApproval = finalOutcome.requiresApproval;
            outcome.reasoning = finalOutcome.reasoning;
            const finalExplanation = await explanationGenerator.generate(decision, finalOutcome, {
              ...context,
              trustTier: (freshUser.trust_tier as TrustTier) ?? TrustTier.OBSERVER,
              autonomySettings: parseAutonomySettings(freshUser.autonomy_settings),
            });
            await preEffectBarrierRepository.markPrepared({
              id: barrier.row.id,
              userId,
              decisionId: decision.id,
              actionId: admittedAction.id,
              explanationId: finalExplanation.id,
              policySnapshot,
            });

            if (!finalPolicy.allowed || finalPolicy.requiresApproval) {
              await preEffectBarrierRepository.markTerminal(
                userId,
                barrier.row.id,
                'blocked',
                { policy: policySnapshot },
                'final_policy_blocked',
              );
              executionResult = {
                status: 'failed',
                planId: savedPlan.id,
                adapterUsed: prepared.selectedAdapter,
              };
              if (finalPolicy.requiresApproval) {
                const {
                  accessToken: _omitFinalToken,
                  rawData: _omitFinalRawData,
                  ...finalVisibleParameters
                } = admittedAction.parameters;
                const finalApproval = await approvalRepository.create({
                  userId,
                  decisionId: decision.id,
                  candidateAction: serializeApprovalCandidate(admittedAction, finalVisibleParameters),
                  reason: finalOutcome.reasoning,
                  urgency: decision.urgency,
                  confirmationLevel: finalPolicy.confirmationLevel === 'dual' ? 'dual' : 'single',
                });
                approvalRequest = finalApproval.row;
                approvalNewlyCreated = finalApproval.created;
              }
              await executionRepository.updatePlanStatus(savedPlan.id, 'failed');
              await executionRepository.createResult({
                planId: savedPlan.id,
                success: false,
                outputs: { code: 'final_policy_blocked' },
                error: 'final_policy_blocked',
                rollbackAvailable: false,
              });
            } else {
              const claim = await preEffectBarrierRepository.claimPrepared(userId, barrier.row.id);
              if (!claim) throw new Error(EXECUTION_FAILURE_CODES.pipelineFailed);

              // No adapter-originated streaming crosses the API/DB boundary.
              // Only this allowlisted terminal envelope is persisted/emitted.
              let adapterResult: ExecutionResult | undefined;
              try {
                adapterResult = await executionRouter.executePrepared(prepared, userId);
              } catch (error) {
                if (!(error instanceof AmbiguousExecutionError)) throw error;
                executionResult = {
                  status: 'unknown',
                  planId: savedPlan.id,
                  adapterUsed: prepared.selectedAdapter,
                };
                await preEffectBarrierRepository.markTerminal(
                  userId,
                  barrier.row.id,
                  'unknown',
                  { planId: savedPlan.id, adapterName: prepared.selectedAdapter },
                  EXECUTION_FAILURE_CODES.dispatchAmbiguous,
                );
                await executionRepository.updatePlanStatus(savedPlan.id, 'failed');
                await executionRepository.createEvent({
                  planId: savedPlan.id,
                  eventType: 'plan_failed',
                  payload: { code: EXECUTION_FAILURE_CODES.dispatchAmbiguous },
                });
                await executionRepository.createResult({
                  planId: savedPlan.id,
                  success: false,
                  outputs: { code: EXECUTION_FAILURE_CODES.dispatchAmbiguous },
                  error: EXECUTION_FAILURE_CODES.dispatchAmbiguous,
                  rollbackAvailable: false,
                });
                sseManager.emit(userId, 'decision:execution-unknown', {
                  decisionId: decision.id,
                  actionType: admittedAction.actionType,
                  code: EXECUTION_FAILURE_CODES.dispatchAmbiguous,
                });
              }

              if (adapterResult) {
                const terminalStatus = adapterResult.status === 'completed' ? 'completed' : 'failed';
                const terminalCode = terminalStatus === 'completed'
                  ? undefined
                  : EXECUTION_FAILURE_CODES.adapterFailed;
                executionResult = {
                  status: terminalStatus,
                  planId: savedPlan.id,
                  adapterUsed: prepared.selectedAdapter,
                };
                await preEffectBarrierRepository.markTerminal(
                  userId,
                  barrier.row.id,
                  terminalStatus === 'completed' ? 'succeeded' : 'failed',
                  {
                    planId: savedPlan.id,
                    adapterName: prepared.selectedAdapter,
                    status: terminalStatus,
                  },
                  terminalCode,
                );
                await executionRepository.updatePlanStatus(savedPlan.id, terminalStatus);
                await executionRepository.createEvent({
                  planId: savedPlan.id,
                  eventType: terminalStatus === 'completed' ? 'plan_completed' : 'plan_failed',
                  payload: terminalCode ? { code: terminalCode } : { status: 'completed' },
                });
                await executionRepository.createResult({
                  planId: savedPlan.id,
                  success: terminalStatus === 'completed',
                  outputs: terminalCode ? { code: terminalCode } : { status: 'completed' },
                  error: terminalCode,
                  rollbackAvailable: admittedAction.reversible,
                });
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
              action: admittedAction,
            });
          }

          // Notify via SSE
          sseManager.emit(userId, 'decision:executed', {
            decisionId: decision.id,
            actionType: admittedAction.actionType,
            description: admittedAction.description,
            status: terminalStatus,
          });
              }
            }
          } catch (error) {
            if (!executionResult) {
              const code = executionFailureCode(error);
              // Before executePrepared, this is definitely pre-dispatch. A
              // terminal barrier must never exist without a durable typed
              // explanation: persist a deliberate non-action first, then
              // atomically attach its owned UUID with the status transition.
              // If either persistence step fails, let the request fail and
              // leave the reservation non-terminal for reconciliation.
              const failureOutcome: DecisionOutcome = {
                ...outcome,
                selectedAction: null,
                riskAssessment: null,
                autoExecute: false,
                requiresApproval: false,
                reasoning: `Execution stopped before dispatch (${code}).`,
                decidedAt: new Date(),
              };
              const failureExplanation = await explanationGenerator.generate(
                decision,
                failureOutcome,
                context,
              );
              await preEffectBarrierRepository.markTerminalWithExplanation({
                id: barrier.row.id,
                userId,
                explanationId: failureExplanation.id,
                decisionId: decision.id,
                actionId: outcome.selectedAction.id,
                status: 'failed',
                effectResult: savedPlanId ? { planId: savedPlanId } : {},
                failureReason: code,
              });
              if (savedPlanId) {
                await executionRepository.updatePlanStatus(savedPlanId, 'failed');
                await executionRepository.createEvent({
                  planId: savedPlanId,
                  eventType: 'plan_failed',
                  payload: { code },
                });
                await executionRepository.createResult({
                  planId: savedPlanId,
                  success: false,
                  outputs: { code },
                  error: code,
                  rollbackAvailable: false,
                });
              }
              executionResult = {
                status: 'failed',
                planId: savedPlanId,
                adapterUsed: 'unknown',
              };
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
      if (!outcome.selectedAction && !approvalRequest && !executionResult) {
        sseManager.emit(userId, 'decision:blocked-by-policy', {
          decisionId: decision.id,
          reason: outcome.reasoning,
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
