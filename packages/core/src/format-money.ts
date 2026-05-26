/**
 * Centralised money formatter (#395).
 *
 * Pre-fix the codebase had ~20 hand-rolled `(cents / 100).toFixed(2)`
 * call sites with hardcoded `$` prefixes — none of them locale-aware,
 * all of them subtly different on edge cases (NaN, negative, non-integer
 * cents). This helper is the single place that knows how to render
 * money for SkyTwin. The browser-side mirror lives at
 * `apps/web/public/js/format.js` and follows the same contract.
 *
 * Backed by `Intl.NumberFormat`, which both Node 20+ and every supported
 * browser implement natively — no extra dependency.
 *
 * Edge-case behavior (deliberately conservative):
 *   - NaN / Infinity / -Infinity → `'$0.00'` (default locale/currency) —
 *     never throw, never crash the calling render path. Money that
 *     can't be rendered is rendered as zero so the UI stays legible.
 *   - Non-integer cents are rounded to the nearest integer first, then
 *     formatted, so a stray float `199.7` doesn't surface as
 *     `$1.997` — that would look like a broken display.
 *   - Negative values round-trip through Intl so locales that wrap
 *     negatives in parens (en-US accounting style) keep working if
 *     a caller ever opts into that NumberFormat style.
 */

export interface FormatMoneyOptions {
  /** ISO 4217 currency code. Defaults to USD. */
  currency?: string;
  /** BCP 47 locale tag. Defaults to en-US. */
  locale?: string;
}

const DEFAULT_OPTS: Required<FormatMoneyOptions> = {
  currency: 'USD',
  locale: 'en-US',
};

export function formatMoney(cents: number, opts: FormatMoneyOptions = {}): string {
  const { currency, locale } = { ...DEFAULT_OPTS, ...opts };
  const safeCents = Number.isFinite(cents) ? Math.round(cents) : 0;
  const amount = safeCents / 100;
  // `style: 'currency'` automatically picks the right symbol, decimal
  // separator, and grouping for the given locale (en-US → "$1,000.00",
  // en-GB → "£1,000.00", ja-JP → "￥1,000" — JPY has zero fraction
  // digits by default, which is the correct behavior). Pin
  // currencyDisplay to 'symbol' so en-CA renders "$" not "CA$"
  // unless the caller explicitly passes a non-default currency.
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
    }).format(amount);
  } catch {
    // Bad locale tag or currency code — fall back to the plain
    // en-US format so the UI never breaks. Intl can throw RangeError
    // on truly invalid input; this catch is the last-ditch safety net.
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'symbol',
    }).format(amount);
  }
}
