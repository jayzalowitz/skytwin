import { describe, expect, it } from 'vitest';
import { classifyOperationalFailure, operationalFailureMeta } from '../content-free-error.js';

const SECRET_MARKER = 'provider-secret-marker-7f3c';

describe('content-free operational failure classification', () => {
  it('never forwards throwable messages, stacks, bodies, or arbitrary codes', () => {
    const error = Object.assign(new Error(SECRET_MARKER), {
      stack: `stack:${SECRET_MARKER}`,
      body: SECRET_MARKER,
      response: { body: SECRET_MARKER },
      code: SECRET_MARKER,
    });

    const serialized = JSON.stringify(operationalFailureMeta(error));
    expect(serialized).toBe('{"errorCode":"operation_failed"}');
    expect(serialized).not.toContain(SECRET_MARKER);
  });

  it('maps only allowlisted status, code, and name values', () => {
    expect(classifyOperationalFailure({ status: 401 })).toBe('authentication_failed');
    expect(classifyOperationalFailure({ statusCode: 429 })).toBe('rate_limited');
    expect(classifyOperationalFailure({ code: 'ECONNREFUSED' })).toBe('network_unavailable');
    expect(classifyOperationalFailure({ name: 'AbortError' })).toBe('timeout');
    expect(classifyOperationalFailure({ status: 503 })).toBe('upstream_unavailable');
  });
});
