import type { DecisionObject, DecisionContext, CandidateAction, TwinProfile } from '@skytwin/shared-types';
import type { CandidateGenerator } from './candidate-strategy.js';
import type { DecisionMaker } from '../decision-maker.js';

/**
 * Wraps the DecisionMaker's built-in rule-based candidate generation
 * so it can be used as a CandidateGenerator fallback.
 */
export class RuleBasedCandidateGenerator implements CandidateGenerator {
  constructor(private readonly decisionMaker: DecisionMaker) {}

  async generate(
    decision: DecisionObject,
    profile: TwinProfile,
    _context: DecisionContext,
  ): Promise<CandidateAction[]> {
    return this.decisionMaker.generateCandidates(decision, profile);
  }
}
