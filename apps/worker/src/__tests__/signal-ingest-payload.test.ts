import { describe, expect, it } from 'vitest';
import { buildSignalIngestPayload } from '../signal-ingest-payload.js';

describe('buildSignalIngestPayload', () => {
  it('keeps Gmail provider ids only inside the service evidence envelope', () => {
    const connectorEvidence = {
      kind: 'gmail_message' as const,
      connectorAccountId: '22222222-2222-4222-8222-222222222222',
      provider: 'google' as const,
      providerMessageId: 'provider-message',
      providerThreadId: 'provider-thread',
      authoringTier: 'inbox_automated' as const,
      observedInInbox: true,
      observedAt: '2026-09-11T12:00:00.000Z',
      messageTimestamp: '2026-09-11T11:00:00.000Z',
    };
    const payload = buildSignalIngestPayload({
      id: 'sig-account-message',
      source: 'gmail',
      type: 'notification',
      timestamp: new Date(connectorEvidence.observedAt),
      data: {
        messageId: 'provider-message',
        emailId: 'legacy-email',
        threadId: 'provider-thread',
        subject: 'Status',
        data: { nested: { messageId: 'hidden-provider-id' } },
      },
      connectorEvidence,
    }, '11111111-1111-4111-8111-111111111111');

    expect(payload).toMatchObject({
      subject: 'Status',
      signalId: 'sig-account-message',
      connectorEvidence,
    });
    expect(payload).not.toHaveProperty('messageId');
    expect(payload).not.toHaveProperty('emailId');
    expect(payload).not.toHaveProperty('threadId');
    expect(payload).not.toHaveProperty('data');
  });

  it('forwards account evidence with an account-scoped non-Gmail signal', () => {
    const connectorAccountId = '22222222-2222-4222-8222-222222222222';
    const connectorEvidence = {
      kind: 'account_signal' as const,
      connectorAccountId,
      provider: 'microsoft' as const,
      source: 'outlook' as const,
      authoringTier: 'inbox_personal' as const,
      observedAt: '2026-09-16T12:00:00.000Z',
    };
    const payload = buildSignalIngestPayload({
      id: `sig_outlook_message_${connectorAccountId}`,
      source: 'outlook',
      type: 'work_email',
      timestamp: new Date(connectorEvidence.observedAt),
      data: { from: 'sender@example.com', subject: 'Status' },
      connectorEvidence,
    }, '11111111-1111-4111-8111-111111111111');

    expect(payload).toMatchObject({
      source: 'outlook',
      signalId: `sig_outlook_message_${connectorAccountId}`,
      connectorEvidence,
    });
  });
});
