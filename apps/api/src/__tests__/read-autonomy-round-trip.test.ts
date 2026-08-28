/**
 * Regression: `readAutonomy` must carry EVERY `AutonomySettings` field.
 *
 * It used to build its own object literal listing five fields, which
 * silently dropped `paused`, `pausedAt`, `pausedReason`, `quietHoursStart`,
 * and `quietHoursEnd`. Callers that correctly passed the result as the fifth
 * argument to `PolicyEvaluator.evaluate` (e.g. `/api/routines`) were still
 * pause-inert and quiet-hours-inert, because the flags had already been
 * stripped by the time the evaluator saw them.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@skytwin/db', () => ({
  twinRepository: { getDraftsDailyCallCap: vi.fn() },
  draftEmailCallsRepository: {
    checkAndReserveCall: vi.fn(),
    updateOutcome: vi.fn(),
    record: vi.fn(),
  },
  userRepository: { findById: vi.fn() },
  spendRepository: { checkAndRecordSpend: vi.fn(), reconcile: vi.fn() },
}));

const { readAutonomy } = await import('../cost-gate.js');

// `readAutonomy` only touches `autonomy_settings`; the rest of UserRow is
// irrelevant to it, so tests cast a minimal shape.
function userWith(autonomySettings: unknown) {
  return { id: 'u-1', autonomy_settings: autonomySettings } as never;
}

describe('readAutonomy round-trip', () => {
  it('carries the pause kill switch (#379) through unchanged', () => {
    const stored = {
      maxSpendPerActionCents: 250,
      maxDailySpendCents: 2500,
      allowedDomains: ['email'],
      blockedDomains: ['finance'],
      requireApprovalForIrreversible: false,
      paused: true,
      pausedAt: '2026-08-27T10:00:00.000Z',
      pausedReason: 'Vacation — nothing should act on my behalf',
    };

    const parsed = readAutonomy(userWith(stored));

    expect(parsed.paused).toBe(true);
    expect(parsed.pausedAt).toBe('2026-08-27T10:00:00.000Z');
    expect(parsed.pausedReason).toBe('Vacation — nothing should act on my behalf');
    // …and does not regress the fields it already carried.
    expect(parsed.maxSpendPerActionCents).toBe(250);
    expect(parsed.maxDailySpendCents).toBe(2500);
    expect(parsed.allowedDomains).toEqual(['email']);
    expect(parsed.blockedDomains).toEqual(['finance']);
    expect(parsed.requireApprovalForIrreversible).toBe(false);
  });

  it('carries the quiet-hours window through unchanged', () => {
    const parsed = readAutonomy(
      userWith({
        maxSpendPerActionCents: 0,
        maxDailySpendCents: 0,
        allowedDomains: [],
        blockedDomains: [],
        requireApprovalForIrreversible: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
      }),
    );

    expect(parsed.quietHoursStart).toBe('22:00');
    expect(parsed.quietHoursEnd).toBe('07:00');
  });

  it('carries per-app overrides through unchanged', () => {
    const parsed = readAutonomy(
      userWith({
        allowedDomains: [],
        blockedDomains: [],
        perAppOverrides: { 'app-x': { maxSpendPerActionCents: 5 } },
      }),
    );

    expect(parsed.perAppOverrides).toEqual({ 'app-x': { maxSpendPerActionCents: 5 } });
  });

  it('falls back conservatively when the user row has no settings', () => {
    for (const raw of [null, undefined, 'not-an-object', 42, []]) {
      const parsed = readAutonomy(userWith(raw));
      expect(parsed.maxSpendPerActionCents).toBe(0);
      expect(parsed.maxDailySpendCents).toBe(0);
      expect(parsed.requireApprovalForIrreversible).toBe(true);
      expect(parsed.allowedDomains).toEqual([]);
      expect(parsed.blockedDomains).toEqual([]);
      expect(parsed.paused).toBeUndefined();
    }
    expect(readAutonomy(null).maxSpendPerActionCents).toBe(0);
  });

  it('ignores malformed field types instead of trusting them', () => {
    const parsed = readAutonomy(
      userWith({
        maxSpendPerActionCents: '500',
        maxDailySpendCents: null,
        allowedDomains: 'email',
        blockedDomains: [1, 'finance', null],
        requireApprovalForIrreversible: 'no',
        paused: 'yes',
        quietHoursStart: 7,
      }),
    );

    // A string spend cap is not a number — fall back to the conservative 0
    // rather than coercing (a coerced '500' would raise the cap silently).
    expect(parsed.maxSpendPerActionCents).toBe(0);
    expect(parsed.maxDailySpendCents).toBe(0);
    expect(parsed.allowedDomains).toEqual([]);
    expect(parsed.blockedDomains).toEqual(['finance']);
    // A truthy non-boolean must not be read as "approval not required".
    expect(parsed.requireApprovalForIrreversible).toBe(true);
    // A truthy non-boolean must not be read as "paused" either — but it must
    // also not be read as "not paused" in a way that hides the real value:
    // there is no real value here, so it stays undefined.
    expect(parsed.paused).toBeUndefined();
    expect(parsed.quietHoursStart).toBeUndefined();
  });
});
