import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';
import { appendSkyTwinEmailAttribution } from '@skytwin/shared-types';
import type { CredentialProvider } from '../credential-provider.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

/**
 * Handler for email actions via the Gmail API.
 * Handles archive, label, send_reply, draft_email, send_email, and delete operations.
 */
export class EmailActionHandler implements ActionHandler {
  readonly actionType = 'email';
  readonly domain = 'email';

  constructor(private readonly credentialProvider?: CredentialProvider) {}

  canHandle(actionType: string): boolean {
    return [
      'archive_email',
      'label_email',
      'send_reply',
      'reply_email',
      'draft_email',
      'send_email',
      'delete_email',
    ].includes(actionType);
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    const actionType = (step.parameters['actionType'] as string) ?? step.type;
    const accessToken = await this.resolveAccessToken(step);
    const messageId = step.parameters['emailId'] as string | undefined;

    switch (actionType) {
      case 'archive_email':
        if (!messageId) throw new Error('Missing emailId in step parameters');
        return this.archiveEmail(accessToken, messageId);
      case 'label_email':
        if (!messageId) throw new Error('Missing emailId in step parameters');
        return this.labelEmail(
          accessToken,
          messageId,
          step.parameters['labels'] as string[] ?? [],
        );
      case 'send_reply':
      case 'reply_email':
      case 'draft_email':
        if (!messageId) throw new Error('Missing emailId in step parameters');
        return this.sendReply(
          accessToken,
          messageId,
          this.resolveReplyBody(step),
          step.parameters,
        );
      case 'send_email':
        return this.sendEmail(accessToken, step.parameters);
      case 'delete_email':
        if (!messageId) throw new Error('Missing emailId in step parameters');
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
      const result = await this.credentialProvider.getAccessToken(userId, 'google');
      if (!result.success) throw new Error(result.error);
      return result.accessToken;
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

  private resolveReplyBody(step: ExecutionStep): string {
    const body =
      step.parameters['draftBody'] ??
      step.parameters['body'] ??
      step.parameters['messageBody'];
    if (typeof body === 'string' && body.trim().length > 0) {
      return this.applyAttribution(body, step.parameters);
    }

    const replyType = step.parameters['replyType'] as string | undefined ?? 'acknowledgment';
    return this.applyAttribution(
      `[SkyTwin auto-${replyType}] This is an automated response.`,
      step.parameters,
    );
  }

  private async sendEmail(
    accessToken: string,
    parameters: Record<string, unknown>,
  ): Promise<StepResult> {
    const to = parameters['to'];
    if (typeof to !== 'string' || to.trim().length === 0) {
      throw new Error('Missing to in step parameters');
    }

    const subject = typeof parameters['subject'] === 'string'
      ? parameters['subject']
      : '(no subject)';
    const body = this.applyAttribution(
      typeof parameters['body'] === 'string'
        ? parameters['body']
        : typeof parameters['messageBody'] === 'string'
          ? parameters['messageBody']
          : '',
      parameters,
    );

    const raw = this.encodeMime([
      `To: ${this.safeHeader(to)}`,
      `Subject: ${this.safeHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ]);

    return this.sendRawMessage(accessToken, { raw });
  }

  private async sendReply(
    accessToken: string,
    messageId: string,
    body: string,
    parameters: Record<string, unknown>,
  ): Promise<StepResult> {
    const original = await this.getOriginalMessageMetadata(accessToken, messageId);
    const to = typeof parameters['replyToFrom'] === 'string' && parameters['replyToFrom'].trim()
      ? parameters['replyToFrom']
      : original.from;
    if (!to) {
      throw new Error('Missing reply recipient; original From header was unavailable');
    }

    const subjectParam = parameters['replyToSubject'] ?? parameters['subject'];
    const subject = typeof subjectParam === 'string' && subjectParam.trim()
      ? subjectParam
      : original.subject;
    const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`;
    const references = [original.references, original.messageId].filter(Boolean).join(' ');

    const lines = [
      `To: ${this.safeHeader(to)}`,
      `Subject: ${this.safeHeader(replySubject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ];
    if (original.messageId) lines.splice(2, 0, `In-Reply-To: ${this.safeHeader(original.messageId)}`);
    if (references) {
      const insertAt = original.messageId ? 3 : 2;
      lines.splice(insertAt, 0, `References: ${this.safeHeader(references)}`);
    }
    const raw = this.encodeMime(lines);

    return this.sendRawMessage(accessToken, { raw, threadId: original.threadId ?? messageId }, {
      action: 'reply_sent',
      messageId,
      replyType: parameters['replyType'] ?? 'custom',
    });
  }

  private async sendRawMessage(
    accessToken: string,
    payload: { raw: string; threadId?: string },
    output: Record<string, unknown> = { action: 'email_sent' },
  ): Promise<StepResult> {
    const url = `${GMAIL_API}/users/me/messages/send`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { success: false, error: `Gmail send failed: ${response.status}` };
    }

    return { success: true, output };
  }

  private async getOriginalMessageMetadata(
    accessToken: string,
    messageId: string,
  ): Promise<{
    from: string;
    subject: string;
    messageId: string;
    references: string;
    threadId: string | null;
  }> {
    const url = new URL(`${GMAIL_API}/users/me/messages/${encodeURIComponent(messageId)}`);
    url.searchParams.set('format', 'metadata');
    for (const header of ['From', 'Subject', 'Message-ID', 'References']) {
      url.searchParams.append('metadataHeaders', header);
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Gmail metadata fetch failed: ${response.status}`);
    }

    const json = await response.json() as {
      threadId?: string;
      payload?: { headers?: Array<{ name?: string; value?: string }> };
    };
    const headers = new Map<string, string>();
    for (const header of json.payload?.headers ?? []) {
      if (header.name && typeof header.value === 'string') {
        headers.set(header.name.toLowerCase(), header.value);
      }
    }
    return {
      from: headers.get('from') ?? '',
      subject: headers.get('subject') ?? '',
      messageId: headers.get('message-id') ?? '',
      references: headers.get('references') ?? '',
      threadId: json.threadId ?? null,
    };
  }

  private applyAttribution(body: string, parameters: Record<string, unknown>): string {
    return appendSkyTwinEmailAttribution(body, {
      enabled: parameters['emailAttributionSignatureEnabled'] !== false,
    });
  }

  private encodeMime(lines: string[]): string {
    return Buffer.from(lines.join('\r\n')).toString('base64url');
  }

  private safeHeader(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').trim();
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
