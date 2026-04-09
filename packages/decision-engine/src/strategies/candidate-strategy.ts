import type { DecisionObject, DecisionContext, CandidateAction, TwinProfile } from '@skytwin/shared-types';

/**
 * Strategy interface for generating candidate actions.
 */
export interface CandidateGenerator {
  generate(
    decision: DecisionObject,
    profile: TwinProfile,
    context: DecisionContext,
  ): Promise<CandidateAction[]>;
}
