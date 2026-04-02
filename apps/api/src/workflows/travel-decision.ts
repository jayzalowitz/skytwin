import { genericWorkflowHandler } from './registry.js';
import type { WorkflowDependencies, WorkflowResult } from './registry.js';

/**
 * Travel decision workflow handler.
 *
 * Enriches the event with travel-specific metadata before
 * running through the generic pipeline.
 */
export async function processTravelDecision(
  event: Record<string, unknown>,
  deps: WorkflowDependencies,
): Promise<WorkflowResult> {
  const enriched: Record<string, unknown> = {
    source: 'travel',
    type: 'travel_booking',
    ...event,
  };

  return genericWorkflowHandler(enriched, deps);
}
