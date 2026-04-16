import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';
import type { CredentialProvider } from '../credential-provider.js';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/**
 * Handler for calendar actions via the Google Calendar API.
 */
export class CalendarActionHandler implements ActionHandler {
  readonly actionType = 'calendar';
  readonly domain = 'calendar';

  constructor(private readonly credentialProvider?: CredentialProvider) {}

  canHandle(actionType: string): boolean {
    return [
      'accept_invite', 'decline_invite', 'propose_alternative',
      'tentative_accept', 'acknowledge', 'dismiss',
    ].includes(actionType);
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    const actionType = (step.parameters['actionType'] as string) ?? step.type;
    const accessToken = await this.resolveAccessToken(step);
    const eventId = step.parameters['eventId'] as string | undefined;

    if (!eventId) {
      return { success: false, error: 'Missing eventId in step parameters' };
    }

    switch (actionType) {
      case 'accept_invite':
        return this.respondToEvent(accessToken, eventId, 'accepted');
      case 'decline_invite':
        return this.respondToEvent(accessToken, eventId, 'declined');
      case 'propose_alternative':
        return this.proposeAlternative(accessToken, eventId, step.parameters);
      case 'tentative_accept':
        return this.respondToEvent(accessToken, eventId, 'tentative');
      case 'acknowledge':
      case 'dismiss':
        return { success: true, output: { action: actionType, eventId } };
      default:
        return { success: false, error: `Unknown calendar action: ${actionType}` };
    }
  }

  async rollback(step: ExecutionStep): Promise<StepResult> {
    const accessToken = await this.resolveAccessToken(step);
    const eventId = step.parameters['eventId'] as string | undefined;

    if (!eventId) {
      return { success: false, error: 'Missing eventId for rollback' };
    }

    // Reset response to needsAction
    return this.respondToEvent(accessToken, eventId, 'needsAction');
  }

  private async resolveAccessToken(step: ExecutionStep): Promise<string> {
    const userId = step.parameters['userId'] as string | undefined;
    if (this.credentialProvider && userId) {
      const result = await this.credentialProvider.getAccessToken(userId, 'google');
      if (!result.success) throw new Error(result.error);
      return result.accessToken;
    }

    const accessToken = step.parameters['accessToken'] as string | undefined;
    if (!accessToken) {
      throw new Error('Missing accessToken — no OAuth token available for Google Calendar.');
    }
    return accessToken;
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
