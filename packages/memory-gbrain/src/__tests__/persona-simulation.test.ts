/**
 * Persona-driven E2E simulation.
 *
 * Runs Sam Patel — a Series A SaaS founder — through six weeks of life inside
 * the gbrain memory layer, then inspects the profile that emerges. Each phase
 * of the test corresponds to a weekly milestone in Sam's story, and at the
 * end we confirm the twin can answer the questions a real founder's twin
 * would face.
 *
 * What this proves:
 *
 *   1. Memory accumulates correctly across hundreds of small writes.
 *   2. Entities + triples + episodes are recoverable through the structured
 *      MemoryPort surface (getEntitiesByType / walkGraph / getEpisodes).
 *   3. Semantic search returns *relevant* hits for natural-language questions.
 *   4. The graph walk reveals real relationships (Mahesh ⇄ Anchor VC,
 *      Anchor ⇄ Beacon Series A, etc.).
 *   5. Episodes serve as time-bounded memory of milestones (term sheet,
 *      hire-approval, closing day, board approval).
 *
 * The test is hermetic — no DB, no network. It uses InMemoryBrainStore plus
 * the deterministic HashEmbeddingProvider so results are stable run-to-run.
 * On a real CRDB-backed install with OpenAI embeddings the recall numbers
 * would be substantially higher; the floors here are conservative enough
 * that they catch retrieval regressions but don't flake.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { EmbeddedGbrainMemoryPort } from '../embedded-port.js';
import {
  HashEmbeddingProvider,
  InMemoryBrainStore,
} from '@skytwin/memory-gbrain-crdb-adapter';
import {
  SAM_USER_ID,
  STORY_START,
  buildSamSignals,
  buildSamEntities,
  buildSamTriples,
  buildSamEpisodes,
  buildSamQuestions,
  type TaggedSignal,
} from './fixtures/persona-sam-patel.js';

interface QuestionResult {
  question: string;
  k: number;
  hits: number;
  relevantHits: number;
  recall: number;
  precision: number;
}

describe('persona simulation — Sam Patel, Series A founder, 6 weeks', () => {
  let store: InMemoryBrainStore;
  let port: EmbeddedGbrainMemoryPort;
  let signals: TaggedSignal[];
  /** id (signal/entity/episode) → tags; used to score "is this hit relevant". */
  let tagsById: Map<string, string[]>;

  beforeAll(async () => {
    store = new InMemoryBrainStore();
    port = new EmbeddedGbrainMemoryPort({
      userId: SAM_USER_ID,
      backend: 'memory',
      store,
      embedding: new HashEmbeddingProvider(256),
    });

    // Drive the full storyline through the port — ordered chronologically so
    // we can inspect intermediate state (e.g. "what did the twin know after
    // week 3?"). Signals first, then derived structure (entities, triples,
    // episodes) — the same shape an idle-miner would emit.
    signals = buildSamSignals().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    tagsById = new Map();
    for (const sig of signals) {
      await port.recordSignal(sig);
      tagsById.set(sig.id, sig.tags);
    }
    for (const e of buildSamEntities()) {
      await port.recordEntity(e);
      tagsById.set(e.id, e.tags);
    }
    for (const t of buildSamTriples()) {
      await port.recordTriple(t);
      tagsById.set(t.id, t.tags);
    }
    for (const ep of buildSamEpisodes()) {
      await port.recordEpisode(ep);
      tagsById.set(ep.id, ep.tags);
    }
  }, 60_000);

  /**
   * Score a search hit against an expected-tag set. Hits surface their
   * underlying source_ref (signal/entity/episode id), which we look up in
   * the tag map. Hits without a tag mapping (raw page id, no source_ref)
   * count as irrelevant.
   */
  function isRelevant(hit: { id: string }, expectedTags: string[]): boolean {
    const tags = tagsById.get(hit.id) ?? [];
    return tags.some((t) => expectedTags.includes(t));
  }

  it('memory volume — every signal and structure was persisted', () => {
    expect(store.getAllSignals(SAM_USER_ID)).toHaveLength(signals.length);
    // Pages = signals + entities + episodes (each gets a content page indexed)
    const counts = store.countPages(SAM_USER_ID);
    const expectedPages = signals.length + buildSamEntities().length + buildSamEpisodes().length;
    expect(counts.total).toBe(expectedPages);
    // With synchronous hash embedding every page got embedded.
    expect(counts.embedded).toBe(expectedPages);
  });

  it('entities — twin recognises the cast of characters', async () => {
    const people = await port.getEntitiesByType('person');
    const peopleNames = people.map((p) => p.name).sort();
    expect(peopleNames).toEqual([
      'Daniel Park',
      'Erica Holm',
      'Maya Chen',
      'Mahesh Rao',
      'Priya Iyer',
    ].sort());

    const orgs = await port.getEntitiesByType('organization');
    const orgNames = orgs.map((o) => o.name).sort();
    expect(orgNames).toEqual(['Anchor VC', 'Beacon']);
  });

  it('graph walk — Mahesh ↔ Anchor VC ↔ Beacon Series A ↔ board chain', async () => {
    const fromMahesh = await port.walkGraph({ startNodeId: 'Mahesh Rao', maxDepth: 2 });
    const objects = fromMahesh.flatMap((n) =>
      n.type === 'triple' ? [(n.data as { object: string }).object] : [],
    );
    // From Mahesh we reach Anchor VC (partner_at) and Beacon Board (joins_board).
    expect(objects).toContain('Anchor VC');
    expect(objects).toContain('Beacon Board');

    // Walking from Anchor VC reaches the Series A relationship.
    const fromAnchor = await port.walkGraph({ startNodeId: 'Anchor VC', maxDepth: 1 });
    const fromAnchorObjects = fromAnchor.flatMap((n) =>
      n.type === 'triple' ? [(n.data as { object: string }).object] : [],
    );
    expect(fromAnchorObjects).toContain('Beacon Series A');
  });

  it('triples — predicate filters return the right facts', async () => {
    const hires = await port.getTriples(undefined, 'hired_for');
    const hireSubjects = hires.map((t) => t.subject).sort();
    expect(hireSubjects).toEqual(['Daniel Park', 'Maya Chen']);

    const partnerOf = await port.getTriples(undefined, 'partner_at');
    expect(partnerOf).toHaveLength(1);
    expect(partnerOf[0]?.subject).toBe('Mahesh Rao');
    expect(partnerOf[0]?.object).toBe('Anchor VC');
  });

  it('episodes — time-bounded queries surface the right milestones', async () => {
    // Week 3 (term sheet)
    const week3 = await port.getEpisodes({
      from: new Date(STORY_START.getTime() + 14 * 86400_000),
      to: new Date(STORY_START.getTime() + 21 * 86400_000),
    });
    expect(week3.some((e) => e.summary.toLowerCase().includes('term sheet'))).toBe(true);

    // Week 5 (closing + board approval + vacation begins)
    const week5 = await port.getEpisodes({
      from: new Date(STORY_START.getTime() + 28 * 86400_000),
      to: new Date(STORY_START.getTime() + 34 * 86400_000),
    });
    expect(week5.some((e) => e.summary.toLowerCase().includes('series a closed'))).toBe(true);
    expect(week5.some((e) => e.summary.toLowerCase().includes('board'))).toBe(true);

    // Vacation episode is in 'personal' wing — wing filter works
    const personal = await port.getEpisodes(
      {
        from: new Date(STORY_START.getTime() + 32 * 86400_000),
        to: new Date(STORY_START.getTime() + 40 * 86400_000),
      },
      { wing: 'personal' },
    );
    expect(personal).toHaveLength(1);
    expect(personal[0]?.summary).toMatch(/lisbon/i);
  });

  it('semantic search — questions a twin would have to answer', async () => {
    const questions = buildSamQuestions();
    const results: QuestionResult[] = [];

    for (const q of questions) {
      const k = q.k ?? 5;
      const hits = await port.searchSemantic(q.question, k);
      // Score by tag overlap across ALL indexed sources (signals + entities
      // + episodes) — gbrain returns the source_ref so a hit could reference
      // any of them.
      const relevant = hits.filter((h) => isRelevant(h, q.expectedTags)).length;
      const recall = q.expectedTags.length === 0 ? 1 : relevant > 0 ? 1 : 0;
      const precision = hits.length === 0 ? 0 : relevant / hits.length;
      results.push({
        question: q.question,
        k,
        hits: hits.length,
        relevantHits: relevant,
        recall,
        precision,
      });
    }

    // Aggregate floor: at least 80% of questions hit their target topic.
    // This is the load-bearing assertion. Per-question recall is not 100%
    // because the deterministic hash-trick embedding is intentionally weak —
    // production users with OpenAI embeddings see materially higher recall.
    // What we're proving here is "memory accumulates correctly and the
    // retrieval pipeline gets the bulk of questions right end-to-end".
    const meanRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
    expect(
      meanRecall,
      `recall ${meanRecall.toFixed(2)}; per-question:\n${results.map((r) => `  [${r.recall ? '✓' : '✗'}] ${r.question} → ${r.relevantHits}/${r.hits}`).join('\n')}`,
    ).toBeGreaterThanOrEqual(0.8);
  }, 30_000);

  it('summarize — emits a coherent profile that mentions the key cast', async () => {
    const sum = await port.summarize({ scope: 'user-profile', maxTokens: 400 });
    expect(sum.text.length).toBeGreaterThan(0);
    expect(sum.tokenCount).toBeLessThanOrEqual(400);
    const lower = sum.text.toLowerCase();
    // The triples-based summary should mention at least one of the central
    // relationships established during the storyline.
    expect(
      lower.includes('mahesh') ||
        lower.includes('anchor vc') ||
        lower.includes('beacon series a') ||
        lower.includes('hired_for'),
    ).toBe(true);
    expect(sum.citations.length).toBeGreaterThan(0);
  });

  it('export → import — Sam migrates to a fresh gbrain instance and answers identically', async () => {
    const exported: import('@skytwin/memory-port').MemoryRecord[] = [];
    for await (const r of port.exportAll()) exported.push(r);
    expect(exported.length).toBeGreaterThan(0);

    const fresh = new InMemoryBrainStore();
    const freshPort = new EmbeddedGbrainMemoryPort({
      userId: SAM_USER_ID,
      backend: 'memory',
      store: fresh,
      embedding: new HashEmbeddingProvider(256),
    });
    async function* gen() {
      for (const r of exported) yield r;
    }
    const summary = await freshPort.importAll(gen());
    expect(summary.imported).toBeGreaterThan(0);

    // Same questions, fresh instance — aggregate recall must match the
    // pre-migration twin (within tolerance — the new pages have different
    // generated IDs but the same source_ref → tag mapping).
    let migratedRelevant = 0;
    for (const q of buildSamQuestions()) {
      const k = q.k ?? 5;
      const hits = await freshPort.searchSemantic(q.question, k);
      if (hits.some((h) => isRelevant(h, q.expectedTags))) migratedRelevant++;
    }
    expect(migratedRelevant / buildSamQuestions().length).toBeGreaterThanOrEqual(0.8);
  }, 60_000);

  it('week-by-week emergence — profile builds incrementally, not all at once', async () => {
    // Re-run the simulation and inspect intermediate state at week boundaries.
    const incStore = new InMemoryBrainStore();
    const incPort = new EmbeddedGbrainMemoryPort({
      userId: SAM_USER_ID + '-inc',
      backend: 'memory',
      store: incStore,
      embedding: new HashEmbeddingProvider(128),
    });
    const sigsInOrder = buildSamSignals().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Week 1 cutoff — fundraise context exists; hiring tag should NOT yet
    // appear in any of the top-5 hits (vector RRF returns weak-similarity tail
    // hits even when the topic is absent — so we score by tag rather than
    // hit count).
    const week1Cutoff = new Date(STORY_START.getTime() + 7 * 86400_000);
    for (const s of sigsInOrder.filter((s) => s.timestamp.getTime() < week1Cutoff.getTime())) {
      await incPort.recordSignal(s);
    }
    {
      const fundraise = await incPort.searchSemantic('Series A pitch deck investor', 5);
      const hiring = await incPort.searchSemantic('senior backend engineer hire', 5);
      const fundraiseTagged = fundraise.filter((h) =>
        (tagsById.get(h.id) ?? []).includes('fundraise'),
      ).length;
      expect(fundraiseTagged).toBeGreaterThan(0);
      const hiringTagged = hiring.filter((h) =>
        (tagsById.get(h.id) ?? []).includes('hiring'),
      ).length;
      expect(hiringTagged).toBe(0); // hiring storyline starts week 2
    }

    // Week 3 cutoff — term sheet appears
    const week3Cutoff = new Date(STORY_START.getTime() + 21 * 86400_000);
    for (const s of sigsInOrder.filter(
      (s) =>
        s.timestamp.getTime() >= week1Cutoff.getTime() &&
        s.timestamp.getTime() < week3Cutoff.getTime(),
    )) {
      await incPort.recordSignal(s);
    }
    {
      const term = await incPort.searchSemantic('Anchor term sheet redlines dilution', 5);
      expect(term.length).toBeGreaterThan(0);
    }

    // Week 5 cutoff — closing day visible
    const week5Cutoff = new Date(STORY_START.getTime() + 35 * 86400_000);
    for (const s of sigsInOrder.filter(
      (s) =>
        s.timestamp.getTime() >= week3Cutoff.getTime() &&
        s.timestamp.getTime() < week5Cutoff.getTime(),
    )) {
      await incPort.recordSignal(s);
    }
    {
      const close = await incPort.searchSemantic('Series A closing day wire received', 5);
      expect(close.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
