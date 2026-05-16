import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmClient } from '@skytwin/llm-client';

vi.mock('../memory-setup.js', () => ({
  getMemoryPortForUser: vi.fn(async () => ({
    port: {
      searchSemantic: vi.fn(async (_q: string, k: number) => [
        // Tier values are stamped on brain_pages.metadata.authoringTier
        // by the connectors / backfill worker (#251 Layer 1 + #271). Mix
        // user-authored and inbox tiers so the filter has real work to
        // do.
        { id: 'h1', score: 0.9, content: 'sent reply A', source: 'gmail', metadata: { authoringTier: 'user_sent_reply', subject: 'A' } },
        { id: 'h2', score: 0.8, content: 'inbox personal', source: 'gmail', metadata: { authoringTier: 'inbox_personal' } },
        { id: 'h3', score: 0.7, content: 'sent originated B', source: 'gmail', metadata: { authoringTier: 'user_sent_originated', subject: 'B' } },
        { id: 'h4', score: 0.6, content: 'newsletter', source: 'gmail', metadata: { authoringTier: 'inbox_newsletter' } },
        { id: 'h5', score: 0.5, content: 'untagged', source: 'gmail' },
      ].slice(0, k)),
    },
  })),
}));

const { buildDraftEmailGenerator, draftsEnabled } = await import('../draft-email-setup.js');

const fakeLlm = (): LlmClient =>
  ({
    hasProviders: true,
    generate: vi.fn(async () => ({ content: 'draft body' })),
  }) as unknown as LlmClient;

describe('draft-email-setup', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env['SKYTWIN_DRAFTS_ENABLED'];
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env['SKYTWIN_DRAFTS_ENABLED'];
    } else {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = original;
    }
  });

  describe('draftsEnabled()', () => {
    it('returns false by default (dark-deploy fail-closed)', () => {
      delete process.env['SKYTWIN_DRAFTS_ENABLED'];
      expect(draftsEnabled()).toBe(false);
    });

    it("returns true only when the env var is exactly 'true'", () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      expect(draftsEnabled()).toBe(true);

      // Tighter than `!== 'false'`: any other value (`1`, `yes`, accidental
      // whitespace) is treated as off so a typo can't enable LLM cost burn.
      for (const v of ['1', 'yes', 'TRUE', 'True', ' true', '']) {
        process.env['SKYTWIN_DRAFTS_ENABLED'] = v;
        expect(draftsEnabled()).toBe(false);
      }
    });
  });

  describe('buildDraftEmailGenerator()', () => {
    it('returns null when the env flag is off, even with an LLM client', () => {
      delete process.env['SKYTWIN_DRAFTS_ENABLED'];
      expect(buildDraftEmailGenerator('u-1', fakeLlm())).toBeNull();
    });

    it('returns null when the env flag is on but the user has no LLM client', () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      expect(buildDraftEmailGenerator('u-1', null)).toBeNull();
    });

    it('returns null when the LlmClient has no configured providers', () => {
      // Match the route's primary-strategy gate (which checks
      // `llmClient && llmClient.hasProviders`). Without this, a user with
      // an LlmClient instance but no providers would build a generator
      // whose `generate()` call has nothing to route to — the candidate
      // path silently drops to `return []` on every signal. Better to
      // not construct the generator at all in that case.
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      const empty = { hasProviders: false } as unknown as LlmClient;
      expect(buildDraftEmailGenerator('u-1', empty)).toBeNull();
    });

    it('returns a generator when the env flag is on AND an LLM client is present', () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      const gen = buildDraftEmailGenerator('u-1', fakeLlm());
      expect(gen).not.toBeNull();
      expect(typeof gen!.generate).toBe('function');
    });
  });

  describe('memory-port-backed AuthoredExamplesPort', () => {
    it('filters semantic hits to user-authored tiers and over-fetches to compensate', async () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      const llm = fakeLlm();
      const gen = buildDraftEmailGenerator('u-1', llm);
      expect(gen).not.toBeNull();
      // Drive the generator end-to-end with a stub decision/context so the
      // examples port runs and we can observe what it returned.
      const result = await gen!.generate(
        {
          id: 'd-1',
          domain: 'email',
          situationType: 'email_triage' as never,
          urgency: 'normal' as never,
          summary: 'reply needed',
          rawData: { requiresResponse: true, from: 'a@b.com', subject: 'Hi', body: 'b' },
          interpretedAt: new Date(),
        } as never,
        {} as never,
        {} as never,
      );
      // The generator produces one draft candidate.
      expect(result).toHaveLength(1);
      // The candidate's `examplesUsed` reflects only the user-authored
      // hits (h1, h3) — the inbox tiers and the untagged hit are filtered
      // out by the port.
      expect((result[0]!.parameters as Record<string, unknown>)['examplesUsed']).toBe(2);
    });
  });
});
