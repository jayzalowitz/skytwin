import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';
import {
  didCredentialRequestStart,
  type CredentialProvider,
} from '../credential-provider.js';
import {
  PreRequestExecutionError,
  type ExecutionRequestPreparation,
} from '../ironclaw-adapter.js';

interface ResolvedCredential {
  accessToken: string;
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
  private readonly preparedCredentials = new WeakMap<object, ResolvedCredential>();

  constructor(private readonly credentialProvider?: CredentialProvider) {
    this.supportsRollback = !credentialProvider;
  }

  canHandle(actionType: string): boolean {
    return [
      'accept_invite', 'decline_invite', 'propose_alternative',
      'tentative_accept', 'acknowledge', 'dismiss',
    ].includes(actionType);
  }

  async prepareRequestStart(step: ExecutionStep): Promise<ExecutionRequestPreparation> {
    if (!this.credentialProvider) return {};
    const userId = step.parameters['userId'];
    if (typeof userId !== 'string') {
      throw new PreRequestExecutionError('Credential dispatch owner is missing.');
    }
    const ready = await this.credentialProvider.getAccessToken(
      userId,
      'google',
      typeof step.parameters['accountEmail'] === 'string'
        ? step.parameters['accountEmail'] : undefined,
    );
    if (!ready.success) {
      if (didCredentialRequestStart(ready) === false) {
        throw new PreRequestExecutionError(ready.error);
      }
      throw new Error(ready.error);
    }
    if (!ready.oauthTokenId || !ready.credentialRevision) {
      throw new PreRequestExecutionError('OAuth credential is missing required dispatch identity.');
    }
    const proof = {};
    this.preparedCredentials.set(proof, { accessToken: ready.accessToken });
    return {
      proof,
      credentialBinding: {
        provider: 'google',
        ...(ready.accountEmail ? { accountEmail: ready.accountEmail } : {}),
        oauthTokenId: ready.oauthTokenId,
        credentialRevision: ready.credentialRevision,
        ...(ready.vaultGeneration ? { vaultGeneration: ready.vaultGeneration } : {}),
      },
    };
  }

  async execute(
    step: ExecutionStep,
    preparation?: ExecutionRequestPreparation,
  ): Promise<StepResult> {
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

    let credential: ResolvedCredential;
    if (this.credentialProvider) {
      const proof = preparation?.proof;
      if (typeof proof !== 'object' || proof === null) {
        throw new Error('Prepared OAuth credential proof is missing.');
      }
      const prepared = this.preparedCredentials.get(proof);
      this.preparedCredentials.delete(proof);
      if (!prepared) throw new Error('Prepared OAuth credential proof is invalid or already consumed.');
      credential = prepared;
    } else {
      const accessToken = step.parameters['accessToken'];
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        return { success: false, error: 'Missing accessToken — no OAuth token available for Google Calendar.' };
      }
      credential = { accessToken };
    }
    let result: StepResult;

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
        const dispatchCapability = step.parameters['dispatchCapability'];
        const dispatchLeaseGeneration = step.parameters['dispatchLeaseGeneration'];
        if (typeof decisionId !== 'string' || typeof actionId !== 'string' ||
            typeof executionPlanId !== 'string' || typeof authorityRevision !== 'string' ||
            typeof policyAuthorityRevision !== 'string' ||
            typeof dispatchCapability !== 'string' ||
            typeof dispatchLeaseGeneration !== 'string' ||
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
          dispatchCapability,
          dispatchLeaseGeneration,
        });
        if (!result.success) {
          if (didCredentialRequestStart(result) === false) {
            throw new PreRequestExecutionError(result.error);
          }
          throw new Error(result.error);
        }
        return { accessToken: result.accessToken };
      }
      const result = await this.credentialProvider.getAccessToken(userId, 'google');
      if (!result.success) throw new Error(result.error);
      return { accessToken: result.accessToken };
    }

    const accessToken = step.parameters['accessToken'] as string | undefined;
    if (!accessToken) {
      throw new PreRequestExecutionError('Missing accessToken — no OAuth token available for Google Calendar.');
    }
    return { accessToken };
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
