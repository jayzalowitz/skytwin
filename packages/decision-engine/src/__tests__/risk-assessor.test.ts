import { describe, it, expect } from 'vitest';
import { RiskAssessor } from '../risk-assessor.js';
import type { CandidateAction } from '@skytwin/shared-types';
import { ConfidenceLevel, RiskTier } from '@skytwin/shared-types';

function createAction(overrides?: Partial<CandidateAction>): CandidateAction {
  return {
    id: 'action_test',
    decisionId: 'dec_test',
    actionType: 'archive_email',
    description: 'Archive this email',
    domain: 'email',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.MODERATE,
    reasoning: 'Test action',
    ...overrides,
  };
}

describe('RiskAssessor', () => {
  const assessor = new RiskAssessor();

  describe('Overall risk assessment', () => {
    it('should assess a reversible, zero-cost action as negligible/low risk', () => {
      const action = createAction({
        actionType: 'archive_email',
        reversible: true,
        estimatedCostCents: 0,
      });

      const assessment = assessor.assess(action);

      expect(assessment.overallTier).toBe(RiskTier.NEGLIGIBLE);
      expect(assessment.actionId).toBe(action.id);
      expect(assessment.assessedAt).toBeInstanceOf(Date);
    });

    it('should assess an irreversible action as higher risk', () => {
      const action = createAction({
        actionType: 'delete_account',
        reversible: false,
        description: 'Delete user account permanently',
      });

      const assessment = assessor.assess(action);

      // Irreversible + delete = high risk
      expect(
        assessment.overallTier === RiskTier.MODERATE ||
        assessment.overallTier === RiskTier.HIGH,
      ).toBe(true);
    });

    it('should assess a high-cost action as elevated risk', () => {
      const action = createAction({
        actionType: 'purchase',
        estimatedCostCents: 15000, // $150
        description: 'Purchase subscription',
      });

      const assessment = assessor.assess(action);

      // High cost should elevate financial impact
      const financialDim = assessment.dimensions['financial_impact'];
      expect(financialDim).toBeDefined();
      expect(
        financialDim.tier === RiskTier.HIGH ||
        financialDim.tier === RiskTier.CRITICAL,
      ).toBe(true);
    });
  });

  describe('Reversibility dimension', () => {
    it('should mark reversible actions as negligible reversibility risk', () => {
      const action = createAction({ reversible: true });
      const dim = assessor.assessReversibility(action);
      expect(dim.tier).toBe(RiskTier.NEGLIGIBLE);
    });

    it('should mark irreversible delete actions as high reversibility risk', () => {
      const action = createAction({
        actionType: 'delete_emails',
        reversible: false,
        description: 'Delete all archived emails',
      });
      const dim = assessor.assessReversibility(action);
      expect(dim.tier).toBe(RiskTier.HIGH);
    });

    it('should mark irreversible send actions as moderate reversibility risk', () => {
      const action = createAction({
        actionType: 'send_reply',
        reversible: false,
        description: 'Send a reply email',
      });
      const dim = assessor.assessReversibility(action);
      expect(dim.tier).toBe(RiskTier.MODERATE);
    });
  });

  describe('Financial impact dimension', () => {
    it('should mark zero-cost actions as negligible', () => {
      const action = createAction({ estimatedCostCents: 0 });
      const dim = assessor.assessFinancialImpact(action);
      expect(dim.tier).toBe(RiskTier.NEGLIGIBLE);
    });

    it('should mark small cost as low risk', () => {
      const action = createAction({ estimatedCostCents: 300 });
      const dim = assessor.assessFinancialImpact(action);
      expect(dim.tier).toBe(RiskTier.LOW);
    });

    it('should mark moderate cost as moderate risk', () => {
      const action = createAction({ estimatedCostCents: 2000 });
      const dim = assessor.assessFinancialImpact(action);
      expect(dim.tier).toBe(RiskTier.MODERATE);
    });

    it('should mark high cost as high risk', () => {
      const action = createAction({ estimatedCostCents: 8000 });
      const dim = assessor.assessFinancialImpact(action);
      expect(dim.tier).toBe(RiskTier.HIGH);
    });

    it('should mark very high cost as critical risk', () => {
      const action = createAction({ estimatedCostCents: 50000 });
      const dim = assessor.assessFinancialImpact(action);
      expect(dim.tier).toBe(RiskTier.CRITICAL);
    });
  });

  describe('Legal sensitivity dimension', () => {
    it('should detect legal keywords', () => {
      const action = createAction({
        actionType: 'sign_contract',
        description: 'Sign the binding legal agreement with liability terms',
      });
      const dim = assessor.assessLegalSensitivity(action);
      expect(
        dim.tier === RiskTier.MODERATE || dim.tier === RiskTier.HIGH,
      ).toBe(true);
    });

    it('should mark non-legal actions as negligible', () => {
      const action = createAction({
        actionType: 'archive_email',
        description: 'Move email to archive',
      });
      const dim = assessor.assessLegalSensitivity(action);
      expect(dim.tier).toBe(RiskTier.NEGLIGIBLE);
    });
  });

  describe('Privacy sensitivity dimension', () => {
    it('should detect privacy-sensitive actions', () => {
      const action = createAction({
        actionType: 'share_personal_data',
        description: 'Share personal confidential information with third party',
      });
      const dim = assessor.assessPrivacySensitivity(action);
      expect(
        dim.tier === RiskTier.MODERATE || dim.tier === RiskTier.HIGH,
      ).toBe(true);
    });

    it('should mark non-privacy actions as negligible', () => {
      const action = createAction({
        actionType: 'archive_email',
        description: 'Archive newsletter',
      });
      const dim = assessor.assessPrivacySensitivity(action);
      expect(dim.tier).toBe(RiskTier.NEGLIGIBLE);
    });
  });

  describe('Relationship sensitivity dimension', () => {
    it('should detect relationship-negative actions', () => {
      const action = createAction({
        actionType: 'decline_invite',
        description: 'Decline the meeting invitation',
      });
      const dim = assessor.assessRelationshipSensitivity(action);
      expect(dim.tier).not.toBe(RiskTier.NEGLIGIBLE);
    });

    it('should mark positive actions as negligible', () => {
      const action = createAction({
        actionType: 'accept_invite',
        description: 'Accept and confirm meeting',
      });
      const dim = assessor.assessRelationshipSensitivity(action);
      expect(dim.tier).toBe(RiskTier.NEGLIGIBLE);
    });
  });

  describe('Operational risk dimension', () => {
    it('should detect operational risk keywords', () => {
      const action = createAction({
        actionType: 'deploy_config_update',
        description: 'Deploy new configuration settings with permission changes',
      });
      const dim = assessor.assessOperationalRisk(action);
      expect(
        dim.tier === RiskTier.LOW ||
        dim.tier === RiskTier.MODERATE ||
        dim.tier === RiskTier.HIGH,
      ).toBe(true);
    });
  });
});
