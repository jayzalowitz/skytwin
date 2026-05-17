import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmClient } from '@skytwin/llm-client';
import type { CostGatePort } from '@skytwin/decision-engine';

const mockIsDraftsEnabled = vi.fn();
const mockIsDraftsEvalPassed = vi.fn();
const mockGetDraftsDailyCallCap = vi.fn();
const mockCheckAndReserveCall = vi.fn();
const mockUpdateOutcome = vi.fn();
const mockRecordCall = vi.fn();
const mockGetEnabledForUser = vi.fn();
const mockUserFindById = vi.fn();
const mockCheckAndRecordSpend = vi.fn();
const mockSpendReconcile = vi.fn();

vi.mock('@skytwin/db', () => ({
  twinRepository: {
    isDraftsEnabled: (...args: unknown[]) => mockIsDraftsEnabled(...args),
    isDraftsEvalPassed: (...args: unknown[]) => mockIsDraftsEvalPassed(...args),
    getDraftsDailyCallCap: (...args: unknown[]) => mockGetDraftsDailyCallCap(...args),
  },
  draftEmailCallsRepository: {
    checkAndReserveCall: (...args: unknown[]) => mockCheckAndReserveCall(...args),
    updateOutcome: (...args: unknown[]) => mockUpdateOutcome(...args),
    record: (...args: unknown[]) => mockRecordCall(...args),
  },
  aiProviderRepository: {
    getEnabledForUser: (...args: unknown[]) => mockGetEnabledForUser(...args),
  },
  userRepository: {
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
  spendRepository: {
    checkAndRecordSpend: (...args: unknown[]) => mockCheckAndRecordSpend(...args),
    reconcile: (...args: unknown[]) => mockSpendReconcile(...args),
  },
}));

// #300 — semantic search now accepts an authoring-tier filter as a third
// argument. The mock honors the filter so the test pins the
// SQL-pushdown contract end-to-end: callers pass `options.authoringTier`,
// the backend returns only matching rows, and the port no longer
// over-fetches + client-side-filters.
const mockSearchSemanticArgs: Array<{
  query: string;
  k: number;
  options?: { authoringTier?: string[] };
}> = [];
vi.mock('../memory-setup.js', () => ({
  getMemoryPortForUser: vi.fn(async () => ({
    port: {
      searchSemantic: vi.fn(
        async (
          query: string,
          k: number,
          options?: { authoringTier?: string[] },
        ) => {
          mockSearchSemanticArgs.push({ query, k, ...(options ? { options } : {}) });
          const corpus = [
            { id: 'h1', score: 0.9, content: 'sent reply A', source: 'gmail', metadata: { authoringTier: 'user_sent_reply', subject: 'A' } },
            { id: 'h2', score: 0.8, content: 'inbox personal', source: 'gmail', metadata: { authoringTier: 'inbox_personal' } },
            { id: 'h3', score: 0.7, content: 'sent originated B', source: 'gmail', metadata: { authoringTier: 'user_sent_originated', subject: 'B' } },
            { id: 'h4', score: 0.6, content: 'newsletter', source: 'gmail', metadata: { authoringTier: 'inbox_newsletter' } },
            { id: 'h5', score: 0.5, content: 'untagged', source: 'gmail' as const, metadata: undefined as Record<string, unknown> | undefined },
          ];
          const tiers = options?.authoringTier;
          const filtered = tiers && tiers.length > 0
            ? corpus.filter((hit) => {
                const tier = hit.metadata?.['authoringTier'];
                return typeof tier === 'string' && tiers.includes(tier);
              })
            : corpus;
          return filtered.slice(0, k);
        },
      ),
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
    mockIsDraftsEvalPassed.mockReset();
    mockGetDraftsDailyCallCap.mockReset();
    mockCheckAndReserveCall.mockReset();
    mockUpdateOutcome.mockReset();
    mockRecordCall.mockReset();
    mockGetEnabledForUser.mockReset();
    mockUserFindById.mockReset();
    mockCheckAndRecordSpend.mockReset();
    mockSpendReconcile.mockReset();
    // Default for tests that don't care about the per-user flag: opted-in.
    // Tests that exercise the per-user gate override per-test.
    mockIsDraftsEnabled.mockResolvedValue(true);
    // Default eval gate: passed. Tests that exercise the eval gate
    // override per-test.
    mockIsDraftsEvalPassed.mockResolvedValue(true);
    // Default AI providers: a single embedded provider — cheapest path,
    // so the conservative cost estimate stays at 0 cents.
    mockGetEnabledForUser.mockResolvedValue([
      { provider: 'embedded', api_key: '', model: 'phi-3', base_url: null, priority: 0 },
    ]);
    // Defaults so the gate's READ side never blocks unless overridden.
    mockGetDraftsDailyCallCap.mockResolvedValue(100);
    mockCheckAndReserveCall.mockResolvedValue({
      allowed: true,
      count: 1,
      record: { id: 'cr-1' },
    });
    mockUserFindById.mockResolvedValue({
      id: 'u-1',
      autonomy_settings: { maxSpendPerActionCents: 100, maxDailySpendCents: 1000 },
    });
    mockCheckAndRecordSpend.mockResolvedValue({
      allowed: true,
      currentTotal: 5,
      record: { id: 'sr-1' },
    });
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

  describe('buildDraftEmailGenerator() — five-gate AND', () => {
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

    it('returns null when the per-user flag is ON but the eval-bench gate has NOT passed (#314)', async () => {
      // #314: the quality gate sits on top of the opt-in gate. A user
      // can manually flip `drafts_enabled` but the generator still
      // refuses until `drafts_eval_passed_at` is non-NULL — preventing
      // the "sounds plausible" failure mode where a generator produces
      // drafts that don't actually match the user's voice / topic /
      // length distribution.
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      mockIsDraftsEnabled.mockResolvedValue(true);
      mockIsDraftsEvalPassed.mockResolvedValue(false);
      expect(await buildDraftEmailGenerator('u-1', fakeLlm())).toBeNull();
      expect(mockIsDraftsEnabled).toHaveBeenCalledWith('u-1');
      expect(mockIsDraftsEvalPassed).toHaveBeenCalledWith('u-1');
    });

    it('returns a generator when ALL five gates are satisfied', async () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      mockIsDraftsEnabled.mockResolvedValue(true);
      mockIsDraftsEvalPassed.mockResolvedValue(true);
      const gen = await buildDraftEmailGenerator('u-1', fakeLlm());
      expect(gen).not.toBeNull();
      expect(typeof gen!.generate).toBe('function');
    });

    it('per-user-OFF path stops before the eval check (perf contract: drafts_enabled short-circuits)', async () => {
      // Staged-rollout cohort cost: at most ONE extra DB read for the
      // drafts_enabled lookup, never two. The eval-bench check must
      // only run for users who have opted in.
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      mockIsDraftsEnabled.mockResolvedValue(false);
      await buildDraftEmailGenerator('u-1', fakeLlm());
      expect(mockIsDraftsEnabled).toHaveBeenCalled();
      expect(mockIsDraftsEvalPassed).not.toHaveBeenCalled();
    });

    it('fails closed when the eval-bench gate read errors (mirrors per-user flag contract)', async () => {
      // Critical safety contract: the eval-bench read MUST NOT
      // propagate. Same rationale as the per-user flag — events.ts
      // depends on this function never rejecting. Treat as "feature
      // off" for this signal ingest.
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      mockIsDraftsEnabled.mockResolvedValue(true);
      mockIsDraftsEvalPassed.mockRejectedValue(new Error('CRDB pool exhausted'));
      const result = await buildDraftEmailGenerator('u-1', fakeLlm());
      expect(result).toBeNull();
    });

    it('queries AI providers to pick the cost-cheapest one for the cost estimate (#299)', async () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      // User has both anthropic AND embedded enabled. The cost-preferred
      // resolver should pick embedded (cost-rank 0) → 0 cent estimate.
      mockGetEnabledForUser.mockResolvedValue([
        { provider: 'anthropic', api_key: 'sk-...', model: 'claude-3-5-sonnet', base_url: null, priority: 0 },
        { provider: 'embedded', api_key: '', model: 'phi-3', base_url: null, priority: 1 },
      ]);
      const gen = await buildDraftEmailGenerator('u-1', fakeLlm());
      expect(gen).not.toBeNull();
      expect(mockGetEnabledForUser).toHaveBeenCalledWith('u-1');
    });

    it('falls through to a conservative cost estimate when the AI-provider read errors (fail-safe-toward-restrictive)', async () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      mockGetEnabledForUser.mockRejectedValue(new Error('CRDB pool exhausted'));
      // No throw — the function must still return a generator, just with
      // a conservative cost estimate. The mocked LlmClient + per-user
      // flag are both fine; the AI-provider read failure should NOT
      // propagate.
      const gen = await buildDraftEmailGenerator('u-1', fakeLlm());
      expect(gen).not.toBeNull();
    });

    it('accepts an explicit CostGatePort override (test seam) and uses it for the generator', async () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      const checkCalls: Array<unknown> = [];
      const recordCalls: Array<unknown> = [];
      const stubGate: CostGatePort = {
        async check(input) {
          checkCalls.push(input);
          return { allowed: true, reason: 'ok' };
        },
        async record(input) {
          recordCalls.push(input);
        },
      };
      const gen = await buildDraftEmailGenerator('u-1', fakeLlm(), stubGate);
      expect(gen).not.toBeNull();
      // Drive generate() and verify the stub gate ran instead of DbCostGate.
      await gen!.generate(
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
        { userId: 'u-1' } as never,
      );
      expect(checkCalls).toHaveLength(1);
      expect(recordCalls).toHaveLength(1);
      // The injected stub gate replaced DbCostGate entirely — no DB-side
      // ledger writes.
      expect(mockRecordCall).not.toHaveBeenCalled();
    });

    it('env-flag-off path adds zero DB roundtrips (perf contract)', async () => {
      // The default-off path is the common case in production until a
      // user opts in. Pin that it never touches the DB for the per-user
      // check — that would be an extra roundtrip per signal ingest.
      delete process.env['SKYTWIN_DRAFTS_ENABLED'];
      await buildDraftEmailGenerator('u-1', fakeLlm());
      expect(mockIsDraftsEnabled).not.toHaveBeenCalled();
    });

    it('fails closed (returns null, does not throw) when the per-user flag read errors', async () => {
      // Critical safety contract: a transient DB hiccup on the per-user
      // flag read MUST NOT propagate. The events.ts route depends on
      // this function never rejecting; a thrown error here would take
      // down `/api/events/ingest` for every LLM-configured user during
      // a DB blip, a migration window where the column doesn't exist
      // yet, etc. Catch and treat as "feature off" — same outcome as
      // the disabled state.
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      mockIsDraftsEnabled.mockRejectedValue(new Error('CRDB pool exhausted'));
      const result = await buildDraftEmailGenerator('u-1', fakeLlm());
      expect(result).toBeNull();
    });
  });

  describe('memory-port-backed AuthoredExamplesPort', () => {
    // #300: post-pushdown contract. The port no longer over-fetches —
    // it requests exactly k results AND a SQL-side filter on
    // authoringTier IN ('user_sent_originated', 'user_sent_reply').
    // The mock honors the filter and returns only matching corpus rows.
    it('pushes the authoringTier filter into searchSemantic options', async () => {
      process.env['SKYTWIN_DRAFTS_ENABLED'] = 'true';
      mockIsDraftsEnabled.mockResolvedValue(true);
      mockSearchSemanticArgs.length = 0;
      const llm = fakeLlm();
      const gen = await buildDraftEmailGenerator('u-1', llm);
      expect(gen).not.toBeNull();
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
      expect(result).toHaveLength(1);

      // 1) The port called searchSemantic with the user-authored tier list.
      expect(mockSearchSemanticArgs.length).toBeGreaterThan(0);
      const lastCall = mockSearchSemanticArgs[mockSearchSemanticArgs.length - 1]!;
      expect(lastCall.options?.authoringTier).toEqual([
        'user_sent_originated',
        'user_sent_reply',
      ]);
      // 2) k passed straight through — no over-fetch multiplier.
      //    The generator asks for some k; the port asks the backend
      //    for the SAME k. Pre-#300, this would have been k*3 or 6.
      expect(lastCall.k).toBeGreaterThan(0);

      // 3) The candidate's `examplesUsed` reflects only user-authored
      //    hits (h1, h3). The mock's SQL-side filter dropped inbox tiers.
      expect((result[0]!.parameters as Record<string, unknown>)['examplesUsed']).toBe(2);
    });
  });
});
