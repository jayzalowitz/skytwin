import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListActive = vi.fn();
const mockListSkillNamesForServer = vi.fn();
const mockCreateIfPending = vi.fn();
const mockQuery = vi.fn();
const mockLoadConfig = vi.fn();
// Soak-floor source (spec 10 Part C): default to a value comfortably past the
// observer floor (24h) so existing promotion-eligibility cases behave as before;
// individual tests can override to assert the floor blocks early promotion.
const mockHoursInCurrentTier = vi.fn().mockResolvedValue(72);

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: {
    listActive: mockListActive,
    listSkillNamesForServer: mockListSkillNamesForServer,
  },
  promotionOffersRepository: { createIfPending: mockCreateIfPending },
  trustTierAuditRepository: { hoursInCurrentTier: mockHoursInCurrentTier },
  query: mockQuery,
}));

vi.mock('@skytwin/config', () => ({
  loadConfig: mockLoadConfig,
}));

const mockEvaluateProgression = vi.fn();
vi.mock('@skytwin/policy-engine', () => ({
  TrustTierEngine: vi.fn(function TrustTierEngine() {
    return {
    evaluateProgression: mockEvaluateProgression,
    };
  }),
}));

vi.mock('@skytwin/shared-types', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    PROMOTION_THRESHOLDS: {
      observer: { consecutiveApprovals: 10, minApprovalRatio: 0.8, nextTier: 'suggest' },
      suggest: { consecutiveApprovals: 20, minApprovalRatio: 0.85, nextTier: 'low_autonomy' },
    },
  };
});

const { runPromotionEligibilityCheckJob } = await import(
  '../jobs/promotion-eligibility-check.js'
);

function makeServer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's-1',
    user_id: 'u-1',
    display_name: 'Linear',
    trust_tier: 'observer',
    auto_promote_paused_until: null,
    status: 'active',
    registry_id: 'linear-mcp',
    oauth_provider: null,
    ...overrides,
  };
}

