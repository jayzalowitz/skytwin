/**
 * Integration tests for the CRDB-backed gbrain repository.
 *
 * These tests exercise the live `repository.ts` functions against a real
 * CockroachDB instance. They are gated on the `RUN_DB_TESTS` env var so
 * unit-test runs (CI default) skip them — the unit suite covers the
 * behavioural surface against the in-memory store, which mirrors the
 * SQL-level semantics. The CRDB tests are the safety net that catches
 * SQL syntax / column-name / type-coercion regressions.
 *
 * Issue #197 AC #13: ≥3 integration tests against gbrain-on-CRDB.
 *
 * To run locally: `RUN_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter
 * @skytwin/memory-gbrain-crdb-adapter test`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  insertPage,
  hybridSearch,
  upsertEntity,
  insertTriple,
  getTriples,
  insertEpisode,
  getEpisodes,
  upsertSettings,
  getSettings,
  enqueueEmbeddingJob,
  leaseEmbeddingJob,
  markJobDone,
  countPages,
} from '../repository.js';
import { HashEmbeddingProvider } from '../embedding.js';

const SHOULD_RUN = process.env['RUN_DB_TESTS'] === '1';
const TEST_USER = process.env['TEST_USER_ID'] ?? '';

describe.skipIf(!SHOULD_RUN)('integration — CRDB-backed repository', () => {
  beforeAll(() => {
    if (!TEST_USER) {
      throw new Error(
        'TEST_USER_ID env var required for CRDB integration tests; create a user row first.',
      );
    }
  });

  it('inserts a page and recovers it via hybridSearch', async () => {
    const emb = new HashEmbeddingProvider(128);
    const content = 'Q2 budget review meeting Tuesday afternoon with CFO';
    const e = await emb.embed(content);
    const page = await insertPage({
      userId: TEST_USER,
      title: 'budget review',
      content,
      source: 'note',
      embedding: e,
      embeddingModel: emb.model,
    });
    expect(page.id).toBeDefined();
    expect(page.embedding).toEqual(e);

    const queryEmb = await emb.embed('budget meeting tuesday');
    const hits = await hybridSearch({
      userId: TEST_USER,
      query: 'budget meeting tuesday',
      queryEmbedding: queryEmb,
      k: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.page.id === page.id)).toBe(true);
  });

  it('round-trips entity + triple data', async () => {
    const ent = await upsertEntity({
      userId: TEST_USER,
      name: `Alice-${Date.now()}`,
      entityType: 'person',
      attributes: { email: 'alice@example.com' },
    });
    expect(ent.id).toBeDefined();

    const tri = await insertTriple({
      userId: TEST_USER,
      subject: ent.name,
      predicate: 'works_at',
      object: 'Acme',
      validFrom: new Date('2025-01-01'),
    });
    expect(tri.id).toBeDefined();

    const queried = await getTriples(TEST_USER, { subject: ent.name });
    expect(queried.some((t) => t.id === tri.id)).toBe(true);
  });

  it('episode persistence + range query', async () => {
    const start = new Date(Date.now() - 60_000);
    const end = new Date(Date.now() - 30_000);
    const ep = await insertEpisode({
      userId: TEST_USER,
      summary: 'integration test episode',
      wing: 'integration',
      startedAt: start,
      endedAt: end,
    });
    const episodes = await getEpisodes(TEST_USER, {
      from: new Date(Date.now() - 120_000),
      to: new Date(),
    });
    expect(episodes.some((e) => e.id === ep.id)).toBe(true);
  });

  it('embedding job queue lifecycle (enqueue → lease → mark done)', async () => {
    // Enqueue a fresh page (no embedding) → job is created.
    const page = await insertPage({
      userId: TEST_USER,
      content: 'integration test page',
      source: 'note',
    });
    expect(page.embedding).toBeNull();

    const job = await leaseEmbeddingJob();
    if (job) {
      // The leased job may not be ours specifically (other tests run too),
      // but the lifecycle methods must not throw.
      await markJobDone(job.id);
    }

    // We can also enqueue manually
    await enqueueEmbeddingJob(TEST_USER, page.id);
  });

  it('settings round-trip', async () => {
    const before = await getSettings(TEST_USER);
    const updated = await upsertSettings(TEST_USER, { backend: 'hybrid' });
    expect(updated.backend).toBe('hybrid');

    // Restore (best-effort)
    await upsertSettings(TEST_USER, {
      backend: before?.backend ?? 'gbrain',
    });
  });

  it('countPages reports total + embedded', async () => {
    const counts = await countPages(TEST_USER);
    expect(counts.total).toBeGreaterThanOrEqual(0);
    expect(counts.embedded).toBeGreaterThanOrEqual(0);
    expect(counts.embedded).toBeLessThanOrEqual(counts.total);
  });
});
