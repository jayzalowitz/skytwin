/**
 * Tests for the in-memory pairing-token store (#385).
 *
 * Locks the security contract:
 *   - Tokens expire after the documented TTL (5 min)
 *   - A consumed token cannot be redeemed twice
 *   - Unknown / never-issued tokens return `unknown` (not throw)
 *   - Expired tokens are swept on next interaction
 *   - The token surface is dense enough to resist guessing
 *     (256-bit equivalent via two UUIDs)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const {
  issuePairingToken,
  consumePairingToken,
  __resetPairingTokenStoreForTests,
  PAIRING_TOKEN_TTL_MS_EXPORTED,
} = await import('../pairing-token-store.js');

beforeEach(() => {
  __resetPairingTokenStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('issuePairingToken', () => {
  it('returns a token + expiry ~5 minutes in the future', () => {
    const now = Date.now();
    const { token, expiresAt } = issuePairingToken('user-1', 'Phone');
    expect(typeof token).toBe('string');
    // Two UUIDs joined by a hyphen — ~73 chars.
    expect(token.length).toBeGreaterThan(60);
    const ttl = expiresAt.getTime() - now;
    expect(ttl).toBeGreaterThan(PAIRING_TOKEN_TTL_MS_EXPORTED - 1000);
    expect(ttl).toBeLessThanOrEqual(PAIRING_TOKEN_TTL_MS_EXPORTED + 1000);
  });

  it('rejects an empty userId', () => {
    expect(() => issuePairingToken('', 'Phone')).toThrow(/userId is required/);
  });

  it('issues distinct tokens on every call', () => {
    const a = issuePairingToken('user-1', 'Phone');
    const b = issuePairingToken('user-1', 'Phone');
    expect(a.token).not.toBe(b.token);
  });
});

describe('consumePairingToken', () => {
  it('returns ok on the first redemption of a fresh token', () => {
    const { token } = issuePairingToken('user-1', 'Phone');
    const result = consumePairingToken(token);
    expect(result).toEqual({ kind: 'ok', userId: 'user-1', deviceName: 'Phone' });
  });

  it('returns already-used on a second redemption within the window', () => {
    const { token } = issuePairingToken('user-1', 'Phone');
    const first = consumePairingToken(token);
    expect(first.kind).toBe('ok');

    const second = consumePairingToken(token);
    expect(second).toEqual({ kind: 'already-used' });
  });

  it('returns expired after the TTL has elapsed', () => {
    vi.useFakeTimers();
    const baseTime = Date.now();
    vi.setSystemTime(new Date(baseTime));
    const { token } = issuePairingToken('user-1', 'Phone');

    // 6 minutes later — past the 5min TTL
    vi.setSystemTime(new Date(baseTime + 6 * 60 * 1000));
    const result = consumePairingToken(token);
    expect(result).toEqual({ kind: 'expired' });

    // A second attempt on the same now-swept token returns unknown
    // (deliberately indistinguishable to a probing attacker)
    const second = consumePairingToken(token);
    expect(second).toEqual({ kind: 'unknown' });
  });

  it('returns unknown for a never-issued token', () => {
    const result = consumePairingToken('not-a-real-token');
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('returns unknown for an empty / missing token', () => {
    expect(consumePairingToken('').kind).toBe('unknown');
  });

  it('preserves device name across consume', () => {
    const { token } = issuePairingToken('user-2', 'iPad');
    const result = consumePairingToken(token);
    expect(result.kind === 'ok' && result.deviceName).toBe('iPad');
  });

  it('does not affect tokens of OTHER users when one is consumed', () => {
    const a = issuePairingToken('user-a', 'Phone');
    const b = issuePairingToken('user-b', 'Phone');
    expect(consumePairingToken(a.token).kind).toBe('ok');
    expect(consumePairingToken(b.token).kind).toBe('ok');
  });
});
