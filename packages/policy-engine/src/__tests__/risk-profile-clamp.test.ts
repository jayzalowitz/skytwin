/**
 * @file risk-profile-clamp.test.ts
 * Tests for the interpretedCaps parameter added to resolveEffectiveCaps (#190).
 *
 * Hard rail: interpretedCaps may NEVER widen autonomy beyond user-global settings.
 * interpretedCaps narrows below global; per-app overrides narrow further on top.
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveEffectiveCaps, SpendTracker } from '../spend-tracker.js';
import type { SpendRepositoryPort } from '../spend-tracker.js';
import type { AutonomySettings } from '@skytwin/shared-types';

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

function repo(dailyTotal = 0): SpendRepositoryPort {
  return {
    getDailyTotal: vi.fn().mockResolvedValue(dailyTotal),
    reconcile: vi.fn().mockResolvedValue(null),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveEffectiveCaps with interpretedCaps
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectiveCaps — interpretedCaps parameter (#190)', () => {
  it('no interpretedCaps → returns user-global caps unchanged', () => {
    const caps = resolveEffectiveCaps(settings());
    expect(caps.maxDailySpendCents).toBe(50000);
    expect(caps.maxSpendPerActionCents).toBe(10000);
    expect(caps.requireApprovalForIrreversible).toBe(false);
  });

  it('interpretedCaps that NARROWS daily cap is honoured', () => {
    const caps = resolveEffectiveCaps(settings(), undefined, {
      maxDailySpendCents: 5000,
    });
    expect(caps.maxDailySpendCents).toBe(5000);
    // per-action unchanged
    expect(caps.maxSpendPerActionCents).toBe(10000);
  });

  it('interpretedCaps that NARROWS per-action cap is honoured', () => {
    const caps = resolveEffectiveCaps(settings(), undefined, {
      maxSpendPerActionCents: 500,
    });
    expect(caps.maxSpendPerActionCents).toBe(500);
  });

  it('HARD RAIL: interpretedCaps that tries to WIDEN daily cap is clamped to global', () => {
    // User global is 50000; interpretedCaps claims 999999 → must stay at 50000.
    const caps = resolveEffectiveCaps(settings(), undefined, {
      maxDailySpendCents: 999999,
    });
    expect(caps.maxDailySpendCents).toBe(50000);
  });

  it('HARD RAIL: interpretedCaps that tries to WIDEN per-action cap is clamped to global', () => {
    const caps = resolveEffectiveCaps(settings(), undefined, {
      maxSpendPerActionCents: 999999,
    });
    expect(caps.maxSpendPerActionCents).toBe(10000);
  });

  it('interpretedCaps tightens requireApprovalForIrreversible from false to true', () => {
    const s = settings({ requireApprovalForIrreversible: false });
    const caps = resolveEffectiveCaps(s, undefined, {
      requireApprovalForIrreversible: true,
    });
    expect(caps.requireApprovalForIrreversible).toBe(true);
  });

  it('HARD RAIL: interpretedCaps cannot relax requireApprovalForIrreversible when global is true', () => {
    const s = settings({ requireApprovalForIrreversible: true });
    const caps = resolveEffectiveCaps(s, undefined, {
      requireApprovalForIrreversible: false,
    });
    // Global hard rail: must stay true
    expect(caps.requireApprovalForIrreversible).toBe(true);
  });

  it('per-app override clamps FURTHER on top of interpretedCaps narrowing', () => {
    // interpretedCaps narrows daily to 5000; per-app narrows further to 2000.
    const s = settings({
      perAppOverrides: {
        'gmail-mcp': { maxDailySpendCents: 2000 },
      },
    });
    const caps = resolveEffectiveCaps(s, 'gmail-mcp', {
      maxDailySpendCents: 5000,
    });
    expect(caps.maxDailySpendCents).toBe(2000);
  });

  it('per-app override cannot widen beyond interpretedCaps-narrowed base', () => {
    // interpretedCaps narrows daily to 5000; per-app tries to go to 10000 (wider than
    // the interpreted base of 5000). Must stay at 5000.
    const s = settings({
      perAppOverrides: {
        'gmail-mcp': { maxDailySpendCents: 10000 },
      },
    });
    const caps = resolveEffectiveCaps(s, 'gmail-mcp', {
      maxDailySpendCents: 5000,
    });
    expect(caps.maxDailySpendCents).toBe(5000);
  });

  it('empty interpretedCaps object is a no-op', () => {
    const caps = resolveEffectiveCaps(settings(), undefined, {});
    expect(caps.maxDailySpendCents).toBe(50000);
    expect(caps.maxSpendPerActionCents).toBe(10000);
    expect(caps.requireApprovalForIrreversible).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SpendTracker.checkDailyLimit with interpretedCaps
// ─────────────────────────────────────────────────────────────────────────────

describe('SpendTracker.checkDailyLimit — interpretedCaps parameter (#190)', () => {
  it('interpretedCaps that narrows daily cap causes rejection when it would otherwise pass', async () => {
    const r = repo(4000);
    const tracker = new SpendTracker(r);
    const s = settings({ maxDailySpendCents: 50000 });

    // Without interpretedCaps: 4000 + 1500 = 5500 < 50000 → allowed.
    // With interpretedCaps narrowing to 5000: 4000 + 1500 = 5500 > 5000 → rejected.
    const result = await tracker.checkDailyLimit('user-1', 1500, s, 24, undefined, {
      maxDailySpendCents: 5000,
    });
    expect(result.allowed).toBe(false);
    expect(result.dailyLimitCents).toBe(5000);
  });

  it('HARD RAIL: interpretedCaps cannot widen limit beyond global', async () => {
    // global is 5000; interpretedCaps claims 1000000; must stay at 5000.
    const r = repo(4900);
    const tracker = new SpendTracker(r);
    const s = settings({ maxDailySpendCents: 5000 });

    const result = await tracker.checkDailyLimit('user-1', 200, s, 24, undefined, {
      maxDailySpendCents: 1000000,
    });
    // 4900 + 200 = 5100 > 5000 → must still reject
    expect(result.allowed).toBe(false);
    expect(result.dailyLimitCents).toBe(5000);
  });

  it('per-app override and interpretedCaps both narrow independently', async () => {
    // global 50000, interpretedCaps narrows to 10000, per-app narrows to 3000.
    // Effective cap should be min(50000, 10000, 3000) = 3000.
    const r = repo(2500);
    const tracker = new SpendTracker(r);
    const s = settings({
      maxDailySpendCents: 50000,
      perAppOverrides: {
        'linear-mcp': { maxDailySpendCents: 3000 },
      },
    });

    const result = await tracker.checkDailyLimit('user-1', 600, s, 24, 'linear-mcp', {
      maxDailySpendCents: 10000,
    });
    // 2500 + 600 = 3100 > 3000 → rejected
    expect(result.allowed).toBe(false);
    expect(result.dailyLimitCents).toBe(3000);
  });
});
