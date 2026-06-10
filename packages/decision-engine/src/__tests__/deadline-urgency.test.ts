import { describe, it, expect } from 'vitest';
import { SituationInterpreter } from '../situation-interpreter.js';

const interp = new SituationInterpreter();
const DAY = 24 * 60 * 60 * 1000;

describe('deadline → urgency wiring (review #1/#2)', () => {
  it('a STALE deadline (already past relative to now) is NOT marked critical', async () => {
    const d = await interp.interpret({
      source: 'gmail',
      type: 'message',
      subject: 'Quick note',
      body: 'Please respond in 2 days.',
      timestamp: new Date(Date.now() - 60 * DAY), // written 60 days ago → deadline long past
      authoringTier: 'inbox_personal',
    });
    expect(d.urgency).not.toBe('critical');
    expect(d.urgency).toBe('low'); // falls through to EMAIL_TRIAGE default
  });

  it('a FAR-OUT deadline does not DOWNGRADE a type default below its baseline', async () => {
    const d = await interp.interpret({
      source: 'gmail',
      type: 'message',
      subject: 'Calendar invite: planning',
      body: 'Please confirm in 10 days.',
      timestamp: new Date(), // now → deadline ~10 days out (future)
      authoringTier: 'inbox_personal',
    });
    // CALENDAR_INVITE default is 'medium'; a far deadline must not make it 'low'.
    expect(d.urgency).toBe('medium');
  });

  it('a NEAR future deadline still escalates urgency', async () => {
    const d = await interp.interpret({
      source: 'gmail',
      type: 'message',
      subject: 'Heads up',
      body: 'Action needed in 2 hours.',
      timestamp: new Date(),
      authoringTier: 'inbox_personal',
    });
    expect(['high', 'critical']).toContain(d.urgency);
  });
});
