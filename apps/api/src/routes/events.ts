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
} from '@skytwin/decision-engine';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { ExplanationGenerator } from '@skytwin/explanations';
import {
  approvalRepository,
  oauthRepository,
  executionRepository,
  userRepository,
  aiProviderRepository,
  emailLabelRepository,
  mempalaceRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  decisionRepositoryAdapter,
  explanationRepositoryAdapter,
  policyRepositoryAdapter,
} from '@skytwin/db';
import type { DecisionContext, ExecutionEvent, RiskAssessment, DimensionAssessment, EpisodicMemory } from '@skytwin/shared-types';
import { SituationType, TrustTier, RiskTier, RiskDimension } from '@skytwin/shared-types';
import type { AIProviderName } from '@skytwin/shared-types';
import { LlmClient } from '@skytwin/llm-client';
import type { ProviderEntry } from '@skytwin/llm-client';
import { createLogger } from '@skytwin/core';

const log = createLogger('api:events');
import { WorkflowHandlerRegistry } from '../workflows/registry.js';
import { processCalendarConflict } from '../workflows/calendar-conflict.js';
import { processSubscriptionRenewal } from '../workflows/subscription-renewal.js';
import { processGroceryReorder } from '../workflows/grocery-reorder.js';
import { processTravelDecision } from '../workflows/travel-decision.js';
import { getExecutionRouter } from '../execution-setup.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { sseManager } from '../sse.js';
import { validateEventIngest } from '../validators/event-ingest.js';
import { getMemoryPortForUser } from '../memory-setup.js';
import type { DecisionObject as _DecisionObject } from '@skytwin/shared-types';

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
async function buildLlmClientForUser(userId: string): Promise<LlmClient | null> {
  const rows = await aiProviderRepository.getEnabledForUser(userId);
  if (rows.length === 0) return null;

  const providers: ProviderEntry[] = rows.map((r: { provider: string; api_key: string; model: string; base_url: string | null }) => ({
    name: r.provider as AIProviderName,
    apiKey: r.api_key,
    model: r.model,
    baseUrl: r.base_url ?? undefined,
  }));

  return new LlmClient(providers, userId);
}

