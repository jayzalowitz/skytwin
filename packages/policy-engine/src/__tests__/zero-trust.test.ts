import { describe, it, expect } from 'vitest';
import { getEffectiveRiskModifier, applyZeroTrustOverride } from '../zero-trust.js';

// Minimal server stub — only the fields the helpers care about.
function makeServer(zero_trust_mode: boolean) {
  return { zero_trust_mode };
}

describe('getEffectiveRiskModifier', () => {
  it('returns 1 when zero_trust_mode is false', () => {
    expect(getEffectiveRiskModifier(makeServer(false))).toBe(1);
  });

  it('returns 2 when zero_trust_mode is true', () => {
    expect(getEffectiveRiskModifier(makeServer(true))).toBe(2);
  });

  it('delta is additive — enabled modifier is exactly 1 more than disabled', () => {
    const off = getEffectiveRiskModifier(makeServer(false));
    const on  = getEffectiveRiskModifier(makeServer(true));
    expect(on - off).toBe(1);
  });
});

describe('applyZeroTrustOverride', () => {
  it('returns null when zero_trust_mode is false', () => {
    expect(applyZeroTrustOverride(makeServer(false))).toBeNull();
  });

  it('returns a requiresApproval decision when zero_trust_mode is true', () => {
    const decision = applyZeroTrustOverride(makeServer(true));
    expect(decision).not.toBeNull();
    expect(decision?.allowed).toBe(true);
    expect(decision?.requiresApproval).toBe(true);
  });

  it('zero-trust override reason mentions zero-trust and explicit approval', () => {
    const decision = applyZeroTrustOverride(makeServer(true));
    expect(decision?.reason.toLowerCase()).toContain('zero-trust');
    expect(decision?.reason.toLowerCase()).toContain('approval');
  });
});
