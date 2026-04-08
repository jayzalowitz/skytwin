import type { DecisionObject } from '@skytwin/shared-types';

/**
 * Strategy interface for interpreting raw events into DecisionObjects.
 */
export interface SituationStrategy {
  interpret(rawEvent: Record<string, unknown>): Promise<DecisionObject>;
}
