import { describe, expect, it } from 'vitest';
import { ConfidenceLevel, type CandidateAction } from '@skytwin/shared-types';
import { createWorkerExecutionAdmissionGuard } from '../execution-account-boundary.js';

function action(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    actionType: 'create_task',
    description: 'Create a local task',
    domain: 'tasks',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Requested by the user',
    provenance: 'user_originated',
    ...overrides,
  };
}

describe('createWorkerExecutionAdmissionGuard', () => {
  it('denies an account-backed selected adapter for a neutral action while disabled', async () => {
    const guard = createWorkerExecutionAdmissionGuard('disabled');

    expect(await guard(action(), 'user-1', 'outlook')).toMatchObject({
      allowed: false,
    });
  });

  it('denies account action vocabulary before adapter selection while disabled', async () => {
    const guard = createWorkerExecutionAdmissionGuard('disabled');

    expect(await guard(action({ actionType: 'groups_events_list' }), 'user-1'))
      .toMatchObject({ allowed: false });
  });

  it('allows a neutral action through a neutral selected adapter while disabled', async () => {
    const guard = createWorkerExecutionAdmissionGuard('disabled');

    expect(await guard(action(), 'user-1', 'direct')).toEqual({ allowed: true });
  });

  it('preserves both action and adapter paths in exact experimental mode', async () => {
    const guard = createWorkerExecutionAdmissionGuard('experimental');

    expect(await guard(
      action({ actionType: 'send_email', domain: 'email' }),
      'user-1',
      'outlook',
    )).toEqual({ allowed: true });
  });
});
