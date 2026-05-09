/**
 * Performance regression test for the gbrain hybrid retrieval engine.
 *
 * Issue #197 AC #9: hybrid-routed `searchSemantic` is ≥30% faster than
 * MemPalace-only on a fixture corpus of 10k user signals.
 *
 * We run a stripped-down comparison here: gbrain's RRF retrieval against an
 * ILIKE-style baseline (the L3 search MemPalace ships with). The ILIKE
 * baseline scans every drawer; gbrain returns the top-K from a fused
 * vector + tsvector ranking. On a 10k-page corpus the gbrain side is
 * dominated by the embedding step (one query embedding) plus an O(N) cosine
 * scan — but it bounds the candidate pool, where the ILIKE baseline must
 * scan N rows AND substring-match them.
 *
 * The test asserts both:
 *   1. gbrain returns *meaningful* results (top-1 contains the seeded query
 *      keywords).
 *   2. gbrain's search latency is ≤70% of the ILIKE baseline.
 */

import { describe, it, expect } from 'vitest';
import { EmbeddedGbrainMemoryPort } from '../embedded-port.js';
import {
  HashEmbeddingProvider,
  InMemoryBrainStore,
} from '@skytwin/memory-gbrain-crdb-adapter';

const USER = 'perf-user';

/**
 * Deterministic content generator so the corpus is identical across runs.
 * Mixes random tokens with a few "needle" pages that contain the search
 * phrase so the test is meaningful.
 */
function buildCorpus(size: number): Array<{ id: string; content: string }> {
  const TOPICS = [
    'budget',
    'review',
    'meeting',
    'tuesday',
    'database',
    'migration',
    'forecast',
    'planning',
    'design',
    'feedback',
  ];
  const corpus: Array<{ id: string; content: string }> = [];
  for (let i = 0; i < size; i++) {
    const a = TOPICS[i % TOPICS.length]!;
    const b = TOPICS[(i + 3) % TOPICS.length]!;
    const c = TOPICS[(i * 5 + 1) % TOPICS.length]!;
    corpus.push({
      id: `pg-${i}`,
      content: `${a} ${b} ${c} document number ${i} payload random text`,
    });
  }
  // Add a needle that exactly matches our query so we can verify retrieval works.
  corpus[Math.floor(size / 2)] = {
    id: 'pg-needle',
    content: 'budget review meeting tuesday afternoon',
  };
  return corpus;
}

/**
 * The MemPalace-style baseline: linear ILIKE-equivalent — split query into
 * terms and substring-match across content. We score by overlap count.
 * Returns top-K. This matches the shape of `mempalaceRepository.searchEpisodes`.
 */
function ilikeBaseline(
  corpus: Array<{ id: string; content: string }>,
  query: string,
  k: number,
): Array<{ id: string; score: number }> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return [];
  const scored = corpus
    .map((doc) => {
      const lc = doc.content.toLowerCase();
      let overlap = 0;
      for (const t of terms) if (lc.includes(t)) overlap++;
      return { id: doc.id, score: overlap };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored;
}

describe('perf — quality (always on)', () => {
  it('gbrain finds the needle in a 1000-page haystack', async () => {
    const SIZE = 1000;
    const corpus = buildCorpus(SIZE);
    const store = new InMemoryBrainStore();
    const port = new EmbeddedGbrainMemoryPort({
      userId: USER,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(128),
    });
    const emb = new HashEmbeddingProvider(128);
    for (const doc of corpus) {
      const e = await emb.embed(doc.content);
      store.insertPage({
        id: doc.id,
        userId: USER,
        content: doc.content,
        source: 'note',
        embedding: e,
        embeddingModel: 'hash-fnv1a-v1',
      });
    }
    const QUERY = 'budget review meeting tuesday';
    const hits = await port.searchSemantic(QUERY, 10);
    expect(hits.length).toBeGreaterThan(0);
    // Top result should contain at least 3 of the 4 query tokens.
    const tokens = ['budget', 'review', 'meeting', 'tuesday'];
    const topContent = hits[0]?.content?.toLowerCase() ?? '';
    const overlap = tokens.filter((t) => topContent.includes(t)).length;
    expect(overlap).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

describe('perf — gbrain RRF vs ILIKE baseline', () => {
  // This benchmark only runs when GBRAIN_PERF=1 is set explicitly. It is not
  // gated on CI — it is gated on opt-in. The 30% target is calibrated against
  // the *production* path (CRDB tsvector + vector indexes), not the in-memory
  // store; running it always would be a flaky test on most workstations.
  it.skipIf(process.env['GBRAIN_PERF'] !== '1')(
    'gbrain ≥ 30% faster than ILIKE-style baseline on 10k-page corpus',
    async () => {
      const SIZE = Number(process.env['GBRAIN_PERF_CORPUS'] ?? 10_000);
      const corpus = buildCorpus(SIZE);

      // Seed the gbrain side (synchronous embedding so the page write also
      // produces a vector — that way searchSemantic doesn't need to embed
      // the corpus at query time).
      const store = new InMemoryBrainStore();
      const port = new EmbeddedGbrainMemoryPort({
        userId: USER,
        backend: 'memory',
        store,
        embedding: new HashEmbeddingProvider(128),
      });
      const emb = new HashEmbeddingProvider(128);
      for (const doc of corpus) {
        const e = await emb.embed(doc.content);
        store.insertPage({
          id: doc.id,
          userId: USER,
          content: doc.content,
          source: 'note',
          embedding: e,
          embeddingModel: 'hash-fnv1a-v1',
        });
      }

      const QUERY = 'budget review meeting tuesday';
      const RUNS = 8;

      // Warm-up — JIT/cache.
      await port.searchSemantic(QUERY, 10);
      ilikeBaseline(corpus, QUERY, 10);

      // Time gbrain
      const gbrainTimes: number[] = [];
      let lastHits: ReturnType<EmbeddedGbrainMemoryPort['searchSemantic']> extends Promise<infer T>
        ? T
        : never = [] as never;
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        // eslint-disable-next-line no-await-in-loop
        lastHits = await port.searchSemantic(QUERY, 10);
        gbrainTimes.push(performance.now() - start);
      }

      // Time ILIKE
      const ilikeTimes: number[] = [];
      let lastBaseline: Array<{ id: string; score: number }> = [];
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        lastBaseline = ilikeBaseline(corpus, QUERY, 10);
        ilikeTimes.push(performance.now() - start);
      }

      // Sanity-check: gbrain finds the needle.
      expect(lastHits.length).toBeGreaterThan(0);
      expect(lastBaseline.length).toBeGreaterThan(0);

      const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
      const gbrainMs = median(gbrainTimes);
      const ilikeMs = median(ilikeTimes);

      // Log so CI artifact captures the numbers
      // eslint-disable-next-line no-console
      console.log(
        `[perf] corpus=${SIZE} gbrain=${gbrainMs.toFixed(2)}ms ilike=${ilikeMs.toFixed(2)}ms ratio=${(gbrainMs / ilikeMs).toFixed(2)}`,
      );

      // Gbrain should be ≤ 70% of the baseline (i.e. ≥30% faster).
      expect(gbrainMs).toBeLessThanOrEqual(ilikeMs * 0.7);
    },
    60_000,
  );
});
