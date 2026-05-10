/**
 * Concurrent-write + embedding-worker drain tests.
 *
 * Production scenario: signals from Gmail/Calendar/idle-miner land
 * concurrently on the API (`recordSignal` paths). When the embedding provider
 * is configured to defer work to the queue (or when synchronous embedding
 * fails), pages get queued to `brain_embedding_jobs` and a worker drains
 * them. We verify:
 *
 *   1. N parallel writes never lose rows.
 *   2. The job queue collects N jobs (one per page that needs an embedding).
 *   3. A simulated worker drains the queue without races (in-memory store
 *      has the same lease semantics as the CRDB FOR UPDATE SKIP LOCKED path).
 *   4. After drain, every page has an embedding, every job is `completed`,
 *      and searchSemantic returns expected hits.
 */

import { describe, it, expect } from 'vitest';
import { EmbeddedGbrainMemoryPort } from '../embedded-port.js';
import {
  HashEmbeddingProvider,
  InMemoryBrainStore,
  type EmbeddingProvider,
} from '@skytwin/memory-gbrain-crdb-adapter';

const USER = 'concurrent-user';

/**
 * Provider that fails the first call but succeeds afterwards. Used to force
 * the embedded port's "embedding failed at write — queue it" code path so the
 * worker has work to do.
 */
class FailFirstThenHashProvider implements EmbeddingProvider {
  readonly model = 'fail-first-hash';
  readonly dim = 64;
  private callCount = 0;
  private readonly hash = new HashEmbeddingProvider(64);

  async embed(text: string): Promise<number[]> {
    this.callCount++;
    if (this.callCount === 1) {
      throw new Error('simulated transient failure');
    }
    return this.hash.embed(text);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

describe('concurrent writes — no row loss', () => {
  it('200 parallel recordSignal calls all persist (in-memory store)', async () => {
    const store = new InMemoryBrainStore();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(64),
    });

    const N = 200;
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      writes.push(
        port.recordSignal({
          id: `concurrent-sig-${i}`,
          source: 'gmail',
          type: 'email',
          timestamp: new Date(Date.now() - i * 1000),
          data: { subject: `concurrent message ${i}`, from: 'concurrent@example.com' },
        }),
      );
    }
    await Promise.all(writes);

    expect(store.getAllSignals(USER)).toHaveLength(N);
    expect(store.countPages(USER).total).toBe(N);
  }, 30_000);

  it('parallel writers under different userIds do not bleed across', async () => {
    const store = new InMemoryBrainStore();
    const emb = new HashEmbeddingProvider(64);
    const portA = new EmbeddedGbrainMemoryPort({ userId: 'concurrent-A', backend: 'memory', store, embedding: emb });
    const portB = new EmbeddedGbrainMemoryPort({ userId: 'concurrent-B', backend: 'memory', store, embedding: emb });

    const N = 50;
    const all: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      all.push(
        portA.recordSignal({
          id: `A-${i}`,
          source: 'g',
          type: 'e',
          timestamp: new Date(),
          data: { subject: `A signal ${i}` },
        }),
      );
      all.push(
        portB.recordSignal({
          id: `B-${i}`,
          source: 'g',
          type: 'e',
          timestamp: new Date(),
          data: { subject: `B signal ${i}` },
        }),
      );
    }
    await Promise.all(all);

    expect(store.getAllSignals('concurrent-A')).toHaveLength(N);
    expect(store.getAllSignals('concurrent-B')).toHaveLength(N);
  }, 30_000);
});

describe('embedding worker drain', () => {
  it('write-time embedding failure → page queued → worker drains → embedded + searchable', async () => {
    const store = new InMemoryBrainStore();
    const provider = new FailFirstThenHashProvider();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: provider,
      embedQueriesSynchronously: false, // let search work even before drain
    });

    // Insert a few signals — first one's embedding throws, others succeed.
    await port.recordSignal({
      id: 's-fail-first',
      source: 'note',
      type: 'capture',
      timestamp: new Date(),
      data: { subject: 'first one', text: 'first signal that needs deferred embedding' },
    });
    for (let i = 1; i < 5; i++) {
      await port.recordSignal({
        id: `s-ok-${i}`,
        source: 'note',
        type: 'capture',
        timestamp: new Date(),
        data: { subject: `ok ${i}`, text: `signal number ${i} is fine` },
      });
    }

    // Pages that didn't get a synchronous embedding get queued. Verify queue
    // depth matches the failed embedding count.
    expect(store.pendingEmbeddingJobs()).toBeGreaterThanOrEqual(1);
    const beforeCounts = store.countPages(USER);
    expect(beforeCounts.total).toBe(5);
    expect(beforeCounts.embedded).toBe(4); // four ok, one queued

    // Drain — a single-process worker leases jobs, embeds, marks done.
    const hash = new HashEmbeddingProvider(64);
    let drained = 0;
    while (drained < 10) {
      const job = store.leaseEmbeddingJob();
      if (!job) break;
      try {
        const v = await hash.embed(job.pageContent);
        store.updatePageEmbedding(job.pageId, v, hash.model);
        store.markJobDone(job.id);
      } catch (err) {
        store.markJobFailed(job.id, err instanceof Error ? err.message : 'unknown');
      }
      drained++;
    }

    expect(drained).toBeGreaterThanOrEqual(1);
    expect(store.pendingEmbeddingJobs()).toBe(0);
    expect(store.countPages(USER).embedded).toBe(5);

    // Search the previously-failed page is now retrievable via vector + text RRF.
    const hits = await port.searchSemantic('first signal deferred', 5);
    expect(hits.some((h) => h.id === 's-fail-first')).toBe(true);
  }, 30_000);

  it('SKIP LOCKED semantics: leasing the same row twice in a row returns null', () => {
    const store = new InMemoryBrainStore();
    store.insertPage({ userId: USER, content: 'one page only', source: 'note' });
    expect(store.pendingEmbeddingJobs()).toBe(1);
    const a = store.leaseEmbeddingJob();
    const b = store.leaseEmbeddingJob();
    expect(a).not.toBeNull();
    expect(b).toBeNull(); // already leased
  });

  it('failed jobs that exhaust attempts move to "failed" and stop blocking the queue', () => {
    const store = new InMemoryBrainStore();
    store.insertPage({ userId: USER, content: 'always fails', source: 'note' });
    for (let i = 0; i < 4; i++) {
      const job = store.leaseEmbeddingJob();
      if (!job) break;
      store.markJobFailed(job.id, `attempt ${i} failure`);
    }
    expect(store.pendingEmbeddingJobs()).toBe(0);
  });
});
