import { genericWorkflowHandler } from './registry.js';
import type { WorkflowDependencies, WorkflowResult } from './registry.js';

/**
 * Calendar conflict workflow handler.
 *
 * Enriches the event with calendar-specific metadata before
 * running through the generic pipeline.
 */
export async function processCalendarConflict(
  event: Record<string, unknown>,
  deps: WorkflowDependencies,
): Promise<WorkflowResult> {
  const enriched: Record<string, unknown> = {
    source: 'calendar',
    type: 'calendar_conflict',
    ...event,
  };

  return genericWorkflowHandler(enriched, deps);
}
