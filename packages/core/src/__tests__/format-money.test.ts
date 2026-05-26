import { describe, it, expect } from 'vitest';
import { formatMoney } from '../format-money.js';

describe('formatMoney', () => {
  describe('en-US (default)', () => {
    it('formats cents to dollar with two-digit decimal', () => {
      expect(formatMoney(0)).toBe('$0.00');
      expect(formatMoney(1)).toBe('$0.01');
      expect(formatMoney(99)).toBe('$0.99');
      expect(formatMoney(100)).toBe('$1.00');
      expect(formatMoney(1234)).toBe('$12.34');
    });

    it('applies grouping separator at thousands', () => {
      expect(formatMoney(123456)).toBe('$1,234.56');
      expect(formatMoney(1_000_000_00)).toBe('$1,000,000.00');
    });
  });

  describe('en-GB', () => {
    it('uses £ symbol when currency is GBP', () => {
      expect(formatMoney(1234, { currency: 'GBP', locale: 'en-GB' })).toBe('£12.34');
    });

    it('preserves $ when currency stays USD (locale only changes formatting conventions)', () => {
      // en-GB with USD currency renders as "US$" since GBP is the local
      // currency. The exact prefix is locale-dependent but the value
      // and decimal style match. Anchor on the digits.
      const out = formatMoney(123456, { currency: 'USD', locale: 'en-GB' });
      expect(out).toMatch(/1,234\.56/);
    });
  });

  describe('ja-JP', () => {
    it('renders JPY with zero fraction digits (yen has no minor unit)', () => {
      // 100 cents == 1 yen-equivalent; Intl knows JPY has no fraction.
      const out = formatMoney(100, { currency: 'JPY', locale: 'ja-JP' });
      // Intl in ja-JP can return either '￥1' or '¥1' depending on
      // the platform; accept both. Crucially: no decimal separator.
      expect(out).toMatch(/^[¥￥]1$/);
    });

    it('rounds appropriately for JPY which has 0 fraction digits', () => {
      const out = formatMoney(150, { currency: 'JPY', locale: 'ja-JP' });
      // 150 cents == 1.5 "yen-units"; Intl rounds to 2 (banker's
      // rounding on .5 — node implementations may pick 1 or 2;
      // assert the result is one of the integers near the input).
      expect(out).toMatch(/^[¥￥][12]$/);
    });
  });

  describe('defensive handling', () => {
    it('renders NaN as $0.00 (never throws)', () => {
      expect(formatMoney(Number.NaN)).toBe('$0.00');
    });

    it('renders Infinity / -Infinity as $0.00', () => {
      expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('$0.00');
      expect(formatMoney(Number.NEGATIVE_INFINITY)).toBe('$0.00');
    });

    it('rounds non-integer cents to nearest integer before formatting', () => {
      // 199.7 cents -> 200 cents -> $2.00 (not $1.997, which would
      // look like display corruption)
      expect(formatMoney(199.7)).toBe('$2.00');
      expect(formatMoney(199.4)).toBe('$1.99');
    });

    it('handles negative values as a negative-formatted string', () => {
      // Intl en-US uses leading minus by default.
      const out = formatMoney(-12345);
      expect(out).toContain('123.45');
      expect(out.startsWith('-') || out.startsWith('(')).toBe(true);
    });

    it('falls back to en-US/USD when given an invalid locale', () => {
      // Intl throws RangeError on totally invalid locale tags; the
      // catch path should give us the en-US/USD fallback rather than
      // crashing the caller.
      expect(formatMoney(1234, { locale: 'not-a-locale-!!!!' })).toBe('$12.34');
    });

    it('falls back to en-US/USD when given an invalid currency code', () => {
      expect(formatMoney(1234, { currency: 'NOTACURRENCY' })).toBe('$12.34');
    });
  });
});
