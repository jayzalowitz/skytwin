import { describe, it, expect, vi } from 'vitest';
import {
  ContextBuilder,
  MAX_CONTEXT_BYTES,
  type TwinContextProvider,
  type MemoryContextProvider,
  type TwinContextSnapshot,
  type MemoryHit,
} from '../context-builder.js';

// Issue #147 (phase 2b) — twin profile + episodic memory enrichment in
// the assistant's system prompt. ContextBuilder is pure: it takes two
// async ports (twin + memory) and renders a compact context block.

function stubTwin(snapshot: TwinContextSnapshot | null = null): TwinContextProvider {
  return {
    fetch: vi.fn().mockImplementation(async () => {
      if (!snapshot) return { trustTier: '', preferences: [], inferences: [] };
      return snapshot;
    }),
  };
}

function stubMemory(hits: MemoryHit[] = []): MemoryContextProvider {
  return {
    search: vi.fn().mockResolvedValue(hits),
  };
}

const VALID_USER = '11111111-2222-3333-4444-555555555555';

describe('ContextBuilder.build', () => {
  it('renders preferences with confidence labels', async () => {
    const twin = stubTwin({
      trustTier: 'moderate_autonomy',
      preferences: [
        { domain: 'email', key: 'auto_archive', value: true, confidence: 'high' },
        { domain: 'calendar', key: 'default_meeting_length', value: 30, confidence: 'confirmed' },
      ],
      inferences: [],
    });
    const builder = new ContextBuilder(twin);
    const out = await builder.build(VALID_USER, 'how do I handle email');

    expect(out).toContain('Trust tier: moderate_autonomy');
    expect(out).toContain('email/auto_archive = yes (high)');
    expect(out).toContain('calendar/default_meeting_length = 30 (confirmed)');
  });

  it('drops speculative + low-confidence preferences (noise floor)', async () => {
    const twin = stubTwin({
      trustTier: 'observer',
      preferences: [
        { domain: 'a', key: 'good', value: 'keep', confidence: 'high' },
        { domain: 'b', key: 'noise', value: 'drop', confidence: 'speculative' },
        { domain: 'c', key: 'weak', value: 'drop', confidence: 'low' },
      ],
      inferences: [],
    });
    const builder = new ContextBuilder(twin);
    const out = await builder.build(VALID_USER, 'q');

    expect(out).toContain('a/good');
    expect(out).not.toContain('b/noise');
    expect(out).not.toContain('c/weak');
  });

  it('ranks confirmed > high > moderate when more than MAX_PREFERENCES exist', async () => {
    // 15 preferences: 1 confirmed, 7 high, 7 moderate.
    // MAX_PREFERENCES is 12 — the moderate ones at the bottom should drop first.
    const prefs = [
      { domain: 'top', key: 'a', value: 'v', confidence: 'confirmed' as const },
      ...Array.from({ length: 7 }, (_, i) => ({
        domain: 'high', key: `k${i}`, value: 'v', confidence: 'high' as const,
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        domain: 'mid', key: `k${i}`, value: 'v', confidence: 'moderate' as const,
      })),
    ];
    const twin = stubTwin({ trustTier: 'low_autonomy', preferences: prefs, inferences: [] });
    const builder = new ContextBuilder(twin);
    const out = await builder.build(VALID_USER, 'q');

    expect(out).toContain('top/a');
    expect(out).toContain('high/k0');
    expect(out).toContain('high/k6');
    // Only 4 of the 7 moderate entries should fit (12 - 1 confirmed - 7 high = 4).
    expect((out.match(/mid\/k\d+/g) ?? []).length).toBe(4);
  });

  it('renders inferences with reasoning prepended by an em-dash', async () => {
    const twin = stubTwin({
      trustTier: 'observer',
      preferences: [],
      inferences: [
        {
          domain: 'finance',
          key: 'monthly_subscription_threshold',
          value: 50,
          confidence: 'high',
          reasoning: 'based on 12 prior approvals',
        },
      ],
    });
    const builder = new ContextBuilder(twin);
    const out = await builder.build(VALID_USER, 'q');

    expect(out).toContain('Inferences (not yet user-confirmed):');
    expect(out).toContain('finance/monthly_subscription_threshold = 50 (high) — based on 12 prior approvals');
  });

  it('renders memory hits with date prefix and outcome', async () => {
    const twin = stubTwin({ trustTier: 'observer', preferences: [], inferences: [] });
    const memory = stubMemory([
      {
        summary: 'Archived a Stripe receipt without asking',
        domain: 'email',
        actionTaken: 'auto-archive',
        outcome: 'approved',
        occurredAt: '2026-04-12T10:30:00Z',
      },
    ]);
    const builder = new ContextBuilder(twin, memory);
    const out = await builder.build(VALID_USER, 'how do I handle stripe receipts');

    expect(out).toContain('## Relevant past episodes');
    expect(out).toContain('[2026-04-12]');
    expect(out).toContain('email · Archived a Stripe receipt without asking · auto-archive (approved)');
  });

  it('returns an empty string when both providers come up empty', async () => {
    const twin = stubTwin({ trustTier: 'observer', preferences: [], inferences: [] });
    const memory = stubMemory([]);
    const builder = new ContextBuilder(twin, memory);
    const out = await builder.build(VALID_USER, 'q');
    expect(out).toBe('');
  });

  it('omits the twin block when only the trust tier is known (avoids noise)', async () => {
    // observer + no preferences + no inferences → "Trust tier: observer" alone.
    // That's noise — the model gains nothing from it. Drop the section.
    const twin = stubTwin({ trustTier: 'observer', preferences: [], inferences: [] });
    const builder = new ContextBuilder(twin);
    const out = await builder.build(VALID_USER, 'q');
    expect(out).toBe('');
  });

  it('renders unknown values as JSON, with truncation for long blobs', async () => {
    const twin = stubTwin({
      trustTier: 'observer',
      preferences: [
        { domain: 'travel', key: 'preferred_airlines', value: ['delta', 'jetblue'], confidence: 'high' },
      ],
      inferences: [],
    });
    const builder = new ContextBuilder(twin);
    const out = await builder.build(VALID_USER, 'q');
    expect(out).toContain('travel/preferred_airlines = ["delta","jetblue"] (high)');
  });

  it('respects MAX_CONTEXT_BYTES and ellipsis-truncates UTF-8 cleanly', async () => {
    // Pile in a huge synthetic profile to overflow the cap.
    const prefs = Array.from({ length: 50 }, (_, i) => ({
      domain: 'spam',
      key: `k${i}`,
      value: 'a very long preference value '.repeat(10),
      confidence: 'high' as const,
    }));
    const twin = stubTwin({ trustTier: 'observer', preferences: prefs, inferences: [] });
    const builder = new ContextBuilder(twin);
    const out = await builder.build(VALID_USER, 'q');

    const byteLen = new TextEncoder().encode(out).length;
    expect(byteLen).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to no-twin context when the twin provider throws', async () => {
    const twin: TwinContextProvider = { fetch: vi.fn().mockRejectedValue(new Error('db down')) };
    const memory = stubMemory([
      { summary: 'something happened', domain: 'general', occurredAt: '2026-04-01T00:00:00Z' },
    ]);
    const builder = new ContextBuilder(twin, memory);
    const out = await builder.build(VALID_USER, 'q');
    // Twin block is missing, but memory block survives — partial context
    // is better than no context.
    expect(out).not.toContain('Trust tier:');
    expect(out).toContain('## Relevant past episodes');
  });

  it('falls back to no-memory context when the memory provider throws', async () => {
    const twin = stubTwin({
      trustTier: 'high_autonomy',
      preferences: [{ domain: 'a', key: 'b', value: true, confidence: 'high' }],
      inferences: [],
    });
    const memory: MemoryContextProvider = {
      search: vi.fn().mockRejectedValue(new Error('mempalace down')),
    };
    const builder = new ContextBuilder(twin, memory);
    const out = await builder.build(VALID_USER, 'q');
    expect(out).toContain('Trust tier: high_autonomy');
    expect(out).not.toContain('## Relevant past episodes');
  });

  it('passes through when memory provider is omitted entirely', async () => {
    const twin = stubTwin({
      trustTier: 'observer',
      preferences: [{ domain: 'x', key: 'y', value: 'z', confidence: 'high' }],
      inferences: [],
    });
    const builder = new ContextBuilder(twin); // no memory
    const out = await builder.build(VALID_USER, 'q');
    expect(out).toContain('x/y = z (high)');
    expect(out).not.toContain('## Relevant past episodes');
  });
});

