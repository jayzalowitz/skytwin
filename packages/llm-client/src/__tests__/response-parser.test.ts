import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSituationResponse, parseCandidateResponse } from '../response-parser.js';
import { SituationType, ConfidenceLevel } from '@skytwin/shared-types';

// Suppress console.warn noise in tests
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('parseSituationResponse', () => {
  const rawEvent = { source: 'gmail', subject: 'Hello' };

  it('parses a valid JSON response with all fields', () => {
    const text = JSON.stringify({
      situationType: SituationType.EMAIL_TRIAGE,
      urgency: 'medium',
      domain: 'email',
      summary: 'New email needs triage',
    });

    const result = parseSituationResponse(text, rawEvent);
    expect(result).not.toBeNull();
    expect(result!.situationType).toBe(SituationType.EMAIL_TRIAGE);
    expect(result!.urgency).toBe('medium');
    expect(result!.domain).toBe('email');
    expect(result!.summary).toBe('New email needs triage');
    expect(result!.rawData).toBe(rawEvent);
    expect(result!.id).toBeTruthy();
    expect(result!.interpretedAt).toBeInstanceOf(Date);
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const text = '```json\n' + JSON.stringify({
      situationType: SituationType.CALENDAR_CONFLICT,
      urgency: 'high',
      domain: 'calendar',
      summary: 'Conflicting meetings',
    }) + '\n```';

    const result = parseSituationResponse(text, rawEvent);
    expect(result).not.toBeNull();
    expect(result!.situationType).toBe(SituationType.CALENDAR_CONFLICT);
    expect(result!.urgency).toBe('high');
  });

  it('parses JSON with preamble text before the object', () => {
    const text = 'Here is my analysis:\n' + JSON.stringify({
      situationType: SituationType.GENERIC,
      urgency: 'low',
    });

    const result = parseSituationResponse(text, rawEvent);
    expect(result).not.toBeNull();
    expect(result!.situationType).toBe(SituationType.GENERIC);
  });

  it('defaults domain to "generic" when missing', () => {
    const text = JSON.stringify({
      situationType: SituationType.TASK_MANAGEMENT,
      urgency: 'low',
      summary: 'A task',
    });

    const result = parseSituationResponse(text, rawEvent);
    expect(result).not.toBeNull();
    expect(result!.domain).toBe('generic');
  });

  it('defaults summary to "LLM-interpreted event" when missing', () => {
    const text = JSON.stringify({
      situationType: SituationType.TASK_MANAGEMENT,
      urgency: 'low',
    });

    const result = parseSituationResponse(text, rawEvent);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('LLM-interpreted event');
  });

  it('returns null for an invalid situationType', () => {
    const text = JSON.stringify({
      situationType: 'not_a_real_type',
      urgency: 'low',
    });

    const result = parseSituationResponse(text, rawEvent);
    expect(result).toBeNull();
  });

  it('returns null for an invalid urgency', () => {
    const text = JSON.stringify({
      situationType: SituationType.EMAIL_TRIAGE,
      urgency: 'extremely_urgent',
    });

    const result = parseSituationResponse(text, rawEvent);
    expect(result).toBeNull();
  });

  it('returns null for completely invalid JSON', () => {
    const text = 'this is not json at all!!!';
    const result = parseSituationResponse(text, rawEvent);
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = parseSituationResponse('', rawEvent);
    expect(result).toBeNull();
  });

  it('accepts all valid urgency levels', () => {
    for (const urgency of ['low', 'medium', 'high', 'critical']) {
      const text = JSON.stringify({
        situationType: SituationType.GENERIC,
        urgency,
      });
      const result = parseSituationResponse(text, rawEvent);
      expect(result).not.toBeNull();
      expect(result!.urgency).toBe(urgency);
    }
  });

  it('accepts all valid situation types', () => {
    for (const st of Object.values(SituationType)) {
      const text = JSON.stringify({
        situationType: st,
        urgency: 'low',
      });
      const result = parseSituationResponse(text, rawEvent);
      expect(result).not.toBeNull();
      expect(result!.situationType).toBe(st);
    }
  });
});

