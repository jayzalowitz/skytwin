import { genericWorkflowHandler } from './registry.js';
import type { WorkflowDependencies, WorkflowResult } from './registry.js';

/**
 * Grocery reorder workflow handler.
 *
 * Enriches the event with grocery/shopping-specific metadata before
 * running through the generic pipeline.
 */
export async function processGroceryReorder(
  event: Record<string, unknown>,
  deps: WorkflowDependencies,
): Promise<WorkflowResult> {
  const enriched: Record<string, unknown> = {
    source: 'shopping',
    type: 'grocery_reorder',
    ...event,
  };

  return genericWorkflowHandler(enriched, deps);
}
