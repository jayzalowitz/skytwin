import type {
  DecisionContext,
  DecisionOutcome,
  ExplanationRecord,
  ExecutionResult,
} from '@skytwin/shared-types';
import { TrustTier, SituationType } from '@skytwin/shared-types';
import type { SituationInterpreter, DecisionMaker } from '@skytwin/decision-engine';
import type { TwinService } from '@skytwin/twin-model';
import type { ExplanationGenerator } from '@skytwin/explanations';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';

/**
 * Common dependencies shared by all workflow handlers.
 */
export interface WorkflowDependencies {
  interpreter: SituationInterpreter;
  twinService: TwinService;
  decisionMaker: DecisionMaker;
  explanationGenerator: ExplanationGenerator;
  ironclawAdapter: IronClawAdapter;
}

/**
 * Standardized result from any workflow handler.
 */
export interface WorkflowResult {
  decisionId: string;
  situationType: SituationType;
  domain: string;
  outcome: DecisionOutcome;
  explanation: ExplanationRecord;
  executionResult: ExecutionResult | null;
  autoHandled: boolean;
}

/**
 * A workflow handler function processes a raw event through the full pipeline.
 */
export type WorkflowHandler = (
  event: Record<string, unknown>,
  dependencies: WorkflowDependencies,
) => Promise<WorkflowResult>;

/**
 * Registry mapping SituationType to workflow handlers.
 *
 * Generalizes the per-type workflow pattern so that adding a new
 * situation type only requires registering a handler function.
 */
export class WorkflowHandlerRegistry {
  private handlers = new Map<SituationType, WorkflowHandler>();
  private defaultHandler: WorkflowHandler;

  constructor() {
    this.defaultHandler = genericWorkflowHandler;
  }

  register(situationType: SituationType, handler: WorkflowHandler): void {
    this.handlers.set(situationType, handler);
  }

  get(situationType: SituationType): WorkflowHandler {
    return this.handlers.get(situationType) ?? this.defaultHandler;
  }

  has(situationType: SituationType): boolean {
    return this.handlers.has(situationType);
  }
}

/**
 * Generic workflow handler that works for any situation type.
 * Domain-specific handlers can override this with richer logic.
 */
export async function genericWorkflowHandler(
  event: Record<string, unknown>,
  deps: WorkflowDependencies,
): Promise<WorkflowResult> {
  const userId = event['userId'] as string;
  if (!userId) {
    throw new Error('Event must include a userId field');
  }

  const decision = deps.interpreter.interpret(event);
  await deps.twinService.getOrCreateProfile(userId);
  const preferences = await deps.twinService.getRelevantPreferences(
    userId,
    decision.domain,
    decision.summary,
  );

  const [patterns, traits, temporalProfile] = await Promise.all([
    deps.twinService.getPatterns(userId),
    deps.twinService.getTraits(userId),
    deps.twinService.getTemporalProfile(userId),
  ]);

  const trustTier = (event['trustTier'] as TrustTier) ?? TrustTier.MODERATE_AUTONOMY;
  const context: DecisionContext = {
    userId,
    decision,
    trustTier,
    relevantPreferences: preferences,
    timestamp: new Date(),
    patterns,
    traits,
    temporalProfile,
  };

  const outcome = await deps.decisionMaker.evaluate(context);

  let executionResult: ExecutionResult | null = null;
  if (outcome.autoExecute && outcome.selectedAction) {
    const plan = await deps.ironclawAdapter.buildPlan(outcome.selectedAction);
    executionResult = await deps.ironclawAdapter.execute(plan);
  }

  const explanation = await deps.explanationGenerator.generate(
    decision,
    outcome,
    context,
  );

  if (outcome.autoExecute && outcome.selectedAction) {
    await deps.twinService.addEvidence(userId, {
      id: `ev_${decision.situationType}_${decision.id}`,
      userId,
      source: `${decision.situationType}_workflow`,
      type: `auto_${outcome.selectedAction.actionType}`,
      data: {
        action: outcome.selectedAction.actionType,
        domain: decision.domain,
      },
      domain: decision.domain,
      timestamp: new Date(),
    });
  }

  return {
    decisionId: decision.id,
    situationType: decision.situationType,
    domain: decision.domain,
    outcome,
    explanation,
    executionResult,
    autoHandled: outcome.autoExecute,
  };
}
