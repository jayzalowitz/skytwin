import type { ActionIntent } from './intent-classifier.js';

/**
 * Outcome of routing a chat-detected `ActionIntent` through the
 * decision pipeline. Issue #148 v1.
 *
 * Three terminal states map to the chat surface:
 *
 *   - `requires-approval` — the decision engine selected an action but
 *     it needs the user to confirm. The route persists an
 *     `ApprovalRequest` and the chat reply links to `#/approvals`. This
 *     is the v1 default for ALL successful intents — even ones the
 *     engine would auto-execute on the events path. Conservative first
 *     cut: chat-driven actions never bypass user confirmation.
 *
 *   - `blocked` — every candidate action was denied by policy (trust
 *     tier too low, spend limit exceeded, domain blocked, etc.). The
 *     chat reply explains *why* without offering an approval link —
 *     there's nothing for the user to approve since the action would
 *     still be denied even with explicit consent.
 *
 *   - `no-action` — the engine couldn't generate any candidate actions
 *     for this intent. Falls through to the regular LLM chat reply.
 *     This is what happens when the rule-based classifier fired but
 *     the engine doesn't actually know how to handle the situation.
 */
export type ActionRouteOutcome =
  | {
      kind: 'requires-approval';
      /** ID of the persisted ApprovalRequest. The chat link uses this. */
      approvalRequestId: string;
      /** Human-readable summary for the chat bubble. */
      summary: string;
      /** Reasoning string from the decision engine, surfaced in the bubble. */
      reasoning: string;
    }
  | {
      kind: 'blocked';
      /** Why the action was blocked — pulled from the policy verdict. */
      reason: string;
    }
  | {
      kind: 'no-action';
    };

/**
 * Port the assistant uses to route a chat-detected `ActionIntent`
 * through the decision engine. Issue #148 v1.
 *
 * The implementation lives in `apps/api/src/routes/assistant.ts` (it's
 * the only place with `@skytwin/decision-engine` + `@skytwin/db` deps
 * wired up). Keeping the contract here keeps `@skytwin/assistant` free
 * of those deps and lets the service unit-test against a stub.
 */
export interface ActionRouter {
  /**
   * Route an intent through `DecisionMaker.evaluate()`, persist any
   * resulting `ExplanationRecord` + `ApprovalRequest`, and return the
   * chat-surfaceable outcome.
   *
   * Throws when the underlying decision engine throws (e.g. trust tier
   * lookup failure). The `AssistantService.routeIntent` caller catches
   * that and returns `{ kind: 'no-action' }` so the chat falls through
   * to the LLM reply rather than blowing up the whole turn.
   */
  route(userId: string, intent: ActionIntent): Promise<ActionRouteOutcome>;
}
