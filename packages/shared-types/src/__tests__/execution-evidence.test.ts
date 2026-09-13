import { describe, expect, it } from 'vitest';
import {
  normalizeExecutionError,
  normalizeExecutionRecord,
} from '../execution-evidence.js';

describe('execution evidence normalization', () => {
  it('recursively redacts credentials, headers, URLs, and arbitrary response bodies', () => {
    const secret = 'short-rotated-token';
    const result = normalizeExecutionRecord({
      planId: 'plan-1',
      status: 'failed',
      output: {
        access_token: secret,
        headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        endpoint: `https://example.test/run?access_token=${secret}#fragment`,
        body: { arbitrary: secret },
        summary: `opaque response ${secret}`,
        nested: { refreshToken: 'refresh-secret' },
      },
      error: `request failed: Bearer ${secret} at https://example.test/x?token=${secret}`,
    }, { secretValues: [secret] });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ planId: 'plan-1', status: 'failed' });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('refresh-secret');
    expect(serialized).not.toContain('?access_token=');
    expect(serialized).not.toContain('?token=');
    expect(serialized).toContain('[redacted:credential]');
    expect(serialized).toContain('[redacted:unapproved-field]');
    expect((result['output'] as Record<string, unknown>)['summary'])
      .toBe('[redacted:unapproved-field]');
  });

  it('removes echoed tokens and URL queries from free-form errors', () => {
    const secret = 'opaque-value';
    const result = normalizeExecutionError(
      `access_token=${secret} Bearer ${secret} https://example.test/error?debug=${secret}`,
      { secretValues: [secret] },
    );
    expect(result).not.toContain(secret);
    expect(result).toBe('[redacted:execution-error]');
  });
});
