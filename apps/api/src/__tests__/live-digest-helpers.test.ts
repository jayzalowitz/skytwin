import { describe, it, expect, afterEach } from 'vitest';
import {
  needsYou,
  sourceLabel,
  normalizeUrgency,
  urgencyReasonFor,
  bareAddress,
  entityLinkingEnabled,
} from '../services/live-digest.js';

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

describe('normalizeUrgency', () => {
  it("maps the DB default 'normal' to 'medium', not 'low'", () => {
    expect(normalizeUrgency('normal')).toBe('medium');
  });

  it('passes through valid union values', () => {
    expect(normalizeUrgency('low')).toBe('low');
    expect(normalizeUrgency('medium')).toBe('medium');
    expect(normalizeUrgency('high')).toBe('high');
    expect(normalizeUrgency('critical')).toBe('critical');
  });

  it('falls back to low for null/unknown values', () => {
    expect(normalizeUrgency(null)).toBe('low');
    expect(normalizeUrgency('whatever')).toBe('low');
  });
});

describe('urgencyReasonFor', () => {
  it('gives the real driver for escalate-only / RSVP situations', () => {
    expect(urgencyReasonFor({ situation_type: 'security_alert', urgency: 'high' })).toMatch(/security alert/i);
    expect(urgencyReasonFor({ situation_type: 'calendar_invite', urgency: 'medium' })).toMatch(/rsvp/i);
  });

  it('describes the urgency level for other situations', () => {
    expect(urgencyReasonFor({ situation_type: 'email_triage', urgency: 'critical' })).toMatch(/urgent/i);
    expect(urgencyReasonFor({ situation_type: 'email_triage', urgency: 'low' })).toMatch(/routine/i);
  });

  it('never returns the generic "Default for" placeholder', () => {
    expect(urgencyReasonFor({ situation_type: 'email_triage', urgency: 'normal' })).not.toMatch(/default for/i);
  });
});

describe('bareAddress (pin/hide join key, #270/#485)', () => {
  it('extracts the bare address from a "Name <addr>" header', () => {
    expect(bareAddress('Acme Billing <Billing@Acme.com>')).toBe('billing@acme.com');
  });

  it('lowercases a plain address (matches the write-time normalization)', () => {
    expect(bareAddress('No-Reply@Example.COM')).toBe('no-reply@example.com');
  });

  it('returns null for empty / nullish input (no override applied)', () => {
    expect(bareAddress(null)).toBeNull();
    expect(bareAddress(undefined)).toBeNull();
    expect(bareAddress('   ')).toBeNull();
  });
});

describe('entityLinkingEnabled (spec 05, #478 rollback switch)', () => {
  afterEach(() => {
    delete process.env['ENTITY_LINKING'];
  });

  it('is ON by default (env unset)', () => {
    delete process.env['ENTITY_LINKING'];
    expect(entityLinkingEnabled()).toBe(true);
  });

  it('is OFF only for the exact rollback value "off"', () => {
    process.env['ENTITY_LINKING'] = 'off';
    expect(entityLinkingEnabled()).toBe(false);
  });

  it('stays ON for any other value (fail toward the shipped behavior)', () => {
    process.env['ENTITY_LINKING'] = 'on';
    expect(entityLinkingEnabled()).toBe(true);
    process.env['ENTITY_LINKING'] = '';
    expect(entityLinkingEnabled()).toBe(true);
  });
});
