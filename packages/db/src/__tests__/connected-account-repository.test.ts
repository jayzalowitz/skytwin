import { describe, expect, it } from 'vitest';
import {
  canonicalizeScopes,
  digestProviderSubject,
} from '../repositories/connected-account-repository.js';

describe('connected account identity normalization', () => {
  it('trims Google subjects while preserving their opaque case semantics', () => {
    expect(digestProviderSubject(' GOOGLE ', ' 12345 ')).toBe(
      digestProviderSubject('google', '12345'),
    );
    expect(digestProviderSubject('google', 'ABC')).not.toBe(
      digestProviderSubject('google', 'abc'),
    );
  });

  it('normalizes Microsoft GUID case', () => {
    expect(digestProviderSubject('microsoft', 'ABC-123')).toBe(
      digestProviderSubject('MICROSOFT', 'abc-123'),
    );
  });

  it('deduplicates, trims, and sorts scopes deterministically', () => {
    expect(canonicalizeScopes([' z ', 'a', 'z', ''])).toEqual(['a', 'z']);
  });

  it('rejects malformed subjects before identity persistence', () => {
    expect(() => digestProviderSubject('google', ' ')).toThrow(/bounded/);
    expect(() => digestProviderSubject('google', 'bad\u0000subject')).toThrow(/bounded/);
    expect(() => digestProviderSubject('google', 'x'.repeat(513))).toThrow(/bounded/);
  });
});
