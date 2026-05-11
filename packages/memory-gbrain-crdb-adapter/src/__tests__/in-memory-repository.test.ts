import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryBrainStore } from '../in-memory-repository.js';
import { HashEmbeddingProvider } from '../embedding.js';

describe('InMemoryBrainStore — pages', () => {
  let store: InMemoryBrainStore;
  beforeEach(() => {
    store = new InMemoryBrainStore();
  });

  it('inserts and returns a page', () => {
    const row = store.insertPage({
      userId: 'u1',
      content: 'Hello world',
      source: 'note',
    });
    expect(row.id).toBeDefined();
    expect(row.user_id).toBe('u1');
    expect(row.content).toBe('Hello world');
    expect(row.embedding).toBeNull();
  });

  it('enqueues an embedding job when no embedding provided', () => {
    expect(store.pendingEmbeddingJobs()).toBe(0);
    store.insertPage({ userId: 'u1', content: 'x', source: 'note' });
    expect(store.pendingEmbeddingJobs()).toBe(1);
  });

  it('does NOT enqueue a job when embedding is provided', () => {
    store.insertPage({
      userId: 'u1',
      content: 'x',
      source: 'note',
      embedding: [0.1, 0.2],
      embeddingModel: 'test',
    });
    expect(store.pendingEmbeddingJobs()).toBe(0);
  });

  it('text search ranks by token overlap', () => {
    store.insertPage({ userId: 'u1', content: 'meeting tuesday afternoon', source: 'note' });
    store.insertPage({ userId: 'u1', content: 'database migration script', source: 'note' });
    store.insertPage({ userId: 'u1', content: 'tuesday meeting tomorrow', source: 'note' });
    const hits = store.textSearch('u1', 'meeting tuesday', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.page.content).toMatch(/tuesday|meeting/);
  });

  it('vector search ranks by cosine similarity', async () => {
    const emb = new HashEmbeddingProvider();
    const a = await emb.embed('schedule meeting');
    const b = await emb.embed('schedule meeting tuesday');
    const c = await emb.embed('database migration');

    store.insertPage({ userId: 'u1', content: 'a', source: 'note', embedding: a, embeddingModel: 'h' });
    store.insertPage({ userId: 'u1', content: 'b', source: 'note', embedding: b, embeddingModel: 'h' });
    store.insertPage({ userId: 'u1', content: 'c', source: 'note', embedding: c, embeddingModel: 'h' });

    const queryEmb = await emb.embed('schedule meeting');
    const hits = store.vectorSearch('u1', queryEmb, 3);
    expect(hits[0]!.page.content).toBe('a'); // exact match wins
  });

  it('hybridSearch fuses text + vector via RRF', async () => {
    const emb = new HashEmbeddingProvider();
    const fooEmb = await emb.embed('foo');
    const barEmb = await emb.embed('bar baz');

    store.insertPage({ userId: 'u1', content: 'foo something', source: 'note', embedding: fooEmb, embeddingModel: 'h' });
    store.insertPage({ userId: 'u1', content: 'bar baz quux', source: 'note', embedding: barEmb, embeddingModel: 'h' });

    const q = await emb.embed('foo');
    const hits = store.hybridSearch({
      userId: 'u1',
      query: 'foo',
      queryEmbedding: q,
      k: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.page.content).toContain('foo');
  });

  it('isolates by user_id', () => {
    store.insertPage({ userId: 'u1', content: 'mine', source: 'note' });
    store.insertPage({ userId: 'u2', content: 'yours', source: 'note' });
    expect(store.textSearch('u1', 'mine', 5)).toHaveLength(1);
    expect(store.textSearch('u1', 'yours', 5)).toHaveLength(0);
    expect(store.textSearch('u2', 'yours', 5)).toHaveLength(1);
  });

  it('updatePageEmbedding sets vector + model', async () => {
    const row = store.insertPage({ userId: 'u1', content: 'x', source: 'note' });
    expect(row.embedding).toBeNull();
    store.updatePageEmbedding(row.id, [0.1, 0.2], 'test-model');
    const updated = [...store.pages.values()].find((p) => p.id === row.id);
    expect(updated?.embedding).toEqual([0.1, 0.2]);
    expect(updated?.embedding_model).toBe('test-model');
  });

  it('countPages reports total + embedded counts', () => {
    store.insertPage({ userId: 'u1', content: 'a', source: 'note' });
    store.insertPage({ userId: 'u1', content: 'b', source: 'note', embedding: [0.1], embeddingModel: 'm' });
    store.insertPage({ userId: 'u2', content: 'c', source: 'note' });
    expect(store.countPages('u1')).toEqual({ total: 2, embedded: 1 });
    expect(store.countPages('u2')).toEqual({ total: 1, embedded: 0 });
  });
});

describe('InMemoryBrainStore — entities', () => {
  it('upsertEntity treats (user, name, type) as unique key', () => {
    const store = new InMemoryBrainStore();
    const a = store.upsertEntity({
      userId: 'u1',
      name: 'Alice',
      entityType: 'person',
      attributes: { email: 'a@example.com' },
    });
    const b = store.upsertEntity({
      userId: 'u1',
      name: 'Alice',
      entityType: 'person',
      attributes: { email: 'alice@example.com' },
    });
    expect(b.id).toBe(a.id); // same row updated
    expect(b.attributes['email']).toBe('alice@example.com');
  });

  it('filters by entityType + nameLike', () => {
    const store = new InMemoryBrainStore();
    store.upsertEntity({ userId: 'u1', name: 'Alice', entityType: 'person' });
    store.upsertEntity({ userId: 'u1', name: 'Bob', entityType: 'person' });
    store.upsertEntity({ userId: 'u1', name: 'Acme Corp', entityType: 'organization' });
    expect(store.getEntities('u1', { entityType: 'person' })).toHaveLength(2);
    expect(store.getEntities('u1', { entityType: 'organization' })).toHaveLength(1);
    expect(store.getEntities('u1', { nameLike: 'al' })).toHaveLength(1);
  });
});

describe('InMemoryBrainStore — triples', () => {
  it('stores and queries triples by subject/predicate/object', () => {
    const store = new InMemoryBrainStore();
    store.insertTriple({ userId: 'u1', subject: 'alice', predicate: 'works_at', object: 'acme' });
    store.insertTriple({ userId: 'u1', subject: 'alice', predicate: 'lives_in', object: 'sf' });
    store.insertTriple({ userId: 'u1', subject: 'bob', predicate: 'works_at', object: 'acme' });

    expect(store.getTriples('u1', { subject: 'alice' })).toHaveLength(2);
    expect(store.getTriples('u1', { predicate: 'works_at' })).toHaveLength(2);
    expect(store.getTriples('u1', { object: 'acme' })).toHaveLength(2);
    expect(store.getTriples('u1', { subject: 'alice', predicate: 'works_at' })).toHaveLength(1);
  });
});

describe('InMemoryBrainStore — episodes', () => {
  it('filters by time range and wing', () => {
    const store = new InMemoryBrainStore();
    const now = new Date('2026-05-01T00:00:00Z');
    const earlier = new Date('2026-04-01T00:00:00Z');

    store.insertEpisode({ userId: 'u1', summary: 'now ep', startedAt: now, endedAt: now, wing: 'work' });
    store.insertEpisode({ userId: 'u1', summary: 'earlier ep', startedAt: earlier, endedAt: earlier, wing: 'home' });
    expect(
      store.getEpisodes('u1', {
        from: new Date('2026-04-15T00:00:00Z'),
        to: new Date('2026-06-01T00:00:00Z'),
      }),
    ).toHaveLength(1);
    expect(store.getEpisodes('u1', { wing: 'home' })).toHaveLength(1);
  });
});

describe('InMemoryBrainStore — signals', () => {
  it('rejects duplicate ids', () => {
    const store = new InMemoryBrainStore();
    store.insertSignal({
      id: 's1',
      userId: 'u1',
      source: 'gmail',
      type: 'email',
      signalTimestamp: new Date(),
    });
    expect(() =>
      store.insertSignal({
        id: 's1',
        userId: 'u1',
        source: 'gmail',
        type: 'email',
        signalTimestamp: new Date(),
      }),
    ).toThrow(/duplicate/);
  });

  it('lists signals chronologically', () => {
    const store = new InMemoryBrainStore();
    store.insertSignal({
      id: 's2',
      userId: 'u1',
      source: 'g',
      type: 'e',
      signalTimestamp: new Date('2026-05-02'),
    });
    store.insertSignal({
      id: 's1',
      userId: 'u1',
      source: 'g',
      type: 'e',
      signalTimestamp: new Date('2026-05-01'),
    });
    const list = store.getAllSignals('u1');
    expect(list[0]?.id).toBe('s1');
    expect(list[1]?.id).toBe('s2');
  });
});

describe('InMemoryBrainStore — settings + embedding queue', () => {
  it('upsertSettings merges patches', () => {
    const store = new InMemoryBrainStore();
    expect(store.getSettings('u1')).toBeNull();
    const a = store.upsertSettings('u1', { backend: 'gbrain' });
    expect(a.backend).toBe('gbrain');
    const b = store.upsertSettings('u1', { hybrid_notification_dismissed: true });
    expect(b.backend).toBe('gbrain'); // preserved
    expect(b.hybrid_notification_dismissed).toBe(true);
  });

  it('upsertSettings on a fresh user with no backend defaults to gbrain (NOT hybrid)', () => {
    // Regression test for /review finding: dismissing the hybrid notification
    // for a brand-new user (no existing brain_settings row) used to silently
    // create the row with backend='hybrid'. The default must match the
    // factory's 'gbrain' default — see apps/api/src/memory-setup.ts.
    const store = new InMemoryBrainStore();
    const row = store.upsertSettings('fresh-user', { hybrid_notification_dismissed: true });
    expect(row.backend).toBe('gbrain');
    expect(row.hybrid_notification_dismissed).toBe(true);
  });

  it('lease/markDone job queue lifecycle', () => {
    const store = new InMemoryBrainStore();
    const page = store.insertPage({ userId: 'u1', content: 'x', source: 'note' });
    expect(store.pendingEmbeddingJobs()).toBe(1);
    const job = store.leaseEmbeddingJob();
    expect(job).not.toBeNull();
    expect(job?.pageId).toBe(page.id);
    // Once leased, no other job is pending
    expect(store.leaseEmbeddingJob()).toBeNull();
    store.markJobDone(job!.id);
  });

  it('markJobFailed re-queues until 3 attempts then fails', () => {
    const store = new InMemoryBrainStore();
    store.insertPage({ userId: 'u1', content: 'x', source: 'note' });
    let job = store.leaseEmbeddingJob();
    store.markJobFailed(job!.id, 'attempt 1');
    job = store.leaseEmbeddingJob();
    store.markJobFailed(job!.id, 'attempt 2');
    job = store.leaseEmbeddingJob();
    store.markJobFailed(job!.id, 'attempt 3');
    // After 3 attempts → permanently failed; pending count drops.
    expect(store.pendingEmbeddingJobs()).toBe(0);
  });
});
