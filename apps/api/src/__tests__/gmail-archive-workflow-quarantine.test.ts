import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfidenceLevel,
  SituationType,
  type CandidateAction,
  type DecisionOutcome,
} from '@skytwin/shared-types';

const { findUser } = vi.hoisted(() => ({
  findUser: vi.fn(async () => ({ trust_tier: 'observer' })),
}));

vi.mock('@skytwin/db', () => ({
  userRepository: { findById: findUser },
}));

import { processEmailEvent } from '../workflows/email-triage.js';
import { genericWorkflowHandler } from '../workflows/registry.js';

function candidate(actionType: string): CandidateAction {
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    actionType,
    description: 'Email action',
    domain: 'email',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'test',
    provenance: 'user_originated',
  };
}

function outcome(selectedAction: CandidateAction): DecisionOutcome {
  return {
    id: 'outcome-1',
    decisionId: 'decision-1',
    selectedAction,
    allCandidates: [selectedAction],
    riskAssessment: null,
    autoExecute: true,
    requiresApproval: false,
    reasoning: 'test',
    decidedAt: new Date('2026-09-12T12:00:00.000Z'),
  };
}

function dependencies(selectedAction: CandidateAction) {
  const buildPlan = vi.fn();
  const execute = vi.fn();
  const generate = vi.fn(async () => ({ id: 'explanation-1' }));
  return {
    buildPlan,
    execute,
    generate,
    value: {
      interpreter: { interpret: vi.fn(async () => ({
        id: 'decision-1', situationType: SituationType.EMAIL_TRIAGE,
        domain: 'email', urgency: 'low', summary: 'Newsletter', rawData: {},
        interpretedAt: new Date(), provenance: 'user_originated',
      })) },
      twinService: {
        getOrCreateProfile: vi.fn(async () => ({ version: 1 })),
        getRelevantPreferences: vi.fn(async () => []),
        getPatterns: vi.fn(async () => []),
        getTraits: vi.fn(async () => []),
        getTemporalProfile: vi.fn(async () => undefined),
      },
      decisionMaker: { evaluate: vi.fn(async () => outcome(selectedAction)) },
      explanationGenerator: { generate },
      ironclawAdapter: {
        buildPlan,
        execute,
        getStatus: vi.fn(),
        rollback: vi.fn(),
        healthCheck: vi.fn(),
      },
    },
  };
}

const workflowCases = [
  {
    name: 'email triage',
    run: (value: unknown) => processEmailEvent({ userId: 'user-1' }, value as never),
  },
  {
    name: 'generic registry handler',
    run: (value: unknown) => genericWorkflowHandler({ userId: 'user-1' }, value as never),
  },
] as const;

describe('legacy API workflow execution quarantine', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(workflowCases)(
    '$name remains explanation-only for Gmail archive and unrelated actions',
    async ({ run }) => {
      for (const actionType of ['archive_email', 'label_email']) {
        const fixture = dependencies(candidate(actionType));
        await expect(run(fixture.value)).resolves.toMatchObject({
          autoHandled: false,
          executionResult: null,
        });
        expect(fixture.generate).toHaveBeenCalledTimes(1);
        expect(fixture.buildPlan).not.toHaveBeenCalled();
        expect(fixture.execute).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps both unmounted legacy workflows free of direct adapter dispatch', async () => {
    const sources = await Promise.all([
      readFile(new URL('../workflows/email-triage.ts', import.meta.url), 'utf8'),
      readFile(new URL('../workflows/registry.ts', import.meta.url), 'utf8'),
    ]);
    for (const source of sources) {
      expect(source).not.toContain('.buildPlan(');
      expect(source).not.toContain('.execute(');
      expect(source).toMatch(/receipt-backed ingest (route|path)/);
    }
  });
});
