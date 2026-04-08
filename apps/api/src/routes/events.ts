import { Router } from 'express';
import {
  SituationInterpreter,
  DecisionMaker,
  LlmSituationStrategy,
  LlmCandidateGenerator,
  FallbackSituationStrategy,
  FallbackCandidateGenerator,
  RuleBasedCandidateGenerator,
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
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  decisionRepositoryAdapter,
  explanationRepositoryAdapter,
  policyRepositoryAdapter,
} from '@skytwin/db';
import type { DecisionContext, RiskAssessment, DimensionAssessment } from '@skytwin/shared-types';
import { SituationType, TrustTier, RiskTier, RiskDimension } from '@skytwin/shared-types';
import type { AIProviderName } from '@skytwin/shared-types';
import { LlmClient } from '@skytwin/llm-client';
import type { ProviderEntry } from '@skytwin/llm-client';
import { WorkflowHandlerRegistry } from '../workflows/registry.js';
import { processCalendarConflict } from '../workflows/calendar-conflict.js';
import { processSubscriptionRenewal } from '../workflows/subscription-renewal.js';
import { processGroceryReorder } from '../workflows/grocery-reorder.js';
import { processTravelDecision } from '../workflows/travel-decision.js';
import { getExecutionRouter } from '../execution-setup.js';
import { sseManager } from '../sse.js';

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

  return new LlmClient(providers);
}

export function createEventsRouter(): Router {
  const router = Router();

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
  // Rule-based fallbacks (always available)
  const ruleBasedInterpreter = new SituationInterpreter();
  const ruleBasedDecisionMaker = new DecisionMaker(twinService, policyEvaluator, decisionRepositoryAdapter);
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
      const rawEvent = req.body as Record<string, unknown>;
      const userId = rawEvent['userId'] as string | undefined;

      if (!userId) {
        res.status(400).json({ error: 'Missing userId in event data' });
        return;
      }

      // 0. Build per-user LLM client and strategies (or fall back to rule-based)
      const llmClient = await buildLlmClientForUser(userId);

      let interpreter: SituationInterpreter;
      let decisionMaker: DecisionMaker;

      if (llmClient && llmClient.hasProviders) {
        const llmSituation = new LlmSituationStrategy(llmClient);
        const llmCandidates = new LlmCandidateGenerator(llmClient);
        const ruleBasedCandidates = new RuleBasedCandidateGenerator(ruleBasedDecisionMaker);
        const situationStrategy = new FallbackSituationStrategy(llmSituation, ruleBasedInterpreter);
        const candidateStrategy = new FallbackCandidateGenerator(llmCandidates, ruleBasedCandidates);
        interpreter = new SituationInterpreter(situationStrategy);
        decisionMaker = new DecisionMaker(twinService, policyEvaluator, decisionRepositoryAdapter, candidateStrategy);
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

      // 5. Fetch patterns, traits, and temporal profile for richer scoring
      const [patterns, traits, temporalProfile] = await Promise.all([
        twinService.getPatterns(userId),
        twinService.getTraits(userId),
        twinService.getTemporalProfile(userId),
      ]);

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
      };

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
            console.error('[events] Failed to persist candidate actions:', msg);
          }
        }
      }

      // 9. Handle outcome
      let executionResult = null;
      let approvalRequest = null;

      if (outcome.requiresApproval && outcome.selectedAction) {
        // Create an approval request so the user can review it
        approvalRequest = await approvalRepository.create({
          userId,
          decisionId: decision.id,
          candidateAction: {
            actionType: outcome.selectedAction.actionType,
            description: outcome.selectedAction.description,
            domain: outcome.selectedAction.domain,
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

        // Execute via the trust-ranked execution router (IronClaw > Direct > OpenClaw)
        const executionRouter = await getRouter();
        const result = await executionRouter.executeWithRouting(
          outcome.selectedAction,
          riskAssessment,
          userId,
        );

        // Persist execution plan and result (include steps for rollback support)
        const savedPlan = await executionRepository.createPlan({
          decisionId: decision.id,
          actionId: outcome.selectedAction.id,
          status: result.status === 'completed' ? 'completed' : 'failed',
          steps: result.output?.['stepsCompleted']
            ? [{ type: outcome.selectedAction.actionType, status: result.status }]
            : [],
        });
        await executionRepository.createResult({
          planId: savedPlan.id,
          success: result.status === 'completed',
          outputs: result.output ?? {},
          error: result.error ?? undefined,
          rollbackAvailable: outcome.selectedAction.reversible,
        });

        executionResult = {
          status: result.status,
          planId: savedPlan.id,
          adapterUsed: result.output?.['adapter_used'] ?? 'unknown',
        };

        // Notify via SSE
        sseManager.emit(userId, 'decision:executed', {
          decisionId: decision.id,
          actionType: outcome.selectedAction.actionType,
          description: outcome.selectedAction.description,
          status: result.status,
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
