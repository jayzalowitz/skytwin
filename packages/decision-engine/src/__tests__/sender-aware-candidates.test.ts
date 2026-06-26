import { describe, it, expect } from 'vitest';
import {
  ConfidenceLevel,
  SituationType,
  type CandidateAction,
  type DecisionContext,
  type DecisionObject,
  type TwinProfile,
} from '@skytwin/shared-types';
import { SenderAwareCandidateGenerator } from '../strategies/sender-aware-candidates.js';
import type { DecisionMaker } from '../decision-maker.js';

/**
 * Build a minimal DecisionMaker double whose only relevant method is
 * `generateCandidates` — that's all the SenderAwareCandidateGenerator calls
 * on it. We don't want to construct the real DecisionMaker here because we'd
 * have to wire TwinService + PolicyEvaluator, which are not under test.
 */
function makeFakeDecisionMaker(): DecisionMaker {
  const fake = {
    generateCandidates(decision: DecisionObject): CandidateAction[] {
      return [
        {
          id: 'cand-archive',
          decisionId: decision.id,
          actionType: 'archive_email',
          description: 'Archive this email.',
          domain: 'email',
          parameters: { emailId: decision.rawData['emailId'], folder: 'archive' },
          estimatedCostCents: 0,
          reversible: true,
          confidence: ConfidenceLevel.HIGH,
          reasoning: 'rule-based fallback',
        },
        {
          id: 'cand-label',
          decisionId: decision.id,
          actionType: 'label_email',
          description: 'Label this email.',
          domain: 'email',
          parameters: { emailId: decision.rawData['emailId'], labels: ['inbox'] },
          estimatedCostCents: 0,
          reversible: true,
          confidence: ConfidenceLevel.MODERATE,
          reasoning: 'rule-based fallback',
        },
      ];
    },
  };
  return fake as unknown as DecisionMaker;
}

const PROFILE: TwinProfile = {
  id: 'p',
  userId: 'u',
  version: 1,
  preferences: [],
  inferences: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const CONTEXT: DecisionContext = {
  userId: 'u',
  decision: {} as DecisionObject,
  trustTier: 'moderate_autonomy' as DecisionContext['trustTier'],
  relevantPreferences: [],
  timestamp: new Date(),
  patterns: [],
  traits: [],
  temporalProfile: {
    userId: 'u',
    activeHours: { start: 8, end: 18 },
    peakResponseTimes: {},
    weekdayPatterns: {},
    urgencyThresholds: {},
  },
};

function makeEmailDecision(args: {
  from: string;
  subject?: string;
  text?: string;
  summary?: string;
}): DecisionObject {
  return {
    id: 'd-' + Math.random().toString(36).slice(2, 8),
    situationType: SituationType.EMAIL_TRIAGE,
    domain: 'email',
    urgency: 'medium',
    summary: args.summary ?? args.subject ?? '',
    rawData: {
      emailId: 'msg-1',
      from: args.from,
      subject: args.subject ?? '',
      text: args.text ?? '',
    },
    interpretedAt: new Date(),
  };
}

describe('SenderAwareCandidateGenerator — protected senders', () => {
  it('emits ONLY flag_for_manual_review for board-chair email (suppresses archive)', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision = makeEmailDecision({
      from: 'chair@beacon-board.example',
      subject: 'May meeting agenda',
    });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out).toHaveLength(1);
    expect(out[0]?.actionType).toBe('flag_for_manual_review');
    expect(out[0]?.reversible).toBe(false);
    expect(out[0]?.confidence).toBe(ConfidenceLevel.CONFIRMED);
    expect(out[0]?.reasoning).toMatch(/sender|protected/i);
    // CRITICAL: archive_email must NOT be in the candidate set for protected
    // senders. If it were, it would score higher than the irreversible flag
    // and auto-execute at MODERATE_AUTONOMY.
    expect(out.find((c) => c.actionType === 'archive_email')).toBeUndefined();
  });

  it('the manual-review flag carries the message id via the messageId fallback', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision: DecisionObject = {
      id: 'd-msgid',
      situationType: SituationType.EMAIL_TRIAGE,
      domain: 'email',
      urgency: 'medium',
      summary: 'May meeting agenda',
      // Real connectors store the id as messageId, not emailId.
      rawData: {
        messageId: 'msg-xyz',
        from: 'chair@beacon-board.example',
        subject: 'May meeting agenda',
      },
      interpretedAt: new Date(),
    };
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out[0]?.actionType).toBe('flag_for_manual_review');
    expect(out[0]?.parameters['emailId']).toBe('msg-xyz');
  });

  it('flags CFO email', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision = makeEmailDecision({ from: 'cfo@beacon.example', subject: 'Q2 forecast' });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out[0]?.actionType).toBe('flag_for_manual_review');
  });

  it('flags legal counsel email', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision = makeEmailDecision({ from: 'counsel@law-firm.example', subject: 'NDA' });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out[0]?.actionType).toBe('flag_for_manual_review');
  });

  it('flags investor email', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision = makeEmailDecision({
      from: 'partner@anchor-vc.example',
      subject: 'Following up',
    });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out[0]?.actionType).toBe('flag_for_manual_review');
  });
});

