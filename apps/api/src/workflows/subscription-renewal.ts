import { genericWorkflowHandler } from './registry.js';
import type { WorkflowDependencies, WorkflowResult } from './registry.js';

/**
 * Subscription renewal workflow handler.
 *
 * Enriches the event with subscription-specific metadata before
 * running through the generic pipeline.
 */
export async function processSubscriptionRenewal(
  event: Record<string, unknown>,
  deps: WorkflowDependencies,
): Promise<WorkflowResult> {
  const enriched: Record<string, unknown> = {
    source: 'billing',
    type: 'subscription_renewal',
    ...event,
  };

  return genericWorkflowHandler(enriched, deps);
}
