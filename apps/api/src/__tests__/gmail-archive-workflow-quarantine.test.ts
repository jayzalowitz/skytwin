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
  const buildPlan = vi.fn(async (action: CandidateAction) => ({
    id: 'plan-1', decisionId: action.decisionId, action,
    steps: [], rollbackSteps: [], createdAt: new Date(),
  }));
  const execute = vi.fn(async () => ({
    planId: 'plan-1', status: 'completed' as const,
    startedAt: new Date(), completedAt: new Date(),
  }));
  const addEvidence = vi.fn();
  const generate = vi.fn(async () => ({ id: 'explanation-1' }));
  return {
    buildPlan,
    execute,
    addEvidence,
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
        addEvidence,
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

describe('legacy API workflow Gmail archive quarantine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(workflowCases)('$name rejects archive before direct adapter work', async ({ run }) => {
    const fixture = dependencies(candidate('archive_email'));

    await expect(run(fixture.value)).rejects.toThrow(
      'archive_email is reserved for its dedicated execution lifecycle',
    );

    expect(fixture.buildPlan).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(fixture.addEvidence).not.toHaveBeenCalled();
  });

  it.each(workflowCases)('$name preserves unrelated direct execution', async ({ run }) => {
    const fixture = dependencies(candidate('label_email'));

    await expect(run(fixture.value)).resolves.toMatchObject({
      autoHandled: true,
      executionResult: { status: 'completed' },
    });

    expect(fixture.buildPlan).toHaveBeenCalledTimes(1);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(fixture.addEvidence).toHaveBeenCalledTimes(1);
  });

  it('does not invoke a hostile selected-action accessor', async () => {
    const getter = vi.fn(() => 'archive_email');
    const hostile = Object.defineProperty({}, 'actionType', {
      enumerable: true,
      get: getter,
    }) as unknown as CandidateAction;
    const fixture = dependencies(hostile);

    await expect(genericWorkflowHandler(
      { userId: 'user-1' }, fixture.value as never,
    )).rejects.toThrow('generic workflow selected an invalid action');
    expect(getter).not.toHaveBeenCalled();
    expect(fixture.buildPlan).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('keeps both direct adapter call sites behind the shared quarantine guard', async () => {
    const sources = await Promise.all([
      readFile(new URL('../workflows/email-triage.ts', import.meta.url), 'utf8'),
      readFile(new URL('../workflows/registry.ts', import.meta.url), 'utf8'),
    ]);
    for (const source of sources) {
      const guard = source.indexOf('assertGenericWorkflowActionAllowed(outcome.selectedAction)');
      const build = source.indexOf('.buildPlan(outcome.selectedAction)');
      expect(guard).toBeGreaterThan(-1);
      expect(build).toBeGreaterThan(guard);
      expect(source).not.toMatch(/GmailArchiveCallerKernel|gmail-archive-caller-kernel/);
    }
  });
});
