/**
 * Robustness tests — every degraded mode the production system can land in.
 *
 * The gbrain memory layer must keep returning something useful when:
 *   - the embedding provider throws / times out / returns junk
 *   - a query is empty, oversize, or punctuation-only
 *   - vectors of different dimensions get mixed (model migration)
 *   - the corpus contains corrupted entries (older rows with no embedding)
 *   - cross-user data exists
 *
 * "Useful" means: never throw out of searchSemantic; gracefully degrade to
 * text-only RRF; isolate user data; surface errors to the caller via
 * structured logging not exceptions.
 */

import { describe, it, expect } from 'vitest';
import { EmbeddedGbrainMemoryPort } from '../embedded-port.js';
import {
  HashEmbeddingProvider,
  InMemoryBrainStore,
  type EmbeddingProvider,
  OpenAiEmbeddingProvider,
} from '@skytwin/memory-gbrain-crdb-adapter';

const USER = 'robustness-user';

function basePort(opts: { embedding?: EmbeddingProvider } = {}) {
  const store = new InMemoryBrainStore();
  return {
    store,
    port: new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: opts.embedding ?? new HashEmbeddingProvider(64),
    }),
  };
}

describe('robustness — embedding provider failures', () => {
  it('searchSemantic falls back to text-only when query embedding throws', async () => {
    const failingEmb: EmbeddingProvider = {
      model: 'always-fails',
      dim: 64,
      embed: async () => {
        throw new Error('network down');
      },
      embedBatch: async () => {
        throw new Error('network down');
      },
    };
    const { port, store } = basePort({ embedding: failingEmb });
    // Pre-populate via direct page insert so search has something to find.
    store.insertPage({
      userId: USER,
      content: 'budget review meeting Tuesday',
      source: 'note',
      embedding: [0, 1, 0, 0],
      embeddingModel: 'static',
    });
    const hits = await port.searchSemantic('budget meeting', 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('recordSignal completes even when embedding fails (page queued for backfill)', async () => {
    const failingEmb: EmbeddingProvider = {
      model: 'always-fails',
      dim: 64,
      embed: async () => {
        throw new Error('embedding service unavailable');
      },
      embedBatch: async () => {
        throw new Error('embedding service unavailable');
      },
    };
    const { port, store } = basePort({ embedding: failingEmb });

    await port.recordSignal({
      id: 'sig-deferred',
      source: 'gmail',
      type: 'email',
      timestamp: new Date(),
      data: { subject: 'deferred indexing test', text: 'this should still get persisted' },
    });

    expect(store.getAllSignals(USER)).toHaveLength(1);
    expect(store.countPages(USER).total).toBe(1);
    expect(store.countPages(USER).embedded).toBe(0);
    expect(store.pendingEmbeddingJobs()).toBeGreaterThan(0);
  });
});

describe('robustness — query edge cases', () => {
  it('empty query returns []', async () => {
    const { port } = basePort();
    expect(await port.searchSemantic('', 5)).toEqual([]);
  });

  it('whitespace-only query returns []', async () => {
    const { port } = basePort();
    expect(await port.searchSemantic('   \n\t  ', 5)).toEqual([]);
  });

  it('punctuation-only query returns []', async () => {
    const { port } = basePort();
    expect(await port.searchSemantic('!!! ??? ...', 5)).toEqual([]);
  });

  it('extremely long query (10k chars) does not throw', async () => {
    const { port } = basePort();
    await port.recordSignal({
      id: 'sig-long-q',
      source: 'note',
      type: 'capture',
      timestamp: new Date(),
      data: { text: 'short content but long query incoming' },
    });
    const longQ = 'budget '.repeat(2000);
    const hits = await port.searchSemantic(longQ, 5);
    // No throw is the test; result count irrelevant.
    expect(Array.isArray(hits)).toBe(true);
  });

  it('k=0 returns []', async () => {
    const { port } = basePort();
    await port.recordSignal({
      id: 's',
      source: 'note',
      type: 'capture',
      timestamp: new Date(),
      data: { text: 'hello' },
    });
    expect(await port.searchSemantic('hello', 0)).toEqual([]);
  });
});

describe('robustness — vector dimension mismatches', () => {
  it('mixed-dim embeddings: cosine returns 0 for length mismatch (no crash)', () => {
    const store = new InMemoryBrainStore();
    // Insert a page with 64-dim embedding
    store.insertPage({
      userId: USER,
      content: 'old model page',
      source: 'note',
      embedding: new Array(64).fill(0).map((_, i) => Math.sin(i)),
      embeddingModel: 'old-model',
    });
    // And a page with 128-dim
    store.insertPage({
      userId: USER,
      content: 'new model page',
      source: 'note',
      embedding: new Array(128).fill(0).map((_, i) => Math.cos(i)),
      embeddingModel: 'new-model',
    });
    // Vector search with a 128-dim query — only the new-model page can match
    const query = new Array(128).fill(0).map((_, i) => Math.cos(i));
    const hits = store.vectorSearch(USER, query, 5);
    // Both pages are scanned; old-model returns sim=0, new-model returns sim=1
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.page.content).toBe('new model page');
  });
});

describe('robustness — corrupted / partial corpus', () => {
  it('pages with embedding=null are skipped from vector search but still text-searchable', async () => {
    const { port, store } = basePort();
    store.insertPage({
      userId: USER,
      content: 'has no embedding',
      source: 'note',
      // No embedding — just text
    });
    expect(store.countPages(USER)).toEqual({ total: 1, embedded: 0 });
    const hits = await port.searchSemantic('embedding', 5);
    // Text-side RRF still surfaces this page even though vector side ignored it.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('mixed corpus (some embedded, some not) — search returns embedded ones too', async () => {
    const { port, store } = basePort();
    const emb = new HashEmbeddingProvider(64);
    const v = await emb.embed('topic alpha');
    store.insertPage({ userId: USER, content: 'topic alpha embedded', source: 'note', embedding: v, embeddingModel: 'h' });
    store.insertPage({ userId: USER, content: 'topic beta no embedding', source: 'note' });
    const hits = await port.searchSemantic('topic alpha', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain('alpha');
  });
});

describe('robustness — OpenAI embedding HTTP timeouts', () => {
  it('aborts after timeoutMs and the error is surfaced (not swallowed)', async () => {
    let abortCalled = false;
    const slowFetch = ((_url: unknown, init: unknown) =>
      new Promise<Response>((_resolve, reject) => {
        const i = init as { signal?: AbortSignal };
        i.signal?.addEventListener('abort', () => {
          abortCalled = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;

    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'test',
      dim: 4,
      fetchImpl: slowFetch,
      timeoutMs: 50,
    });

    await expect(provider.embed('hi')).rejects.toBeDefined();
    expect(abortCalled).toBe(true);
  }, 5_000);

  it('handles non-JSON response gracefully', async () => {
    const fakeFetch = (async () =>
      new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const provider = new OpenAiEmbeddingProvider({ apiKey: 'k', dim: 2, fetchImpl: fakeFetch });
    await expect(provider.embed('x')).rejects.toBeDefined();
  });
});

describe('robustness — multi-tenant safety under partial failures', () => {
  it('one user\'s embedding failure does not affect another user\'s recall', async () => {
    const sharedStore = new InMemoryBrainStore();
    const goodEmb = new HashEmbeddingProvider(64);
    const failingEmb: EmbeddingProvider = {
      model: 'fails-for-this-user',
      dim: 64,
      embed: async () => {
        throw new Error('boom');
      },
      embedBatch: async () => {
        throw new Error('boom');
      },
    };

    const portGood = new EmbeddedGbrainMemoryPort({
      userId: 'user-good',
      backend: 'memory',
      store: sharedStore,
      embedding: goodEmb,
    });
    const portBad = new EmbeddedGbrainMemoryPort({
      userId: 'user-bad',
      backend: 'memory',
      store: sharedStore,
      embedding: failingEmb,
    });

    await portGood.recordSignal({
      id: 'good-1',
      source: 'note',
      type: 'capture',
      timestamp: new Date(),
      data: { text: 'good user query target — this should rank high' },
    });
    await portBad.recordSignal({
      id: 'bad-1',
      source: 'note',
      type: 'capture',
      timestamp: new Date(),
      data: { text: 'bad user query target — should also persist' },
    });

    const goodHits = await portGood.searchSemantic('query target', 5);
    expect(goodHits.length).toBeGreaterThan(0);
    expect(goodHits[0]?.content).toContain('good user');

    // The bad user's page is persisted (text-side searchable) but un-embedded
    expect(sharedStore.countPages('user-bad').embedded).toBe(0);
    expect(sharedStore.countPages('user-good').embedded).toBe(1);
  });
});
