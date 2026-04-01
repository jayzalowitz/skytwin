import type { SkillGap } from '@skytwin/shared-types';

/**
 * Creates a SkillGap record when no adapter in the registry can handle an action.
 *
 * This function builds the SkillGap object in memory. Actual persistence to
 * CockroachDB should be performed by the caller via @skytwin/db.
 */
export function logSkillGap(
  actionType: string,
  actionDescription: string,
  attemptedAdapters: string[],
  userId: string,
  decisionId?: string,
): SkillGap {
  const id = `skill_gap_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  return {
    id,
    actionType,
    actionDescription,
    attemptedAdapters,
    userId,
    decisionId,
    loggedAt: new Date(),
  };
}
