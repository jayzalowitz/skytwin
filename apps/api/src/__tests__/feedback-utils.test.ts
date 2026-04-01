import { describe, it, expect } from 'vitest';
import { mapFeedbackType, parseUndoReasoning } from '../routes/feedback.js';

describe('mapFeedbackType', () => {
  it('should map "approve" to "approve"', () => {
    expect(mapFeedbackType('approve')).toBe('approve');
  });

  it('should map "reward" to "approve"', () => {
    expect(mapFeedbackType('reward')).toBe('approve');
  });

  it('should map "reject" to "reject"', () => {
    expect(mapFeedbackType('reject')).toBe('reject');
  });

  it('should map "punish" to "reject"', () => {
    expect(mapFeedbackType('punish')).toBe('reject');
  });

  it('should map "undo" to "undo"', () => {
    expect(mapFeedbackType('undo')).toBe('undo');
  });

  it('should map "edit" to "correct"', () => {
    expect(mapFeedbackType('edit')).toBe('correct');
  });

  it('should map "restate_preference" to "correct"', () => {
    expect(mapFeedbackType('restate_preference')).toBe('correct');
  });

  it('should map unknown values to "ignore"', () => {
    expect(mapFeedbackType('unknown')).toBe('ignore');
    expect(mapFeedbackType('')).toBe('ignore');
    expect(mapFeedbackType('foobar')).toBe('ignore');
  });
});

describe('parseUndoReasoning', () => {
  it('should return null for null input', () => {
    expect(parseUndoReasoning(null)).toBeNull();
  });

  it('should return null for undefined input', () => {
    expect(parseUndoReasoning(undefined)).toBeNull();
  });

  it('should return null for non-object input', () => {
    expect(parseUndoReasoning('string')).toBeNull();
    expect(parseUndoReasoning(42)).toBeNull();
    expect(parseUndoReasoning(true)).toBeNull();
  });

  it('should return null when whatWentWrong is missing', () => {
    expect(parseUndoReasoning({ severity: 'minor' })).toBeNull();
  });

  it('should return null when whatWentWrong is empty', () => {
    expect(parseUndoReasoning({ whatWentWrong: '', severity: 'minor' })).toBeNull();
  });

  it('should return null when severity is missing', () => {
    expect(parseUndoReasoning({ whatWentWrong: 'wrong action' })).toBeNull();
  });

  it('should return null when severity is invalid', () => {
    expect(parseUndoReasoning({ whatWentWrong: 'wrong action', severity: 'critical' })).toBeNull();
    expect(parseUndoReasoning({ whatWentWrong: 'wrong action', severity: '' })).toBeNull();
    expect(parseUndoReasoning({ whatWentWrong: 'wrong action', severity: 123 })).toBeNull();
  });

  it('should parse valid minimal input (whatWentWrong + severity)', () => {
    const result = parseUndoReasoning({
      whatWentWrong: 'It sent the wrong email',
      severity: 'minor',
    });
    expect(result).toEqual({
      whatWentWrong: 'It sent the wrong email',
      severity: 'minor',
    });
  });

  it('should accept all valid severity levels', () => {
    for (const severity of ['minor', 'moderate', 'severe']) {
      const result = parseUndoReasoning({
        whatWentWrong: 'something wrong',
        severity,
      });
      expect(result).not.toBeNull();
      expect(result!.severity).toBe(severity);
    }
  });

  it('should include optional fields when present and non-empty', () => {
    const result = parseUndoReasoning({
      whatWentWrong: 'It declined the meeting',
      severity: 'moderate',
      whichStep: 'calendar evaluation',
      preferredAlternative: 'Accept and add a note',
    });
    expect(result).toEqual({
      whatWentWrong: 'It declined the meeting',
      severity: 'moderate',
      whichStep: 'calendar evaluation',
      preferredAlternative: 'Accept and add a note',
    });
  });

  it('should omit optional fields when they are empty strings', () => {
    const result = parseUndoReasoning({
      whatWentWrong: 'Wrong action taken',
      severity: 'severe',
      whichStep: '',
      preferredAlternative: '',
    });
    expect(result).toEqual({
      whatWentWrong: 'Wrong action taken',
      severity: 'severe',
    });
    expect(result).not.toHaveProperty('whichStep');
    expect(result).not.toHaveProperty('preferredAlternative');
  });

  it('should omit optional fields when they are non-string types', () => {
    const result = parseUndoReasoning({
      whatWentWrong: 'Wrong action taken',
      severity: 'minor',
      whichStep: 42,
      preferredAlternative: true,
    });
    expect(result).toEqual({
      whatWentWrong: 'Wrong action taken',
      severity: 'minor',
    });
    expect(result).not.toHaveProperty('whichStep');
    expect(result).not.toHaveProperty('preferredAlternative');
  });
});
