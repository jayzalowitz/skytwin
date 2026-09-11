import { describe, expect, it } from 'vitest';
import { extractErrorCode } from '../oauth-error-code.js';

describe('extractErrorCode', () => {
  it('classifies invalid credentials without inspecting a provider body', () => {
    expect(extractErrorCode(400)).toBe('invalid_grant');
    expect(extractErrorCode(403)).toBe('invalid_grant');
  });

  it('classifies client authorization failures', () => {
    expect(extractErrorCode(401)).toBe('unauthorized_client');
  });

  it('returns null for non-permanent or unknown status codes', () => {
    expect(extractErrorCode(429)).toBeNull();
    expect(extractErrorCode(500)).toBeNull();
  });
});
