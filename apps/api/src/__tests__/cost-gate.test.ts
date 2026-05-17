import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetDraftsDailyCallCap = vi.fn();
const mockCountInWindow = vi.fn();
const mockRecord = vi.fn();
const mockUserFindById = vi.fn();
const mockGetDailyTotal = vi.fn();
const mockGetMonthlyTotal = vi.fn();
const mockReconcile = vi.fn();

vi.mock('@skytwin/db', () => ({
  twinRepository: {
    getDraftsDailyCallCap: (...args: unknown[]) => mockGetDraftsDailyCallCap(...args),
  },
  draftEmailCallsRepository: {
    countInWindow: (...args: unknown[]) => mockCountInWindow(...args),
    record: (...args: unknown[]) => mockRecord(...args),
  },
  userRepository: {
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
  spendRepository: {
    getDailyTotal: (...args: unknown[]) => mockGetDailyTotal(...args),
    getMonthlyTotal: (...args: unknown[]) => mockGetMonthlyTotal(...args),
    reconcile: (...args: unknown[]) => mockReconcile(...args),
  },
}));

const { DbCostGate } = await import('../cost-gate.js');

const STANDARD_AUTONOMY = {
  maxSpendPerActionCents: 100,
  maxDailySpendCents: 1000,
  allowedDomains: [],
  blockedDomains: [],
  requireApprovalForIrreversible: true,
};

describe('DbCostGate.check()', () => {
  beforeEach(() => {
    mockGetDraftsDailyCallCap.mockReset();
    mockCountInWindow.mockReset();
    mockRecord.mockReset();
    mockUserFindById.mockReset();
    mockGetDailyTotal.mockReset();
    mockGetMonthlyTotal.mockReset();
    mockReconcile.mockReset();
    // Defaults: liberal user / fresh day. Tests override per-case.
    mockGetDraftsDailyCallCap.mockResolvedValue(100);
    mockCountInWindow.mockResolvedValue(0);
    mockUserFindById.mockResolvedValue({
      id: 'u-1',
      autonomy_settings: STANDARD_AUTONOMY,
    });
    mockGetDailyTotal.mockResolvedValue(0);
  });

  it('allows the call when both gates are well under their caps', async () => {
    const gate = new DbCostGate();
    const result = await gate.check({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 5,
    });
    expect(result.allowed).toBe(true);
    // Cap read was the first DB hit (cheaper than the spend roundtrip).
    expect(mockGetDraftsDailyCallCap).toHaveBeenCalledWith('u-1');
    expect(mockCountInWindow).toHaveBeenCalledWith('u-1', 24);
  });

  it('refuses when the per-day CALL cap is reached, before consulting the spend cap', async () => {
    mockGetDraftsDailyCallCap.mockResolvedValue(10);
    mockCountInWindow.mockResolvedValue(10);
    const gate = new DbCostGate();
    const result = await gate.check({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 5,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily draft-email call cap');
    // Spend-side reads must not have run — the call cap short-circuits.
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockGetDailyTotal).not.toHaveBeenCalled();
  });

  it('refuses when the per-day SPEND cap would be exceeded', async () => {
    mockGetDailyTotal.mockResolvedValue(996); // 996 + 5 = 1001 > 1000 cap
    const gate = new DbCostGate();
    const result = await gate.check({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 5,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily spend limit exceeded');
  });

  it('allows zero-cost (embedded/Ollama) calls even when daily spend is at cap', async () => {
    // Spend already at cap; estimatedCostCents=0 means "no new spend"
    // — the SpendTracker special-cases zero-cost actions to always pass.
    mockGetDailyTotal.mockResolvedValue(1000);
    const gate = new DbCostGate();
    const result = await gate.check({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 0,
    });
    expect(result.allowed).toBe(true);
  });

  it('uses the schema-default cap (100) when twin_profile is missing', async () => {
    // The repo returns 100 when the user has no row (its documented
    // fail-safe default). The gate should NOT add its own fallback or
    // double-count.
    mockGetDraftsDailyCallCap.mockResolvedValue(100);
    mockCountInWindow.mockResolvedValue(99);
    const gate = new DbCostGate();
    const result = await gate.check({
      userId: 'u-new',
      decisionId: 'd-1',
      estimatedCostCents: 5,
    });
    expect(result.allowed).toBe(true);
  });
});

describe('DbCostGate.record()', () => {
  beforeEach(() => {
    mockRecord.mockReset();
  });

  it('inserts a call-ledger row with the provided fields', async () => {
    mockRecord.mockResolvedValue({ id: 'r-1' });
    const gate = new DbCostGate();
    await gate.record({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 5,
      provider: 'anthropic',
      succeeded: true,
    });
    expect(mockRecord).toHaveBeenCalledWith({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 5,
      provider: 'anthropic',
      succeeded: true,
    });
  });

  it('swallows ledger-write errors — the LLM call already happened, no point taking down the candidate', async () => {
    mockRecord.mockRejectedValue(new Error('CRDB pool exhausted'));
    const gate = new DbCostGate();
    // Must not throw.
    await expect(
      gate.record({
        userId: 'u-1',
        decisionId: 'd-1',
        estimatedCostCents: 5,
        provider: 'anthropic',
        succeeded: false,
      }),
    ).resolves.toBeUndefined();
  });
});
