/**
 * Centralised money formatter (#395).
 *
 * Browser-side mirror of `packages/core/src/format-money.ts` — same
 * contract, same defensive behaviour, same defaults. Kept in lockstep
 * by convention; the package's vitest suite is the canonical test bed.
 *
 * Use it instead of inline `(cents / 100).toFixed(2)` so spend
 * formatting stays consistent across the dashboard and i18n is a
 * single-callsite change in the future.
 */

const DEFAULT_LOCALE = 'en-US';
const DEFAULT_CURRENCY = 'USD';

/**
 * Render an integer-cents value as a locale-aware currency string.
 *
 * @param {number} cents
 * @param {{ currency?: string, locale?: string }} [opts]
 * @returns {string}
 */
export function formatMoney(cents, opts = {}) {
  const currency = opts.currency || DEFAULT_CURRENCY;
  const locale = opts.locale || DEFAULT_LOCALE;
  const safeCents = Number.isFinite(cents) ? Math.round(cents) : 0;
  const amount = safeCents / 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
    }).format(amount);
  } catch {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'symbol',
    }).format(amount);
  }
}
