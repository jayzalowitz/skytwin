import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDemoSessionLifecycleForTests,
  DEMO_USER_ID,
  isDemoReadRequest,
  isLocalDemoAddress,
  isLocalDemoRequest,
  inspectDemoSession,
  isDemoSessionActive,
  isDemoSessionTokenCandidate,
  issueDemoSession,
  revokeDemoSession,
  verifyDemoSession,
} from '../auth/demo-session.js';

describe('demo session credential', () => {
  const previousSecret = process.env['SESSION_SECRET'];

  beforeEach(() => {
    _resetDemoSessionLifecycleForTests();
    process.env['SESSION_SECRET'] =
      'test-demo-session-secret-that-is-long-enough';
  });

  it('retains discarded and replacement tombstones through signed expiry', () => {
    const now = 1_800_000_000_000;
    const discarded = issueDemoSession(now);
    const claims = inspectDemoSession(discarded.token, now + 1)!;
    expect(isDemoSessionActive(claims, now + 1)).toBe(true);
    expect(revokeDemoSession(discarded.token, now + 2)).toBe(true);
    expect(claims.signal.aborted).toBe(true);
    expect(inspectDemoSession(discarded.token, now + 3)).toBeNull();

    const previous = issueDemoSession(now + 4);
    const replacement = issueDemoSession(now + 5, previous.token);
    expect(inspectDemoSession(previous.token, now + 6)).toBeNull();
    expect(inspectDemoSession(replacement.token, now + 6)).not.toBeNull();
  });

  it('recognizes reserved token candidates without accepting malformed ones', () => {
    expect(isDemoSessionTokenCandidate('skytwin-demo-v1')).toBe(true);
    expect(isDemoSessionTokenCandidate('skytwin-demo-v1.not-valid')).toBe(true);
    expect(isDemoSessionTokenCandidate('normal-session-token')).toBe(false);
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

  it('requires the resolved client and raw socket peer to both be loopback', () => {
    expect(isLocalDemoRequest('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(isLocalDemoRequest('127.0.0.1', '203.0.113.7')).toBe(false);
    expect(isLocalDemoRequest('203.0.113.7', '127.0.0.1')).toBe(false);
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

  it('derives distinct one-way state keys for independently issued sessions', () => {
    const first = issueDemoSession(1_800_000_000_000);
    const second = issueDemoSession(1_800_000_000_000);
    const firstClaims = inspectDemoSession(first.token, 1_800_000_000_001);
    const secondClaims = inspectDemoSession(second.token, 1_800_000_000_001);
    expect(firstClaims?.sessionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secondClaims?.sessionKey).not.toBe(firstClaims?.sessionKey);
    expect(firstClaims?.sessionKey).not.toContain(first.token);
  });

  it('recognizes only loopback addresses for the packaged sample', () => {
    expect(isLocalDemoAddress('127.0.0.1')).toBe(true);
    expect(isLocalDemoAddress('::1')).toBe(true);
    expect(isLocalDemoAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalDemoAddress('203.0.113.8')).toBe(false);
    expect(isLocalDemoAddress(undefined)).toBe(false);
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
      isDemoReadRequest('GET', `/api/connectors/${DEMO_USER_ID}/status`),
    ).toBe(true);
    expect(
      isDemoReadRequest('GET', `/api/lifebooks/${DEMO_USER_ID}/Health`),
    ).toBe(true);
    expect(
      isDemoReadRequest(
        'GET',
        `/api/twin-briefings/lifebook/Health/latest?userId=${DEMO_USER_ID}`,
      ),
    ).toBe(true);
  });

  it('rejects every mutation even when it targets the sample identity', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isDemoReadRequest(method, `/api/twin/${DEMO_USER_ID}`)).toBe(
        false,
      );
    }
    expect(isDemoReadRequest('POST', '/api/v1/demo/simulation/commands')).toBe(
      false,
    );
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
    ).toBe(false);
    expect(
      isDemoReadRequest(
        'GET',
        '/api/twin-briefings/lifebook/Health/latest?userId=other',
      ),
    ).toBe(false);
  });

  it('rejects paid, externally-backed, and long-lived streaming surfaces', () => {
    for (const path of [
      `/api/capabilities/recipes?userId=${DEMO_USER_ID}`,
      `/api/about-me?userId=${DEMO_USER_ID}`,
      `/api/search?userId=${DEMO_USER_ID}&q=invoice`,
      `/api/events/stream/${DEMO_USER_ID}?token=x`,
    ]) {
      expect(isDemoReadRequest('GET', path)).toBe(false);
    }
  });
});
