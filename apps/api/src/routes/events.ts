import { Router } from 'express';
import { SituationInterpreter, DecisionMaker } from '@skytwin/decision-engine';
import { TwinService } from '@skytwin/twin-model';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { ExplanationGenerator } from '@skytwin/explanations';
import { BasicMockAdapter } from '@skytwin/ironclaw-adapter';
import {
  twinRepository,
  decisionRepository,
  policyRepository,
  explanationRepository,
} from '@skytwin/db';
import type { DecisionContext } from '@skytwin/shared-types';
import { TrustTier } from '@skytwin/shared-types';

/**
 * Create the events router for ingesting raw events.
 */
export function createEventsRouter(): Router {
  const router = Router();
  const interpreter = new SituationInterpreter();

  // The DB repositories have a different shape than the Port interfaces
  // expected by the service classes. At runtime they're compatible for the
  // methods actually called; the `as never` cast bridges the compile-time gap
  // until proper adapter wrappers are built.
  const twinService = new TwinService(twinRepository as never);
  const policyEvaluator = new PolicyEvaluator(policyRepository as never);
  const decisionMaker = new DecisionMaker(twinService, policyEvaluator, decisionRepository as never);
  const explanationGenerator = new ExplanationGenerator(explanationRepository as never);
  const ironclawAdapter = new BasicMockAdapter();

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

      // 4. Build decision context
      const context: DecisionContext = {
        userId,
        decision,
        trustTier: (rawEvent['trustTier'] as TrustTier) ?? TrustTier.LOW_AUTONOMY,
        relevantPreferences: preferences,
        timestamp: new Date(),
      };

      // 5. Evaluate through decision maker
      const outcome = await decisionMaker.evaluate(context);

      // 6. Generate explanation
      const explanation = await explanationGenerator.generate(
        decision,
        outcome,
        context,
      );

      // 7. Handle outcome
      let executionResult = null;

      if (outcome.autoExecute && outcome.selectedAction) {
        // Auto-execute via IronClaw
        const plan = await ironclawAdapter.buildPlan(outcome.selectedAction);
        executionResult = await ironclawAdapter.execute(plan);
      }

      // 8. Return result
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
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
