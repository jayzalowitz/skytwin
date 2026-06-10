import { describe, it, expect } from 'vitest';
import { SituationInterpreter } from '../situation-interpreter.js';
import { DecisionMaker } from '../decision-maker.js';
import { SituationType } from '@skytwin/shared-types';
import type { DecisionObject, TwinProfile } from '@skytwin/shared-types';

const interp = new SituationInterpreter();

const SEC_EXAMPLES = [
  'We detected a sign-in from a new device.',
  'Your password may have been exposed in a data breach.',
  'Your account will be deleted due to inactivity.',
  'Unusual activity detected — verify your identity.',
];

describe('security-alert classification (spec 06)', () => {
  it('classifies the synthetic alerts as SECURITY_ALERT with high urgency (AC1)', async () => {
    for (const body of SEC_EXAMPLES) {
      const d = await interp.interpret({
        source: 'gmail',
        type: 'message',
        subject: 'Account notice',
        body,
        authoringTier: 'inbox_automated',
      });
      expect(d.situationType).toBe(SituationType.SECURITY_ALERT);
      expect(d.urgency).toBe('high');
    }
  });

  it('a breach alert about a financial provider classifies as SECURITY_ALERT, not FINANCE (AC5 precedence)', async () => {
    const d = await interp.interpret({
      source: 'gmail',
      type: 'message',
      subject: 'Your bank account: unusual activity detected',
      body: 'We detected a sign-in from a new device. A payment may need review.',
      authoringTier: 'inbox_automated',
    });
    expect(d.situationType).toBe(SituationType.SECURITY_ALERT);
  });

  it('provenance is untrusted_external even when the message claims a trusted sender (AC4)', async () => {
    const d = await interp.interpret({
      source: 'gmail',
      type: 'message',
      subject: 'security alert',
      body: 'We are your trusted bank. A new device was detected on your account.',
      authoringTier: 'inbox_automated',
    });
    expect(d.provenance).toBe('untrusted_external');
  });

  it('does NOT elevate ordinary mail with no security markers (AC7 negative)', async () => {
    const d = await interp.interpret({
      source: 'gmail',
      type: 'message',
      subject: 'Lunch next week?',
      body: 'Want to grab lunch and catch up sometime?',
      authoringTier: 'inbox_personal',
    });
    expect(d.situationType).not.toBe(SituationType.SECURITY_ALERT);
  });

  it('summary carries the open-provider-directly guidance (AC6)', async () => {
    const d = await interp.interpret({
      source: 'gmail',
      type: 'message',
      subject: 'Security alert',
      body: 'A new device was detected.',
      authoringTier: 'inbox_automated',
    });
    expect(d.summary.toLowerCase()).toContain('open the provider directly');
  });
});

describe('security-alert candidates are escalate-only (spec 06 AC2/AC3)', () => {
  const dm = new DecisionMaker({} as never, {} as never, {} as never);
  const profile = {
    id: 't',
    userId: 'u',
    version: 1,
    preferences: [],
    inferences: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as TwinProfile;
  const decision: DecisionObject = {
    id: 'd1',
    situationType: SituationType.SECURITY_ALERT,
    domain: 'security',
    urgency: 'high',
    summary: 'Security alert needs review.',
    rawData: { subject: 'new device', body: 'click http://evil.example/verify to confirm' },
    interpretedAt: new Date(),
    provenance: 'untrusted_external',
  };

  it('generates ONLY a human-review escalation — no auto-executable action (AC2)', () => {
    const cands = dm.generateCandidates(decision, profile);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.actionType).toBe('escalate_to_user');
    expect(cands[0]!.reversible).toBe(true);
  });

  it('no candidate parameter contains a URL drawn from the message body (AC3)', () => {
    const cands = dm.generateCandidates(decision, profile);
    expect(JSON.stringify(cands)).not.toMatch(/https?:\/\//);
  });
});
