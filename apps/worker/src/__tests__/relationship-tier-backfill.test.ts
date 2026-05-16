/**
 * Tests for the relationship-tier backfill worker (#251 Phase 2).
 *
 * Same mock-the-adapter shape as tier-backfill.test.ts:
 *
 *   1. Reads contact-count map + recent pages.
 *   2. For each page with a fromAddress, looks up the count and
 *      derives the tier band.
 *   3. Writes via `updatePageMetadata` only when the tier differs.
 *
 * What we verify:
 *
 *   - Tier is derived correctly from the count map.
 *   - Pages already on the correct tier are reported `unchanged`.
 *   - Pages without `metadata.fromAddress` are reported `skipped`.
 *   - Adapter failures bubble up as `failed`, don't stop the loop.
 *   - A failed `computeBidirectionalThreadCounts` lookup yields an
 *     empty summary without throwing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCounts, mockPages, mockUpdate } = vi.hoisted(() => ({
  mockCounts: vi.fn(),
  mockPages: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@skytwin/memory-gbrain-crdb-adapter', async () => {
  const actual: typeof import('@skytwin/memory-gbrain-crdb-adapter') =
    await vi.importActual('@skytwin/memory-gbrain-crdb-adapter');
  return {
    ...actual,
    computeBidirectionalThreadCounts: mockCounts,
    getRecentPages: mockPages,
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

import { runRelationshipTierBackfillJob } from '../jobs/relationship-tier-backfill.js';

const USER = 'u-1';

function makePage(id: string, metadata: Record<string, unknown>): unknown {
  return {
    id,
    user_id: USER,
    title: '',
    content: '',
    source: 'signal',
    source_ref: null,
    metadata,
    embedding: null,
    embedding_model: null,
    embedding_dim: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCounts.mockResolvedValue(new Map<string, number>());
  mockPages.mockResolvedValue([]);
  mockUpdate.mockResolvedValue(1);
});

describe('runRelationshipTierBackfillJob', () => {
  it('derives the right tier band for each contact and writes to metadata', async () => {
    mockCounts.mockResolvedValueOnce(
      new Map([
        ['boss@example.com', 25], // core (>= 5)
        ['teammate@example.com', 3], // frequent (2..4) — re-tuned in #281
        ['vendor@example.com', 1], // occasional (1)
        // stranger@example.com isn't in the map → 0 → stranger
      ]),
    );
    mockPages.mockResolvedValueOnce([
      makePage('p-core', { fromAddress: 'boss@example.com' }),
      makePage('p-freq', { fromAddress: 'teammate@example.com' }),
      makePage('p-occ', { fromAddress: 'vendor@example.com' }),
      makePage('p-stranger', { fromAddress: 'stranger@example.com' }),
    ]);

    const summary = await runRelationshipTierBackfillJob(USER);
    expect(summary.updated).toBe(4);
    expect(summary.unchanged).toBe(0);
    expect(summary.failed).toBe(0);
    expect(mockUpdate).toHaveBeenNthCalledWith(1, USER, 'p-core', {
      relationshipTier: 'core',
    });
    expect(mockUpdate).toHaveBeenNthCalledWith(2, USER, 'p-freq', {
      relationshipTier: 'frequent',
    });
    expect(mockUpdate).toHaveBeenNthCalledWith(3, USER, 'p-occ', {
      relationshipTier: 'occasional',
    });
    expect(mockUpdate).toHaveBeenNthCalledWith(4, USER, 'p-stranger', {
      relationshipTier: 'stranger',
    });
  });

  it('lower-cases the fromAddress before lookup', async () => {
    mockCounts.mockResolvedValueOnce(new Map([['boss@example.com', 25]]));
    mockPages.mockResolvedValueOnce([
      makePage('p-1', { fromAddress: 'Boss@Example.COM' }),
    ]);
    const summary = await runRelationshipTierBackfillJob(USER);
    expect(summary.updated).toBe(1);
    expect(mockUpdate).toHaveBeenCalledWith(USER, 'p-1', {
      relationshipTier: 'core',
    });
  });

  it('reports unchanged when the existing tier already matches', async () => {
    mockCounts.mockResolvedValueOnce(new Map([['boss@example.com', 25]]));
    mockPages.mockResolvedValueOnce([
      makePage('p-already', {
        fromAddress: 'boss@example.com',
        relationshipTier: 'core',
      }),
    ]);
    const summary = await runRelationshipTierBackfillJob(USER);
    expect(summary.unchanged).toBe(1);
    expect(summary.updated).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips pages without metadata.fromAddress (e.g. calendar / code signals)", async () => {
    mockPages.mockResolvedValueOnce([
      makePage('p-cal', { signalSource: 'cal' }),
      makePage('p-code', { signalSource: 'idle-miner' }),
    ]);
    const summary = await runRelationshipTierBackfillJob(USER);
    expect(summary.skipped).toBe(2);
    expect(summary.updated).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('counts adapter failures and continues with the next page', async () => {
    mockCounts.mockResolvedValueOnce(new Map([['a@example.com', 25]]));
    mockPages.mockResolvedValueOnce([
      makePage('fails', { fromAddress: 'a@example.com' }),
      makePage('works', { fromAddress: 'a@example.com' }),
    ]);
    mockUpdate.mockImplementation(async (_userId, pageId) => {
      if (pageId === 'fails') throw new Error('db down');
      return 1;
    });
    const summary = await runRelationshipTierBackfillJob(USER);
    expect(summary.failed).toBe(1);
    expect(summary.updated).toBe(1);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('returns an empty summary when the count lookup throws', async () => {
    mockCounts.mockRejectedValueOnce(new Error('boom'));
    const summary = await runRelationshipTierBackfillJob(USER);
    expect(summary).toEqual({
      attempted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('also counts updatePageMetadata returning 0 as failed (race / not found)', async () => {
    mockCounts.mockResolvedValueOnce(new Map([['a@example.com', 25]]));
    mockPages.mockResolvedValueOnce([
      makePage('gone', { fromAddress: 'a@example.com' }),
    ]);
    mockUpdate.mockResolvedValueOnce(0);
    const summary = await runRelationshipTierBackfillJob(USER);
    expect(summary.failed).toBe(1);
    expect(summary.updated).toBe(0);
  });
});
