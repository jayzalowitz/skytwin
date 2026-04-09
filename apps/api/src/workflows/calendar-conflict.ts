import { genericWorkflowHandler } from './registry.js';
import type { WorkflowDependencies, WorkflowResult } from './registry.js';

/**
 * Calendar workflow handler.
 *
 * Enriches the event with calendar-specific metadata before
 * running through the generic pipeline. Preserves the original
 * event type so the situation interpreter can sub-classify
 * (invite vs conflict vs update).
 */
export async function processCalendarConflict(
  event: Record<string, unknown>,
  deps: WorkflowDependencies,
): Promise<WorkflowResult> {
  const enriched: Record<string, unknown> = {
    source: 'calendar',
    type: event['type'] ?? 'calendar_event',
    ...event,
  };

  return genericWorkflowHandler(enriched, deps);
}
