import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionStep } from '@skytwin/shared-types';
import {
  SKYTWIN_EMAIL_ATTRIBUTION_TEXT,
} from '@skytwin/shared-types';
import type { CredentialProvider } from '../credential-provider.js';
import { EmailActionHandler } from '../handlers/email-action-handler.js';

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: 'step-1',
    order: 1,
    type: 'draft_email',
    description: 'Send reviewed draft',
    timeout: 30000,
    parameters: {
      actionType: 'draft_email',
      accessToken: 'token-1',
      emailId: 'msg-1',
      draftBody: 'Tuesday works for me.',
      replyToFrom: 'Pat Example <pat@example.com>',
      replyToSubject: 'Schedule',
      replyThreadId: 'thread-1',
      replyMessageId: '<orig@example.com>',
    },
    ...overrides,
  };
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('EmailActionHandler outbound sends', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('handles draft_email as a Gmail reply and appends the SkyTwin attribution', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new EmailActionHandler().execute(makeStep());

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sendBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      raw: string;
      threadId: string;
    };
    const mime = decodeRaw(sendBody.raw);
    expect(sendBody.threadId).toBe('thread-1');
    expect(mime).toContain('To: Pat Example <pat@example.com>');
    expect(mime).toContain('Subject: Re: Schedule');
    expect(mime).toContain('In-Reply-To: <orig@example.com>');
    expect(mime).toContain('\r\n\r\nTuesday works for me.');
    expect(mime).toContain(SKYTWIN_EMAIL_ATTRIBUTION_TEXT);
  });

  it('does not append attribution when the user disabled it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new EmailActionHandler().execute(makeStep({
      parameters: {
        actionType: 'send_reply',
        accessToken: 'token-1',
        emailId: 'msg-1',
        body: 'Plain reply.',
        replyToFrom: 'pat@example.com',
        emailAttributionSignatureEnabled: false,
      },
    }));

    const sendBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { raw: string };
    expect(decodeRaw(sendBody.raw)).not.toContain(SKYTWIN_EMAIL_ATTRIBUTION_TEXT);
  });

  it('omits Gmail threadId when metadata does not include a real thread id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new EmailActionHandler().execute(makeStep({
      parameters: {
        actionType: 'send_reply',
        accessToken: 'token-1',
        emailId: 'msg-1',
        body: 'Plain reply.',
        replyToFrom: 'pat@example.com',
      },
    }));

    const sendBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      raw: string;
      threadId?: string;
    };
    expect(sendBody.threadId).toBeUndefined();
  });

  it('sends new email bodies with attribution and sanitized headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new EmailActionHandler().execute(makeStep({
      type: 'send_email',
      parameters: {
        actionType: 'send_email',
        accessToken: 'token-1',
        to: 'alex@example.com\r\nBcc: injected@example.com',
        subject: 'Hello\r\nInjected: bad',
        body: 'Checking in.',
      },
    }));

    const sendBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { raw: string };
    const mime = decodeRaw(sendBody.raw);
    expect(mime).toContain('To: alex@example.com Bcc: injected@example.com');
    expect(mime).toContain('Subject: Hello Injected: bad');
    expect(mime).toContain(SKYTWIN_EMAIL_ATTRIBUTION_TEXT);
  });

  it('keeps a started credential dispatch ambiguous on a provider 500 and blocks replay', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
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
    const handler = new EmailActionHandler(credentialProvider);
    const step = makeStep({
      type: 'send_email',
      parameters: {
        actionType: 'send_email',
        userId: 'user-1',
        to: 'alex@example.com',
        body: 'Checking in.',
        credentialDecisionId: 'decision-1',
        credentialActionId: 'action-1',
        credentialExecutionPlanId: 'plan-1',
        credentialAuthorityRevision: 'authority-revision-1',
        credentialPolicyAuthorityRevision: 'policy-revision-1',
      },
    });

    await expect(handler.execute(step)).rejects.toThrow('outcome is ambiguous');
    expect(terminalizeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'capability-1' }),
      'ambiguous',
    );
    expect(terminalizeDispatch).not.toHaveBeenCalledWith(expect.anything(), 'failed');

    await expect(handler.execute(step)).rejects.toThrow('already exists');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
