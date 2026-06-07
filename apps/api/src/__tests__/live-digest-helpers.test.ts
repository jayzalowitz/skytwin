import { describe, it, expect } from 'vitest';
import { needsYou, sourceLabel } from '../services/live-digest.js';

/**
 * The to-do/FYI split (spec 01) and source labels (spec 07) that drive the
 * live digest. Pure logic — guarded here so the classification can't silently
 * drift (e.g. a security alert quietly dropping out of the to-do bucket).
 */
describe('needsYou (to-do bucket classification)', () => {
  const row = (over: Partial<Parameters<typeof needsYou>[0]>) => ({
    requires_approval: false,
    situation_type: 'email_triage',
    urgency: 'low',
    ...over,
  });

  it('is a to-do when the engine escalated it for approval', () => {
    expect(needsYou(row({ requires_approval: true }))).toBe(true);
  });

  it('is a to-do for a security alert (escalate-only, spec 06)', () => {
    expect(needsYou(row({ situation_type: 'security_alert' }))).toBe(true);
  });

  it('is a to-do for a new calendar invite (needs RSVP)', () => {
    expect(needsYou(row({ situation_type: 'calendar_invite' }))).toBe(true);
  });

  it('is a to-do when urgency is high or critical', () => {
    expect(needsYou(row({ urgency: 'high' }))).toBe(true);
    expect(needsYou(row({ urgency: 'critical' }))).toBe(true);
  });

  it('is FYI (not a to-do) for routine low/medium items', () => {
    expect(needsYou(row({}))).toBe(false);
    expect(needsYou(row({ urgency: 'medium' }))).toBe(false);
    expect(needsYou(row({ situation_type: 'calendar_update', urgency: 'medium' }))).toBe(false);
  });

  it('treats a null requires_approval as not-escalated', () => {
    expect(needsYou(row({ requires_approval: null }))).toBe(false);
  });
});

describe('sourceLabel', () => {
  it('maps connector channels to digest source labels', () => {
    expect(sourceLabel('gmail')).toBe('email');
    expect(sourceLabel('email')).toBe('email');
    expect(sourceLabel('google_calendar')).toBe('calendar');
    expect(sourceLabel('calendar')).toBe('calendar');
    expect(sourceLabel('filesystem')).toBe('file');
    expect(sourceLabel('voice')).toBe('voice');
  });

  it('falls back to the raw source, or "app" when empty', () => {
    expect(sourceLabel('slack')).toBe('slack');
    expect(sourceLabel('')).toBe('app');
  });
});
