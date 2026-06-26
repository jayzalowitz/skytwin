import { describe, it, expect, afterEach } from 'vitest';
import {
  SituationType,
  ConfidenceLevel,
  type DecisionObject,
  type DecisionOutcome,
  type CandidateAction,
} from '@skytwin/shared-types';
import {
  isAwarenessOnly,
  awarenessDispositionGateEnabled,
} from '../awareness-disposition.js';

function action(over: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'a1',
    decisionId: 'd1',
    actionType: 'archive_email',
    description: 'Archive this email',
    domain: 'email',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.LOW,
    reasoning: 'low-risk',
    ...over,
  };
}

function decision(over: Partial<DecisionObject> = {}): DecisionObject {
  return {
    id: 'd1',
    situationType: SituationType.EMAIL_TRIAGE,
    domain: 'email',
    urgency: 'low',
    summary: 'Newsletter from Acme',
    rawData: { authoringTier: 'inbox_newsletter' },
    interpretedAt: new Date(),
    ...over,
  };
}

function outcome(over: Partial<DecisionOutcome> = {}): DecisionOutcome {
  return {
    id: 'o1',
    decisionId: 'd1',
    selectedAction: action(),
    allCandidates: [],
    riskAssessment: null,
    autoExecute: false,
    requiresApproval: true,
    reasoning: 'observer tier forces approval',
    decidedAt: new Date(),
    ...over,
  };
}

describe('isAwarenessOnly', () => {
  it('gates a newsletter archive (inbox_newsletter + archive_email)', () => {
    expect(isAwarenessOnly(decision(), outcome())).toBe(true);
  });

  it.each(['inbox_newsletter', 'inbox_automated', 'user_sent_originated', 'user_sent_reply'])(
    'gates EMAIL_TRIAGE awareness tier %s',
    (tier) => {
      expect(isAwarenessOnly(decision({ rawData: { authoringTier: tier } }), outcome())).toBe(true);
    },
  );

  it('gates a CALENDAR_UPDATE acknowledge', () => {
    const d = decision({
      situationType: SituationType.CALENDAR_UPDATE,
      domain: 'calendar',
      rawData: {},
    });
    const o = outcome({ selectedAction: action({ actionType: 'acknowledge', domain: 'calendar' }) });
    expect(isAwarenessOnly(d, o)).toBe(true);
  });

  it('reads authoringTier from a nested data envelope', () => {
    const d = decision({ rawData: { data: { authoringTier: 'inbox_automated' } } });
    expect(isAwarenessOnly(d, outcome())).toBe(true);
  });

  it.each(['inbox_personal', 'inbox_broadcast'])(
    'does NOT gate human inbound mail (%s) — it stays an approval',
    (tier) => {
      expect(isAwarenessOnly(decision({ rawData: { authoringTier: tier } }), outcome())).toBe(false);
    },
  );

  it('does NOT gate an injection-guard escalation (confirmationLevel set)', () => {
    expect(isAwarenessOnly(decision(), outcome({ confirmationLevel: 'single' }))).toBe(false);
  });

  it('does NOT gate a non-passive action (send_reply)', () => {
    const o = outcome({ selectedAction: action({ actionType: 'send_reply', reversible: false }) });
    expect(isAwarenessOnly(decision(), o)).toBe(false);
  });

  it('does NOT gate an irreversible action', () => {
    expect(isAwarenessOnly(decision(), outcome({ selectedAction: action({ reversible: false }) }))).toBe(
      false,
    );
  });

  it('does NOT gate a costed action', () => {
    expect(
      isAwarenessOnly(decision(), outcome({ selectedAction: action({ estimatedCostCents: 50 }) })),
    ).toBe(false);
  });

  it('does NOT gate an action whose zero cost is unverified (costZeroIntent unknown)', () => {
    expect(
      isAwarenessOnly(decision(), outcome({ selectedAction: action({ costZeroIntent: 'unknown' }) })),
    ).toBe(false);
  });

  it('does NOT gate a CALENDAR_INVITE (needs a real response)', () => {
    const d = decision({
      situationType: SituationType.CALENDAR_INVITE,
      domain: 'calendar',
      rawData: {},
    });
    expect(isAwarenessOnly(d, outcome({ selectedAction: action({ actionType: 'acknowledge' }) }))).toBe(
      false,
    );
  });

  it('does NOT gate when no action was selected', () => {
    expect(isAwarenessOnly(decision(), outcome({ selectedAction: null }))).toBe(false);
  });
});

describe('awarenessDispositionGateEnabled', () => {
  const prev = process.env['AWARENESS_DISPOSITION_GATE'];
  afterEach(() => {
    if (prev === undefined) delete process.env['AWARENESS_DISPOSITION_GATE'];
    else process.env['AWARENESS_DISPOSITION_GATE'] = prev;
  });

  it('defaults to off', () => {
    delete process.env['AWARENESS_DISPOSITION_GATE'];
    expect(awarenessDispositionGateEnabled()).toBe(false);
  });

  it('is on only for the exact value "on"', () => {
    process.env['AWARENESS_DISPOSITION_GATE'] = 'on';
    expect(awarenessDispositionGateEnabled()).toBe(true);
    process.env['AWARENESS_DISPOSITION_GATE'] = 'true';
    expect(awarenessDispositionGateEnabled()).toBe(false);
  });
});
