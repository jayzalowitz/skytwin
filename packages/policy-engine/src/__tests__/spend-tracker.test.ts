import { describe, it, expect, vi } from 'vitest';
import { SpendTracker } from '../spend-tracker.js';
import type { SpendRepositoryPort } from '../spend-tracker.js';
import type { AutonomySettings } from '@skytwin/shared-types';

function createMockRepo(dailyTotal: number = 0): SpendRepositoryPort {
  return {
    getDailyTotal: vi.fn().mockResolvedValue(dailyTotal),
    reconcile: vi.fn().mockResolvedValue(null),
  };
}

function createSettings(overrides?: Partial<AutonomySettings>): AutonomySettings {
  return {
    maxSpendPerActionCents: 5000,
    maxDailySpendCents: 10000,
    allowedDomains: [],
    blockedDomains: [],
    requireApprovalForIrreversible: true,
    ...overrides,
  };
}

describe('SpendTracker', () => {
  describe('checkDailyLimit', () => {
    it('should allow an action within daily limit', async () => {
      const repo = createMockRepo(2000); // $20 spent today
      const tracker = new SpendTracker(repo);
      const settings = createSettings({ maxDailySpendCents: 10000 }); // $100 limit

      const result = await tracker.checkDailyLimit('user1', 3000, settings);

      expect(result.allowed).toBe(true);
      expect(result.currentDailySpendCents).toBe(2000);
      expect(result.remainingCents).toBe(5000); // 10000 - 2000 - 3000
    });

    it('should block an action that would exceed daily limit', async () => {
      const repo = createMockRepo(4500); // $45 spent today
      const tracker = new SpendTracker(repo);
      const settings = createSettings({ maxDailySpendCents: 5000 }); // $50 limit

      const result = await tracker.checkDailyLimit('user1', 1000, settings);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('exceeded');
      expect(result.remainingCents).toBe(500); // only $5 left
    });

    it('should block when proposed equals remaining exactly (strict >)', async () => {
      const repo = createMockRepo(4000);
      const tracker = new SpendTracker(repo);
      const settings = createSettings({ maxDailySpendCents: 5000 });

      // 4000 + 1000 = 5000, which equals the limit (not exceeding)
      const result = await tracker.checkDailyLimit('user1', 1000, settings);

      expect(result.allowed).toBe(true);
    });

    it('should block when proposed is 1 cent over limit', async () => {
      const repo = createMockRepo(4000);
      const tracker = new SpendTracker(repo);
      const settings = createSettings({ maxDailySpendCents: 5000 });

      // 4000 + 1001 = 5001, exceeds limit
      const result = await tracker.checkDailyLimit('user1', 1001, settings);

      expect(result.allowed).toBe(false);
    });

    it('should always allow zero-cost actions', async () => {
      const repo = createMockRepo(10000);
      const tracker = new SpendTracker(repo);
      const settings = createSettings({ maxDailySpendCents: 5000 });

      const result = await tracker.checkDailyLimit('user1', 0, settings);

      expect(result.allowed).toBe(true);
      // Should not even query the repo for zero-cost
    });

    it('should allow negative cost (refund scenario)', async () => {
      const repo = createMockRepo(5000);
      const tracker = new SpendTracker(repo);
      const settings = createSettings({ maxDailySpendCents: 5000 });

      const result = await tracker.checkDailyLimit('user1', -500, settings);

      expect(result.allowed).toBe(true);
    });

    it('should block when daily spend is already at limit', async () => {
      const repo = createMockRepo(10000);
      const tracker = new SpendTracker(repo);
      const settings = createSettings({ maxDailySpendCents: 10000 });

      const result = await tracker.checkDailyLimit('user1', 100, settings);

      expect(result.allowed).toBe(false);
      expect(result.remainingCents).toBe(0);
    });

    it('should pass custom window hours to repository', async () => {
      const repo = createMockRepo(0);
      const tracker = new SpendTracker(repo);
      const settings = createSettings();

      await tracker.checkDailyLimit('user1', 100, settings, 48);

      expect(repo.getDailyTotal).toHaveBeenCalledWith('user1', 48);
    });
  });

  describe('reconcile', () => {
    it('should calculate variance when actual exceeds estimate', async () => {
      const repo = createMockRepo();
      const tracker = new SpendTracker(repo);

      const result = await tracker.reconcile('action1', 5000, 7500);

      expect(result.varianceCents).toBe(2500);
      expect(result.variancePercent).toBe(50);
      expect(result.overEstimated).toBe(false);
      expect(repo.reconcile).toHaveBeenCalledWith('action1', 7500);
    });

    it('should calculate variance when actual is less than estimate', async () => {
      const repo = createMockRepo();
      const tracker = new SpendTracker(repo);

      const result = await tracker.reconcile('action2', 5000, 3000);

      expect(result.varianceCents).toBe(-2000);
      expect(result.variancePercent).toBe(-40);
      expect(result.overEstimated).toBe(true);
    });

    it('should handle zero estimate gracefully', async () => {
      const repo = createMockRepo();
      const tracker = new SpendTracker(repo);

      const result = await tracker.reconcile('action3', 0, 500);

      expect(result.varianceCents).toBe(500);
      expect(result.variancePercent).toBe(0); // avoid division by zero
    });

    it('should handle exact match', async () => {
      const repo = createMockRepo();
      const tracker = new SpendTracker(repo);

      const result = await tracker.reconcile('action4', 1000, 1000);

      expect(result.varianceCents).toBe(0);
      expect(result.variancePercent).toBe(0);
      expect(result.overEstimated).toBe(false);
    });
  });
});
