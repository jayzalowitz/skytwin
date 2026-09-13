import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDemoSessionLifecycleForTests,
  _demoSessionLifecycleSizeForTests,
  canonicalLocalDemoAddress,
  DEMO_USER_ID,
  DEMO_SESSION_LIFECYCLE_LIMIT,
  DemoSessionCapacityError,
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

const TEST_FIXTURE = {
  userId: DEMO_USER_ID,
  revision: 'demo-fixture-test-v1',
} as const;

describe('demo session credential', () => {
  const previousSecret = process.env['SESSION_SECRET'];

  beforeEach(() => {
    _resetDemoSessionLifecycleForTests();
    process.env['SESSION_SECRET'] =
      'test-demo-session-secret-that-is-long-enough';
  });

  it('retains discarded and replacement tombstones through signed expiry', () => {
    const now = 1_800_000_000_000;
    const discarded = issueDemoSession(TEST_FIXTURE, now);
    const claims = inspectDemoSession(discarded.token, now + 1)!;
    expect(isDemoSessionActive(claims, now + 1)).toBe(true);
    expect(revokeDemoSession(discarded.token, now + 2)).toBe(true);
    expect(claims.signal.aborted).toBe(true);
    expect(inspectDemoSession(discarded.token, now + 3)).toBeNull();

    const previous = issueDemoSession(TEST_FIXTURE, now + 4);
    const replacement = issueDemoSession(TEST_FIXTURE, now + 5, previous.token);
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
    const issued = issueDemoSession(TEST_FIXTURE, 1_800_000_000_000);
    expect(verifyDemoSession(issued.token, 1_800_000_000_001)).toBe(true);
    expect(
      inspectDemoSession(issued.token, 1_800_000_000_001)?.fixtureIncarnation,
    ).toEqual(TEST_FIXTURE);
    expect(issued.expiresAt.getTime()).toBe(1_800_014_400_000);
  });

  it('freezes the fixture incarnation captured at issuance', () => {
    const mutableProof = { ...TEST_FIXTURE, revision: 'fixture-before-mutation' };
    const issued = issueDemoSession(mutableProof);
    mutableProof.revision = 'fixture-after-mutation';

    expect(inspectDemoSession(issued.token)?.fixtureIncarnation.revision).toBe(
      'fixture-before-mutation',
    );
  });

  it('requires the resolved client and raw socket peer to both be loopback', () => {
    expect(isLocalDemoRequest('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(isLocalDemoRequest('127.0.0.1', '203.0.113.7')).toBe(false);
    expect(isLocalDemoRequest('203.0.113.7', '127.0.0.1')).toBe(false);
  });

  it('rejects expired, malformed, and tampered tokens', () => {
    const issued = issueDemoSession(TEST_FIXTURE, 1_800_000_000_000);
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
    const first = issueDemoSession(TEST_FIXTURE, 1_800_000_000_000);
    const second = issueDemoSession(TEST_FIXTURE, 1_800_000_000_000);
    const firstClaims = inspectDemoSession(first.token, 1_800_000_000_001);
    const secondClaims = inspectDemoSession(second.token, 1_800_000_000_001);
    expect(firstClaims?.sessionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secondClaims?.sessionKey).not.toBe(firstClaims?.sessionKey);
    expect(firstClaims?.sessionKey).not.toContain(first.token);
  });

  it('fails closed at the lifecycle cap without evicting active sessions or tombstones', () => {
    const now = 1_800_000_000_000;
    const tombstoned = issueDemoSession(TEST_FIXTURE, now);
    revokeDemoSession(tombstoned.token, now + 1);
    const active = Array.from(
      { length: DEMO_SESSION_LIFECYCLE_LIMIT - 1 },
      () => issueDemoSession(TEST_FIXTURE, now + 2),
    );

    expect(() => issueDemoSession(TEST_FIXTURE, now + 3)).toThrow(DemoSessionCapacityError);
    expect(() =>
      issueDemoSession(TEST_FIXTURE, now + 3, active[0]!.token),
    ).toThrow(DemoSessionCapacityError);
    expect(inspectDemoSession(tombstoned.token, now + 3)).toBeNull();
    expect(inspectDemoSession(active[0]!.token, now + 3)).not.toBeNull();
    expect(inspectDemoSession(active.at(-1)!.token, now + 3)).not.toBeNull();

    // Elapsed entries may be pruned; live or tombstoned authority may not.
    expect(() =>
      issueDemoSession(TEST_FIXTURE, tombstoned.expiresAt.getTime()),
    ).not.toThrow();
  });

  it('does not exceed the lifecycle cap for a signed token from an earlier process', () => {
    const priorProcessToken = issueDemoSession(TEST_FIXTURE).token;
    _resetDemoSessionLifecycleForTests();
    const active = Array.from(
      { length: DEMO_SESSION_LIFECYCLE_LIMIT },
      () => issueDemoSession(TEST_FIXTURE),
    );

    expect(revokeDemoSession(priorProcessToken)).toBe(true);
    expect(_demoSessionLifecycleSizeForTests()).toBe(
      DEMO_SESSION_LIFECYCLE_LIMIT,
    );
    expect(inspectDemoSession(active[0]!.token)).not.toBeNull();
    expect(inspectDemoSession(priorProcessToken)).toBeNull();
  });

  it('recognizes only loopback addresses for the packaged sample', () => {
    expect(isLocalDemoAddress('127.0.0.1')).toBe(true);
    expect(isLocalDemoAddress('::1')).toBe(true);
    expect(isLocalDemoAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalDemoAddress('203.0.113.8')).toBe(false);
    expect(isLocalDemoAddress(undefined)).toBe(false);
  });

  it('canonicalizes every accepted loopback spelling and IPv6 zone to one rate key', () => {
    for (const address of [
      '127.0.0.1',
      '::1',
      '::1%lo0',
      '::1%attacker-controlled-zone',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:7f00:1',
    ]) {
      expect(canonicalLocalDemoAddress(address)).toBe('loopback');
    }
    expect(canonicalLocalDemoAddress('203.0.113.8%lo0')).toBeNull();
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
