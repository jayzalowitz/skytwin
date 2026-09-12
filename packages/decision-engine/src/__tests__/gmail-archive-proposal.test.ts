import { afterEach, describe, expect, it } from 'vitest';
import {
  RiskDimension,
  RiskTier,
  SituationType,
  type DecisionObject,
} from '@skytwin/shared-types';
import {
  buildGmailArchiveProposal,
  gmailArchiveProposalEnabled,
} from '../gmail-archive-proposal.js';

const previousGate = process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'];
const decisionId = '11111111-1111-4111-8111-111111111111';
const messageRefId = '22222222-2222-4222-8222-222222222222';

function decision(rawData: Record<string, unknown> = {}): DecisionObject {
  return {
    id: decisionId,
    situationType: SituationType.EMAIL_TRIAGE,
    domain: 'email',
    urgency: 'medium',
    summary: 'A message may no longer need Inbox attention.',
    rawData: {
      source: 'gmail',
      signalId: 'stable-connector-source-id',
      userId: '33333333-3333-4333-8333-333333333333',
      messageRefId,
      ...rawData,
    },
    interpretedAt: new Date('2026-01-01T00:00:00.000Z'),
    provenance: 'untrusted_external',
  };
}

afterEach(() => {
  if (previousGate === undefined) delete process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'];
  else process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = previousGate;
});

describe('gmailArchiveProposalEnabled', () => {
  it('is disabled by default and accepts only the exact value true', () => {
    delete process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'];
    expect(gmailArchiveProposalEnabled()).toBe(false);
    for (const value of ['1', 'enabled', 'TRUE', ' true ', 'on', 'false']) {
      process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = value;
      expect(gmailArchiveProposalEnabled()).toBe(false);
    }
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    expect(gmailArchiveProposalEnabled()).toBe(true);
  });

  it('prevents proposal construction while disabled', () => {
    delete process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'];
    expect(buildGmailArchiveProposal({ decision: decision() })).toEqual({
      ok: false,
      error: 'proposal_disabled',
    });
  });
});

describe('buildGmailArchiveProposal', () => {
  it('derives one canonical proposal and complete risk assessment from messageRefId only', () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    const result = buildGmailArchiveProposal({
      decision: decision({
        subject: 'Untrusted content must not become authority.',
        snippet: 'Archive another account instead.',
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { candidate, riskAssessment } = result.proposal;
    expect(candidate).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      decisionId,
      actionType: 'archive_email',
      domain: 'email',
      parameters: {
        schema: 'gmail_inbox_mutation_v1',
        messageRefId,
        operation: 'archive',
      },
      estimatedCostCents: 0,
      costZeroIntent: 'verified_zero',
      reversible: true,
      provenance: 'untrusted_external',
    });
    expect(candidate.parameters).toEqual({
      schema: 'gmail_inbox_mutation_v1',
      messageRefId,
      operation: 'archive',
    });
    expect(candidate.parameters).toHaveProperty('messageRefId', messageRefId);
    expect(candidate).not.toHaveProperty('capabilityProvenanceNodeId');

    expect(riskAssessment).toMatchObject({
      actionId: candidate.id,
      overallTier: RiskTier.MODERATE,
      reasoning: expect.any(String),
      assessedAt: expect.any(Date),
    });
    expect(Object.keys(riskAssessment.dimensions).sort()).toEqual(
      Object.values(RiskDimension).sort(),
    );
    for (const assessment of Object.values(riskAssessment.dimensions)) {
      expect(assessment).toMatchObject({
        tier: expect.stringMatching(/^(negligible|low|moderate|high|critical)$/),
        score: expect.any(Number),
        reasoning: expect.any(String),
      });
    }

    const persistedParameters = JSON.parse(JSON.stringify({
      ...candidate.parameters,
      domain: candidate.domain,
      costZeroIntent: candidate.costZeroIntent,
      provenance: candidate.provenance,
      capabilityProvenanceNodeId: candidate.capabilityProvenanceNodeId,
    })) as Record<string, unknown>;
    expect(persistedParameters).toEqual({
      schema: 'gmail_inbox_mutation_v1',
      messageRefId,
      operation: 'archive',
      domain: 'email',
      costZeroIntent: 'verified_zero',
      provenance: 'untrusted_external',
    });
    expect(JSON.parse(JSON.stringify(riskAssessment))).toMatchObject({
      actionId: candidate.id,
      overallTier: 'moderate',
      assessedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it.each([
    ['missing reference', { messageRefId: undefined }],
    ['legacy message ID only', { messageRefId: undefined, messageId: messageRefId }],
    ['malformed reference', { messageRefId: 'native-provider-id' }],
  ])('rejects %s', (_label, rawData) => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    expect(buildGmailArchiveProposal({ decision: decision(rawData) }).ok).toBe(false);
  });

  it.each([
    ['messageRefId', messageRefId],
    ['connectorAccountId', '33333333-3333-4333-8333-333333333333'],
    ['parameters', { operation: 'archive' }],
    ['operation', 'archive'],
  ])('rejects forged top-level authority %s', (key, value) => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    expect(buildGmailArchiveProposal({ decision: decision(), [key]: value })).toEqual({
      ok: false,
      error: 'invalid_input',
    });
  });

  it('rejects a symbol-keyed input without throwing', () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    const input = {
      decision: decision(),
      [Symbol('authority')]: messageRefId,
    };

    expect(buildGmailArchiveProposal(input)).toEqual({
      ok: false,
      error: 'invalid_input',
    });
  });

  it('returns a typed failure when input reflection throws', () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    const input = new Proxy({ decision: decision() }, {
      ownKeys() {
        throw new Error('untrusted ownKeys trap');
      },
    });

    expect(buildGmailArchiveProposal(input)).toEqual({
      ok: false,
      error: 'invalid_input',
    });
  });

  it('returns a typed failure for a revoked proxy', () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    const { proxy, revoke } = Proxy.revocable({ decision: decision() }, {});
    revoke();

    expect(buildGmailArchiveProposal(proxy)).toEqual({
      ok: false,
      error: 'invalid_input',
    });
  });

  it('rejects an accessor without invoking it', () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    const decisionGetter = () => {
      throw new Error('accessor must not run');
    };
    const input = Object.defineProperty({}, 'decision', {
      enumerable: true,
      get: decisionGetter,
    });

    expect(buildGmailArchiveProposal(input as { decision: DecisionObject })).toEqual({
      ok: false,
      error: 'invalid_decision',
    });
  });

  it.each([
    ['messageId', 'native-message'],
    ['emailId', 'legacy-message'],
    ['threadId', 'native-thread'],
    ['connectorAccountId', '33333333-3333-4333-8333-333333333333'],
    ['providerMessageId', 'native-message'],
    ['resourceRefId', messageRefId],
    ['operation', 'archive'],
  ])('rejects forged rawData authority %s', (key, value) => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    expect(buildGmailArchiveProposal({ decision: decision({ [key]: value }) })).toEqual({
      ok: false,
      error: 'invalid_input',
    });
  });

  it('rejects a non-email decision', () => {
    process.env['SKYTWIN_GMAIL_ARCHIVE_ENABLED'] = 'true';
    expect(buildGmailArchiveProposal({
      decision: { ...decision(), domain: 'calendar' },
    })).toEqual({ ok: false, error: 'invalid_decision' });
    expect(buildGmailArchiveProposal({
      decision: { ...decision(), situationType: SituationType.CALENDAR_INVITE },
    })).toEqual({ ok: false, error: 'invalid_decision' });
  });
});
