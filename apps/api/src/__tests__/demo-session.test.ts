import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEMO_USER_ID,
  isDemoReadRequest,
  issueDemoSession,
  verifyDemoSession,
} from '../auth/demo-session.js';

describe('demo session credential', () => {
  const previousSecret = process.env['SESSION_SECRET'];

  beforeEach(() => {
    process.env['SESSION_SECRET'] =
      'test-demo-session-secret-that-is-long-enough';
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
    else process.env['SESSION_SECRET'] = previousSecret;
  });

  it('verifies an issued token before expiry', () => {
    const issued = issueDemoSession(1_800_000_000_000);
    expect(verifyDemoSession(issued.token, 1_800_000_000_001)).toBe(true);
    expect(issued.expiresAt.getTime()).toBe(1_800_014_400_000);
  });

  it('rejects expired, malformed, and tampered tokens', () => {
    const issued = issueDemoSession(1_800_000_000_000);
    expect(verifyDemoSession(issued.token, issued.expiresAt.getTime())).toBe(
      false,
    );
    expect(verifyDemoSession('not-a-demo-token', 1_800_000_000_001)).toBe(
      false,
    );

    const last = issued.token.at(-1);
    const replacement = last === 'a' ? 'b' : 'a';
    const tampered = `${issued.token.slice(0, -1)}${replacement}`;
    expect(verifyDemoSession(tampered, 1_800_000_000_001)).toBe(false);
  });
});

describe('demo read allowlist', () => {
  it('allows core reads for the reserved sample identity', () => {
    expect(isDemoReadRequest('GET', `/api/users/${DEMO_USER_ID}`)).toBe(true);
    expect(
      isDemoReadRequest('GET', `/api/decisions/${DEMO_USER_ID}?limit=50`),
    ).toBe(true);
    expect(
      isDemoReadRequest('GET', `/api/capabilities?userId=${DEMO_USER_ID}`),
    ).toBe(true);
    expect(isDemoReadRequest('HEAD', `/api/v1/briefings/${DEMO_USER_ID}`)).toBe(
      true,
    );
    expect(
      isDemoReadRequest('GET', `/api/events/stream/${DEMO_USER_ID}?token=x`),
    ).toBe(true);
    expect(
      isDemoReadRequest('GET', `/api/connectors/${DEMO_USER_ID}/status`),
    ).toBe(true);
    expect(
      isDemoReadRequest('GET', `/api/lifebooks/${DEMO_USER_ID}/Health`),
    ).toBe(true);
  });

  it('rejects every mutation even when it targets the sample identity', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isDemoReadRequest(method, `/api/twin/${DEMO_USER_ID}`)).toBe(
        false,
      );
    }
  });

  it('rejects another identity, user enumeration, and sensitive surfaces', () => {
    expect(isDemoReadRequest('GET', '/api/users')).toBe(false);
    expect(
      isDemoReadRequest(
        'GET',
        '/api/users/11111111-1111-4111-8111-111111111111',
      ),
    ).toBe(false);
    expect(isDemoReadRequest('GET', '/api/settings')).toBe(false);
    expect(isDemoReadRequest('GET', '/api/admin/dead-letters')).toBe(false);
    expect(isDemoReadRequest('GET', '/api/credentials/status')).toBe(false);
    expect(
      isDemoReadRequest('GET', `/api/lifebooks/${DEMO_USER_ID}/work/layout`),
    ).toBe(false);
    expect(
      isDemoReadRequest('GET', `/api/events/stream?userId=${DEMO_USER_ID}`),
    ).toBe(false);
    expect(
      isDemoReadRequest(
        'GET',
        `/api/decisions/not-a-canonical-uuid/explanation`,
      ),
    ).toBe(false);
  });

  it('requires the sample identity on query-scoped reads', () => {
    expect(isDemoReadRequest('GET', '/api/about-me')).toBe(false);
    expect(isDemoReadRequest('GET', '/api/about-me?userId=other')).toBe(false);
    expect(
      isDemoReadRequest('GET', `/api/about-me?userId=${DEMO_USER_ID}`),
    ).toBe(true);
  });
});