export function createEventsRouter(): Router {
  const router = Router();
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

      // 0. Build per-user LLM client and strategies (or fall back to rule-based)
      const llmClient = await buildLlmClientForUser(userId);

      let interpreter: SituationInterpreter;
      let decisionMaker: DecisionMaker;

      if (llmClient && llmClient.hasProviders) {
        const llmSituation = new LlmSituationStrategy(llmClient);
        const llmCandidates = new LlmCandidateGenerator(llmClient);
        // The LLM fallback path uses the sender-aware rule-based generator
        // so if the LLM call fails (network / quota / parse error), the
        // safety pre-pass for protected senders still runs. RuleBasedCandidateGenerator
        // wraps a DecisionMaker; we pass the sender-aware-wrapped one.
        const ruleBasedCandidates = new RuleBasedCandidateGenerator(ruleBasedDecisionMaker);
        const situationStrategy = new FallbackSituationStrategy(llmSituation, ruleBasedInterpreter);
        const candidateStrategy = new FallbackCandidateGenerator(llmCandidates, ruleBasedCandidates);
        interpreter = new SituationInterpreter(situationStrategy);
        decisionMaker = new DecisionMaker(
          twinService,
          policyEvaluator,
          decisionRepositoryAdapter,
          candidateStrategy,
          labelInferencePort,
        );
      } else {
        interpreter = ruleBasedInterpreter;
        decisionMaker = ruleBasedDecisionMaker;
      }

      // 1. Interpret the raw event
      const decision = await interpreter.interpret(rawEvent);

      // 1b. Persist the decision to DB so foreign keys (outcomes, candidates) work
      await decisionRepositoryAdapter.saveDecision(decision);

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

        approvalRequest = await approvalRepository.create({
          userId,
          decisionId: decision.id,
          candidateAction: {
            actionType: outcome.selectedAction.actionType,
            description: outcome.selectedAction.description,
            domain: outcome.selectedAction.domain,
            parameters: visibleParameters,
            estimatedCostCents: outcome.selectedAction.estimatedCostCents,
            reversible: outcome.selectedAction.reversible,
            confidence: outcome.selectedAction.confidence,
            reasoning: outcome.selectedAction.reasoning,
          },
          reason: outcome.reasoning,
          urgency: decision.urgency,
        });
      } else if (outcome.autoExecute && outcome.selectedAction) {
        // Inject OAuth token if available for real execution
        const tokenRow = await oauthRepository.getToken(userId, 'google');
        if (tokenRow) {
          outcome.selectedAction.parameters['accessToken'] = tokenRow.access_token;
        }

        // Build risk assessment for routing
        const tier = explanation.riskTier as RiskTier ?? RiskTier.LOW;
        const defaultDim: DimensionAssessment = { tier, score: 0.5, reasoning: outcome.reasoning };
        const riskAssessment: RiskAssessment = {
          actionId: outcome.selectedAction.id,
          overallTier: tier,
          dimensions: {
            [RiskDimension.REVERSIBILITY]: defaultDim,
            [RiskDimension.FINANCIAL_IMPACT]: defaultDim,
            [RiskDimension.LEGAL_SENSITIVITY]: defaultDim,
            [RiskDimension.PRIVACY_SENSITIVITY]: defaultDim,
            [RiskDimension.RELATIONSHIP_SENSITIVITY]: defaultDim,
            [RiskDimension.OPERATIONAL_RISK]: defaultDim,
          },
          reasoning: outcome.reasoning,
          assessedAt: new Date(),
        };

        // Persist the DB execution plan before routing so streaming events can
        // reference it via execution_events.plan_id.
        const savedPlan = await executionRepository.createPlan({
          decisionId: decision.id,
          actionId: outcome.selectedAction.id,
          status: 'running',
          steps: [{ type: outcome.selectedAction.actionType, status: 'pending' }],
        });
        outcome.selectedAction.parameters['executionPlanId'] = savedPlan.id;
        if (user?.ironclaw_channel) {
          outcome.selectedAction.parameters['ironclawChannel'] = user.ironclaw_channel;
        }

        // Execute via the trust-ranked execution router (IronClaw > Direct > OpenClaw)
        const executionRouter = await getRouter();
        let terminalEvent: ExecutionEvent | null = null;
        let terminalStatus: 'completed' | 'failed' = 'failed';
        const stepOutputs: Array<{ stepId?: string; eventType: string; payload: Record<string, unknown> }> = [];
        let terminalPayload: Record<string, unknown> = {};

        try {
          for await (const event of executionRouter.executeWithRoutingStreaming(
            outcome.selectedAction,
            riskAssessment,
            userId,
          )) {
            if (event.payload && Object.keys(event.payload).length > 0) {
              stepOutputs.push({ stepId: event.stepId, eventType: event.eventType, payload: event.payload });
            }
            terminalPayload = event.payload ?? terminalPayload;
            await executionRepository.createEvent({
              planId: savedPlan.id,
              stepId: event.stepId,
              eventType: event.eventType,
              payload: event.payload ?? {},
            });
            sseManager.emit(userId, 'decision:step', {
              decisionId: decision.id,
              actionType: outcome.selectedAction.actionType,
              description: outcome.selectedAction.description,
              ...event,
            });

            if (event.eventType === 'plan_completed' || event.eventType === 'plan_failed') {
              terminalEvent = event;
              terminalStatus = event.eventType === 'plan_completed' ? 'completed' : 'failed';
            }
          }
        } catch (error) {
          terminalStatus = 'failed';
          terminalPayload = {
            error: error instanceof Error ? error.message : String(error),
          };
          terminalEvent = {
            planId: savedPlan.id,
            eventType: 'plan_failed',
            timestamp: new Date(),
            payload: terminalPayload,
          };
          stepOutputs.push({ eventType: 'plan_failed', payload: terminalPayload });
          await executionRepository.createEvent({
            planId: savedPlan.id,
            eventType: 'plan_failed',
            payload: terminalPayload,
          });
          sseManager.emit(userId, 'decision:step', {
            decisionId: decision.id,
            actionType: outcome.selectedAction.actionType,
            description: outcome.selectedAction.description,
            ...terminalEvent,
          });
        }

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
          rollbackAvailable: outcome.selectedAction.reversible,
        });

        executionResult = {
          status: terminalStatus,
          planId: savedPlan.id,
          adapterUsed: terminalPayload['adapter_used'] ?? 'unknown',
        };

        // Notify via SSE
        sseManager.emit(userId, 'decision:executed', {
          decisionId: decision.id,
          actionType: outcome.selectedAction.actionType,
          description: outcome.selectedAction.description,
          status: terminalStatus,
          eventType: terminalEvent?.eventType,
        });
      }

      // Notify if a new approval was created
      if (approvalRequest) {
        sseManager.emit(userId, 'approval:new', {
          id: approvalRequest.id,
          decisionId: decision.id,
          reason: outcome.reasoning,
          urgency: decision.urgency,
        });
      }

      // Surface "no action taken" outcomes (every candidate blocked, or none
      // generated) so the user can see why nothing happened. Without this the
      // event ingest is silent and the policy decision is invisible — Safety
      // Invariant #1 (every auto-execute path went through a policy check) is
      // structurally enforced upstream, but the *result* of that check needs
      // to be observable.
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
