import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmClient } from '@skytwin/llm-client';

const mockIsDraftsEnabled = vi.fn();

vi.mock('@skytwin/db', () => ({
  twinRepository: {
    isDraftsEnabled: (...args: unknown[]) => mockIsDraftsEnabled(...args),
  },
}));

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
    mockIsDraftsEnabled.mockReset();
    // Default for tests that don't care about the per-user flag: opted-in.
    // Tests that exercise the per-user gate override per-test.
    mockIsDraftsEnabled.mockResolvedValue(true);
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env['SKYTWIN_DRAFTS_ENABLED'];
    } else {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = original;
    }
  });

  describe('draftsEnabled() — global env kill-switch', () => {
    it('returns false by default (fail-closed)', () => {
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

  describe('buildDraftEmailGenerator() — four-gate AND', () => {
    it('returns null when the env flag is off, even with all other gates satisfied', async () => {
      delete process.env['SKYTWIN_DRAFTS_ENABLED'];
      mockIsDraftsEnabled.mockResolvedValue(true);
      expect(await buildDraftEmailGenerator('u-1', fakeLlm())).toBeNull();
      // The cheap env check should short-circuit before any DB roundtrip.
      expect(mockIsDraftsEnabled).not.toHaveBeenCalled();
    });

    it('returns null when the env flag is on but the user has no LLM client', async () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      expect(await buildDraftEmailGenerator('u-1', null)).toBeNull();
      // The LlmClient check is also synchronous and should short-circuit.
      expect(mockIsDraftsEnabled).not.toHaveBeenCalled();
    });

    it('returns null when the LlmClient has no configured providers', async () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      const empty = { hasProviders: false } as unknown as LlmClient;
      expect(await buildDraftEmailGenerator('u-1', empty)).toBeNull();
      expect(mockIsDraftsEnabled).not.toHaveBeenCalled();
    });

    it('returns null when env + LlmClient are ON but the per-user flag is OFF (#302)', async () => {
      // The whole point of #302: a staged rollout means most users have
      // `drafts_enabled: false` and the feature stays dark for them
      // even when the global env flag is set. Existing users were not
      // auto-opted-in by migration 047 (DEFAULT FALSE).
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      mockIsDraftsEnabled.mockResolvedValue(false);
      expect(await buildDraftEmailGenerator('u-1', fakeLlm())).toBeNull();
      expect(mockIsDraftsEnabled).toHaveBeenCalledWith('u-1');
    });

    it('returns a generator when ALL four gates are satisfied', async () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      mockIsDraftsEnabled.mockResolvedValue(true);
      const gen = await buildDraftEmailGenerator('u-1', fakeLlm());
      expect(gen).not.toBeNull();
      expect(typeof gen!.generate).toBe('function');
    });

    it('env-flag-off path adds zero DB roundtrips (perf contract)', async () => {
      // The default-off path is the common case in production until a
      // user opts in. Pin that it never touches the DB for the per-user
      // check — that would be an extra roundtrip per signal ingest.
      delete process.env['SKYTWIN_DRAFTS_ENABLED'];
      await buildDraftEmailGenerator('u-1', fakeLlm());
      expect(mockIsDraftsEnabled).not.toHaveBeenCalled();
    });
  });

  describe('memory-port-backed AuthoredExamplesPort', () => {
    it('filters semantic hits to user-authored tiers and over-fetches to compensate', async () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      mockIsDraftsEnabled.mockResolvedValue(true);
      const llm = fakeLlm();
      const gen = await buildDraftEmailGenerator('u-1', llm);
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
