import { describe, it, expect } from 'vitest';
import { EscalationTriggerEngine } from '../escalation-triggers.js';
import type { EscalationTrigger, EscalationContext } from '../escalation-triggers.js';
import type { CandidateAction, RiskAssessment } from '@skytwin/shared-types';
import {
  RiskTier,
  RiskDimension,
  ConfidenceLevel,
} from '@skytwin/shared-types';

function createContext(overrides?: Partial<EscalationContext>): EscalationContext {
  const defaultDim = { tier: RiskTier.NEGLIGIBLE, score: 0, reasoning: 'OK' };
  return {
    action: {
      id: 'action1',
      decisionId: 'dec1',
      actionType: 'archive_email',
      description: 'Archive email',
      domain: 'email',
      parameters: {},
      estimatedCostCents: 0,
      reversible: true,
      confidence: ConfidenceLevel.MODERATE,
      reasoning: 'test',
    } as CandidateAction,
    riskAssessment: {
      actionId: 'action1',
      overallTier: RiskTier.NEGLIGIBLE,
      dimensions: {
        [RiskDimension.REVERSIBILITY]: defaultDim,
        [RiskDimension.FINANCIAL_IMPACT]: defaultDim,
        [RiskDimension.LEGAL_SENSITIVITY]: defaultDim,
        [RiskDimension.PRIVACY_SENSITIVITY]: defaultDim,
        [RiskDimension.RELATIONSHIP_SENSITIVITY]: defaultDim,
        [RiskDimension.OPERATIONAL_RISK]: defaultDim,
      },
      reasoning: 'OK',
      assessedAt: new Date(),
    } as RiskAssessment,
    matchingPreferenceCount: 3,
    consecutiveRejections: 0,
    ...overrides,
  };
}

function createTrigger(
  type: EscalationTrigger['triggerType'],
  conditions: Record<string, unknown>,
  id: string = 'trigger1',
): EscalationTrigger {
  return { id, triggerType: type, conditions, enabled: true };
}

describe('EscalationTriggerEngine', () => {
  const engine = new EscalationTriggerEngine();

  describe('amount_threshold', () => {
    it('should escalate when cost meets threshold', () => {
      const trigger = createTrigger('amount_threshold', { thresholdCents: 5000 });
      const context = createContext({
        action: { ...createContext().action, estimatedCostCents: 5000 },
      });

      const result = engine.evaluate([trigger], context);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reasons[0]).toContain('5000 cents');
    });

    it('should not escalate when cost is below threshold', () => {
      const trigger = createTrigger('amount_threshold', { thresholdCents: 5000 });
      const context = createContext({
        action: { ...createContext().action, estimatedCostCents: 4999 },
      });

      const result = engine.evaluate([trigger], context);

      expect(result.shouldEscalate).toBe(false);
    });
  });

  describe('risk_tier_threshold', () => {
    it('should escalate when risk meets threshold', () => {
      const trigger = createTrigger('risk_tier_threshold', { minRiskTier: 'moderate' });
      const context = createContext({
        riskAssessment: { ...createContext().riskAssessment, overallTier: RiskTier.HIGH },
      });

      const result = engine.evaluate([trigger], context);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reasons[0]).toContain('high');
    });

    it('should not escalate when risk is below threshold', () => {
      const trigger = createTrigger('risk_tier_threshold', { minRiskTier: 'high' });
      const context = createContext({
        riskAssessment: { ...createContext().riskAssessment, overallTier: RiskTier.LOW },
      });

      const result = engine.evaluate([trigger], context);

      expect(result.shouldEscalate).toBe(false);
    });
  });

  describe('low_confidence', () => {
    it('should escalate when confidence is below minimum', () => {
      const trigger = createTrigger('low_confidence', { minConfidence: 'moderate' });
      const context = createContext({
        action: { ...createContext().action, confidence: ConfidenceLevel.LOW },
      });

      const result = engine.evaluate([trigger], context);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reasons[0]).toContain('low');
    });

    it('should not escalate when confidence meets minimum', () => {
      const trigger = createTrigger('low_confidence', { minConfidence: 'moderate' });
      const context = createContext({
        action: { ...createContext().action, confidence: ConfidenceLevel.HIGH },
      });

      const result = engine.evaluate([trigger], context);

      expect(result.shouldEscalate).toBe(false);
    });
  });

  describe('novel_situation', () => {
    it('should escalate when no matching preferences found', () => {
      const trigger = createTrigger('novel_situation', {});
      const context = createContext({ matchingPreferenceCount: 0 });

      const result = engine.evaluate([trigger], context);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reasons[0]).toContain('novel');
    });

    it('should not escalate when preferences exist', () => {
      const trigger = createTrigger('novel_situation', {});
      const context = createContext({ matchingPreferenceCount: 2 });

      const result = engine.evaluate([trigger], context);

      expect(result.shouldEscalate).toBe(false);
    });
  });

  describe('consecutive_rejections', () => {
    it('should escalate after N consecutive rejections', () => {
      const trigger = createTrigger('consecutive_rejections', { count: 3 });
      const context = createContext({ consecutiveRejections: 4 });

      const result = engine.evaluate([trigger], context);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reasons[0]).toContain('4 consecutive rejections');
    });

    it('should not escalate below threshold', () => {
      const trigger = createTrigger('consecutive_rejections', { count: 3 });
      const context = createContext({ consecutiveRejections: 2 });

      const result = engine.evaluate([trigger], context);

      expect(result.shouldEscalate).toBe(false);
    });
  });

  describe('multiple triggers', () => {
    it('should collect all firing trigger reasons', () => {
      const triggers = [
        createTrigger('amount_threshold', { thresholdCents: 100 }, 't1'),
        createTrigger('risk_tier_threshold', { minRiskTier: 'low' }, 't2'),
      ];
      const context = createContext({
        action: { ...createContext().action, estimatedCostCents: 500 },
        riskAssessment: { ...createContext().riskAssessment, overallTier: RiskTier.MODERATE },
      });

      const result = engine.evaluate(triggers, context);

      expect(result.shouldEscalate).toBe(true);
      expect(result.reasons).toHaveLength(2);
      expect(result.triggeredBy).toEqual(['t1', 't2']);
    });

    it('should skip disabled triggers', () => {
      const triggers: EscalationTrigger[] = [
        { id: 't1', triggerType: 'novel_situation', conditions: {}, enabled: false },
      ];
      const context = createContext({ matchingPreferenceCount: 0 });

      const result = engine.evaluate(triggers, context);

      expect(result.shouldEscalate).toBe(false);
    });

    it('should return no escalation when all triggers pass', () => {
      const triggers = [
        createTrigger('amount_threshold', { thresholdCents: 10000 }),
        createTrigger('risk_tier_threshold', { minRiskTier: 'critical' }),
      ];
      const context = createContext();

      const result = engine.evaluate(triggers, context);

      expect(result.shouldEscalate).toBe(false);
      expect(result.reasons).toHaveLength(0);
    });
  });
});