describe('SenderAwareCandidateGenerator — protected subject content', () => {
  it('flags an email about a term sheet even from an unfamiliar sender', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision = makeEmailDecision({
      from: 'unknown@example.com',
      subject: 'Updated draft term sheet for review',
    });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out[0]?.actionType).toBe('flag_for_manual_review');
    expect(out[0]?.reasoning).toMatch(/term/i);
  });

  it('flags an email about a wire transfer', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision = makeEmailDecision({
      from: 'noreply@bank.example',
      subject: 'Wire transfer scheduled',
      text: 'Confirm the wire transfer of $50,000',
    });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out[0]?.actionType).toBe('flag_for_manual_review');
  });

  it('flags content mentioning cap table', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision = makeEmailDecision({
      from: 'cofounder@example.com',
      subject: 'Updated cap table',
    });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out[0]?.actionType).toBe('flag_for_manual_review');
  });
});

describe('SenderAwareCandidateGenerator — passes through routine email', () => {
  it('newsletter from stratechery returns base candidates only', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision = makeEmailDecision({
      from: 'newsletter@stratechery.example',
      subject: 'Weekly digest',
    });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out.find((c) => c.actionType === 'flag_for_manual_review')).toBeUndefined();
    expect(out[0]?.actionType).toBe('archive_email');
  });

  it('routine reply-all chatter falls through', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision = makeEmailDecision({
      from: 'colleague@example.com',
      subject: 'Lunch tomorrow?',
    });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out.find((c) => c.actionType === 'flag_for_manual_review')).toBeUndefined();
  });
});

describe('SenderAwareCandidateGenerator — non-email situations passthrough', () => {
  it('CALENDAR_INVITE skips the protected-sender pre-pass', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker());
    const decision: DecisionObject = {
      id: 'd-cal',
      situationType: SituationType.CALENDAR_INVITE,
      domain: 'calendar',
      urgency: 'medium',
      summary: 'Board meeting invite', // would have flagged on subject
      rawData: { eventId: 'evt-1', from: 'chair@board.example' },
      interpretedAt: new Date(),
    };
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    // No flag candidate — calendar has its own irreversibility signals.
    expect(out.find((c) => c.actionType === 'flag_for_manual_review')).toBeUndefined();
  });
});

describe('SenderAwareCandidateGenerator — custom patterns', () => {
  it('respects a custom protected pattern', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker(), {
      protectedPattern: /\bauditor\b/i,
    });
    // Default would NOT flag this — only "auditor" is protected here
    const decision = makeEmailDecision({
      from: 'lead@auditor-firm.example',
      subject: 'Field work next week',
    });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out[0]?.actionType).toBe('flag_for_manual_review');
  });

  it('default board-pattern does not match a custom-patterned generator', async () => {
    const gen = new SenderAwareCandidateGenerator(makeFakeDecisionMaker(), {
      protectedPattern: /\bauditor\b/i,
      protectedSubjectPattern: /\baudit\b/i,
    });
    const decision = makeEmailDecision({
      from: 'chair@board.example', // not in custom pattern
      subject: 'May meeting',
    });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out.find((c) => c.actionType === 'flag_for_manual_review')).toBeUndefined();
  });
});
