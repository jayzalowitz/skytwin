import { describe, it, expect, vi } from 'vitest';
import { DomainAutonomyManager } from '../domain-autonomy.js';
import type { DomainAutonomyRepositoryPort, DomainAutonomyPolicy } from '../domain-autonomy.js';
import { TrustTier } from '@skytwin/shared-types';

function createMockRepo(
  policies: Map<string, DomainAutonomyPolicy> = new Map(),
): DomainAutonomyRepositoryPort {
  return {
    getForUser: vi.fn().mockResolvedValue([...policies.values()]),
    getForDomain: vi.fn().mockImplementation(async (_userId: string, domain: string) =>
      policies.get(domain) ?? null,
    ),
  };
}

describe('DomainAutonomyManager', () => {
  describe('getEffectiveTier', () => {
    it('should return global tier when no domain override exists', async () => {
      const repo = createMockRepo();
      const manager = new DomainAutonomyManager(repo);

      const result = await manager.getEffectiveTier(
        'user1', 'email', TrustTier.MODERATE_AUTONOMY,
      );

      expect(result.effectiveTier).toBe(TrustTier.MODERATE_AUTONOMY);
      expect(result.source).toBe('global');
    });

    it('should use domain tier when it is more restrictive than global', async () => {
      const policies = new Map([
        ['finance', { domain: 'finance', trustTier: TrustTier.LOW_AUTONOMY }],
      ]);
      const repo = createMockRepo(policies);
      const manager = new DomainAutonomyManager(repo);

      const result = await manager.getEffectiveTier(
        'user1', 'finance', TrustTier.HIGH_AUTONOMY,
      );

      expect(result.effectiveTier).toBe(TrustTier.LOW_AUTONOMY);
      expect(result.source).toBe('domain');
    });

    it('should use global tier when it is more restrictive than domain', async () => {
      const policies = new Map([
        ['email', { domain: 'email', trustTier: TrustTier.HIGH_AUTONOMY }],
      ]);
      const repo = createMockRepo(policies);
      const manager = new DomainAutonomyManager(repo);

      const result = await manager.getEffectiveTier(
        'user1', 'email', TrustTier.SUGGEST,
      );

      expect(result.effectiveTier).toBe(TrustTier.SUGGEST);
      expect(result.source).toBe('global');
    });

    it('should use domain tier when both are equal', async () => {
      const policies = new Map([
        ['calendar', { domain: 'calendar', trustTier: TrustTier.LOW_AUTONOMY }],
      ]);
      const repo = createMockRepo(policies);
      const manager = new DomainAutonomyManager(repo);

      const result = await manager.getEffectiveTier(
        'user1', 'calendar', TrustTier.LOW_AUTONOMY,
      );

      // Equal rank: domain rank <= global rank, so domain source
      expect(result.effectiveTier).toBe(TrustTier.LOW_AUTONOMY);
      expect(result.source).toBe('domain');
    });

    it('should handle OBSERVER domain override', async () => {
      const policies = new Map([
        ['social', { domain: 'social', trustTier: TrustTier.OBSERVER }],
      ]);
      const repo = createMockRepo(policies);
      const manager = new DomainAutonomyManager(repo);

      const result = await manager.getEffectiveTier(
        'user1', 'social', TrustTier.HIGH_AUTONOMY,
      );

      expect(result.effectiveTier).toBe(TrustTier.OBSERVER);
      expect(result.source).toBe('domain');
    });
  });

  describe('resolveEffectiveTier (in-memory)', () => {
    it('should resolve using provided policies array', () => {
      const repo = createMockRepo();
      const manager = new DomainAutonomyManager(repo);
      const policies: DomainAutonomyPolicy[] = [
        { domain: 'finance', trustTier: TrustTier.OBSERVER },
        { domain: 'email', trustTier: TrustTier.HIGH_AUTONOMY },
      ];

      expect(
        manager.resolveEffectiveTier('finance', TrustTier.MODERATE_AUTONOMY, policies),
      ).toBe(TrustTier.OBSERVER);

      expect(
        manager.resolveEffectiveTier('email', TrustTier.SUGGEST, policies),
      ).toBe(TrustTier.SUGGEST); // global is more restrictive

      expect(
        manager.resolveEffectiveTier('calendar', TrustTier.LOW_AUTONOMY, policies),
      ).toBe(TrustTier.LOW_AUTONOMY); // no domain policy, falls back to global
    });
  });
});
