import { describe, expect, it } from 'vitest';
import { parseReasoningMode, REASONING_MODES } from '../reasoning-mode.js';

describe('reasoning modes', () => {
  it('accepts only canonical persisted values', () => {
    for (const mode of REASONING_MODES) expect(parseReasoningMode(mode)).toBe(mode);
  });

  it('fails closed for unknown, case-shifted, and non-string values', () => {
    for (const value of ['local', 'ON_DEVICE', 'confidential', '', null, 1]) {
      expect(parseReasoningMode(value)).toBeNull();
    }
  });
});
