import { describe, it, expect } from 'vitest';
import { buildDigestItemDetail, provenanceLabel } from '../digest-detail.js';

describe('provenanceLabel (spec 14)', () => {
  it('maps known provenance to human labels', () => {
    expect(provenanceLabel('user_originated')).toBe('From you');
    expect(provenanceLabel('trusted_context')).toBe('From your twin');
    expect(provenanceLabel('untrusted_external')).toBe('Inbound — untrusted');
  });
  it('fails safe to the untrusted wording for unknown/absent', () => {
    expect(provenanceLabel(undefined)).toBe('Inbound — untrusted');
    expect(provenanceLabel('weird' as never)).toBe('Inbound — untrusted');
  });
});

describe('buildDigestItemDetail (spec 14)', () => {
  it('renders confidence 0..1 as a 0-100 integer, null when absent', () => {
    expect(buildDigestItemDetail({ confidence: 0.73, sourceRefs: [] }).confidencePct).toBe(73);
    expect(buildDigestItemDetail({ sourceRefs: [] }).confidencePct).toBeNull();
    // clamps out-of-range
    expect(buildDigestItemDetail({ confidence: 1.5, sourceRefs: [] }).confidencePct).toBe(100);
  });

  it('uses the deadline phrase as the urgency reason when present, else the default', () => {
    expect(buildDigestItemDetail({ deadlinePhrase: 'in 2 days', sourceRefs: [] }).urgencyReason).toBe(
      'Deadline: "in 2 days"',
    );
    expect(buildDigestItemDetail({ domain: 'email', sourceRefs: [] }).urgencyReason).toBe(
      'Default for email',
    );
  });

  it('humanizes why-not-auto-executed block reasons', () => {
    const d = buildDigestItemDetail({
      requiresApproval: true,
      blockedReasons: ['missing_write_scope:gmail.send', 'trust_tier:observer'],
      sourceRefs: [],
    });
    expect(d.whyNotAutoExecuted[0]).toMatch(/No permission granted.*gmail\.send/);
    expect(d.whyNotAutoExecuted[1]).toMatch(/trust level \(observer\)/);
  });

  it('gives a generic review reason when approval is required without specific codes', () => {
    expect(
      buildDigestItemDetail({ requiresApproval: true, sourceRefs: [] }).whyNotAutoExecuted,
    ).toEqual(['Set aside for your review']);
  });

  it('whyNotAutoExecuted is empty when the item would auto-run', () => {
    expect(buildDigestItemDetail({ requiresApproval: false, sourceRefs: [] }).whyNotAutoExecuted).toEqual([]);
  });

  it('passes through source refs and explanation', () => {
    const d = buildDigestItemDetail({
      sourceRefs: ['gmail:abc', 'voice:xyz'],
      explanation: 'Flagged urgent: "in 2 days"',
    });
    expect(d.sourceRefs).toEqual(['gmail:abc', 'voice:xyz']);
    expect(d.explanation).toBe('Flagged urgent: "in 2 days"');
  });
});
