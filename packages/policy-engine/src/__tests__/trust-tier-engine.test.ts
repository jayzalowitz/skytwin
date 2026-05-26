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

    // ── Temporal floor (#373) ────────────────────────────────────

    it('should NOT promote OBSERVER → SUGGEST before 24h in tier even with 10+ approvals', () => {
      // 20 approvals racked up in 3 hours is the exact failure case
      // #373 describes: count threshold cleared, time floor not.
      const stats = createStats({
        consecutiveApprovals: 20,
        totalApprovals: 20,
        approvalRatio: 1.0,
        hoursInCurrentTier: 3,
      });

      const result = engine.evaluateProgression(TrustTier.OBSERVER, stats);

      expect(result.shouldChange).toBe(false);
      expect(result.reason).toContain('Time-in-tier floor');
      expect(result.reason).toMatch(/need 24h/);
    });

    it('should promote OBSERVER → SUGGEST once 24h in tier AND 10+ approvals are met', () => {
      const stats = createStats({
        consecutiveApprovals: 12,
        totalApprovals: 12,
        approvalRatio: 1.0,
        hoursInCurrentTier: 25,
      });

      const result = engine.evaluateProgression(TrustTier.OBSERVER, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.recommendedTier).toBe(TrustTier.SUGGEST);
    });

    it('should NOT promote SUGGEST → LOW_AUTONOMY before 72h in tier', () => {
      const stats = createStats({
        consecutiveApprovals: 25,
        totalApprovals: 25,
        totalRejections: 3,
        approvalRatio: 25 / 28,
        hoursInCurrentTier: 24, // observer-promotion-passing duration is not enough here
      });

      const result = engine.evaluateProgression(TrustTier.SUGGEST, stats);

      expect(result.shouldChange).toBe(false);
      expect(result.reason).toMatch(/need 72h/);
    });

    it('should NOT promote LOW_AUTONOMY → MODERATE_AUTONOMY before 168h (one week) in tier', () => {
      const stats = createStats({
        consecutiveApprovals: 55,
        totalApprovals: 55,
        totalRejections: 2,
        approvalRatio: 55 / 57,
        hoursInCurrentTier: 100,
      });

      const result = engine.evaluateProgression(TrustTier.LOW_AUTONOMY, stats);

      expect(result.shouldChange).toBe(false);
      expect(result.reason).toMatch(/need 168h/);
    });

    it('should NOT let NaN hoursInCurrentTier bypass the temporal floor (#373, post-Copilot)', () => {
      // typeof NaN === 'number' would have let a malformed
      // trust_tier_audit row (clock skew, mis-parsed timestamp) sneak
      // past the floor. Number.isFinite rejects NaN/Infinity.
      const stats = createStats({
        consecutiveApprovals: 12,
        totalApprovals: 12,
        approvalRatio: 1.0,
        hoursInCurrentTier: Number.NaN,
      });

      const result = engine.evaluateProgression(TrustTier.OBSERVER, stats);

      // NaN is treated like undefined: floor is skipped, count+ratio
      // criteria still let the promotion through. The important
      // property is that the reasoning string does not contain literal
      // "NaN".
      expect(result.reason).not.toMatch(/NaN/);
    });

    it('should NOT let Infinity hoursInCurrentTier short-circuit the floor (#373, post-Copilot)', () => {
      const stats = createStats({
        consecutiveApprovals: 12,
        totalApprovals: 12,
        approvalRatio: 1.0,
        hoursInCurrentTier: Number.POSITIVE_INFINITY,
      });

      const result = engine.evaluateProgression(TrustTier.OBSERVER, stats);

      // Infinity is also non-finite — same treatment as NaN: skip the
      // floor, fall through to count+ratio, no literal "Infinity" in
      // the reasoning string.
      expect(result.reason).not.toMatch(/Infinity/);
    });

    it('should skip the temporal floor when hoursInCurrentTier is undefined (legacy compat)', () => {
      // Older callers (and unit tests above) omit the field. They
      // continue to be evaluated on count + ratio alone so the change
      // is opt-in for the API path that actually populates the field
      // from trust_tier_audit.
      const stats = createStats({
        consecutiveApprovals: 12,
        totalApprovals: 12,
        approvalRatio: 1.0,
        // hoursInCurrentTier intentionally omitted
      });

      const result = engine.evaluateProgression(TrustTier.OBSERVER, stats);

      expect(result.shouldChange).toBe(true);
      expect(result.recommendedTier).toBe(TrustTier.SUGGEST);
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
