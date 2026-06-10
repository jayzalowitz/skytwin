import { describe, it, expect } from 'vitest';
import { resolveLanguage, resolveTimezone, isNonEnglish } from '../locale.js';

describe('resolveLanguage (spec 12)', () => {
  it('returns the language when set, else falls back to en', () => {
    expect(resolveLanguage('es')).toBe('es');
    expect(resolveLanguage('ja-JP')).toBe('ja-JP');
    expect(resolveLanguage(null)).toBe('en');
    expect(resolveLanguage('')).toBe('en');
    expect(resolveLanguage('   ')).toBe('en');
  });
});

describe('resolveTimezone (spec 12)', () => {
  it('returns the tz when set without defaulting', () => {
    expect(resolveTimezone('America/New_York')).toEqual({
      timezone: 'America/New_York',
      defaulted: false,
    });
  });
  it('falls back to UTC and flags defaulted (caller logs a warning)', () => {
    expect(resolveTimezone(null)).toEqual({ timezone: 'UTC', defaulted: true });
    expect(resolveTimezone('')).toEqual({ timezone: 'UTC', defaulted: true });
  });
});

describe('isNonEnglish (spec 12)', () => {
  it('false for en variants (incl. unset → en)', () => {
    expect(isNonEnglish('en')).toBe(false);
    expect(isNonEnglish('en-US')).toBe(false);
    expect(isNonEnglish(null)).toBe(false);
  });
  it('true for non-English locales (routes to the LLM path)', () => {
    expect(isNonEnglish('es')).toBe(true);
    expect(isNonEnglish('ja-JP')).toBe(true);
    expect(isNonEnglish('zh-Hant')).toBe(true);
  });
});
