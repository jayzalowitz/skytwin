import type {
  DecisionObject,
  DecisionContext,
  CandidateAction,
  TwinProfile,
} from '@skytwin/shared-types';
import type { CandidateGenerator } from './candidate-strategy.js';

/**
 * Runs N candidate generators in parallel and concatenates their results.
 *
 * Unlike `FallbackCandidateGenerator` (which is "primary OR fallback"),
 * this is "primary AND alongside" — every generator runs, every generator's
 * candidates land in the merged list. The DecisionMaker's scoring layer
 * picks the best candidate from the union.
 *
 * Used to wire the `DraftEmailCandidateGenerator` alongside the rule-based
 * or LLM-based primary strategy: the rule-based generator emits
 * `label_email` / `archive` candidates, the draft generator emits an
 * additional `draft_email` candidate, and the engine selects whichever
 * scores highest.
 *
 * Behaviour:
 *   - Generators are awaited in parallel via `Promise.all`. The slowest
 *     dominates the latency, but the alternative — sequential await — adds
 *     `n * mean_latency` to every decision.
 *   - If a generator throws, that generator's contribution is dropped and
 *     the others still land. Composition must never amplify one
 *     generator's failure into a total outage. Errors are caught but NOT
 *     logged here (the decision-engine package doesn't pull a logger);
 *     callers wrap us if they want telemetry.
 *   - Order is preserved: the first generator's candidates appear first
 *     in the merged list, then the second's, etc. Some scoring code
 *     uses position as a tiebreaker, so the order is documented contract.
 */
export class CompositeCandidateGenerator implements CandidateGenerator {
  constructor(private readonly generators: readonly CandidateGenerator[]) {}

  async generate(
    decision: DecisionObject,
    profile: TwinProfile,
    context: DecisionContext,
  ): Promise<CandidateAction[]> {
    if (this.generators.length === 0) return [];
    const results = await Promise.all(
      this.generators.map((gen) =>
        gen.generate(decision, profile, context).catch(() => [] as CandidateAction[]),
      ),
    );
    return results.flat();
  }
}
