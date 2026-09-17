/**
 * Tests for the embedding-backfill worker job.
 *
 * Mocks the @skytwin/memory-gbrain-crdb-adapter module's CRDB functions
 * (`leaseEmbeddingJob`, `completeEmbeddingJob`, `markJobFailed`,
 * `pendingEmbeddingJobs`) so we can verify the
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

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLease, mockComplete, mockMarkFailed, mockPending } = vi.hoisted(() => ({
  mockLease: vi.fn(),
  mockComplete: vi.fn(),
  mockMarkFailed: vi.fn(),
  mockPending: vi.fn(),
}));

vi.mock('@skytwin/memory-gbrain-crdb-adapter', async () => {
  const actual: typeof import('@skytwin/memory-gbrain-crdb-adapter') =
    await vi.importActual('@skytwin/memory-gbrain-crdb-adapter');
  return {
    ...actual,
    leaseEmbeddingJob: mockLease,
    completeEmbeddingJob: mockComplete,
    markJobFailed: mockMarkFailed,
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
import { HashEmbeddingProvider, InMemoryBrainStore } from '@skytwin/memory-gbrain-crdb-adapter';

beforeEach(() => {
  vi.clearAllMocks();
  mockPending.mockResolvedValue(0);
  mockComplete.mockResolvedValue(true);
  mockMarkFailed.mockResolvedValue(true);
  delete process.env['OPENAI_EMBEDDING_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  _resetEmbeddingProviderCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runEmbeddingBackfillJob — happy path', () => {
  it('drains pending jobs and marks each completed', async () => {
    const queue = [
      { id: 'job-1', userId: 'u1', pageId: 'p1', pageContent: 'first content', leaseToken: 'lease-1' },
      { id: 'job-2', userId: 'u1', pageId: 'p2', pageContent: 'second content', leaseToken: 'lease-2' },
      { id: 'job-3', userId: 'u2', pageId: 'p3', pageContent: 'third content', leaseToken: 'lease-3' },
    ];
    mockLease.mockImplementation(async () => queue.shift() ?? null);
    const summary = await runEmbeddingBackfillJob({
      embedding: new HashEmbeddingProvider(64),
      batchSize: 10,
    });
    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    expect(mockComplete).toHaveBeenCalledTimes(3);
  });

  it('stops early when lease returns null (queue empty)', async () => {
    mockLease.mockResolvedValueOnce({
      id: 'a', userId: 'u', pageId: 'p', pageContent: 'x', leaseToken: 'lease-a',
    });
    mockLease.mockResolvedValue(null);
    const summary = await runEmbeddingBackfillJob({ batchSize: 10 });
    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(1);
  });

  it('respects batchSize cap', async () => {
    let leasedCount = 0;
    mockLease.mockImplementation(async () => {
      leasedCount++;
      return {
        id: `j-${leasedCount}`,
        userId: 'u',
        pageId: 'p',
        pageContent: 'x',
        leaseToken: `lease-${leasedCount}`,
      };
    });
    await runEmbeddingBackfillJob({ batchSize: 3 });
    expect(leasedCount).toBe(3);
  });
});

describe('runEmbeddingBackfillJob — failure handling', () => {
  it('reclaims an expired lease after its worker generation is revoked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = new InMemoryBrainStore();
    store.insertPage({ userId: 'u1', content: 'recoverable', source: 'note' });
    mockLease.mockImplementation(async () => store.leaseEmbeddingJob());
    mockComplete.mockImplementation(
      async (jobId: string, leaseToken: string, embedding: number[], model: string) =>
        store.completeEmbeddingJob(jobId, leaseToken, embedding, model),
    );
    mockMarkFailed.mockImplementation(
      async (jobId: string, leaseToken: string, message: string) =>
        store.markJobFailed(jobId, leaseToken, message),
    );
    mockPending.mockImplementation(async () => store.pendingEmbeddingJobs());

    let releaseEmbedding: ((embedding: number[]) => void) | undefined;
    const firstEmbedding = new Promise<number[]>((resolve) => {
      releaseEmbedding = resolve;
    });
    const provider = {
      model: 'test',
      dim: 2,
      embed: vi.fn()
        .mockImplementationOnce(() => firstEmbedding)
        .mockResolvedValue([0.25, 0.75]),
      embedBatch: vi.fn(async () => []),
    };
    const controller = new AbortController();
    const firstRun = runEmbeddingBackfillJob({
      embedding: provider,
      batchSize: 1,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(provider.embed).toHaveBeenCalledOnce());

    controller.abort(new Error('generation revoked'));
    releaseEmbedding?.([0.1, 0.9]);
    await expect(firstRun).rejects.toThrow('generation revoked');
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(store.jobs[0]?.status).toBe('in_progress');

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await expect(runEmbeddingBackfillJob({ embedding: provider, batchSize: 1 }))
      .resolves.toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(store.jobs[0]?.status).toBe('completed');
    expect(store.jobs[0]?.attempts).toBe(2);
    vi.useRealTimers();
  });

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
      { id: 'a', userId: 'u', pageId: 'p1', pageContent: 'x', leaseToken: 'lease-a' },
      { id: 'b', userId: 'u', pageId: 'p2', pageContent: 'y', leaseToken: 'lease-b' },
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
    expect(mockComplete).not.toHaveBeenCalled();
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
      { id: 'a', userId: 'u', pageId: 'p1', pageContent: 'x', leaseToken: 'lease-a' },
      { id: 'b', userId: 'u', pageId: 'p2', pageContent: 'y', leaseToken: 'lease-b' },
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
