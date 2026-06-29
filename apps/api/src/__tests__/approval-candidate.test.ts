import { describe, it, expect } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type { CandidateAction } from '@skytwin/shared-types';
import { serializeApprovalCandidate } from '../routes/approval-candidate.js';

const action: CandidateAction = {
  id: 'act-1',
  decisionId: 'dec-1',
  actionType: 'send_email',
  description: 'Send',
  domain: 'email',
  parameters: { secret: 'x' },
  estimatedCostCents: 0,
  costZeroIntent: 'unknown',
  provenance: 'untrusted_external',
  reversible: false,
  confidence: ConfidenceLevel.LOW,
  reasoning: 'r',
};

describe('serializeApprovalCandidate', () => {
  it('carries the safety flags + id so they survive the approval round-trip', () => {
    const out = serializeApprovalCandidate(action, { visible: true });
    // costZeroIntent must NOT be dropped — an absent value reloads as verified_zero.
    expect(out.costZeroIntent).toBe('unknown');
    expect(out.provenance).toBe('untrusted_external');
    expect(out.id).toBe('act-1'); // #371 risk-assessment linkage
    expect(out.parameters).toEqual({ visible: true }); // uses the passed (redacted) params
    expect(out.estimatedCostCents).toBe(0);
  });

  it('passes an explicit verified_zero through unchanged', () => {
    const out = serializeApprovalCandidate({ ...action, costZeroIntent: 'verified_zero' }, {});
    expect(out.costZeroIntent).toBe('verified_zero');
  });
});
