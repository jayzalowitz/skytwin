import { describe, it, expect } from 'vitest';
import { normalizeSenderAddress } from '../email-normalize.js';

// `normalizeSenderAddress` lives in @skytwin/core specifically because the
// Gmail connector uses it on the WRITE side (recording per-sender label
// observations) and the decision engine uses it on the READ side (looking
// those observations up). Any divergence between the two would cause every
// per-sender label query to silently miss. Having one canonical implementation
// removes that hazard. Issue #122 follow-up.
describe('normalizeSenderAddress', () => {
  it('strips display name from "Name <addr>"', () => {
    expect(normalizeSenderAddress('Black Rock Rangers <rangers@blackrockrangers.org>'))
      .toBe('rangers@blackrockrangers.org');
  });

  it('lowercases the address', () => {
    expect(normalizeSenderAddress('rangers@BlackRockRangers.ORG'))
      .toBe('rangers@blackrockrangers.org');
  });

  it('returns the bare address unchanged when no angle brackets', () => {
    expect(normalizeSenderAddress('  alice@example.com  '))
      .toBe('alice@example.com');
  });

  it('returns "" for inputs without an @ (poisoning guard)', () => {
    expect(normalizeSenderAddress('not an email')).toBe('');
    expect(normalizeSenderAddress('')).toBe('');
    expect(normalizeSenderAddress('   ')).toBe('');
  });

  it('handles malformed angle brackets without throwing', () => {
    expect(normalizeSenderAddress('Name <bad>')).toBe('');
    expect(normalizeSenderAddress('<>')).toBe('');
  });

  it('handles non-string inputs (read-side passes raw rawData[from])', () => {
    expect(normalizeSenderAddress(undefined)).toBe('');
    expect(normalizeSenderAddress(null)).toBe('');
    expect(normalizeSenderAddress(42)).toBe('');
    expect(normalizeSenderAddress({ from: 'a@b.com' })).toBe('');
  });

  it('keeps the address when display name has @ in it (real-world)', () => {
    // Some Gmail clients put the email address as the display name too.
    // Regex prefers the angle-bracketed form.
    expect(normalizeSenderAddress('"alice@old.com" <alice@new.com>'))
      .toBe('alice@new.com');
  });

  it('round-trips with itself (idempotent)', () => {
    const once = normalizeSenderAddress('Foo <FOO@Example.org>');
    const twice = normalizeSenderAddress(once);
    expect(twice).toBe(once);
  });
});
