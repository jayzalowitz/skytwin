// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseLifebookRoute,
  renderImportanceControl,
  formatOverrideExpiry,
} from './lifebook.js';

/**
 * #321: unit tests for the Lifebook detail page promote/demote ceremony
 * controls. These cover the pure render/parse helpers — the parts that
 * decide which tier button is active, how the "set by you" override line
 * renders, and the override-expiry formatting (including its fallback on
 * garbage input). The delegated click handler + network calls are
 * covered by the API-side route tests in
 * `apps/api/src/__tests__/lifebook-importance-routes.test.ts`.
 */

beforeEach(() => {
  // Reset the hash gate used by parseLifebookRoute.
  globalThis.window.location.hash = '';
});

describe('parseLifebookRoute', () => {
  it('extracts a domain name from a #/lifebook/<domain> hash', () => {
    globalThis.window.location.hash = '#/lifebook/Aging%20Parents';
    expect(parseLifebookRoute()).toBe('Aging Parents');
  });

  it('returns null for a non-lifebook route', () => {
    globalThis.window.location.hash = '#/dashboard';
    expect(parseLifebookRoute()).toBeNull();
  });

  it('strips a query string before matching', () => {
    globalThis.window.location.hash = '#/lifebook/Health?from=card';
    expect(parseLifebookRoute()).toBe('Health');
  });
});

describe('renderImportanceControl — #321 promote/demote', () => {
  const baseLb = {
    domainName: 'Health',
    importance: 'secondary',
    importanceOverride: null,
  };

  it('renders three tier buttons and marks the current tier disabled/pressed', () => {
    const html = renderImportanceControl(baseLb);
    // Three set-importance buttons, one per tier.
    const matches = html.match(/data-action="set-importance"/g) ?? [];
    expect(matches.length).toBe(3);
    // Each tier carries its data-importance value.
    expect(html).toContain('data-importance="core"');
    expect(html).toContain('data-importance="secondary"');
    expect(html).toContain('data-importance="emerging"');
    // The current tier (secondary) is the disabled, pressed, primary one.
    expect(html).toMatch(
      /class="btn btn-primary btn-sm" data-action="set-importance" data-domain="Health" data-importance="secondary" aria-pressed="true" disabled/,
    );
    // Non-current tiers are outline buttons and NOT disabled.
    expect(html).toMatch(
      /class="btn btn-outline btn-sm" data-action="set-importance" data-domain="Health" data-importance="core"(?!.*disabled)/,
    );
  });

  it('shows the auto-detected hint and no Clear button when there is no override', () => {
    const html = renderImportanceControl(baseLb);
    expect(html).toContain('Auto-detected by your weekly review');
    expect(html).not.toContain('data-action="clear-importance"');
  });

  it('shows "Set by you" + a Clear button when an override is in effect', () => {
    const html = renderImportanceControl({
      ...baseLb,
      importance: 'core',
      importanceOverride: { value: 'core', setAt: '2026-06-01T00:00:00Z', decayDays: 90 },
    });
    expect(html).toContain('Set by you');
    expect(html).toContain('data-action="clear-importance"');
    expect(html).toContain('data-domain="Health"');
    // 90-day window → it shows a reset date, not the never-clear copy.
    expect(html).toContain('resets');
    expect(html).not.toContain('stays until you clear it');
  });

  it('describes a decayDays=0 override as sticking until cleared', () => {
    const html = renderImportanceControl({
      ...baseLb,
      importance: 'emerging',
      importanceOverride: { value: 'emerging', setAt: '2026-06-01T00:00:00Z', decayDays: 0 },
    });
    expect(html).toContain('stays until you clear it');
    expect(html).not.toContain('resets');
  });

  it('escapes the domain name in the rendered control (no raw injection)', () => {
    const html = renderImportanceControl({
      domainName: '<img src=x>',
      importance: 'core',
      importanceOverride: null,
    });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img src=x&gt;');
  });
});

describe('formatOverrideExpiry', () => {
  it('returns setAt + decayDays as a locale date', () => {
    const out = formatOverrideExpiry({ setAt: '2026-06-01T00:00:00Z', decayDays: 90 });
    // 2026-06-01 + 90 days ≈ 2026-08-30. Don't pin the exact locale
    // string; just assert it parsed to a real date in the right year.
    expect(out).not.toBe('soon');
    expect(out).toMatch(/2026/);
  });

  it('falls back to "soon" on an invalid setAt', () => {
    expect(formatOverrideExpiry({ setAt: 'not-a-date', decayDays: 90 })).toBe('soon');
  });

  it('falls back to "soon" when the override is missing fields', () => {
    expect(formatOverrideExpiry({})).toBe('soon');
  });
});
