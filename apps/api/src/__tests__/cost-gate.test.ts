import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetDraftsDailyCallCap = vi.fn();
const mockCheckAndReserveCall = vi.fn();
const mockUpdateOutcome = vi.fn();
const mockRecord = vi.fn();
const mockUserFindById = vi.fn();
const mockCheckAndRecordSpend = vi.fn();
const mockReconcile = vi.fn();

vi.mock('@skytwin/db', () => ({
  twinRepository: {
    getDraftsDailyCallCap: (...args: unknown[]) => mockGetDraftsDailyCallCap(...args),
  },
  draftEmailCallsRepository: {
    checkAndReserveCall: (...args: unknown[]) => mockCheckAndReserveCall(...args),
    updateOutcome: (...args: unknown[]) => mockUpdateOutcome(...args),
    record: (...args: unknown[]) => mockRecord(...args),
  },
  userRepository: {
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
  spendRepository: {
    checkAndRecordSpend: (...args: unknown[]) => mockCheckAndRecordSpend(...args),
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
    mockCheckAndReserveCall.mockReset();
    mockUpdateOutcome.mockReset();
    mockRecord.mockReset();
    mockUserFindById.mockReset();
    mockCheckAndRecordSpend.mockReset();
    mockReconcile.mockReset();
    // Defaults: liberal user / fresh day. Tests override per-case.
    mockGetDraftsDailyCallCap.mockResolvedValue(100);
    mockCheckAndReserveCall.mockResolvedValue({
      allowed: true,
      count: 1,
      record: { id: 'cr-1' },
    });
    mockUserFindById.mockResolvedValue({
      id: 'u-1',
      autonomy_settings: STANDARD_AUTONOMY,
    });
    mockCheckAndRecordSpend.mockResolvedValue({
      allowed: true,
      currentTotal: 5,
      record: { id: 'sr-1' },
    });
  });

  it('allows the call when both gates are well under their caps', async () => {
    const gate = new DbCostGate();
    const result = await gate.check({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 5,
    });
    expect(result.allowed).toBe(true);
    // Cap read was the first DB hit, then atomic reserve.
    expect(mockGetDraftsDailyCallCap).toHaveBeenCalledWith('u-1');
    expect(mockCheckAndReserveCall).toHaveBeenCalled();
  });

  it('refuses when the per-day CALL cap is reached (atomic reserve refuses), before consulting the spend cap', async () => {
    mockGetDraftsDailyCallCap.mockResolvedValue(10);
    mockCheckAndReserveCall.mockResolvedValue({
      allowed: false,
      count: 10,
      record: null,
    });
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
    expect(mockCheckAndRecordSpend).not.toHaveBeenCalled();
  });

  it('refuses when the per-day SPEND cap would be exceeded (atomic reservation says no)', async () => {
    mockCheckAndRecordSpend.mockResolvedValue({
      allowed: false,
      currentTotal: 996,
      record: null,
    });
    const gate = new DbCostGate();
    const result = await gate.check({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 5,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily spend limit exceeded');
  });

  it('skips the spend reservation entirely for zero-cost (embedded/Ollama) calls', async () => {
    // estimatedCostCents=0 → no reservation → no spend_records noise.
    const gate = new DbCostGate();
    const result = await gate.check({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 0,
    });
    expect(result.allowed).toBe(true);
    expect(mockCheckAndRecordSpend).not.toHaveBeenCalled();
    expect(mockUserFindById).not.toHaveBeenCalled();
  });

  it('uses the schema-default cap (100) when twin_profile is missing and the reserve succeeds', async () => {
    // The repo returns 100 when the user has no row (its documented
    // fail-safe default). The gate should NOT add its own fallback or
    // double-count.
    mockGetDraftsDailyCallCap.mockResolvedValue(100);
    mockCheckAndReserveCall.mockResolvedValue({
      allowed: true,
      count: 100,
      record: { id: 'cr-100' },
    });
    const gate = new DbCostGate();
    const result = await gate.check({
      userId: 'u-new',
      decisionId: 'd-1',
      estimatedCostCents: 5,
    });
    expect(result.allowed).toBe(true);
    expect(mockCheckAndReserveCall).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 100 }),
    );
  });
});

describe('DbCostGate.record()', () => {
  beforeEach(() => {
    mockRecord.mockReset();
    mockReconcile.mockReset();
  });

  it('inserts a call-ledger row with the provided fields on success', async () => {
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
    // On success the spend reservation stays as-is (no reconcile call).
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('reconciles the spend reservation to 0 cents when the LLM call failed', async () => {
    // A flapping provider would otherwise eat the user's daily budget
    // on every retry — once for each reserved-but-uncompleted call.
    mockRecord.mockResolvedValue({ id: 'r-1' });
    mockReconcile.mockResolvedValue({ id: 'sr-1', actual_cost_cents: 0 });
    const gate = new DbCostGate();
    await gate.record({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 5,
      provider: 'anthropic',
      succeeded: false,
    });
    expect(mockReconcile).toHaveBeenCalledWith('draft-email:d-1', 0);
  });

  it('does NOT reconcile when the failed call was zero-cost (no reservation existed)', async () => {
    // Embedded/Ollama path: no reservation was made, so reconcile
    // would 404 against a nonexistent action_id. Skip entirely.
    mockRecord.mockResolvedValue({ id: 'r-1' });
    const gate = new DbCostGate();
    await gate.record({
      userId: 'u-1',
      decisionId: 'd-1',
      estimatedCostCents: 0,
      provider: 'embedded',
      succeeded: false,
    });
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('swallows ledger-write errors — the LLM call already happened, no point taking down the candidate', async () => {
    mockRecord.mockRejectedValue(new Error('CRDB pool exhausted'));
    const gate = new DbCostGate();
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

  it('swallows reconcile errors too — the call already happened, stale reservation is noise', async () => {
    mockRecord.mockResolvedValue({ id: 'r-1' });
    mockReconcile.mockRejectedValue(new Error('CRDB pool exhausted'));
    const gate = new DbCostGate();
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
