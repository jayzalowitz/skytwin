import { describe, it, expect } from 'vitest';
import {
  HashEmbeddingProvider,
  cosineSimilarity,
  fnv1a32,
  tokenise,
  OpenAiEmbeddingProvider,
} from '../embedding.js';

describe('tokenise', () => {
  it('splits on whitespace and punctuation', () => {
    expect(tokenise('Hello, World! How are you?')).toEqual(['hello', 'world', 'how', 'are', 'you']);
  });
  it('drops single-character tokens', () => {
    expect(tokenise('a b cd e')).toEqual(['cd']);
  });
  it('lowercases', () => {
    expect(tokenise('FooBar Baz')).toEqual(['foobar', 'baz']);
  });
  it('returns [] on empty / whitespace input', () => {
    expect(tokenise('')).toEqual([]);
    expect(tokenise('   ')).toEqual([]);
  });
});

describe('fnv1a32', () => {
  it('is deterministic', () => {
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
  });
  it('differs for different inputs', () => {
    expect(fnv1a32('hello')).not.toBe(fnv1a32('world'));
  });
  it('returns an unsigned 32-bit integer', () => {
    const h = fnv1a32('the quick brown fox');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBe(1);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it('handles zero-norm vectors gracefully', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });
  it('returns 0 for length mismatch (defensive)', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });
});

describe('HashEmbeddingProvider', () => {
  it('returns a deterministic vector for the same input', async () => {
    const provider = new HashEmbeddingProvider();
    const a = await provider.embed('the quick brown fox');
    const b = await provider.embed('the quick brown fox');
    expect(a).toEqual(b);
  });

  it('produces a unit-normalised vector', async () => {
    const provider = new HashEmbeddingProvider();
    const v = await provider.embed('memory palace gbrain hybrid retrieval');
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
  });

  it('similar texts have higher cosine than unrelated texts', async () => {
    const provider = new HashEmbeddingProvider();
    const a = await provider.embed('user wants to schedule a meeting next Tuesday');
    const b = await provider.embed('schedule a meeting Tuesday afternoon');
    const c = await provider.embed('build the database migration script');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });

  it('embedBatch matches per-call embedding', async () => {
    const provider = new HashEmbeddingProvider();
    const inputs = ['first text', 'second text', 'third text'];
    const batch = await provider.embedBatch(inputs);
    for (let i = 0; i < inputs.length; i++) {
      const single = await provider.embed(inputs[i]!);
      expect(batch[i]).toEqual(single);
    }
  });

  it('respects custom dim', async () => {
    const provider = new HashEmbeddingProvider(128);
    const v = await provider.embed('hello');
    expect(v).toHaveLength(128);
  });

  it('rejects nonsense dim', () => {
    expect(() => new HashEmbeddingProvider(10)).toThrow();
    expect(() => new HashEmbeddingProvider(10000)).toThrow();
  });

  it('returns zero vector for empty input', async () => {
    const provider = new HashEmbeddingProvider(64);
    const v = await provider.embed('');
    expect(v).toHaveLength(64);
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it('reports a stable model identifier', () => {
    const provider = new HashEmbeddingProvider();
    expect(provider.model).toBe('hash-fnv1a-v1');
  });
});

describe('OpenAiEmbeddingProvider', () => {
  it('posts to /embeddings with auth header', async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const fakeFetch = (async (url: unknown, init: unknown) => {
      const i = init as { body: string; headers: Record<string, string> };
      calls.push({
        url: String(url),
        body: JSON.parse(i.body) as Record<string, unknown>,
        headers: i.headers,
      });
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
      dim: 2,
      fetchImpl: fakeFetch,
    });

    const out = await provider.embedBatch(['hello', 'world']);
    expect(out).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/embeddings');
    expect(calls[0]!.headers['authorization']).toBe('Bearer test-key');
    expect((calls[0]!.body as { input: string[] }).input).toEqual(['hello', 'world']);
  });

  it('throws on non-2xx', async () => {
    const fakeFetch = (async () =>
      new Response('error', { status: 500 })) as unknown as typeof fetch;
    const provider = new OpenAiEmbeddingProvider({ apiKey: 'k', dim: 2, fetchImpl: fakeFetch });
    await expect(provider.embed('x')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on response shape mismatch', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    const provider = new OpenAiEmbeddingProvider({ apiKey: 'k', dim: 2, fetchImpl: fakeFetch });
    await expect(provider.embed('x')).rejects.toThrow(/count mismatch/);
  });

  it('returns [] for empty input batch without calling fetch', async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    const provider = new OpenAiEmbeddingProvider({ apiKey: 'k', dim: 2, fetchImpl: fakeFetch });
    const out = await provider.embedBatch([]);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('strips trailing slash from baseUrl', async () => {
    let observedUrl = '';
    const fakeFetch = (async (url: unknown) => {
      observedUrl = String(url);
      return new Response(JSON.stringify({ data: [{ embedding: [0] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1/',
      dim: 1,
      fetchImpl: fakeFetch,
    });
    await provider.embed('x');
    expect(observedUrl).toBe('http://localhost:11434/v1/embeddings');
  });
});
