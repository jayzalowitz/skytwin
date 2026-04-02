import { describe, it, expect } from 'vitest';
import { TrustTierEngine } from '../trust-tier-engine.js';
import { TrustTier } from '@skytwin/shared-types';
import type { ApprovalStats } from '@skytwin/shared-types';

// ── Helpers ──────────────────────────────────────────────────────

function createStats(overrides?: Partial<ApprovalStats>): ApprovalStats {
  return {
    totalApprovals: 0,
    totalRejections: 0,
    totalUndos: 0,
    consecutiveApprovals: 0,
    recentRejections: 0,
    hasCriticalUndo: false,
    approvalRatio: 0,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('TrustTierEngine', () => {
  const engine = new TrustTierEngine();

  // ── Promotion ──────────────────────────────────────────────────

  describe('evaluateProgression', () => {
    it('should promote OBSERVER → SUGGEST with 10+ consecutive approvals and 80%+ ratio', () => {
      const stats = createStats({
        consecutiveApprovals: 12,
        totalApprovals: 12,
        approvalRatio: 1.0,
      });

      const result = engine.evaluateProgression(TrustTier.OBSERVER, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.recommendedTier).toBe(TrustTier.SUGGEST);
      expect(result.direction).toBe('promotion');
    });

    it('should promote SUGGEST → LOW_AUTONOMY with 20+ consecutive approvals and 85%+ ratio', () => {
      const stats = createStats({
        consecutiveApprovals: 25,
        totalApprovals: 25,
        totalRejections: 3,
        approvalRatio: 25 / 28,
      });

      const result = engine.evaluateProgression(TrustTier.SUGGEST, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.recommendedTier).toBe(TrustTier.LOW_AUTONOMY);
    });

    it('should promote LOW_AUTONOMY → MODERATE_AUTONOMY with 50+ consecutive approvals and 90%+ ratio', () => {
      const stats = createStats({
        consecutiveApprovals: 55,
        totalApprovals: 55,
        totalRejections: 2,
        approvalRatio: 55 / 57,
      });

      const result = engine.evaluateProgression(TrustTier.LOW_AUTONOMY, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.recommendedTier).toBe(TrustTier.MODERATE_AUTONOMY);
    });

    it('should NOT auto-promote MODERATE_AUTONOMY → HIGH_AUTONOMY', () => {
      const stats = createStats({
        consecutiveApprovals: 200,
        totalApprovals: 200,
        approvalRatio: 1.0,
      });

      const result = engine.evaluateProgression(TrustTier.MODERATE_AUTONOMY, stats);

      expect(result.shouldChange).toBe(false);
      expect(result.reason).toContain('explicit user opt-in');
    });

    it('should NOT promote when already at HIGH_AUTONOMY', () => {
      const stats = createStats({
        consecutiveApprovals: 200,
        approvalRatio: 1.0,
      });

      const result = engine.evaluateProgression(TrustTier.HIGH_AUTONOMY, stats);

      expect(result.shouldChange).toBe(false);
      expect(result.reason).toContain('highest');
    });

    it('should NOT promote with insufficient consecutive approvals', () => {
      const stats = createStats({
        consecutiveApprovals: 5,
        totalApprovals: 5,
        approvalRatio: 1.0,
      });

      const result = engine.evaluateProgression(TrustTier.OBSERVER, stats);

      expect(result.shouldChange).toBe(false);
      expect(result.reason).toContain('consecutive approvals');
    });

    it('should NOT promote with low approval ratio even if consecutive count is met', () => {
      const stats = createStats({
        consecutiveApprovals: 12,
        totalApprovals: 12,
        totalRejections: 10,
        approvalRatio: 12 / 22, // ~54%
      });

      const result = engine.evaluateProgression(TrustTier.OBSERVER, stats);

      expect(result.shouldChange).toBe(false);
      expect(result.reason).toContain('Approval ratio');
    });

    it('should require exactly the threshold number of consecutive approvals', () => {
      // 9 consecutive should fail for OBSERVER (needs 10)
      const stats9 = createStats({
        consecutiveApprovals: 9,
        totalApprovals: 9,
        approvalRatio: 1.0,
      });
      expect(engine.evaluateProgression(TrustTier.OBSERVER, stats9).shouldChange).toBe(false);

      // 10 consecutive should pass
      const stats10 = createStats({
        consecutiveApprovals: 10,
        totalApprovals: 10,
        approvalRatio: 1.0,
      });
      expect(engine.evaluateProgression(TrustTier.OBSERVER, stats10).shouldChange).toBe(true);
    });
  });

  // ── Regression ─────────────────────────────────────────────────

  describe('evaluateRegression', () => {
    it('should demote on critical undo', () => {
      const stats = createStats({
        hasCriticalUndo: true,
        totalApprovals: 100,
        approvalRatio: 0.95,
      });

      const result = engine.evaluateRegression(TrustTier.MODERATE_AUTONOMY, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.recommendedTier).toBe(TrustTier.OBSERVER);
      expect(result.direction).toBe('regression');
      expect(result.reason).toContain('Critical undo');
      expect(result.reason).toContain('OBSERVER');
    });

    it('should demote on 3+ recent rejections', () => {
      const stats = createStats({
        recentRejections: 4,
        totalApprovals: 50,
        totalRejections: 6,
        approvalRatio: 50 / 56,
      });

      const result = engine.evaluateRegression(TrustTier.LOW_AUTONOMY, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.recommendedTier).toBe(TrustTier.SUGGEST);
      expect(result.reason).toContain('rejections in rolling window');
    });

    it('should demote on high rejection ratio with sufficient events', () => {
      const stats = createStats({
        totalApprovals: 6,
        totalRejections: 5,
        approvalRatio: 6 / 11, // ~54%, rejection ratio ~45% > 30% threshold
        recentRejections: 2, // below spike threshold
      });

      const result = engine.evaluateRegression(TrustTier.HIGH_AUTONOMY, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.recommendedTier).toBe(TrustTier.MODERATE_AUTONOMY);
      expect(result.reason).toContain('Rejection ratio');
    });

    it('should NOT regress below OBSERVER', () => {
      const stats = createStats({
        hasCriticalUndo: true,
        recentRejections: 10,
      });

      const result = engine.evaluateRegression(TrustTier.OBSERVER, stats);

      expect(result.shouldChange).toBe(false);
      expect(result.reason).toContain('lowest');
    });

    it('should NOT regress when stats are healthy', () => {
      const stats = createStats({
        totalApprovals: 30,
        totalRejections: 1,
        recentRejections: 0,
        approvalRatio: 30 / 31,
        hasCriticalUndo: false,
      });

      const result = engine.evaluateRegression(TrustTier.MODERATE_AUTONOMY, stats);

      expect(result.shouldChange).toBe(false);
      expect(result.reason).toContain('stable');
    });

    it('should NOT apply ratio check with fewer than 10 events', () => {
      const stats = createStats({
        totalApprovals: 3,
        totalRejections: 3,
        approvalRatio: 0.5, // 50% rejection ratio, but only 6 events
        recentRejections: 2,
      });

      const result = engine.evaluateRegression(TrustTier.SUGGEST, stats);

      expect(result.shouldChange).toBe(false);
    });

    it('should demote HIGH_AUTONOMY → MODERATE_AUTONOMY on rejection spike', () => {
      const stats = createStats({
        recentRejections: 3,
        totalApprovals: 100,
        totalRejections: 5,
        approvalRatio: 100 / 105,
      });

      const result = engine.evaluateRegression(TrustTier.HIGH_AUTONOMY, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.recommendedTier).toBe(TrustTier.MODERATE_AUTONOMY);
    });

    it('should demote SUGGEST → OBSERVER on critical undo', () => {
      const stats = createStats({ hasCriticalUndo: true });

      const result = engine.evaluateRegression(TrustTier.SUGGEST, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.recommendedTier).toBe(TrustTier.OBSERVER);
    });
  });

  // ── Combined evaluate ─────────────────────────────────────────

  describe('evaluate (combined)', () => {
    it('should prioritize regression over progression when not at floor', () => {
      // Stats that would qualify for promotion AND regression
      const stats = createStats({
        consecutiveApprovals: 25,
        totalApprovals: 25,
        approvalRatio: 1.0,
        hasCriticalUndo: true, // triggers regression
      });

      const result = engine.evaluate(TrustTier.SUGGEST, stats);

      // Regression takes priority: critical undo demotes SUGGEST → OBSERVER
      expect(result.shouldChange).toBe(true);
      expect(result.direction).toBe('regression');
      expect(result.recommendedTier).toBe(TrustTier.OBSERVER);
    });

    it('should allow promotion at floor even with critical undo', () => {
      // OBSERVER can't regress (floor), so regression returns no-change.
      // Then progression kicks in.
      const stats = createStats({
        consecutiveApprovals: 15,
        totalApprovals: 15,
        approvalRatio: 1.0,
        hasCriticalUndo: true,
      });

      const result = engine.evaluate(TrustTier.OBSERVER, stats);

      // At floor, regression is a no-op, so promotion applies
      expect(result.shouldChange).toBe(true);
      expect(result.direction).toBe('promotion');
    });

    it('regression takes priority when not at floor', () => {
      const stats = createStats({
        consecutiveApprovals: 25,
        totalApprovals: 25,
        totalRejections: 1,
        approvalRatio: 25 / 26,
        recentRejections: 3, // triggers regression
      });

      const result = engine.evaluate(TrustTier.SUGGEST, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.direction).toBe('regression');
      expect(result.recommendedTier).toBe(TrustTier.OBSERVER);
    });

    it('should promote when no regression triggers exist', () => {
      const stats = createStats({
        consecutiveApprovals: 12,
        totalApprovals: 12,
        approvalRatio: 1.0,
        recentRejections: 0,
        hasCriticalUndo: false,
      });

      const result = engine.evaluate(TrustTier.OBSERVER, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.direction).toBe('promotion');
      expect(result.recommendedTier).toBe(TrustTier.SUGGEST);
    });

    it('should return no change when neither promotion nor regression applies', () => {
      const stats = createStats({
        consecutiveApprovals: 5, // not enough for promotion
        totalApprovals: 5,
        approvalRatio: 1.0,
        recentRejections: 0,
      });

      const result = engine.evaluate(TrustTier.OBSERVER, stats);

      expect(result.shouldChange).toBe(false);
    });
  });
});
