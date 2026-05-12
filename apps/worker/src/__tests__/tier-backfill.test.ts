/**
 * Tests for the tier-backfill worker job (#251 follow-up).
 *
 * Mocks the @skytwin/memory-gbrain-crdb-adapter functions so we can drive
 * the worker through every reclassification path without a live database:
 *
 *   1. Trust the signal: signal.data.authoringTier already present →
 *      copy it through to page metadata.
 *   2. Reclassify: only raw headers in signal.data → run the local
 *      classifier and produce a tier.
 *   3. Unreclassifiable: signal too thin (no labels, no from) → leave
 *      the page alone but count it.
 *   4. Failed update: adapter throws → counted in `failed`, keeps going.
 *   5. The find query throwing is non-fatal — returns an empty summary.
 *   6. fromAddress is also copied / normalized when data.from is present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFind, mockUpdate } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@skytwin/memory-gbrain-crdb-adapter', async () => {
  const actual: typeof import('@skytwin/memory-gbrain-crdb-adapter') =
    await vi.importActual('@skytwin/memory-gbrain-crdb-adapter');
  return {
    ...actual,
    findPagesMissingAuthoringTier: mockFind,
    updatePageMetadata: mockUpdate,
  };
});

vi.mock('@skytwin/core', async () => {
  const actual: typeof import('@skytwin/core') = await vi.importActual('@skytwin/core');
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

import { runTierBackfillJob } from '../jobs/tier-backfill.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue([]);
  mockUpdate.mockResolvedValue(1);
});

describe('runTierBackfillJob', () => {
  it('copies an existing signal.data.authoringTier straight to page metadata', async () => {
    mockFind.mockResolvedValueOnce([
      {
        page_id: 'p-1',
        user_id: 'u-1',
        signal_data: {
          authoringTier: 'inbox_newsletter',
          from: 'newsletter@vendor.example.com',
        },
      },
    ]);
    const summary = await runTierBackfillJob({ batchSize: 5 });
    expect(summary.attempted).toBe(1);
    expect(summary.copiedFromSignal).toBe(1);
    expect(summary.reclassified).toBe(0);
    expect(mockUpdate).toHaveBeenCalledWith('u-1', 'p-1', {
      authoringTier: 'inbox_newsletter',
      fromAddress: 'newsletter@vendor.example.com',
    });
  });

  it('reclassifies from raw headers when signal.data has no authoringTier', async () => {
    mockFind.mockResolvedValueOnce([
      {
        page_id: 'p-2',
        user_id: 'u-1',
        signal_data: {
          // No authoringTier — but headers + labels are present, so the
          // classifier can derive it. SENT label → user_sent_*.
          labels: ['SENT', 'INBOX'],
          from: 'me@example.com',
          to: 'colleague@example.com',
          cc: '',
          inReplyTo: '',
          listUnsubscribe: '',
          listId: '',
        },
      },
    ]);
    const summary = await runTierBackfillJob({ batchSize: 5 });
    expect(summary.reclassified).toBe(1);
    expect(summary.copiedFromSignal).toBe(0);
    expect(mockUpdate).toHaveBeenCalledWith('u-1', 'p-2', {
      authoringTier: 'user_sent_originated',
      fromAddress: 'me@example.com',
    });
  });

  it('reclassifies a newsletter via List-Unsubscribe header', async () => {
    mockFind.mockResolvedValueOnce([
      {
        page_id: 'p-3',
        user_id: 'u-1',
        signal_data: {
          labels: ['INBOX'],
          from: 'news@example.com',
          to: 'me@example.com',
          cc: '',
          inReplyTo: '',
          listUnsubscribe: '<mailto:unsubscribe@example.com>',
          listId: '',
        },
      },
    ]);
    const summary = await runTierBackfillJob({ batchSize: 5 });
    expect(summary.reclassified).toBe(1);
    expect(mockUpdate).toHaveBeenCalledWith('u-1', 'p-3', {
      authoringTier: 'inbox_newsletter',
      fromAddress: 'news@example.com',
    });
  });

  it("counts a signal with no usable data as 'unreclassifiable' and doesn't call updatePageMetadata", async () => {
    mockFind.mockResolvedValueOnce([
      {
        page_id: 'p-4',
        user_id: 'u-1',
        signal_data: { subject: 'just a subject line' },
      },
    ]);
    const summary = await runTierBackfillJob({ batchSize: 5 });
    expect(summary.unreclassifiable).toBe(1);
    expect(summary.copiedFromSignal).toBe(0);
    expect(summary.reclassified).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('counts update failures and continues with the next page', async () => {
    mockFind.mockResolvedValueOnce([
      {
        page_id: 'fails',
        user_id: 'u-1',
        signal_data: { authoringTier: 'inbox_personal', from: 'a@example.com' },
      },
      {
        page_id: 'works',
        user_id: 'u-1',
        signal_data: { authoringTier: 'user_sent_originated', from: 'me@example.com' },
      },
    ]);
    mockUpdate.mockImplementation(async (_userId, pageId) => {
      if (pageId === 'fails') throw new Error('db down');
      return 1;
    });
    const summary = await runTierBackfillJob({ batchSize: 5 });
    expect(summary.attempted).toBe(2);
    expect(summary.failed).toBe(1);
    // The second update still went through — the failure didn't stop the loop.
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenLastCalledWith('u-1', 'works', {
      authoringTier: 'user_sent_originated',
      fromAddress: 'me@example.com',
    });
  });

  it('returns an empty summary when the find query throws', async () => {
    mockFind.mockRejectedValueOnce(new Error('connection refused'));
    const summary = await runTierBackfillJob({ batchSize: 5 });
    expect(summary).toEqual({
      attempted: 0,
      copiedFromSignal: 0,
      reclassified: 0,
      unreclassifiable: 0,
      failed: 0,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('omits fromAddress from the patch when signal.data.from is missing', async () => {
    mockFind.mockResolvedValueOnce([
      {
        page_id: 'p-no-from',
        user_id: 'u-1',
        signal_data: { authoringTier: 'inbox_automated' },
      },
    ]);
    const summary = await runTierBackfillJob({ batchSize: 5 });
    expect(summary.copiedFromSignal).toBe(1);
    expect(mockUpdate).toHaveBeenCalledWith('u-1', 'p-no-from', {
      authoringTier: 'inbox_automated',
    });
  });

  it('respects the userId scope when provided', async () => {
    await runTierBackfillJob({ batchSize: 10, userId: 'u-target' });
    expect(mockFind).toHaveBeenCalledWith('u-target', 10);
  });

  it('uses null scope (all users) by default', async () => {
    await runTierBackfillJob({ batchSize: 50 });
    expect(mockFind).toHaveBeenCalledWith(null, 50);
  });
});
