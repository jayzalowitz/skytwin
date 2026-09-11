import { describe, expect, it } from 'vitest';
import { isDecisionBlockCode } from '../decision.js';

describe('isDecisionBlockCode', () => {
  it('accepts canonical policy/scope codes and rejects prose or unbounded input', () => {
    expect(isDecisionBlockCode('missing_write_scope:gmail.send')).toBe(true);
    expect(isDecisionBlockCode('trust_tier:observer')).toBe(true);
    expect(isDecisionBlockCode('policy_denied')).toBe(true);
    expect(isDecisionBlockCode('Write access is missing; user approval is required.')).toBe(false);
    expect(isDecisionBlockCode(`missing_write_scope:${'x'.repeat(600)}`)).toBe(false);
    expect(isDecisionBlockCode('missing_write_scope:')).toBe(false);
    expect(isDecisionBlockCode('missing_write_scope:<script>')).toBe(false);
    expect(isDecisionBlockCode('trust_tier:invented')).toBe(false);
    expect(isDecisionBlockCode({ code: 'missing_write_scope' })).toBe(false);
  });
});