describe('ContextBuilder.buildWithSources', () => {
  it('renders the memory in context AND returns it as a citable source', async () => {
    const twin = stubTwin({ trustTier: 'observer', preferences: [], inferences: [] });
    const memory = stubMemory([
      {
        id: 'page-1',
        source: 'gmail',
        summary: 'Archived a Stripe receipt without asking',
        domain: 'email',
        actionTaken: 'auto-archive',
        outcome: 'approved',
        occurredAt: '2026-04-12T10:30:00Z',
      },
    ]);
    const builder = new ContextBuilder(twin, memory);
    const { context, sources } = await builder.buildWithSources(VALID_USER, 'stripe receipts');

    // The memory still renders into the prompt block (build() behavior).
    expect(context).toContain('## Relevant past episodes');
    expect(context).toContain('Archived a Stripe receipt without asking');
    // ...and is also surfaced as a citable source for the UI footer.
    expect(sources).toEqual([
      {
        id: 'page-1',
        label: 'Archived a Stripe receipt without asking',
        source: 'gmail',
        domain: 'email',
        occurredAt: '2026-04-12T10:30:00Z',
      },
    ]);
  });

  it('excludes memories without an id from sources (uncitable) but still renders them', async () => {
    const twin = stubTwin({ trustTier: 'observer', preferences: [], inferences: [] });
    const memory = stubMemory([
      { id: 'has-id', source: 'calendar', summary: 'Citable episode', domain: 'calendar' },
      { summary: 'Uncitable episode', domain: 'general' }, // no id
    ]);
    const builder = new ContextBuilder(twin, memory);
    const { context, sources } = await builder.buildWithSources(VALID_USER, 'q');

    // Both render in the prompt context...
    expect(context).toContain('Citable episode');
    expect(context).toContain('Uncitable episode');
    // ...but only the one with an id is claimed as a source.
    expect(sources.map((s) => s.id)).toEqual(['has-id']);
  });

  it('falls back to domain for the source label when no source slug is present', async () => {
    const twin = stubTwin({ trustTier: 'observer', preferences: [], inferences: [] });
    const memory = stubMemory([
      { id: 'e1', summary: 'No source slug', domain: 'finance' },
    ]);
    const builder = new ContextBuilder(twin, memory);
    const { sources } = await builder.buildWithSources(VALID_USER, 'q');
    expect(sources[0]).toMatchObject({ id: 'e1', source: 'finance', domain: 'finance' });
  });

  it('ellipsis-truncates an over-long source label', async () => {
    const twin = stubTwin({ trustTier: 'observer', preferences: [], inferences: [] });
    const longSummary = 'x'.repeat(300);
    const memory = stubMemory([{ id: 'e1', source: 'memory', summary: longSummary, domain: 'general' }]);
    const builder = new ContextBuilder(twin, memory);
    const { sources } = await builder.buildWithSources(VALID_USER, 'q');
    expect(sources[0]!.label.length).toBeLessThanOrEqual(140);
    expect(sources[0]!.label.endsWith('…')).toBe(true);
  });

  it('collapses a multi-line summary into a single clean source label', async () => {
    // gbrain stores raw page bodies (multi-line email/web/file content); the
    // citation label must read as one legible line, not a wrapped body dump.
    const twin = stubTwin({ trustTier: 'observer', preferences: [], inferences: [] });
    const memory = stubMemory([
      {
        id: 'page-9',
        source: 'gmail',
        summary: 'Subject: Invoice\n\nHi there,\n\n  Your   invoice   is attached.\nThanks',
        domain: 'email',
      },
    ]);
    const builder = new ContextBuilder(twin, memory);
    const { sources } = await builder.buildWithSources(VALID_USER, 'q');
    expect(sources[0]!.label).toBe('Subject: Invoice Hi there, Your invoice is attached. Thanks');
    expect(sources[0]!.label).not.toContain('\n');
  });

  it('does not cite a memory that truncation dropped from the context (no over-claim)', async () => {
    // A big twin block fills the byte budget; the memories block sits at the
    // end of the composed context and gets cut, so its memory must NOT be
    // cited — the footer can only claim evidence the model actually received.
    const prefs = Array.from({ length: 60 }, (_, i) => ({
      domain: 'spam',
      key: `k${i}`,
      value: 'a very long preference value '.repeat(8),
      confidence: 'high' as const,
    }));
    const twin = stubTwin({ trustTier: 'observer', preferences: prefs, inferences: [] });
    const memory = stubMemory([
      { id: 'page-cut', source: 'gmail', summary: 'UNIQUE_MEMORY_THAT_GETS_TRUNCATED_AWAY', domain: 'email' },
    ]);
    const builder = new ContextBuilder(twin, memory);
    const { context, sources } = await builder.buildWithSources(VALID_USER, 'q');

    expect(new TextEncoder().encode(context).length).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    expect(context).not.toContain('UNIQUE_MEMORY_THAT_GETS_TRUNCATED_AWAY');
    expect(sources).toEqual([]);
  });

  it('returns empty context and empty sources when nothing is relevant', async () => {
    const twin = stubTwin({ trustTier: 'observer', preferences: [], inferences: [] });
    const memory = stubMemory([]);
    const builder = new ContextBuilder(twin, memory);
    const { context, sources } = await builder.buildWithSources(VALID_USER, 'q');
    expect(context).toBe('');
    expect(sources).toEqual([]);
  });
});
