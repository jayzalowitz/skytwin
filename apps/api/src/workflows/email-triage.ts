import type {
  DecisionContext,
  DecisionOutcome,
  ExplanationRecord,
  ExecutionResult,
} from '@skytwin/shared-types';
import { TrustTier } from '@skytwin/shared-types';
import type { SituationInterpreter, DecisionMaker } from '@skytwin/decision-engine';
import type { TwinService } from '@skytwin/twin-model';
import type { ExplanationGenerator } from '@skytwin/explanations';
import type { IronClawAdapter } from '@skytwin/ironclaw-adapter';
import { userRepository } from '@skytwin/db';

/**
 * Dependencies required by the email triage workflow.
 */
export interface EmailTriageDependencies {
  interpreter: SituationInterpreter;
  twinService: TwinService;
  decisionMaker: DecisionMaker;
  explanationGenerator: ExplanationGenerator;
  ironclawAdapter: IronClawAdapter;
}

/**
 * Result of processing an email event through the triage workflow.
 */
export interface EmailTriageResult {
  /** The structured decision object */
  decisionId: string;
  /** The outcome from the decision engine */
  outcome: DecisionOutcome;
  /** The explanation record for audit */
  explanation: ExplanationRecord;
  /** The execution result, if the action was auto-executed */
  executionResult: ExecutionResult | null;
  /** Whether the email was auto-handled or needs user attention */
  autoHandled: boolean;
}

/**
 * Process an email event through the complete triage workflow.
 *
 * This orchestrates the full pipeline:
 * 1. Receive raw email event
 * 2. SituationInterpreter classifies it
 * 3. TwinService retrieves relevant preferences
 * 4. DecisionMaker evaluates (generates candidates, assesses risk, checks policies)
 * 5. PolicyEngine validates (done inside DecisionMaker)
 * 6. If approved: IronClaw adapter executes (archive, draft reply, etc.)
 * 7. ExplanationGenerator creates audit record
 * 8. All state persisted to DB (done by services internally)
 */
export async function processEmailEvent(
  event: Record<string, unknown>,
  dependencies: EmailTriageDependencies,
): Promise<EmailTriageResult> {
  const {
    interpreter,
    twinService,
    decisionMaker,
    explanationGenerator,
    ironclawAdapter,
  } = dependencies;

  const userId = event['userId'] as string;
  if (!userId) {
    throw new Error('Email event must include a userId field');
  }

  // Step 1: Interpret the raw email event
  const decision = await interpreter.interpret({
    source: 'email',
    type: 'email_received',
    ...event,
  });

  console.info(
    `[email-triage] Interpreted email: ${decision.situationType} / ${decision.urgency} - "${decision.summary}"`,
  );

  // Step 2: Get twin profile and relevant preferences
  const profile = await twinService.getOrCreateProfile(userId);
  const preferences = await twinService.getRelevantPreferences(
    userId,
    decision.domain,
    decision.summary,
  );

  console.info(
    `[email-triage] Twin profile v${profile.version}: ${preferences.length} relevant preferences`,
  );

  // Step 3: Build decision context
  // Trust tier must come from DB, never from the event payload
  const user = await userRepository.findById(userId);
  const trustTier = (user?.trust_tier as TrustTier) ?? TrustTier.OBSERVER;
  const context: DecisionContext = {
    userId,
    decision,
    trustTier,
    relevantPreferences: preferences,
    timestamp: new Date(),
  };

  // Step 4: Run through DecisionMaker (which internally generates candidates,
  // assesses risk, and checks policies via PolicyEvaluator)
  const outcome = await decisionMaker.evaluate(context);

  console.info(
    `[email-triage] Decision outcome: autoExecute=${outcome.autoExecute}, ` +
    `requiresApproval=${outcome.requiresApproval}, ` +
    `action=${outcome.selectedAction?.actionType ?? 'none'}`,
  );

  // Step 5: Execute if auto-approved
  let executionResult: ExecutionResult | null = null;

  if (outcome.autoExecute && outcome.selectedAction) {
    console.info(
      `[email-triage] Auto-executing: ${outcome.selectedAction.actionType} - ${outcome.selectedAction.description}`,
    );

    const plan = await ironclawAdapter.buildPlan(outcome.selectedAction);
    executionResult = await ironclawAdapter.execute(plan);

    console.info(
      `[email-triage] Execution result: status=${executionResult.status}`,
    );
  }

  // Step 6: Generate explanation for audit
  const explanation = await explanationGenerator.generate(
    decision,
    outcome,
    context,
  );

  console.info(
    `[email-triage] Explanation generated: risk=${explanation.riskTier}, ` +
    `confidence=${explanation.overallConfidence}`,
  );

  // Step 7: If the event should be treated as evidence, update the twin
  if (outcome.autoExecute && outcome.selectedAction) {
    // The fact that we auto-executed is itself evidence about user preferences
    await twinService.addEvidence(userId, {
      id: `ev_email_${decision.id}`,
      userId,
      source: 'email_triage_workflow',
      type: `auto_${outcome.selectedAction.actionType}`,
      data: {
        action: outcome.selectedAction.actionType,
        domain: decision.domain,
        emailFrom: event['from'],
        emailCategory: event['category'],
      },
      domain: decision.domain,
      timestamp: new Date(),
    });
  }

  return {
    decisionId: decision.id,
    outcome,
    explanation,
    executionResult,
    autoHandled: outcome.autoExecute,
  };
}
