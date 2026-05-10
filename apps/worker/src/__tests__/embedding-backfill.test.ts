/**
 * Tests for the embedding-backfill worker job.
 *
 * Mocks the @skytwin/memory-gbrain-crdb-adapter module's CRDB functions
 * (`leaseEmbeddingJob`, `markJobDone`, `markJobFailed`,
 * `updatePageEmbedding`, `pendingEmbeddingJobs`) so we can verify the
 * backfill loop's behaviour without a live database.
 *
 * What we cover:
 *   1. Drains pending jobs up to batchSize.
 *   2. Stops early when no more jobs are available.
 *   3. Marks failed jobs as failed and continues.
 *   4. Returns a summary that callers can log.
 *   5. Defaults to the hash-trick provider when no API key is set.
 *   6. Picks up the OpenAI provider when OPENAI_EMBEDDING_API_KEY is set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLease, mockMarkDone, mockMarkFailed, mockUpdate, mockPending } = vi.hoisted(() => ({
  mockLease: vi.fn(),
  mockMarkDone: vi.fn(),
  mockMarkFailed: vi.fn(),
  mockUpdate: vi.fn(),
  mockPending: vi.fn(),
}));

vi.mock('@skytwin/memory-gbrain-crdb-adapter', async () => {
  const actual: typeof import('@skytwin/memory-gbrain-crdb-adapter') =
    await vi.importActual('@skytwin/memory-gbrain-crdb-adapter');
  return {
    ...actual,
    leaseEmbeddingJob: mockLease,
    markJobDone: mockMarkDone,
    markJobFailed: mockMarkFailed,
    updatePageEmbedding: mockUpdate,
    pendingEmbeddingJobs: mockPending,
  };
});

vi.mock('@skytwin/core', async () => {
  const actual: typeof import('@skytwin/core') = await vi.importActual('@skytwin/core');
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

import {
  runEmbeddingBackfillJob,
  getWorkerEmbeddingProvider,
  _resetEmbeddingProviderCacheForTests,
} from '../jobs/embedding-backfill.js';
import { HashEmbeddingProvider } from '@skytwin/memory-gbrain-crdb-adapter';

beforeEach(() => {
  vi.clearAllMocks();
  mockPending.mockResolvedValue(0);
  mockUpdate.mockResolvedValue(undefined);
  mockMarkDone.mockResolvedValue(undefined);
  mockMarkFailed.mockResolvedValue(undefined);
  delete process.env['OPENAI_EMBEDDING_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  _resetEmbeddingProviderCacheForTests();
});

describe('runEmbeddingBackfillJob — happy path', () => {
  it('drains pending jobs and marks each completed', async () => {
    const queue = [
      { id: 'job-1', userId: 'u1', pageId: 'p1', pageContent: 'first content' },
      { id: 'job-2', userId: 'u1', pageId: 'p2', pageContent: 'second content' },
      { id: 'job-3', userId: 'u2', pageId: 'p3', pageContent: 'third content' },
    ];
    mockLease.mockImplementation(async () => queue.shift() ?? null);
    const summary = await runEmbeddingBackfillJob({
      embedding: new HashEmbeddingProvider(64),
      batchSize: 10,
    });
    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    expect(mockUpdate).toHaveBeenCalledTimes(3);
    expect(mockMarkDone).toHaveBeenCalledTimes(3);
  });

  it('stops early when lease returns null (queue empty)', async () => {
    mockLease.mockResolvedValueOnce({ id: 'a', userId: 'u', pageId: 'p', pageContent: 'x' });
    mockLease.mockResolvedValue(null);
    const summary = await runEmbeddingBackfillJob({ batchSize: 10 });
    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(1);
  });

  it('respects batchSize cap', async () => {
    let leasedCount = 0;
    mockLease.mockImplementation(async () => {
      leasedCount++;
      return { id: `j-${leasedCount}`, userId: 'u', pageId: 'p', pageContent: 'x' };
    });
    await runEmbeddingBackfillJob({ batchSize: 3 });
    expect(leasedCount).toBe(3);
  });
});

describe('runEmbeddingBackfillJob — failure handling', () => {
  it('marks job failed when embedding throws and continues with the next', async () => {
    const failingEmbed = {
      model: 'fail',
      dim: 4,
      embed: vi.fn(async () => {
        throw new Error('rate limited');
      }),
      embedBatch: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    };
    const queue = [
      { id: 'a', userId: 'u', pageId: 'p1', pageContent: 'x' },
      { id: 'b', userId: 'u', pageId: 'p2', pageContent: 'y' },
    ];
    mockLease.mockImplementation(async () => queue.shift() ?? null);
    const summary = await runEmbeddingBackfillJob({
      embedding: failingEmbed,
      batchSize: 5,
    });
    expect(summary.attempted).toBe(2);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(2);
    expect(mockMarkFailed).toHaveBeenCalledTimes(2);
    expect(mockMarkDone).not.toHaveBeenCalled();
  });

  it('survives leaseEmbeddingJob throwing (DB hiccup) by stopping the cycle', async () => {
    mockLease.mockRejectedValueOnce(new Error('connection lost'));
    const summary = await runEmbeddingBackfillJob({ batchSize: 5 });
    expect(summary.attempted).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('survives markJobFailed itself throwing — does not halt the run', async () => {
    const failingEmbed = {
      model: 'fail',
      dim: 4,
      embed: vi.fn(async () => {
        throw new Error('boom');
      }),
      embedBatch: vi.fn(async () => []),
    };
    mockMarkFailed.mockRejectedValueOnce(new Error('mark failure DB error'));
    const queue = [
      { id: 'a', userId: 'u', pageId: 'p1', pageContent: 'x' },
      { id: 'b', userId: 'u', pageId: 'p2', pageContent: 'y' },
    ];
    mockLease.mockImplementation(async () => queue.shift() ?? null);
    const summary = await runEmbeddingBackfillJob({
      embedding: failingEmbed,
      batchSize: 5,
    });
    expect(summary.attempted).toBe(2);
    expect(summary.failed).toBe(2);
  });
});

describe('runEmbeddingBackfillJob — pendingAfter reflects DB state', () => {
  it('reads pendingEmbeddingJobs after the cycle completes', async () => {
    mockLease.mockResolvedValue(null);
    mockPending.mockResolvedValue(7);
    const summary = await runEmbeddingBackfillJob();
    expect(summary.pendingAfter).toBe(7);
  });

  it('handles pendingEmbeddingJobs throwing — defaults to 0', async () => {
    mockLease.mockResolvedValue(null);
    mockPending.mockRejectedValueOnce(new Error('db gone'));
    const summary = await runEmbeddingBackfillJob();
    expect(summary.pendingAfter).toBe(0);
  });
});

describe('getWorkerEmbeddingProvider — env-driven choice', () => {
  it('picks hash provider when no API key is set', () => {
    const provider = getWorkerEmbeddingProvider();
    expect(provider.model).toBe('hash-fnv1a-v1');
  });

  it('picks OpenAI provider when OPENAI_EMBEDDING_API_KEY is set', () => {
    process.env['OPENAI_EMBEDDING_API_KEY'] = 'sk-test';
    const provider = getWorkerEmbeddingProvider();
    expect(provider.model).toBe('text-embedding-3-small');
  });

  it('respects OPENAI_EMBEDDING_MODEL', () => {
    process.env['OPENAI_EMBEDDING_API_KEY'] = 'sk-test';
    process.env['OPENAI_EMBEDDING_MODEL'] = 'text-embedding-3-large';
    const provider = getWorkerEmbeddingProvider();
    expect(provider.model).toBe('text-embedding-3-large');
    delete process.env['OPENAI_EMBEDDING_MODEL'];
  });

  it('falls back to OPENAI_API_KEY when EMBEDDING-specific is absent', () => {
    process.env['OPENAI_API_KEY'] = 'sk-shared';
    const provider = getWorkerEmbeddingProvider();
    expect(provider.model).toBe('text-embedding-3-small');
  });
});
