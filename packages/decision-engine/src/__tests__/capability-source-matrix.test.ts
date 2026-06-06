import { describe, it, expect } from 'vitest';
import {
  capabilityCoversSource,
  sourcesForCapability,
  CAPABILITY_SOURCE_MATRIX,
} from '../capability-source-matrix.js';

describe('capability×source matrix (spec 07 AC6 / spec 02 AC matrix)', () => {
  it('commitments run on authored channels (mail, calendar, voice) but NOT filesystem', () => {
    expect(capabilityCoversSource('commitments', 'gmail')).toBe(true);
    expect(capabilityCoversSource('commitments', 'google_calendar')).toBe(true);
    expect(capabilityCoversSource('commitments', 'voice')).toBe(true);
    expect(capabilityCoversSource('commitments', 'filesystem')).toBe(false);
  });

  it('deadlines run on every text source including filesystem TODOs', () => {
    for (const s of ['gmail', 'google_calendar', 'filesystem', 'voice', 'email', 'calendar']) {
      expect(capabilityCoversSource('deadlines', s)).toBe(true);
    }
  });

  it('security alerts are inbound-mail only (off for calendar/filesystem/voice by design)', () => {
    expect(capabilityCoversSource('security', 'gmail')).toBe(true);
    expect(capabilityCoversSource('security', 'email')).toBe(true);
    expect(capabilityCoversSource('security', 'google_calendar')).toBe(false);
    expect(capabilityCoversSource('security', 'filesystem')).toBe(false);
    expect(capabilityCoversSource('security', 'voice')).toBe(false);
  });

  it('clusters and entities are source-agnostic (every text source)', () => {
    for (const s of ['gmail', 'google_calendar', 'filesystem', 'voice']) {
      expect(capabilityCoversSource('clusters', s)).toBe(true);
      expect(capabilityCoversSource('entities', s)).toBe(true);
    }
  });

  it('unknown source is never covered (fail safe)', () => {
    expect(capabilityCoversSource('commitments', 'slack')).toBe(false);
    expect(capabilityCoversSource('deadlines', 'unknown')).toBe(false);
    expect(capabilityCoversSource('security', '')).toBe(false);
  });

  it('every capability has a non-empty allowlist and mock sources mirror real ones', () => {
    for (const cap of Object.keys(CAPABILITY_SOURCE_MATRIX) as Array<
      keyof typeof CAPABILITY_SOURCE_MATRIX
    >) {
      expect(sourcesForCapability(cap).length).toBeGreaterThan(0);
      // gmail<->email and google_calendar<->calendar parity
      expect(capabilityCoversSource(cap, 'gmail')).toBe(capabilityCoversSource(cap, 'email'));
      expect(capabilityCoversSource(cap, 'google_calendar')).toBe(
        capabilityCoversSource(cap, 'calendar'),
      );
    }
  });
});
