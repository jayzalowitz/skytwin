import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';
import type { CredentialDispatchResult, CredentialProvider } from '../credential-provider.js';

interface ResolvedCredential {
  accessToken: string;
  grant?: CredentialDispatchResult;
}

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

function throwIfProviderOutcomeIsAmbiguous(status: number): void {
  if (status === 408 || status === 429 || status >= 500) {
    throw new Error(`Calendar API returned ${status} after request start; outcome is ambiguous.`);
  }
}

/**
 * Handler for calendar actions via the Google Calendar API.
 */
export class CalendarActionHandler implements ActionHandler {
  readonly actionType = 'calendar';
  readonly domain = 'calendar';
  readonly supportsRollback: boolean;

  constructor(private readonly credentialProvider?: CredentialProvider) {
    this.supportsRollback = !credentialProvider;
  }

  canHandle(actionType: string): boolean {
    return [
      'accept_invite', 'decline_invite', 'propose_alternative',
      'tentative_accept', 'acknowledge', 'dismiss',
    ].includes(actionType);
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    const actionType = (step.parameters['actionType'] as string) ?? step.type;
    const eventId = step.parameters['eventId'] as string | undefined;

    if (!eventId) {
      return { success: false, error: 'Missing eventId in step parameters' };
    }

    if (actionType === 'acknowledge' || actionType === 'dismiss') {
      return { success: true, output: { action: actionType, eventId } };
    }
    if (!new Set(['accept_invite', 'decline_invite', 'propose_alternative', 'tentative_accept'])
      .has(actionType)) {
      return { success: false, error: `Unknown calendar action: ${actionType}` };
    }

    const credential = await this.resolveAccessToken(step, true);
    let result: StepResult;

    try {
      switch (actionType) {
        case 'accept_invite':
          result = await this.respondToEvent(credential.accessToken, eventId, 'accepted');
          break;
        case 'decline_invite':
          result = await this.respondToEvent(credential.accessToken, eventId, 'declined');
          break;
        case 'propose_alternative':
          result = await this.proposeAlternative(credential.accessToken, eventId, step.parameters);
          break;
        case 'tentative_accept':
          result = await this.respondToEvent(credential.accessToken, eventId, 'tentative');
          break;
        default:
          throw new Error('Validated calendar action was not dispatched.');
      }
    } catch (error) {
      await this.finishDispatch(credential.grant, 'ambiguous');
      throw error;
    }
    await this.finishDispatch(credential.grant, result.success ? 'completed' : 'failed');
    return result;
  }

  async rollback(step: ExecutionStep): Promise<StepResult> {
    if (this.credentialProvider) {
      return {
        success: false,
        error: 'Credential-backed rollback requires a separately admitted dispatch authority.',
      };
    }
    const { accessToken } = await this.resolveAccessToken(step, false);
    const eventId = step.parameters['eventId'] as string | undefined;

    if (!eventId) {
      return { success: false, error: 'Missing eventId for rollback' };
    }

    // Reset response to needsAction
    return this.respondToEvent(accessToken, eventId, 'needsAction');
  }

  private async resolveAccessToken(
    step: ExecutionStep,
    requireDispatchLease: boolean,
  ): Promise<ResolvedCredential> {
    const userId = step.parameters['userId'] as string | undefined;
    if (this.credentialProvider && userId) {
      if (requireDispatchLease) {
        const decisionId = step.parameters['credentialDecisionId'];
        const actionId = step.parameters['credentialActionId'];
        const executionPlanId = step.parameters['credentialExecutionPlanId'];
        const authorityRevision = step.parameters['credentialAuthorityRevision'];
        const policyAuthorityRevision = step.parameters['credentialPolicyAuthorityRevision'];
        if (typeof decisionId !== 'string' || typeof actionId !== 'string' ||
            typeof executionPlanId !== 'string' || typeof authorityRevision !== 'string' ||
            typeof policyAuthorityRevision !== 'string' ||
            !this.credentialProvider.startDispatch) {
          throw new Error('Credential dispatch authority is missing.');
        }
        const result = await this.credentialProvider.startDispatch({
          userId,
          provider: 'google',
          accountEmail: typeof step.parameters['accountEmail'] === 'string'
            ? step.parameters['accountEmail'] : undefined,
          decisionId,
          actionId,
          executionPlanId,
          authorityRevision,
          policyAuthorityRevision,
        });
        if (!result.success) throw new Error(result.error);
        return { accessToken: result.accessToken, grant: result };
      }
      const result = await this.credentialProvider.getAccessToken(userId, 'google');
      if (!result.success) throw new Error(result.error);
      return { accessToken: result.accessToken };
    }

    const accessToken = step.parameters['accessToken'] as string | undefined;
    if (!accessToken) {
      throw new Error('Missing accessToken — no OAuth token available for Google Calendar.');
    }
    return { accessToken };
  }

  private async finishDispatch(
    grant: CredentialDispatchResult | undefined,
    state: 'completed' | 'failed' | 'ambiguous',
  ): Promise<void> {
    if (!grant) return;
    const persisted = await this.credentialProvider?.terminalizeDispatch?.(grant, state);
    if (!persisted) throw new Error('Credential dispatch terminal state could not be persisted.');
  }

  private async respondToEvent(
    accessToken: string,
    eventId: string,
    responseStatus: string,
  ): Promise<StepResult> {
    const calendarId = 'primary';
    const url = `${CALENDAR_API}/calendars/${calendarId}/events/${eventId}?sendUpdates=all`;

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        attendees: [{ self: true, responseStatus }],
      }),
    });

    if (!response.ok) {
      throwIfProviderOutcomeIsAmbiguous(response.status);
      return { success: false, error: `Calendar API respond failed: ${response.status}` };
    }

    return {
      success: true,
      output: { action: 'response_updated', eventId, responseStatus },
    };
  }

  private async proposeAlternative(
    accessToken: string,
    eventId: string,
    parameters: Record<string, unknown>,
  ): Promise<StepResult> {
    // Decline the original and note proposed times
    const declineResult = await this.respondToEvent(accessToken, eventId, 'tentative');
    if (!declineResult.success) return declineResult;

    return {
      success: true,
      output: {
        action: 'alternative_proposed',
        eventId,
        suggestedTimes: parameters['suggestedTimes'] ?? [],
        note: 'Set to tentative. Suggested alternatives should be communicated separately.',
      },
    };
  }
}
