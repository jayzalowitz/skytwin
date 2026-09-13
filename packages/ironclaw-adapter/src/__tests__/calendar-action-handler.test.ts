import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionStep } from '@skytwin/shared-types';
import { NoopCredentialProvider, type CredentialProvider } from '../credential-provider.js';
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
      dispatchCapability: 'dispatch-capability-1',
      dispatchLeaseGeneration: 'dispatch-generation-1',
    },
  };
}

describe('CalendarActionHandler credential dispatch', () => {
  it('returns a known failed result when credential resolution proves no request started', async () => {
    const handler = new CalendarActionHandler(new NoopCredentialProvider());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(handler.prepareRequestStart(makeStep())).rejects.toThrow('No credential');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps a started dispatch ambiguous on a provider timeout response and blocks replay', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 408 }));
    vi.stubGlobal('fetch', fetchMock);
    const credentialProvider: CredentialProvider = {
      getAccessToken: vi.fn().mockResolvedValue({
        success: true,
        accessToken: 'leased-access',
        oauthTokenId: 'oauth-1',
        credentialRevision: 'revision-1',
        accountEmail: 'work@example.com',
      }),
    };
    const handler = new CalendarActionHandler(credentialProvider);

    const step = makeStep();
    const preparation = await handler.prepareRequestStart(step);
    await expect(handler.execute(step, preparation)).rejects.toThrow('outcome is ambiguous');

    await expect(handler.execute(step, preparation)).rejects.toThrow('invalid or already consumed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
