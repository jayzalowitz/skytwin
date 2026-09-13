import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';
import { appendSkyTwinEmailAttribution } from '@skytwin/shared-types';
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
  private readonly preparedCredentials = new WeakMap<object, ResolvedCredential>();

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
    const messageId = step.parameters['emailId'] as string | undefined;

    if (['archive_email', 'label_email', 'send_reply', 'reply_email', 'draft_email', 'delete_email']
      .includes(actionType) && !messageId) {
      return { success: false, error: 'Missing emailId in step parameters' };
    }
    if (actionType === 'send_email') {
      const to = step.parameters['to'];
      if (typeof to !== 'string' || to.trim().length === 0) {
        return { success: false, error: 'Missing to in step parameters' };
      }
    }
    if (['send_reply', 'reply_email', 'draft_email'].includes(actionType)) {
      const replyTo = step.parameters['replyToFrom'];
      if (typeof replyTo !== 'string' || replyTo.trim().length === 0) {
        return { success: false, error: 'Missing replyToFrom in step parameters' };
      }
    }
    const supported = new Set([
      'archive_email', 'label_email', 'send_reply', 'reply_email',
      'draft_email', 'send_email', 'delete_email',
    ]);
    if (!supported.has(actionType)) {
      return { success: false, error: `Unknown email action: ${actionType}` };
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
        return { success: false, error: 'Missing accessToken — no OAuth token available for Gmail.' };
      }
      credential = { accessToken };
    }
    let result: StepResult;

    // No await occurs between the credential bind returned above and this
    // call. The router owns the encompassing request-start lease.
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
      throw new PreRequestExecutionError('Missing accessToken — no OAuth token available for Gmail.');
    }
    return { accessToken };
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