describe('parseCandidateResponse', () => {
  const decisionId = 'decision-123';

  it('parses a valid array of candidates', () => {
    const text = JSON.stringify([
      {
        actionType: 'reply_email',
        description: 'Send a reply',
        domain: 'email',
        parameters: { to: 'alice@example.com' },
        confidence: ConfidenceLevel.HIGH,
        reasoning: 'User always replies to this sender',
      },
    ]);

    const result = parseCandidateResponse(text, decisionId);
    expect(result).toHaveLength(1);
    expect(result[0]!.actionType).toBe('reply_email');
    expect(result[0]!.description).toBe('Send a reply');
    expect(result[0]!.domain).toBe('email');
    expect(result[0]!.parameters).toEqual({ to: 'alice@example.com' });
    expect(result[0]!.confidence).toBe(ConfidenceLevel.HIGH);
    expect(result[0]!.reasoning).toBe('User always replies to this sender');
    expect(result[0]!.decisionId).toBe(decisionId);
    expect(result[0]!.id).toBeTruthy();
  });

  it('forces estimatedCostCents to 0 and reversible to false (safety invariant)', () => {
    const text = JSON.stringify([
      {
        actionType: 'buy_something',
        estimatedCostCents: 9999,
        reversible: true,
      },
    ]);

    const result = parseCandidateResponse(text, decisionId);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedCostCents).toBe(0);
    expect(result[0]!.reversible).toBe(false);
  });

  it('defaults confidence to MODERATE for invalid values', () => {
    const text = JSON.stringify([
      {
        actionType: 'do_thing',
        confidence: 'super_confident',
      },
    ]);

    const result = parseCandidateResponse(text, decisionId);
    expect(result).toHaveLength(1);
    expect(result[0]!.confidence).toBe(ConfidenceLevel.MODERATE);
  });

  it('defaults confidence to MODERATE when missing', () => {
    const text = JSON.stringify([{ actionType: 'do_thing' }]);

    const result = parseCandidateResponse(text, decisionId);
    expect(result).toHaveLength(1);
    expect(result[0]!.confidence).toBe(ConfidenceLevel.MODERATE);
  });

  it('accepts all valid confidence levels', () => {
    for (const cl of Object.values(ConfidenceLevel)) {
      const text = JSON.stringify([{ actionType: 'test', confidence: cl }]);
      const result = parseCandidateResponse(text, decisionId);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence).toBe(cl);
    }
  });

  it('defaults domain to "generic" and description to actionType', () => {
    const text = JSON.stringify([{ actionType: 'archive_email' }]);

    const result = parseCandidateResponse(text, decisionId);
    expect(result).toHaveLength(1);
    expect(result[0]!.domain).toBe('generic');
    expect(result[0]!.description).toBe('archive_email');
  });

  it('defaults reasoning to "LLM-generated candidate"', () => {
    const text = JSON.stringify([{ actionType: 'test' }]);

    const result = parseCandidateResponse(text, decisionId);
    expect(result[0]!.reasoning).toBe('LLM-generated candidate');
  });

  it('defaults parameters to empty object when missing', () => {
    const text = JSON.stringify([{ actionType: 'test' }]);

    const result = parseCandidateResponse(text, decisionId);
    expect(result[0]!.parameters).toEqual({});
  });

  it('drops candidates missing actionType', () => {
    const text = JSON.stringify([
      { actionType: 'valid_one' },
      { description: 'no action type here' },
      { actionType: '', description: 'empty action type' },
      { actionType: 'valid_two' },
    ]);

    const result = parseCandidateResponse(text, decisionId);
    expect(result).toHaveLength(2);
    expect(result[0]!.actionType).toBe('valid_one');
    expect(result[1]!.actionType).toBe('valid_two');
  });

  it('returns empty array for completely invalid JSON', () => {
    const result = parseCandidateResponse('not json', decisionId);
    expect(result).toEqual([]);
  });

  it('returns empty array for a JSON object (not array)', () => {
    const text = JSON.stringify({ actionType: 'reply_email' });
    const result = parseCandidateResponse(text, decisionId);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    const result = parseCandidateResponse('', decisionId);
    expect(result).toEqual([]);
  });

  it('parses candidates from markdown-fenced JSON', () => {
    const text = '```json\n' + JSON.stringify([
      { actionType: 'reply_email', confidence: ConfidenceLevel.LOW },
    ]) + '\n```';

    const result = parseCandidateResponse(text, decisionId);
    expect(result).toHaveLength(1);
    expect(result[0]!.actionType).toBe('reply_email');
  });

  it('handles multiple candidates with mixed validity', () => {
    const text = JSON.stringify([
      { actionType: 'good', confidence: ConfidenceLevel.HIGH },
      { description: 'missing action type' },
      { actionType: 'also_good', confidence: ConfidenceLevel.SPECULATIVE },
    ]);

    const result = parseCandidateResponse(text, decisionId);
    expect(result).toHaveLength(2);
    expect(result[0]!.confidence).toBe(ConfidenceLevel.HIGH);
    expect(result[1]!.confidence).toBe(ConfidenceLevel.SPECULATIVE);
  });
});
