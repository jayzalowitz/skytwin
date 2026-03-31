import { Router } from 'express';
import { SituationInterpreter, DecisionMaker } from '@skytwin/decision-engine';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { ExplanationGenerator } from '@skytwin/explanations';
import {
  BasicMockAdapter,
  RealIronClawAdapter,
  ActionHandlerRegistry,
  EmailActionHandler,
  CalendarActionHandler,
  GenericActionHandler,
} from '@skytwin/ironclaw-adapter';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import { loadConfig } from '@skytwin/config';
import {
  approvalRepository,
  oauthRepository,
  executionRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  decisionRepositoryAdapter,
  explanationRepositoryAdapter,
  policyRepositoryAdapter,
} from '@skytwin/db';
import type { DecisionContext } from '@skytwin/shared-types';
import { TrustTier } from '@skytwin/shared-types';

/**
 * Create the events router for ingesting raw events.
 */
export function createEventsRouter(): Router {
  const router = Router();
  const interpreter = new SituationInterpreter();

  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());
  const policyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);
  const decisionMaker = new DecisionMaker(twinService, policyEvaluator, decisionRepositoryAdapter);
  const explanationGenerator = new ExplanationGenerator(explanationRepositoryAdapter);
  const eventsConfig = loadConfig();
  let ironclawAdapter: IronClawAdapter;

  if (eventsConfig.useMockIronclaw) {
    ironclawAdapter = new BasicMockAdapter();
  } else {
    const registry = new ActionHandlerRegistry();
    registry.register(new EmailActionHandler());
    registry.register(new CalendarActionHandler());
    registry.register(new GenericActionHandler());
    ironclawAdapter = new RealIronClawAdapter(registry);
  }

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

      // 1. Interpret the raw event
      const decision = interpreter.interpret(rawEvent);

      // 2. Get the twin profile (used internally for preferences)
      await twinService.getOrCreateProfile(userId);

      // 3. Get relevant preferences
      const preferences = await twinService.getRelevantPreferences(
        userId,
        decision.domain,
        decision.summary,
      );

      // 4. Fetch patterns, traits, and temporal profile for richer scoring
      const [patterns, traits, temporalProfile] = await Promise.all([
        twinService.getPatterns(userId),
        twinService.getTraits(userId),
        twinService.getTemporalProfile(userId),
      ]);

      // 5. Build decision context
      const context: DecisionContext = {
        userId,
        decision,
        trustTier: (rawEvent['trustTier'] as TrustTier) ?? TrustTier.LOW_AUTONOMY,
        relevantPreferences: preferences,
        timestamp: new Date(),
        patterns,
        traits,
        temporalProfile,
      };

      // 6. Evaluate through decision maker
      const outcome = await decisionMaker.evaluate(context);

      // 7. Generate explanation
      const explanation = await explanationGenerator.generate(
        decision,
        outcome,
        context,
      );

      // 8. Handle outcome
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

        // Auto-execute via IronClaw
        const plan = await ironclawAdapter.buildPlan(outcome.selectedAction);
        executionResult = await ironclawAdapter.execute(plan);

        // Persist execution plan and result
        const savedPlan = await executionRepository.createPlan({
          decisionId: decision.id,
          actionId: outcome.selectedAction.id,
          status: executionResult.status === 'completed' ? 'completed' : 'failed',
          steps: plan.steps ?? [],
        });
        await executionRepository.createResult({
          planId: savedPlan.id,
          success: executionResult.status === 'completed',
          outputs: executionResult.output ?? {},
          error: executionResult.error ?? undefined,
          rollbackAvailable: outcome.selectedAction.reversible,
        });
      }

      // 9. Return result
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
