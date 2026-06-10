import { describe, it, expect } from 'vitest';
import { describePreference } from '../routes/twin.js';

/**
 * Render hardening: describePreference must never emit "[object Object]" for a
 * structured preference value (the dashboard "What I've learned" summaries go
 * straight to the user). Regression guard for the Home-page bug where a
 * brand-preference object rendered as "[object Object]".
 */
describe('describePreference', () => {
  it('renders an object value readably, never "[object Object]"', () => {
    const out = describePreference('shopping', 'brand_preference', {
      category: 'electronics',
      preferred: ['Apple', 'Sony'],
    });
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('electronics');
    expect(out).toContain('Apple');
    expect(out).toContain('Sony');
  });

  it('renders an array value as a joined list', () => {
    const out = describePreference('shopping', 'favorites', ['Apple', 'Sony']);
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('Apple, Sony');
  });

  it('renders nested objects without "[object Object]"', () => {
    const out = describePreference('travel', 'rules', { seat: { window: true } });
    expect(out).not.toContain('[object Object]');
  });

  it('renders booleans as enabled/disabled', () => {
    expect(describePreference('calendar', 'morning_person', true)).toContain('enabled');
    expect(describePreference('calendar', 'morning_person', false)).toContain('disabled');
  });

  it('surfaces a free-form string preference directly', () => {
    expect(describePreference('email', 'tone', 'concise')).toBe('Email: concise');
  });

  it('includes the key for a numeric preference', () => {
    expect(describePreference('scheduling', 'meeting_buffer', 15)).toContain('15');
    expect(describePreference('scheduling', 'meeting_buffer', 15)).toContain('meeting buffer');
  });

  it('returns null for null/undefined/empty values', () => {
    expect(describePreference('email', 'x', null)).toBeNull();
    expect(describePreference('email', 'x', undefined)).toBeNull();
    expect(describePreference('email', 'x', '')).toBeNull();
  });
});
