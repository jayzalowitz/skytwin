import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionStep } from '@skytwin/shared-types';
import {
  SKYTWIN_EMAIL_ATTRIBUTION_TEXT,
} from '@skytwin/shared-types';
import { EmailActionHandler } from '../handlers/email-action-handler.js';
import type { CredentialProvider } from '../credential-provider.js';

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
      .mockResolvedValueOnce(new Response(JSON.stringify({
        threadId: 'thread-1',
        payload: {
          headers: [
            { name: 'From', value: 'Pat Example <pat@example.com>' },
            { name: 'Subject', value: 'Schedule' },
            { name: 'Message-ID', value: '<orig@example.com>' },
          ],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new EmailActionHandler().execute(makeStep());

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0].toString()).toContain('/messages/msg-1');
    const sendBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as {
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
      .mockResolvedValueOnce(new Response(JSON.stringify({
        threadId: 'thread-1',
        payload: { headers: [{ name: 'From', value: 'pat@example.com' }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new EmailActionHandler().execute(makeStep({
      parameters: {
        actionType: 'send_reply',
        accessToken: 'token-1',
        emailId: 'msg-1',
        body: 'Plain reply.',
        emailAttributionSignatureEnabled: false,
      },
    }));

    const sendBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as { raw: string };
    expect(decodeRaw(sendBody.raw)).not.toContain(SKYTWIN_EMAIL_ATTRIBUTION_TEXT);
  });

  it('omits Gmail threadId when metadata does not include a real thread id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payload: { headers: [{ name: 'From', value: 'pat@example.com' }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new EmailActionHandler().execute(makeStep({
      parameters: {
        actionType: 'send_reply',
        accessToken: 'token-1',
        emailId: 'msg-1',
        body: 'Plain reply.',
      },
    }));

    const sendBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as {
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
});

describe('EmailActionHandler Gmail archive quarantine', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not advertise archive_email', () => {
    expect(new EmailActionHandler().canHandle('archive_email')).toBe(false);
    expect(new EmailActionHandler().canHandle('label_email')).toBe(true);
  });

  it.each([
    { type: 'archive_email', parameters: { actionType: 'archive_email' } },
    { type: 'archive_email', parameters: { actionType: 'label_email' } },
    { type: 'label_email', parameters: { actionType: 'archive_email' } },
  ])('refuses mixed archive execution before credentials or network: %o', async (mixed) => {
    const getAccessToken = vi.fn(async () => ({ success: true, accessToken: 'secret' } as const));
    const credentialProvider: CredentialProvider = { getAccessToken };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await new EmailActionHandler(credentialProvider).execute(makeStep({
      type: mixed.type,
      parameters: { ...mixed.parameters, userId: 'user-1', emailId: 'provider-id' },
    }));
    expect(result).toEqual({
      success: false,
      error: 'archive_email is reserved for its dedicated lifecycle',
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'rollback_archive_email', originalActionType: 'archive_email' },
    { type: 'archive_email', originalActionType: 'label_email' },
    { type: 'label_email', originalActionType: 'archive_email' },
  ])('refuses mixed archive rollback before credentials or network: %o', async (mixed) => {
    const getAccessToken = vi.fn(async () => ({ success: true, accessToken: 'secret' } as const));
    const credentialProvider: CredentialProvider = { getAccessToken };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await new EmailActionHandler(credentialProvider).rollback(makeStep({
      type: mixed.type,
      parameters: {
        originalActionType: mixed.originalActionType,
        userId: 'user-1',
        emailId: 'provider-id',
      },
    }));
    expect(result).toEqual({
      success: false,
      error: 'archive_email rollback requires its dedicated lifecycle',
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