describe('runPromotionEligibilityCheckJob (#310)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ googleConnectionMode: 'experimental' });
    mockListSkillNamesForServer.mockResolvedValue(['create_issue']);
    // Default: no approval stats — engine returns "stable" by default
    mockQuery.mockResolvedValue({ rows: [{ total: '0', approved: '0' }] });
    mockEvaluateProgression.mockReturnValue({
      shouldChange: false,
      currentTier: 'observer',
      reason: 'No change.',
    });
  });

  it('writes a promotion_offers row when the trust-tier engine recommends a tier change', async () => {
    mockListActive.mockResolvedValue([makeServer()]);
    // First call: stats query. Second: recent-actions query. We get both
    // from the same mock — return different shapes per-call.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '20', approved: '18' }] })
      .mockResolvedValueOnce({
        rows: Array(10).fill({ payload: { approved: true } }),
      });
    mockEvaluateProgression.mockReturnValue({
      shouldChange: true,
      currentTier: 'observer',
      recommendedTier: 'suggest',
      direction: 'promotion',
      reason: '10 consecutive approvals + 90% ratio.',
    });
    mockCreateIfPending.mockResolvedValue({ id: 'o-1' });

    const summary = await runPromotionEligibilityCheckJob();
    expect(summary.offered).toBe(1);
    expect(summary.alreadyPending).toBe(0);
    expect(summary.evaluated).toBe(1);
    expect(mockCreateIfPending).toHaveBeenCalledWith({
      userId: 'u-1',
      serverId: 's-1',
      currentTier: 'observer',
      proposedTier: 'suggest',
      reason: '10 consecutive approvals + 90% ratio.',
      decisionsObservedCount: 20,
      approvedCount: 18,
    });
  });

  it('does not evaluate or create offers for retained account-backed servers while disabled', async () => {
    mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
    mockListActive.mockResolvedValue([
      makeServer({ id: 'gmail', registry_id: 'gmail-mcp' }),
      makeServer({ id: 'outlook', registry_id: 'custom', oauth_provider: 'outlook' }),
    ]);

    const summary = await runPromotionEligibilityCheckJob();

    expect(summary).toEqual({ evaluated: 0, offered: 0, alreadyPending: 0 });
    expect(mockListSkillNamesForServer).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockCreateIfPending).not.toHaveBeenCalled();
  });

  it('fails closed before offer creation when cached skill inventory is empty', async () => {
    mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
    mockListActive.mockResolvedValue([
      makeServer({ id: 'empty', registry_id: 'custom-empty' }),
    ]);
    mockListSkillNamesForServer.mockResolvedValue([]);

    const summary = await runPromotionEligibilityCheckJob();

    expect(summary).toEqual({ evaluated: 0, offered: 0, alreadyPending: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockCreateIfPending).not.toHaveBeenCalled();
  });

  it('fails closed before offer creation when cached skill inventory cannot be read', async () => {
    mockLoadConfig.mockReturnValue({ googleConnectionMode: 'disabled' });
    mockListActive.mockResolvedValue([
      makeServer({ id: 'unreadable', registry_id: 'custom-unreadable' }),
    ]);
    mockListSkillNamesForServer.mockRejectedValue(new Error('inventory unavailable'));

    const summary = await runPromotionEligibilityCheckJob();

    expect(summary).toEqual({ evaluated: 0, offered: 0, alreadyPending: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockCreateIfPending).not.toHaveBeenCalled();
  });

  it('preserves promotion offers for account-backed servers under exact experimental mode', async () => {
    mockLoadConfig.mockReturnValue({ googleConnectionMode: 'experimental' });
    mockListActive.mockResolvedValue([makeServer({ id: 'gmail', registry_id: 'gmail-mcp' })]);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '20', approved: '18' }] })
      .mockResolvedValueOnce({ rows: Array(10).fill({ payload: { approved: true } }) });
    mockEvaluateProgression.mockReturnValue({
      shouldChange: true,
      currentTier: 'observer',
      recommendedTier: 'suggest',
      direction: 'promotion',
      reason: 'Eligible.',
    });
    mockCreateIfPending.mockResolvedValue({ id: 'offer' });

    const summary = await runPromotionEligibilityCheckJob();

    expect(summary.offered).toBe(1);
    expect(mockListSkillNamesForServer).not.toHaveBeenCalled();
    expect(mockCreateIfPending).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'gmail',
    }));
  });

  it('passes hoursInCurrentTier from the audit repo into the engine (soak-floor wiring, spec 10 Part C)', async () => {
    mockListActive.mockResolvedValue([makeServer()]);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '20', approved: '18' }] })
      .mockResolvedValueOnce({ rows: Array(10).fill({ payload: { approved: true } }) });
    mockHoursInCurrentTier.mockResolvedValueOnce(5); // below the 24h observer floor
    mockEvaluateProgression.mockReturnValue({ shouldChange: false, currentTier: 'observer', reason: 'soak' });

    await runPromotionEligibilityCheckJob();

    expect(mockHoursInCurrentTier).toHaveBeenCalledWith('u-1');
    expect(mockEvaluateProgression).toHaveBeenCalledWith(
      'observer',
      expect.objectContaining({ hoursInCurrentTier: 5 }),
    );
  });

  it('counts alreadyPending when createIfPending returns null (idempotency)', async () => {
    // The partial unique index dedup'd a duplicate offer — the repo
    // returns null on the ON CONFLICT DO NOTHING path. The job records
    // that as `alreadyPending`, not as a new offer.
    mockListActive.mockResolvedValue([makeServer()]);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '20', approved: '18' }] })
      .mockResolvedValueOnce({
        rows: Array(10).fill({ payload: { approved: true } }),
      });
    mockEvaluateProgression.mockReturnValue({
      shouldChange: true,
      currentTier: 'observer',
      recommendedTier: 'suggest',
      direction: 'promotion',
      reason: 'Already-pending case.',
    });
    mockCreateIfPending.mockResolvedValue(null);

    const summary = await runPromotionEligibilityCheckJob();
    expect(summary.offered).toBe(0);
    expect(summary.alreadyPending).toBe(1);
  });

  it('skips servers whose auto_promote_paused_until is in the future', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    mockListActive.mockResolvedValue([
      makeServer({ auto_promote_paused_until: future }),
    ]);

    const summary = await runPromotionEligibilityCheckJob();
    expect(summary.evaluated).toBe(0);
    expect(mockCreateIfPending).not.toHaveBeenCalled();
  });

  it('skips servers at terminal tier (no PROMOTION_THRESHOLDS entry)', async () => {
    mockListActive.mockResolvedValue([
      makeServer({ trust_tier: 'high_autonomy' }), // not in mocked thresholds
    ]);

    const summary = await runPromotionEligibilityCheckJob();
    expect(summary.evaluated).toBe(0);
    expect(mockCreateIfPending).not.toHaveBeenCalled();
  });

  it('absorbs per-server failures so one bad server does not stop the batch', async () => {
    mockListActive.mockResolvedValue([
      makeServer({ id: 's-1' }),
      makeServer({ id: 's-2' }),
    ]);
    mockQuery
      // s-1 query throws
      .mockRejectedValueOnce(new Error('CRDB pool exhausted'))
      // s-2 succeeds (stats + recent)
      .mockResolvedValueOnce({ rows: [{ total: '20', approved: '18' }] })
      .mockResolvedValueOnce({
        rows: Array(10).fill({ payload: { approved: true } }),
      });
    mockEvaluateProgression.mockReturnValue({
      shouldChange: true,
      currentTier: 'observer',
      recommendedTier: 'suggest',
      direction: 'promotion',
      reason: 'ok.',
    });
    mockCreateIfPending.mockResolvedValue({ id: 'o-2' });

    const summary = await runPromotionEligibilityCheckJob();
    expect(summary.offered).toBe(1);
    expect(summary.evaluated).toBe(1); // s-1 failed before evaluated++
  });
});
