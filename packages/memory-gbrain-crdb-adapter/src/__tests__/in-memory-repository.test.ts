import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  // #300 — SQL-pushdown authoringTier filter

  it('textSearch authoringTier filter narrows to matching pages', () => {
    store.insertPage({
      userId: 'u1',
      content: 'meeting tuesday',
      source: 'note',
      metadata: { authoringTier: 'user_sent_originated' },
    });
    store.insertPage({
      userId: 'u1',
      content: 'meeting wednesday',
      source: 'note',
      metadata: { authoringTier: 'inbox_personal' },
    });
    store.insertPage({
      userId: 'u1',
      content: 'meeting thursday',
      source: 'note',
      metadata: { authoringTier: 'user_sent_reply' },
    });

    const all = store.textSearch('u1', 'meeting', 10);
    expect(all).toHaveLength(3);

    const authored = store.textSearch('u1', 'meeting', 10, [
      'user_sent_originated',
      'user_sent_reply',
    ]);
    expect(authored).toHaveLength(2);
    for (const hit of authored) {
      const tier = (hit.page.metadata as Record<string, unknown>)['authoringTier'];
      expect(tier).toMatch(/^user_sent_/);
    }
  });

  it('textSearch empty authoringTier array is treated as no-filter', () => {
    store.insertPage({
      userId: 'u1',
      content: 'meeting',
      source: 'note',
      metadata: { authoringTier: 'inbox_personal' },
    });
    const unfiltered = store.textSearch('u1', 'meeting', 10);
    const emptyFilter = store.textSearch('u1', 'meeting', 10, []);
    expect(emptyFilter).toHaveLength(unfiltered.length);
  });

  it('textSearch rejects pages whose metadata authoringTier is not a string', () => {
    store.insertPage({
      userId: 'u1',
      content: 'meeting',
      source: 'note',
      metadata: { authoringTier: 42 },
    });
    store.insertPage({
      userId: 'u1',
      content: 'meeting',
      source: 'note',
      metadata: { authoringTier: 'user_sent_originated' },
    });
    const filtered = store.textSearch('u1', 'meeting', 10, ['user_sent_originated']);
    expect(filtered).toHaveLength(1);
    expect(
      (filtered[0]!.page.metadata as Record<string, unknown>)['authoringTier'],
    ).toBe('user_sent_originated');
  });

  it('vectorSearch authoringTier filter narrows the cosine pool', async () => {
    const emb = new HashEmbeddingProvider();
    const a = await emb.embed('schedule meeting');
    const b = await emb.embed('schedule meeting tuesday');

    store.insertPage({
      userId: 'u1',
      content: 'a',
      source: 'note',
      embedding: a,
      embeddingModel: 'h',
      metadata: { authoringTier: 'inbox_personal' },
    });
    store.insertPage({
      userId: 'u1',
      content: 'b',
      source: 'note',
      embedding: b,
      embeddingModel: 'h',
      metadata: { authoringTier: 'user_sent_reply' },
    });

    const q = await emb.embed('schedule meeting');
    const filtered = store.vectorSearch('u1', q, 10, ['user_sent_reply']);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.page.content).toBe('b');
  });

  it('hybridSearch authoringTier filter propagates to both legs', async () => {
    const emb = new HashEmbeddingProvider();
    const fooEmb = await emb.embed('foo');
    const barEmb = await emb.embed('foo bar');

    store.insertPage({
      userId: 'u1',
      content: 'foo authored',
      source: 'note',
      embedding: fooEmb,
      embeddingModel: 'h',
      metadata: { authoringTier: 'user_sent_originated' },
    });
    store.insertPage({
      userId: 'u1',
      content: 'foo bar inboxed',
      source: 'note',
      embedding: barEmb,
      embeddingModel: 'h',
      metadata: { authoringTier: 'inbox_personal' },
    });

    const q = await emb.embed('foo');
    const all = store.hybridSearch({ userId: 'u1', query: 'foo', queryEmbedding: q, k: 5 });
    expect(all.length).toBeGreaterThan(1);

    const authored = store.hybridSearch({
      userId: 'u1',
      query: 'foo',
      queryEmbedding: q,
      k: 5,
      authoringTier: ['user_sent_originated'],
    });
    expect(authored).toHaveLength(1);
    expect(authored[0]!.page.content).toBe('foo authored');
  });

  it('pages with no metadata are dropped when an authoringTier filter is set', () => {
    store.insertPage({ userId: 'u1', content: 'no metadata', source: 'note' });
    store.insertPage({
      userId: 'u1',
      content: 'matches',
      source: 'note',
      metadata: { authoringTier: 'user_sent_originated' },
    });
    const filtered = store.textSearch('u1', 'matches no metadata', 10, [
      'user_sent_originated',
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.page.content).toBe('matches');
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
    // Absolute dates are fine here: getAllSignals does no window
    // filtering, so these fixtures cannot age out. Only the
    // computeBidirectionalThreadCounts suite needs relative days.
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

describe('InMemoryBrainStore — metadata overrides (#251 privacy)', () => {
  let store: InMemoryBrainStore;
  beforeEach(() => {
    store = new InMemoryBrainStore();
  });

  it('updatePageMetadata merges a patch, preserving other metadata keys', () => {
    const page = store.insertPage({
      userId: 'u1',
      content: 'hello',
      source: 'signal',
      metadata: { signalSource: 'gmail', authoringTier: 'inbox_personal', bodyLen: 5 },
    });
    const n = store.updatePageMetadata('u1', page.id, { userOverride: 'pinned' });
    expect(n).toBe(1);
    const after = store.getRecentPages('u1', 1)[0]!;
    expect(after.metadata).toEqual({
      signalSource: 'gmail',
      authoringTier: 'inbox_personal',
      bodyLen: 5,
      userOverride: 'pinned',
    });
  });

  it('updatePageMetadata treats null patch values as a delete-key request', async () => {
    const page = store.insertPage({
      userId: 'u1',
      content: 'x',
      source: 'signal',
      metadata: { authoringTier: 'inbox_newsletter', userOverride: 'pinned', bodyLen: 200 },
    });
    const n = store.updatePageMetadata('u1', page.id, { userOverride: null });
    expect(n).toBe(1);
    const after = store.getRecentPages('u1', 1)[0]!;
    const meta = after.metadata as Record<string, unknown>;
    // Key is gone — not set to null — so downstream consumers that
    // distinguish "absent" from "present-but-null" see the cleared shape.
    expect('userOverride' in meta).toBe(false);
    // Other keys preserved.
    expect(meta['authoringTier']).toBe('inbox_newsletter');
    expect(meta['bodyLen']).toBe(200);
  });

  it("updatePageMetadata returns 0 when the page isn't owned by the user", () => {
    const page = store.insertPage({
      userId: 'u1',
      content: 'x',
      source: 'signal',
    });
    // u2 tries to mutate u1's page — must be a no-op.
    const n = store.updatePageMetadata('u2', page.id, { userOverride: 'hidden' });
    expect(n).toBe(0);
    const after = store.getRecentPages('u1', 1)[0]!;
    expect((after.metadata as Record<string, unknown>)['userOverride']).toBeUndefined();
  });

  it('updatePageMetadata returns 0 for a missing page id', () => {
    const n = store.updatePageMetadata('u1', 'nonexistent', { userOverride: 'pinned' });
    expect(n).toBe(0);
  });

  it('hideAllPagesFromSender hides every matching page (case-insensitive)', () => {
    store.insertPage({
      userId: 'u1',
      content: 'a',
      source: 'signal',
      metadata: { fromAddress: 'spam@vendor.example.com' },
    });
    store.insertPage({
      userId: 'u1',
      content: 'b',
      source: 'signal',
      metadata: { fromAddress: 'spam@vendor.example.com', authoringTier: 'inbox_newsletter' },
    });
    store.insertPage({
      userId: 'u1',
      content: 'c',
      source: 'signal',
      metadata: { fromAddress: 'someone-else@example.com' },
    });
    // Different user — must not be touched.
    store.insertPage({
      userId: 'u2',
      content: 'd',
      source: 'signal',
      metadata: { fromAddress: 'spam@vendor.example.com' },
    });

    // Upper-case input still matches lower-case stored values.
    const n = store.hideAllPagesFromSender('u1', 'SPAM@VENDOR.EXAMPLE.COM');
    expect(n).toBe(2);

    const u1Pages = store.getRecentPages('u1', 10);
    for (const p of u1Pages) {
      const meta = p.metadata as Record<string, unknown>;
      if (meta['fromAddress'] === 'spam@vendor.example.com') {
        expect(meta['userOverride']).toBe('hidden');
      } else {
        expect(meta['userOverride']).toBeUndefined();
      }
    }

    // u2's page is untouched.
    const u2Pages = store.getRecentPages('u2', 10);
    expect((u2Pages[0]!.metadata as Record<string, unknown>)['userOverride']).toBeUndefined();
  });

  it('hideAllPagesFromSender returns 0 when no pages match the sender', () => {
    store.insertPage({
      userId: 'u1',
      content: 'x',
      source: 'signal',
      metadata: { fromAddress: 'alice@example.com' },
    });
    const n = store.hideAllPagesFromSender('u1', 'bob@example.com');
    expect(n).toBe(0);
  });
});

describe('InMemoryBrainStore — findPagesMissingAuthoringTier (#251 backfill)', () => {
  let store: InMemoryBrainStore;
  beforeEach(() => {
    store = new InMemoryBrainStore();
  });

  it('returns pages missing authoringTier paired with their signal data', () => {
    // Seed a signal + a page that references it via source_ref.
    store.insertSignal({
      id: 'sig-1',
      userId: 'u1',
      source: 'gmail',
      type: 'email',
      data: { from: 'me@example.com', labels: ['SENT'] },
      signalTimestamp: new Date(),
    });
    store.insertPage({
      userId: 'u1',
      content: 'a',
      source: 'signal',
      sourceRef: 'sig-1',
      metadata: { signalSource: 'gmail' }, // intentionally no authoringTier
    });
    // A second page that already HAS a tier — must not be returned.
    store.insertSignal({
      id: 'sig-2',
      userId: 'u1',
      source: 'gmail',
      type: 'email',
      data: { from: 'a@example.com' },
      signalTimestamp: new Date(),
    });
    store.insertPage({
      userId: 'u1',
      content: 'b',
      source: 'signal',
      sourceRef: 'sig-2',
      metadata: { authoringTier: 'inbox_personal' },
    });

    const rows = store.findPagesMissingAuthoringTier(null, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe('u1');
    expect(rows[0]!.signal_data['from']).toBe('me@example.com');
  });

  it('skips pages whose source_ref does not match a stored signal', () => {
    store.insertPage({
      userId: 'u1',
      content: 'orphan',
      source: 'signal',
      sourceRef: 'no-such-signal',
      metadata: {},
    });
    const rows = store.findPagesMissingAuthoringTier(null, 10);
    expect(rows).toHaveLength(0);
  });

  it('scopes by userId when supplied', () => {
    store.insertSignal({
      id: 'sig-a',
      userId: 'u1',
      source: 'gmail',
      type: 'email',
      data: { from: 'x@example.com' },
      signalTimestamp: new Date(),
    });
    store.insertSignal({
      id: 'sig-b',
      userId: 'u2',
      source: 'gmail',
      type: 'email',
      data: { from: 'y@example.com' },
      signalTimestamp: new Date(),
    });
    store.insertPage({
      userId: 'u1',
      content: 'a',
      source: 'signal',
      sourceRef: 'sig-a',
      metadata: {},
    });
    store.insertPage({
      userId: 'u2',
      content: 'b',
      source: 'signal',
      sourceRef: 'sig-b',
      metadata: {},
    });

    expect(store.findPagesMissingAuthoringTier('u1', 10)).toHaveLength(1);
    expect(store.findPagesMissingAuthoringTier('u2', 10)).toHaveLength(1);
    expect(store.findPagesMissingAuthoringTier(null, 10)).toHaveLength(2);
  });

  it('caps the result set at `limit`', () => {
    for (let i = 0; i < 5; i++) {
      const id = `sig-${i}`;
      store.insertSignal({
        id,
        userId: 'u1',
        source: 'gmail',
        type: 'email',
        data: { from: 'x@example.com' },
        signalTimestamp: new Date(),
      });
      store.insertPage({
        userId: 'u1',
        content: `p${i}`,
        source: 'signal',
        sourceRef: id,
        metadata: {},
      });
    }
    expect(store.findPagesMissingAuthoringTier(null, 2)).toHaveLength(2);
  });
});

// Anti-rot: the entire suite runs twice — once on the real clock, once five
// years ahead. Every fixture below derives from `daysAgo()`, so it travels
// with the clock; an absolute date literal does not, and falls outside the
// 90-day window in the shifted run.
//
// This shape matters. An earlier version of this guard was a single extra
// test with its own inline relative fixtures — which only proved the
// implementation reads `Date.now()` (never in doubt) and stayed green when an
// absolute date was reintroduced into a sibling test. A guard has to cover the
// fixtures it is guarding, not restate the thing it is guarding them against.
describe.each([
  ['current clock', 0],
  ['five years ahead', 5 * 365 * 24 * 60 * 60 * 1000],
] as const)(
  'InMemoryBrainStore — computeBidirectionalThreadCounts (#251 Phase 2, intersection per #281) [%s]',
  (_label, clockOffsetMs) => {
  let store: InMemoryBrainStore;
  // Captured ONCE per test so every `daysAgo()` call within a test resolves
  // against the same instant. Reading `Date.now()` per call let a test whose
  // seeds straddled UTC midnight bucket its "same day" pair onto two different
  // days, producing a midnight-only flake.
  let now: number;

  beforeEach(() => {
    if (clockOffsetMs > 0) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + clockOffsetMs));
    }
    now = Date.now();
    store = new InMemoryBrainStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seedReceived(id: string, fromHeader: string, day: string) {
    store.insertSignal({
      id,
      userId: 'u1',
      source: 'gmail',
      type: 'email',
      data: { from: fromHeader, labels: ['INBOX'] },
      signalTimestamp: new Date(day),
    });
  }
  function seedSent(id: string, toHeader: string, day: string, ccHeader?: string) {
    store.insertSignal({
      id,
      userId: 'u1',
      source: 'gmail',
      type: 'email',
      data: {
        from: 'me@example.com',
        to: toHeader,
        ...(ccHeader ? { cc: ccHeader } : {}),
        labels: ['SENT'],
      },
      signalTimestamp: new Date(day),
    });
  }

  /**
   * A `YYYY-MM-DD` day `n` days before today.
   *
   * These fixtures MUST be anchored to `Date.now()`, never written as
   * absolute dates. `computeBidirectionalThreadCounts` filters on
   * `Date.now() - windowDays * 86_400_000`, so hardcoded days silently
   * age out of the window: this suite was written with `2026-05-0X`
   * literals and went red on 2026-07-30 with no code change at all,
   * taking CI — and with it the whole release pipeline — down until
   * someone read past the turbo-cache noise in the log.
   *
   * Keep every offset comfortably inside 90 days so the suite can never
   * fail on a window boundary.
   */
  function daysAgo(n: number): string {
    return new Date(now - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  it('extracts bare address from RFC 5322 display-name format', () => {
    // Send + receive on the SAME day so the intersection is 1. (Under
    // the pre-#281 loose semantics any cross-day pair counted; now they
    // must share a day. `daysAgo` resolves against a per-test `now`, so
    // both calls are guaranteed the same day even across UTC midnight.)
    seedReceived('r1', 'Alice Smith <alice@example.com>', daysAgo(29));
    seedSent('s1', 'Alice Smith <alice@example.com>', daysAgo(29));
    const out = store.computeBidirectionalThreadCounts('u1', 90);
    expect(out.get('alice@example.com')).toBe(1);
    expect(out.has('alice smith <alice@example.com>')).toBe(false);
  });

  it('handles bare addresses without angle brackets', () => {
    seedReceived('r1', 'bob@example.com', daysAgo(29));
    seedSent('s1', 'bob@example.com', daysAgo(29));
    const out = store.computeBidirectionalThreadCounts('u1', 90);
    expect(out.get('bob@example.com')).toBe(1);
  });

  it('splits comma-separated `to` lists into individual recipients', () => {
    // Received once from each of two contacts on the same day; sent a
    // single email to both on that same day. Under intersection, each
    // contact gets a count of 1.
    seedReceived('r1', 'alice@example.com', daysAgo(29));
    seedReceived('r2', 'carol@example.com', daysAgo(29));
    seedSent('s1', 'alice@example.com, carol@example.com', daysAgo(29));
    const out = store.computeBidirectionalThreadCounts('u1', 90);
    expect(out.get('alice@example.com')).toBe(1);
    expect(out.get('carol@example.com')).toBe(1);
  });

  it('considers `cc` recipients as bidirectional contacts', () => {
    seedReceived('r1', 'dan@example.com', daysAgo(29));
    seedSent('s1', 'alice@example.com', daysAgo(29), 'dan@example.com');
    const out = store.computeBidirectionalThreadCounts('u1', 90);
    expect(out.get('dan@example.com')).toBe(1);
  });

  it('returns no entry for received-only contacts (no bidirectional)', () => {
    seedReceived('r1', 'eve@example.com', daysAgo(29));
    seedSent('s1', 'alice@example.com', daysAgo(28));
    // Positive control: a genuinely bidirectional contact in the same
    // store. Without it every assertion below is satisfied by an empty
    // map, which is how this test kept passing while the window was
    // silently dropping all of its fixtures.
    seedReceived('r-ctl', 'ctl@example.com', daysAgo(27));
    seedSent('s-ctl', 'ctl@example.com', daysAgo(27));
    const out = store.computeBidirectionalThreadCounts('u1', 90);
    expect(out.get('ctl@example.com')).toBe(1);
    expect(out.has('eve@example.com')).toBe(false);
    expect(out.get('alice@example.com')).toBeUndefined();
  });

  it('counts distinct days where both directions occurred (intersection)', () => {
    // Frank: received twice on the SAME day (29d ago), received again
    // 27d ago, sent on both of those days. Under intersection: 2 days.
    // The duplicate receive on the first day doesn't inflate the count.
    seedReceived('r1', 'frank@example.com', daysAgo(29));
    seedReceived('r2', 'frank@example.com', daysAgo(29));
    seedReceived('r3', 'frank@example.com', daysAgo(27));
    seedSent('s1', 'frank@example.com', daysAgo(29));
    seedSent('s2', 'frank@example.com', daysAgo(27));
    const out = store.computeBidirectionalThreadCounts('u1', 90);
    expect(out.get('frank@example.com')).toBe(2);
  });

  it('treats missing labels as received (not silently dropped)', () => {
    // Copilot finding on Phase 4: when `labels` is missing/NULL the
    // CRDB predicate yields NULL → both CTEs drop the row. The in-memory
    // mirror correctly treats missing as []. Test pins the behaviour so
    // a future refactor can't regress to the SQL-divergent state.
    store.insertSignal({
      id: 's-no-labels',
      userId: 'u1',
      source: 'gmail',
      type: 'email',
      data: { from: 'irene@example.com' },
      signalTimestamp: new Date(daysAgo(29)),
    });
    seedSent('s1', 'irene@example.com', daysAgo(29));
    const out = store.computeBidirectionalThreadCounts('u1', 90);
    expect(out.get('irene@example.com')).toBe(1);
  });

  it('respects the windowDays cutoff', () => {
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    seedReceived('r-old', 'gary@example.com', longAgo);
    seedSent('s-old', 'gary@example.com', longAgo);
    seedReceived('r1', 'henry@example.com', today);
    seedSent('s1', 'henry@example.com', today);
    const out = store.computeBidirectionalThreadCounts('u1', 90);
    expect(out.has('gary@example.com')).toBe(false);
    expect(out.get('henry@example.com')).toBe(1);
  });

  // ── #281 intersection-vs-window-presence pins ─────────────────────────
  //
  // The pre-#281 semantics counted "any received-day where the contact
  // also has any sent activity anywhere in the 90d window." A single
  // sent email could promote 10 newsletters → core. The intersection
  // semantics fix that. These tests pin the distinction explicitly so a
  // future refactor toward window-presence can't re-introduce the bug.

  it('does NOT count cross-day activity (the #281 regression)', () => {
    // 10 received days from a contact, plus one sent message on a day
    // with NO received activity. Old semantics: 10. New semantics: 0.
    for (let i = 1; i <= 10; i++) {
      seedReceived(`r${i}`, 'jim@example.com', daysAgo(30 - i));
    }
    seedSent('s1', 'jim@example.com', daysAgo(15)); // no overlap
    // Positive control — see the note on the received-only test above.
    // This is the #281 guard; if it can pass on an empty map it is
    // guarding nothing.
    seedReceived('r-ctl', 'ctl@example.com', daysAgo(27));
    seedSent('s-ctl', 'ctl@example.com', daysAgo(27));
    const out = store.computeBidirectionalThreadCounts('u1', 90);
    expect(out.get('ctl@example.com')).toBe(1);
    expect(out.has('jim@example.com')).toBe(false);
  });

  it('counts only the days that appear in BOTH directions', () => {
    // Received 29/28/27d ago. Sent 28/27/26d ago. Intersection: the
    // 28d and 27d days — 2.
    seedReceived('r1', 'kate@example.com', daysAgo(29));
    seedReceived('r2', 'kate@example.com', daysAgo(28));
    seedReceived('r3', 'kate@example.com', daysAgo(27));
    seedSent('s1', 'kate@example.com', daysAgo(28));
    seedSent('s2', 'kate@example.com', daysAgo(27));
    seedSent('s3', 'kate@example.com', daysAgo(26));
    const out = store.computeBidirectionalThreadCounts('u1', 90);
    expect(out.get('kate@example.com')).toBe(2);
  });
  },
);
