import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';
import type { CredentialProvider } from '../credential-provider.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

/**
 * Handler for email actions via the Gmail API.
 * Handles archive, label, send_reply, and delete operations.
 */
export class EmailActionHandler implements ActionHandler {
  readonly actionType = 'email';
  readonly domain = 'email';

  constructor(private readonly credentialProvider?: CredentialProvider) {}

  canHandle(actionType: string): boolean {
    return ['archive_email', 'label_email', 'send_reply', 'delete_email'].includes(actionType);
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    const actionType = (step.parameters['actionType'] as string) ?? step.type;
    const accessToken = await this.resolveAccessToken(step);
    const messageId = step.parameters['emailId'] as string | undefined;

    if (!messageId) {
      throw new Error('Missing emailId in step parameters');
    }

    switch (actionType) {
      case 'archive_email':
        return this.archiveEmail(accessToken, messageId);
      case 'label_email':
        return this.labelEmail(
          accessToken,
          messageId,
          step.parameters['labels'] as string[] ?? [],
        );
      case 'send_reply':
        return this.sendReply(
          accessToken,
          messageId,
          step.parameters['replyType'] as string ?? 'acknowledgment',
        );
      case 'delete_email':
        return this.deleteEmail(accessToken, messageId);
      default:
        return { success: false, error: `Unknown email action: ${actionType}` };
    }
  }

  async rollback(step: ExecutionStep): Promise<StepResult> {
    const originalAction = (step.parameters['originalActionType'] as string) ?? step.type;
    const accessToken = await this.resolveAccessToken(step);
    const messageId = step.parameters['emailId'] as string | undefined;

    if (!messageId) {
      return { success: false, error: 'Missing emailId for rollback' };
    }

    switch (originalAction) {
      case 'archive_email':
        // Un-archive: add INBOX label back
        return this.modifyLabels(accessToken, messageId, ['INBOX'], []);
      case 'label_email':
        // Remove added labels
        return this.modifyLabels(
          accessToken,
          messageId,
          [],
          step.parameters['labels'] as string[] ?? [],
        );
      default:
        return { success: false, error: `Cannot rollback action: ${originalAction}` };
    }
  }

  private async resolveAccessToken(step: ExecutionStep): Promise<string> {
    const userId = step.parameters['userId'] as string | undefined;
    if (this.credentialProvider && userId) {
      return this.credentialProvider.getAccessToken(userId, 'google');
    }

    const accessToken = step.parameters['accessToken'] as string | undefined;
    if (!accessToken) {
      throw new Error('Missing accessToken — no OAuth token available for Gmail. Falling back to next adapter.');
    }
    return accessToken;
  }

  private async archiveEmail(accessToken: string, messageId: string): Promise<StepResult> {
    return this.modifyLabels(accessToken, messageId, [], ['INBOX']);
  }

  private async labelEmail(accessToken: string, messageId: string, labels: string[]): Promise<StepResult> {
    return this.modifyLabels(accessToken, messageId, labels, []);
  }

  private async deleteEmail(accessToken: string, messageId: string): Promise<StepResult> {
    const url = `${GMAIL_API}/users/me/messages/${messageId}/trash`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      return { success: false, error: `Gmail trash failed: ${response.status}` };
    }

    return { success: true, output: { action: 'trashed', messageId } };
  }

  private async sendReply(accessToken: string, messageId: string, replyType: string): Promise<StepResult> {
    // Build a minimal reply message
    // In production this would construct a proper MIME message referencing the original
    const raw = Buffer.from(
      `Subject: Re: (auto-reply)\r\n` +
      `In-Reply-To: ${messageId}\r\n` +
      `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
      `[SkyTwin auto-${replyType}] This is an automated response.`,
    ).toString('base64url');

    const url = `${GMAIL_API}/users/me/messages/send`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw, threadId: messageId }),
    });

    if (!response.ok) {
      return { success: false, error: `Gmail send failed: ${response.status}` };
    }

    return { success: true, output: { action: 'reply_sent', messageId, replyType } };
  }

  private async modifyLabels(
    accessToken: string,
    messageId: string,
    addLabels: string[],
    removeLabels: string[],
  ): Promise<StepResult> {
    const url = `${GMAIL_API}/users/me/messages/${messageId}/modify`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        addLabelIds: addLabels,
        removeLabelIds: removeLabels,
      }),
    });

    if (!response.ok) {
      return { success: false, error: `Gmail modify failed: ${response.status}` };
    }

    return {
      success: true,
      output: { action: 'labels_modified', messageId, added: addLabels, removed: removeLabels },
    };
  }
}
