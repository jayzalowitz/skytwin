import { Router } from 'express';
import { SituationInterpreter, DecisionMaker } from '@skytwin/decision-engine';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { ExplanationGenerator } from '@skytwin/explanations';
import {
  approvalRepository,
  oauthRepository,
  executionRepository,
  userRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  decisionRepositoryAdapter,
  explanationRepositoryAdapter,
  policyRepositoryAdapter,
} from '@skytwin/db';
import type { DecisionContext, RiskAssessment, DimensionAssessment } from '@skytwin/shared-types';
import { SituationType, TrustTier, RiskTier, RiskDimension } from '@skytwin/shared-types';
import { WorkflowHandlerRegistry } from '../workflows/registry.js';
import { processCalendarConflict } from '../workflows/calendar-conflict.js';
import { processSubscriptionRenewal } from '../workflows/subscription-renewal.js';
import { processGroceryReorder } from '../workflows/grocery-reorder.js';
import { processTravelDecision } from '../workflows/travel-decision.js';
import { getExecutionRouter } from '../execution-setup.js';

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
  // Set up workflow registry
  const workflowRegistry = new WorkflowHandlerRegistry();
  workflowRegistry.register(SituationType.CALENDAR_CONFLICT, processCalendarConflict);
  workflowRegistry.register(SituationType.SUBSCRIPTION_RENEWAL, processSubscriptionRenewal);
  workflowRegistry.register(SituationType.GROCERY_REORDER, processGroceryReorder);
  workflowRegistry.register(SituationType.TRAVEL_DECISION, processTravelDecision);

  const executionRouter = getExecutionRouter();

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
