import type { DecisionObject, DecisionContext, CandidateAction, TwinProfile } from '@skytwin/shared-types';
import type { SituationStrategy } from './situation-strategy.js';
import type { CandidateGenerator } from './candidate-strategy.js';

/**
 * Wraps a primary strategy with a fallback.
 * If the primary (e.g., LLM) throws, falls back to the secondary (e.g., rule-based).
 */
export class FallbackSituationStrategy implements SituationStrategy {
  constructor(
    private readonly primary: SituationStrategy,
    private readonly fallback: SituationStrategy,
  ) {}

  async interpret(rawEvent: Record<string, unknown>): Promise<DecisionObject> {
    try {
      return await this.primary.interpret(rawEvent);
    } catch (err) {
      console.warn(
        `[strategy] LLM situation interpretation failed, using rule-based fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.fallback.interpret(rawEvent);
    }
  }
}

/**
 * Wraps a primary candidate generator with a fallback.
 */
export class FallbackCandidateGenerator implements CandidateGenerator {
  constructor(
    private readonly primary: CandidateGenerator,
    private readonly fallback: CandidateGenerator,
  ) {}

  async generate(
    decision: DecisionObject,
    profile: TwinProfile,
    context: DecisionContext,
  ): Promise<CandidateAction[]> {
    try {
      return await this.primary.generate(decision, profile, context);
    } catch (err) {
      console.warn(
        `[strategy] LLM candidate generation failed, using rule-based fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.fallback.generate(decision, profile, context);
    }
  }
}
