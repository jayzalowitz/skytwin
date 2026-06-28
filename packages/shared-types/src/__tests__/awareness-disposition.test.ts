import { afterEach, describe, expect, it } from 'vitest';
import {
  AWARENESS_TIERS,
  PASSIVE_AWARENESS_ACTIONS,
  awarenessDispositionGateEnabled,
  isPassiveAwarenessShape,
} from '../awareness-disposition.js';

describe('isPassiveAwarenessShape', () => {
  const base = {
    actionType: 'create_note',
    reversible: true,
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero' as const,
  };

  it('is true for a passive, reversible, verified-free action', () => {
    expect(isPassiveAwarenessShape(base)).toBe(true);
    for (const actionType of PASSIVE_AWARENESS_ACTIONS) {
      expect(isPassiveAwarenessShape({ ...base, actionType })).toBe(true);
    }
  });

  it('is false for a non-passive action type', () => {
    expect(isPassiveAwarenessShape({ ...base, actionType: 'draft_email' })).toBe(false);
    expect(isPassiveAwarenessShape({ ...base, actionType: 'send_reply' })).toBe(false);
    expect(isPassiveAwarenessShape({ ...base, actionType: 'schedule_meeting' })).toBe(false);
  });

  it('is false for an irreversible action', () => {
    expect(isPassiveAwarenessShape({ ...base, reversible: false })).toBe(false);
  });

  it('is false for a costed action', () => {
    expect(isPassiveAwarenessShape({ ...base, estimatedCostCents: 5 })).toBe(false);
  });

  it('is false when zero cost is unverified (costZeroIntent="unknown")', () => {
    // The cost gate escalates these without a confirmation level, so they must
    // not be silently disposed.
    expect(isPassiveAwarenessShape({ ...base, costZeroIntent: 'unknown' })).toBe(false);
  });

  it('treats a missing cost as zero', () => {
    expect(
      isPassiveAwarenessShape({ actionType: 'create_note', reversible: true, costZeroIntent: 'verified_zero' }),
    ).toBe(true);
  });

  it('exposes the awareness authoring tiers without human inbound', () => {
    expect(AWARENESS_TIERS.has('inbox_newsletter')).toBe(true);
    expect(AWARENESS_TIERS.has('inbox_automated')).toBe(true);
    expect(AWARENESS_TIERS.has('user_sent_originated')).toBe(true);
    // Human inbound must NOT be an awareness tier — it stays an approval.
    expect(AWARENESS_TIERS.has('inbox_personal')).toBe(false);
    expect(AWARENESS_TIERS.has('inbox_broadcast')).toBe(false);
  });
});

describe('awarenessDispositionGateEnabled', () => {
  const prev = process.env['AWARENESS_DISPOSITION_GATE'];
  afterEach(() => {
    if (prev === undefined) delete process.env['AWARENESS_DISPOSITION_GATE'];
    else process.env['AWARENESS_DISPOSITION_GATE'] = prev;
  });

  it('is off by default and only "on" enables it', () => {
    delete process.env['AWARENESS_DISPOSITION_GATE'];
    expect(awarenessDispositionGateEnabled()).toBe(false);
    process.env['AWARENESS_DISPOSITION_GATE'] = 'off';
    expect(awarenessDispositionGateEnabled()).toBe(false);
    process.env['AWARENESS_DISPOSITION_GATE'] = 'true';
    expect(awarenessDispositionGateEnabled()).toBe(false);
    process.env['AWARENESS_DISPOSITION_GATE'] = 'on';
    expect(awarenessDispositionGateEnabled()).toBe(true);
  });
});
