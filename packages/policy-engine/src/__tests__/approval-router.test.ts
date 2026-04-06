import { describe, it, expect, vi } from 'vitest';
import { ApprovalRouter } from '../approval-router.js';
import type { ApprovalRepositoryPort } from '../approval-router.js';

function createMockRepo(): ApprovalRepositoryPort {
  return {
    expirePending: vi.fn().mockResolvedValue(0),
    batchRespond: vi.fn().mockResolvedValue([]),
  };
}

describe('ApprovalRouter', () => {
  describe('computeExpiry', () => {
    const now = new Date('2026-04-01T12:00:00Z');

    it('should set 15 minute expiry for immediate urgency', () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      const expiry = router.computeExpiry('immediate', now);

      expect(expiry.getTime()).toBe(now.getTime() + 15 * 60 * 1000);
    });

    it('should set 24 hour expiry for normal urgency', () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      const expiry = router.computeExpiry('normal', now);

      expect(expiry.getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    });

    it('should set 72 hour expiry for low urgency', () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      const expiry = router.computeExpiry('low', now);

      expect(expiry.getTime()).toBe(now.getTime() + 72 * 60 * 60 * 1000);
    });

    it('should default to 24 hours for unknown urgency', () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      const expiry = router.computeExpiry('unknown_urgency', now);

      expect(expiry.getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    });
  });

  describe('isExpired', () => {
    it('should return true when current time is past expiry', () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      const expiresAt = new Date('2026-04-01T12:00:00Z');
      const now = new Date('2026-04-01T12:00:01Z');

      expect(router.isExpired(expiresAt, now)).toBe(true);
    });

    it('should return true when current time equals expiry exactly', () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      const expiresAt = new Date('2026-04-01T12:00:00Z');
      const now = new Date('2026-04-01T12:00:00Z');

      expect(router.isExpired(expiresAt, now)).toBe(true);
    });

    it('should return false when current time is before expiry', () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      const expiresAt = new Date('2026-04-01T12:00:00Z');
      const now = new Date('2026-04-01T11:59:59Z');

      expect(router.isExpired(expiresAt, now)).toBe(false);
    });
  });

  describe('expirePendingApprovals', () => {
    it('should delegate to repository and return count', async () => {
      const repo = createMockRepo();
      (repo.expirePending as ReturnType<typeof vi.fn>).mockResolvedValue(5);
      const router = new ApprovalRouter(repo);

      const count = await router.expirePendingApprovals();

      expect(count).toBe(5);
      expect(repo.expirePending).toHaveBeenCalledOnce();
    });

    it('should return 0 when no approvals are expired', async () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      const count = await router.expirePendingApprovals();

      expect(count).toBe(0);
    });
  });

  describe('batchRespond', () => {
    it('should approve multiple approvals at once', async () => {
      const repo = createMockRepo();
      (repo.batchRespond as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'a' }, { id: 'b' }, { id: 'c' },
      ]);
      const router = new ApprovalRouter(repo);

      const result = await router.batchRespond(
        ['a', 'b', 'c'],
        'approve',
        'user-1',
        'Batch approved',
      );

      expect(result.processed).toBe(3);
      expect(repo.batchRespond).toHaveBeenCalledWith(
        ['a', 'b', 'c'],
        'approve',
        'user-1',
        'Batch approved',
      );
    });

    it('should reject multiple approvals at once', async () => {
      const repo = createMockRepo();
      (repo.batchRespond as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'x' },
      ]);
      const router = new ApprovalRouter(repo);

      const result = await router.batchRespond(['x', 'y'], 'reject', 'user-1');

      // Only 1 was actually pending and got updated
      expect(result.processed).toBe(1);
    });

    it('should handle empty batch', async () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      const result = await router.batchRespond([], 'approve', 'user-1');

      expect(result.processed).toBe(0);
    });
  });

  describe('getExpiryDurationMs', () => {
    it('should return correct durations for known urgencies', () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      expect(router.getExpiryDurationMs('immediate')).toBe(15 * 60 * 1000);
      expect(router.getExpiryDurationMs('normal')).toBe(24 * 60 * 60 * 1000);
      expect(router.getExpiryDurationMs('low')).toBe(72 * 60 * 60 * 1000);
    });

    it('should return default for unknown urgency', () => {
      const repo = createMockRepo();
      const router = new ApprovalRouter(repo);

      expect(router.getExpiryDurationMs('custom')).toBe(24 * 60 * 60 * 1000);
    });
  });
});
