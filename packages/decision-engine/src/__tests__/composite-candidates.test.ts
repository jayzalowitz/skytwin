import { describe, it, expect, vi } from 'vitest';
import { CompositeCandidateGenerator } from '../strategies/composite-candidates.js';
import { SituationType } from '@skytwin/shared-types';
import type {
  CandidateAction,
  DecisionObject,
  DecisionContext,
  TwinProfile,
} from '@skytwin/shared-types';

const fakeDecision = (): DecisionObject => ({
  id: 'd-1',
  domain: 'email',
  situationType: SituationType.EMAIL_TRIAGE,
  urgency: 'normal' as DecisionObject['urgency'],
  summary: 's',
  rawData: {},
  interpretedAt: new Date(),
});

const fakeProfile = (): TwinProfile => ({
  userId: 'u-1',
  preferences: [],
  patterns: [],
  traits: [],
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as TwinProfile);

const fakeContext = (): DecisionContext => ({
  userId: 'u-1',
  decision: fakeDecision(),
  trustTier: 'observer',
  relevantPreferences: [],
  timestamp: new Date(),
} as unknown as DecisionContext);

const fakeCandidate = (id: string, actionType: string): CandidateAction => ({
  id,
  decisionId: 'd-1',
  actionType,
  description: `${actionType} candidate`,
  domain: 'email',
  parameters: {},
  estimatedCostCents: 0,
  reversible: true,
  confidence: 'medium' as CandidateAction['confidence'],
  reasoning: 'test',
});

describe('CompositeCandidateGenerator', () => {
  it('runs all generators in parallel and concatenates their candidates', async () => {
    const genA = { generate: vi.fn().mockResolvedValue([fakeCandidate('a1', 'label_email')]) };
    const genB = { generate: vi.fn().mockResolvedValue([fakeCandidate('b1', 'draft_email')]) };
    const composite = new CompositeCandidateGenerator([genA, genB]);

    const result = await composite.generate(fakeDecision(), fakeProfile(), fakeContext());

    expect(result.map((c) => c.id)).toEqual(['a1', 'b1']);
    expect(genA.generate).toHaveBeenCalledOnce();
    expect(genB.generate).toHaveBeenCalledOnce();
  });

  it('preserves generator order (position is a documented contract)', async () => {
    // Order matters because some scoring code uses generator position as a
    // tiebreaker. Pin the contract: result[0] comes from generators[0],
    // result[1] from generators[1], etc.
    const genA = { generate: vi.fn().mockResolvedValue([fakeCandidate('a1', 'x'), fakeCandidate('a2', 'y')]) };
    const genB = { generate: vi.fn().mockResolvedValue([fakeCandidate('b1', 'z')]) };
    const composite = new CompositeCandidateGenerator([genA, genB]);

    const result = await composite.generate(fakeDecision(), fakeProfile(), fakeContext());

    expect(result.map((c) => c.id)).toEqual(['a1', 'a2', 'b1']);
  });

  it('drops a single generator failure without losing the others', async () => {
    // Composition must never amplify a single generator's hiccup into a
    // total outage. If genB throws (LLM timeout, memory backend error), the
    // user still gets the rule-based candidates from genA.
    const genA = { generate: vi.fn().mockResolvedValue([fakeCandidate('a1', 'label_email')]) };
    const genB = { generate: vi.fn().mockRejectedValue(new Error('LLM timed out')) };
    const composite = new CompositeCandidateGenerator([genA, genB]);

    const result = await composite.generate(fakeDecision(), fakeProfile(), fakeContext());

    expect(result.map((c) => c.id)).toEqual(['a1']);
  });

  it('returns [] for an empty generator list', async () => {
    const composite = new CompositeCandidateGenerator([]);
    const result = await composite.generate(fakeDecision(), fakeProfile(), fakeContext());
    expect(result).toEqual([]);
  });

  it('runs generators in parallel, not sequentially', async () => {
    // Pinning the parallel-execution contract: if `genB` waited on `genA`,
    // the total latency would be `tA + tB`. We measure that it's closer to
    // max(tA, tB) within a tolerance for setTimeout's resolution.
    let resolveA: () => void;
    const promiseA = new Promise<void>((r) => { resolveA = r; });
    let resolveB: () => void;
    const promiseB = new Promise<void>((r) => { resolveB = r; });
    const genA = { generate: vi.fn(async () => { await promiseA; return [fakeCandidate('a1', 'x')]; }) };
    const genB = { generate: vi.fn(async () => { await promiseB; return [fakeCandidate('b1', 'y')]; }) };
    const composite = new CompositeCandidateGenerator([genA, genB]);

    const inFlight = composite.generate(fakeDecision(), fakeProfile(), fakeContext());
    // If execution is sequential, genB.generate hasn't been called yet —
    // it's still waiting for genA to finish. If parallel, both have been
    // called. Give the event loop one tick to start both.
    await new Promise((r) => setImmediate(r));
    expect(genA.generate).toHaveBeenCalled();
    expect(genB.generate).toHaveBeenCalled();
    resolveA!();
    resolveB!();
    await inFlight;
  });
});
