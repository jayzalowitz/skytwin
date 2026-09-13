import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionStep } from '@skytwin/shared-types';
import type { CredentialProvider } from '../credential-provider.js';
import { CalendarActionHandler } from '../handlers/calendar-action-handler.js';

function makeStep(): ExecutionStep {
  return {
    id: 'step-1',
    order: 1,
    type: 'accept_invite',
    description: 'Accept the calendar invitation',
    timeout: 30_000,
    parameters: {
      actionType: 'accept_invite',
      userId: 'user-1',
      eventId: 'event-1',
      credentialDecisionId: 'decision-1',
      credentialActionId: 'action-1',
      credentialExecutionPlanId: 'plan-1',
      credentialAuthorityRevision: 'authority-revision-1',
      credentialPolicyAuthorityRevision: 'policy-revision-1',
    },
  };
}

describe('CalendarActionHandler credential dispatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a started dispatch ambiguous on a provider timeout response and blocks replay', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 408 }));
    vi.stubGlobal('fetch', fetchMock);
    const startDispatch = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        accessToken: 'leased-access',
        oauthTokenId: 'oauth-1',
        credentialRevision: 'revision-1',
        accountEmail: 'work@example.com',
        capability: 'capability-1',
        leaseGeneration: 'lease-generation-1',
        executionPlanId: 'plan-1',
        userId: 'user-1',
      })
      .mockResolvedValueOnce({ success: false, error: 'Execution credential lease already exists.' });
    const terminalizeDispatch = vi.fn().mockResolvedValue(true);
    const credentialProvider: CredentialProvider = {
      getAccessToken: vi.fn(),
      startDispatch,
      terminalizeDispatch,
    };
    const handler = new CalendarActionHandler(credentialProvider);

    await expect(handler.execute(makeStep())).rejects.toThrow('outcome is ambiguous');
    expect(terminalizeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'capability-1' }),
      'ambiguous',
    );
    expect(terminalizeDispatch).not.toHaveBeenCalledWith(expect.anything(), 'failed');

    await expect(handler.execute(makeStep())).rejects.toThrow('already exists');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
