import { describe, it, expect } from 'vitest';
import {
  CONSERVATIVE_AUTONOMY_DEFAULTS,
  parseAutonomySettings,
} from '../autonomy.js';
import type { AutonomySettings } from '../user.js';

describe('parseAutonomySettings', () => {
  it('round-trips every field of a fully populated settings object', () => {
    const stored: AutonomySettings = {
      maxSpendPerActionCents: 250,
      maxDailySpendCents: 2500,
      allowedDomains: ['email', 'calendar'],
      blockedDomains: ['finance'],
      requireApprovalForIrreversible: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      paused: true,
      pausedAt: '2026-08-27T10:00:00.000Z',
      pausedReason: 'Vacation',
      perAppOverrides: { 'app-x': { maxSpendPerActionCents: 5 } },
    };

    expect(parseAutonomySettings(stored)).toEqual(stored);
  });

  it('returns conservative defaults for a missing or non-object value', () => {
    for (const raw of [null, undefined, 0, '', 'nope', [], true]) {
      expect(parseAutonomySettings(raw)).toEqual({
        maxSpendPerActionCents: 0,
        maxDailySpendCents: 0,
        allowedDomains: [],
        blockedDomains: [],
        requireApprovalForIrreversible: true,
      });
    }
  });

  it('never hands back the shared defaults object itself', () => {
    // A caller mutating the result must not corrupt the module-level default
    // for every other caller.
    const parsed = parseAutonomySettings(null);
    expect(parsed).not.toBe(CONSERVATIVE_AUTONOMY_DEFAULTS);
    parsed.allowedDomains.push('email');
    expect(CONSERVATIVE_AUTONOMY_DEFAULTS.allowedDomains).toEqual([]);
  });

  it('falls back per-field for malformed types rather than coercing', () => {
    const parsed = parseAutonomySettings({
      maxSpendPerActionCents: '500',
      maxDailySpendCents: null,
      allowedDomains: 'email',
      requireApprovalForIrreversible: 'no',
      paused: 'yes',
      pausedAt: 12345,
      quietHoursStart: 7,
      perAppOverrides: ['nope'],
    });

    expect(parsed.maxSpendPerActionCents).toBe(0);
    expect(parsed.maxDailySpendCents).toBe(0);
    expect(parsed.allowedDomains).toEqual([]);
    expect(parsed.requireApprovalForIrreversible).toBe(true);
    expect(parsed.paused).toBeUndefined();
    expect(parsed.pausedAt).toBeUndefined();
    expect(parsed.quietHoursStart).toBeUndefined();
    expect(parsed.perAppOverrides).toBeUndefined();
  });

  it('drops non-string entries from the domain lists', () => {
    const parsed = parseAutonomySettings({
      allowedDomains: ['email', 42, null, 'calendar'],
      blockedDomains: [{ nope: true }, 'finance'],
    });

    expect(parsed.allowedDomains).toEqual(['email', 'calendar']);
    expect(parsed.blockedDomains).toEqual(['finance']);
  });

  it('honours an explicit `paused: false` instead of treating it as absent', () => {
    const parsed = parseAutonomySettings(
      { paused: false },
      { ...CONSERVATIVE_AUTONOMY_DEFAULTS, paused: true },
    );

    expect(parsed.paused).toBe(false);
  });

  it('applies a caller-supplied fallback for absent fields', () => {
    const fallback: AutonomySettings = {
      maxSpendPerActionCents: 10,
      maxDailySpendCents: 100,
      allowedDomains: ['email'],
      blockedDomains: ['finance'],
      requireApprovalForIrreversible: false,
      quietHoursStart: '23:00',
      quietHoursEnd: '06:00',
    };

    const parsed = parseAutonomySettings({ maxDailySpendCents: 999 }, fallback);

    expect(parsed.maxDailySpendCents).toBe(999);
    expect(parsed.maxSpendPerActionCents).toBe(10);
    expect(parsed.allowedDomains).toEqual(['email']);
    expect(parsed.requireApprovalForIrreversible).toBe(false);
    expect(parsed.quietHoursStart).toBe('23:00');
  });
});
