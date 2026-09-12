import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { DecisionRow } from '../types.js';

const { appendMock } = vi.hoisted(() => ({ appendMock: vi.fn() }));
vi.mock('../repositories/decision-receipt-repository.js', () => ({
  decisionReceiptRepository: { appendForUserInTransaction: appendMock },
}));

import {
  buildDecisionRecordedReceiptContentV1,
  decisionReceiptLifecycleRepository,
} from '../repositories/decision-receipt-lifecycle.js';

const userId = '11111111-1111-4111-8111-111111111111';
const decisionId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const client = { query: vi.fn() } as unknown as PoolClient;
const decision: DecisionRow = {
  id: decisionId,
  user_id: userId,
  situation_type: 'email',
  raw_event: { messageRefId: 'opaque' },
  interpreted_situation: { summary: 'An email arrived' },
  domain: 'email',
  urgency: 'normal',
  metadata: {},
  signal_id: 'sig_gmail_source',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
};

describe('decisionReceiptLifecycleRepository', () => {
  beforeEach(() => {
    appendMock.mockReset();
    appendMock.mockResolvedValue({ success: false, code: 'chain_conflict' });
  });

  it('builds the canonical initial cumulative snapshot from the durable decision row', () => {
    expect(buildDecisionRecordedReceiptContentV1(decision)).toMatchObject({
      version: 1,
      stage: 'decision_recorded',
      disposition: 'pending',
      decision: {
        id: decisionId,
        canonicalHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      evidence: [],
      policyEvaluations: [],
      inference: { receipts: [] },
    });
  });

  it('derives a deterministic event key and delegates to the caller transaction', async () => {
    const content = buildDecisionRecordedReceiptContentV1(decision);
    await decisionReceiptLifecycleRepository.appendForUser(client, userId, {
      eventKind: 'decision_created',
      eventId,
      expectedPreviousDigest: null,
      content,
    });
    expect(appendMock).toHaveBeenCalledWith(client, userId, {
      eventKey: `decision_created:${eventId}`,
      expectedPreviousDigest: null,
      content,
    });
  });

  it('returns a typed failure for a non-deterministic event identity', async () => {
    const content = buildDecisionRecordedReceiptContentV1(decision);
    await expect(
      decisionReceiptLifecycleRepository.appendForUser(client, userId, {
        eventKind: 'Decision Created',
        eventId,
        expectedPreviousDigest: null,
        content,
      }),
    ).resolves.toEqual({ success: false, code: 'invalid_content' });
    expect(appendMock).not.toHaveBeenCalled();
  });
});
