import { describe, it, expect, vi } from 'vitest';
import { SpendTracker, resolveEffectiveCaps } from '../spend-tracker.js';
import type { SpendRepositoryPort } from '../spend-tracker.js';
import type { AutonomySettings } from '@skytwin/shared-types';

function repo(dailyTotal = 0): SpendRepositoryPort {
  return {
    getDailyTotal: vi.fn().mockResolvedValue(dailyTotal),
    getMonthlyTotal: vi.fn().mockResolvedValue(0),
    reconcile: vi.fn().mockResolvedValue(null),
  };
}

function settings(overrides?: Partial<AutonomySettings>): AutonomySettings {
  return {
    maxSpendPerActionCents: 10000,
    maxDailySpendCents: 50000,
    allowedDomains: [],
    blockedDomains: [],
    requireApprovalForIrreversible: false,
    ...overrides,
  };
}

const NOTION = '@modelcontextprotocol/server-notion';
const LINEAR = 'linear-mcp';

describe('Capability Acquisition Loop #173 — per-app overrides (resolveEffectiveCaps)', () => {
  it('returns user-global caps when no override is supplied', () => {
    const caps = resolveEffectiveCaps(settings());
    expect(caps.maxSpendPerActionCents).toBe(10000);
    expect(caps.maxDailySpendCents).toBe(50000);
    expect(caps.requireApprovalForIrreversible).toBe(false);
    expect(caps.override).toBeUndefined();
  });

  it('returns user-global caps when registry id is unknown', () => {
    const s = settings({
      perAppOverrides: { [NOTION]: { maxDailySpendCents: 1000 } },
    });
    const caps = resolveEffectiveCaps(s, LINEAR);
    expect(caps.maxDailySpendCents).toBe(50000);
    expect(caps.override).toBeUndefined();
  });

  it('narrows the daily cap when override is tighter than global', () => {
    const s = settings({
      perAppOverrides: { [NOTION]: { maxDailySpendCents: 2000 } },
    });
    const caps = resolveEffectiveCaps(s, NOTION);
    expect(caps.maxDailySpendCents).toBe(2000);
    expect(caps.override).toBeDefined();
  });

  it('narrows the per-action cap when override is tighter', () => {
    const s = settings({
      perAppOverrides: { [NOTION]: { maxSpendPerActionCents: 500 } },
    });
    const caps = resolveEffectiveCaps(s, NOTION);
    expect(caps.maxSpendPerActionCents).toBe(500);
  });

  it('clamps an override that tries to widen autonomy back to the global cap', () => {
    const s = settings({
      perAppOverrides: { [NOTION]: { maxDailySpendCents: 999999 } },
    });
    const caps = resolveEffectiveCaps(s, NOTION);
    // Override may not widen — must clamp down to global.
    expect(caps.maxDailySpendCents).toBe(50000);
  });

  it('clamps a per-action override above the global cap', () => {
    const s = settings({
      perAppOverrides: { [NOTION]: { maxSpendPerActionCents: 999999 } },
    });
    const caps = resolveEffectiveCaps(s, NOTION);
    expect(caps.maxSpendPerActionCents).toBe(10000);
  });

  it('OR-combines requireApprovalForIrreversible — override can only tighten', () => {
    const s = settings({
      requireApprovalForIrreversible: false,
      perAppOverrides: { [NOTION]: { requireApprovalForIrreversible: true } },
    });
    expect(resolveEffectiveCaps(s, NOTION).requireApprovalForIrreversible).toBe(true);
  });

  it('keeps requireApprovalForIrreversible true when global is true regardless of override', () => {
    const s = settings({
      requireApprovalForIrreversible: true,
      perAppOverrides: { [NOTION]: { requireApprovalForIrreversible: false } },
    });
    // Global true is the upper bound; override "false" cannot relax it.
    expect(resolveEffectiveCaps(s, NOTION).requireApprovalForIrreversible).toBe(true);
  });

  it('handles independent overrides on multiple apps without cross-contamination', () => {
    const s = settings({
      perAppOverrides: {
        [NOTION]: { maxDailySpendCents: 1000 },
        [LINEAR]: { maxDailySpendCents: 2000 },
      },
    });
    expect(resolveEffectiveCaps(s, NOTION).maxDailySpendCents).toBe(1000);
    expect(resolveEffectiveCaps(s, LINEAR).maxDailySpendCents).toBe(2000);
    expect(resolveEffectiveCaps(s).maxDailySpendCents).toBe(50000);
  });
});

describe('Capability Acquisition Loop #173 — per-app overrides applied via SpendTracker', () => {
  it('checkDailyLimit honors a tighter per-app cap and rejects accordingly', async () => {
    const r = repo(800);
    const tracker = new SpendTracker(r);
    const s = settings({
      perAppOverrides: { [NOTION]: { maxDailySpendCents: 1000 } },
    });
    const result = await tracker.checkDailyLimit('user-1', 500, s, 24, NOTION);
    expect(result.allowed).toBe(false);
    expect(result.dailyLimitCents).toBe(1000);
    expect(result.reason).toContain(NOTION);
  });

  it('checkDailyLimit allows when both global and per-app caps have headroom', async () => {
    const r = repo(800);
    const tracker = new SpendTracker(r);
    const s = settings({
      perAppOverrides: { [NOTION]: { maxDailySpendCents: 5000 } },
    });
    const result = await tracker.checkDailyLimit('user-1', 500, s, 24, NOTION);
    expect(result.allowed).toBe(true);
    expect(result.dailyLimitCents).toBe(5000);
  });

  it('checkDailyLimit ignores per-app override when no registry id is supplied', async () => {
    const r = repo(45000);
    const tracker = new SpendTracker(r);
    const s = settings({
      perAppOverrides: { [NOTION]: { maxDailySpendCents: 100 } },
    });
    // No app id → user-global 50000 cap, 45000 + 1000 = 46000, allowed.
    const result = await tracker.checkDailyLimit('user-1', 1000, s);
    expect(result.allowed).toBe(true);
    expect(result.dailyLimitCents).toBe(50000);
  });

  it('hard-rails: an override cannot widen past the user absolute global cap', async () => {
    const r = repo(49500);
    const tracker = new SpendTracker(r);
    const s = settings({
      maxDailySpendCents: 50000,
      perAppOverrides: { [NOTION]: { maxDailySpendCents: 1000000 } },
    });
    // Override claims 1M cap; clamp to global 50k. 49500+1000 = 50500 > 50000 → reject.
    const result = await tracker.checkDailyLimit('user-1', 1000, s, 24, NOTION);
    expect(result.allowed).toBe(false);
    expect(result.dailyLimitCents).toBe(50000);
  });

  it('zero-cost actions still pass with per-app override applied', async () => {
    const r = repo(999);
    const tracker = new SpendTracker(r);
    const s = settings({
      perAppOverrides: { [NOTION]: { maxDailySpendCents: 1000 } },
    });
    const result = await tracker.checkDailyLimit('user-1', 0, s, 24, NOTION);
    expect(result.allowed).toBe(true);
    expect(result.dailyLimitCents).toBe(1000);
  });

  it('negative cost is rejected even with per-app override (defense-in-depth)', async () => {
    const r = repo(0);
    const tracker = new SpendTracker(r);
    const s = settings({
      perAppOverrides: { [NOTION]: { maxDailySpendCents: 1000 } },
    });
    const result = await tracker.checkDailyLimit('user-1', -100, s, 24, NOTION);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('negative');
  });
});
