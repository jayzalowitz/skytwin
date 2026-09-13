import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';
import { appendSkyTwinEmailAttribution } from '@skytwin/shared-types';
import type {
  CredentialDispatchResult,
  CredentialProvider,
} from '../credential-provider.js';

interface ResolvedCredential {
  accessToken: string;
  grant?: CredentialDispatchResult;
}

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

function throwIfProviderOutcomeIsAmbiguous(service: string, status: number): void {
  if (status === 408 || status === 429 || status >= 500) {
    throw new Error(`${service} returned ${status} after request start; outcome is ambiguous.`);
  }
}

/**
 * Handler for email actions via the Gmail API.
 * Handles archive, label, send_reply, draft_email, send_email, and delete operations.
 */
export class EmailActionHandler implements ActionHandler {
  readonly actionType = 'email';
  readonly domain = 'email';
  readonly supportsRollback: boolean;

  constructor(private readonly credentialProvider?: CredentialProvider) {
    this.supportsRollback = !credentialProvider;
  }

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
    const messageId = step.parameters['emailId'] as string | undefined;

    if (['archive_email', 'label_email', 'send_reply', 'reply_email', 'draft_email', 'delete_email']
      .includes(actionType) && !messageId) {
      throw new Error('Missing emailId in step parameters');
    }
    if (actionType === 'send_email') {
      const to = step.parameters['to'];
      if (typeof to !== 'string' || to.trim().length === 0) {
        throw new Error('Missing to in step parameters');
      }
    }
    if (['send_reply', 'reply_email', 'draft_email'].includes(actionType)) {
      const replyTo = step.parameters['replyToFrom'];
      if (typeof replyTo !== 'string' || replyTo.trim().length === 0) {
        throw new Error('Missing replyToFrom in step parameters');
      }
    }
    const supported = new Set([
      'archive_email', 'label_email', 'send_reply', 'reply_email',
      'draft_email', 'send_email', 'delete_email',
    ]);
    if (!supported.has(actionType)) {
      return { success: false, error: `Unknown email action: ${actionType}` };
    }
    const credential = await this.resolveAccessToken(step, true);
    let result: StepResult;

    try {
      // No await occurs between the committed lease returned above and this
      // call. Each branch invokes fetch synchronously before yielding.
      switch (actionType) {
        case 'archive_email':
          result = await this.archiveEmail(credential.accessToken, messageId!);
          break;
        case 'label_email':
          result = await this.labelEmail(
            credential.accessToken, messageId!, step.parameters['labels'] as string[] ?? [],
          );
          break;
        case 'send_reply':
        case 'reply_email':
        case 'draft_email':
          result = await this.sendReply(
            credential.accessToken, messageId!, this.resolveReplyBody(step), step.parameters,
          );
          break;
        case 'send_email':
          result = await this.sendEmail(credential.accessToken, step.parameters);
          break;
        case 'delete_email':
          result = await this.deleteEmail(credential.accessToken, messageId!);
          break;
        default:
          throw new Error('Validated email action was not dispatched.');
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
    const originalAction = (step.parameters['originalActionType'] as string) ?? step.type;
    const { accessToken } = await this.resolveAccessToken(step, false);
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
      throw new Error('Missing accessToken — no OAuth token available for Gmail. Falling back to next adapter.');
    }
    return { accessToken };
  }

  private async finishDispatch(
    grant: CredentialDispatchResult | undefined,
    state: 'completed' | 'failed' | 'ambiguous',
  ): Promise<void> {
    if (!grant) return;
    const persisted = await this.credentialProvider?.terminalizeDispatch?.(grant, state);
    if (!persisted) {
      throw new Error('Credential dispatch terminal state could not be persisted.');
    }
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
      throwIfProviderOutcomeIsAmbiguous('Gmail trash', response.status);
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
    const to = parameters['replyToFrom'] as string;

    const subjectParam = parameters['replyToSubject'] ?? parameters['subject'];
    const subject = typeof subjectParam === 'string' && subjectParam.trim()
      ? subjectParam
      : '';
    const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`;
    const originalMessageId = typeof parameters['replyMessageId'] === 'string'
      ? parameters['replyMessageId'] : '';
    const originalReferences = typeof parameters['replyReferences'] === 'string'
      ? parameters['replyReferences'] : '';
    const references = [originalReferences, originalMessageId].filter(Boolean).join(' ');

    const lines = [
      `To: ${this.safeHeader(to)}`,
      `Subject: ${this.safeHeader(replySubject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ];
    if (originalMessageId) lines.splice(2, 0, `In-Reply-To: ${this.safeHeader(originalMessageId)}`);
    if (references) {
      const insertAt = originalMessageId ? 3 : 2;
      lines.splice(insertAt, 0, `References: ${this.safeHeader(references)}`);
    }
    const raw = this.encodeMime(lines);

    return this.sendRawMessage(accessToken, {
      raw,
      ...(typeof parameters['replyThreadId'] === 'string' && parameters['replyThreadId']
        ? { threadId: parameters['replyThreadId'] } : {}),
    }, {
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
      throwIfProviderOutcomeIsAmbiguous('Gmail send', response.status);
      return { success: false, error: `Gmail send failed: ${response.status}` };
    }

    return { success: true, output };
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
      throwIfProviderOutcomeIsAmbiguous('Gmail modify', response.status);
      return { success: false, error: `Gmail modify failed: ${response.status}` };
    }

    return {
      success: true,
      output: { action: 'labels_modified', messageId, added: addLabels, removed: removeLabels },
    };
  }
}
