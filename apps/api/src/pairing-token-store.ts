import { randomUUID } from 'node:crypto';

/**
 * In-memory pairing token store for the QR pairing flow (#385).
 *
 * Pre-fix, `POST /api/sessions` minted a 7-day session token and
 * embedded it directly in the QR URL. A screenshot of the QR (shared
 * in Slack, posted in a tweet, taken over your shoulder, scrollback
 * of a Zoom screen-share) granted indefinite pairing AND multiple
 * devices could redeem the same code in parallel because there was
 * no single-use semantic. That's a 7-day window to redeem somebody
 * else's credential.
 *
 * Post-fix, the QR carries a **short-lived pairing token** (5 min TTL)
 * which the mobile client exchanges for a real session token via
 * `POST /api/sessions/pair/consume`. Consume marks the token used;
 * a second redemption attempt fails with `already-used`. A token
 * that's been sitting for >5 minutes fails with `expired`.
 *
 * Storage: in-process Map. A 5-minute window is short enough that
 * loss-on-restart is acceptable (the user just generates a new code).
 * Multi-instance API would need to lift this to CRDB the same way
 * #58 lifted PKCE verifiers — tracked as a follow-up; for now
 * single-process self-hosters get the fix.
 */

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface PairingTokenEntry {
  userId: string;
  /** Caller-supplied device label (defaults to "Phone"). */
  deviceName: string;
  /** Epoch ms at which the token stops being redeemable. */
  expiresAt: number;
  /** Set to the epoch ms of the first successful consume. */
  consumedAt?: number;
}

const store = new Map<string, PairingTokenEntry>();

/**
 * Best-effort sweep of expired entries. Runs on every issue + every
 * consume so the map stays bounded without a background timer.
 * O(n) but n is the count of in-flight pairings, typically ≤1.
 */
function sweepExpired(now: number): void {
  for (const [token, entry] of store.entries()) {
    // Drop expired-and-unconsumed entries. Consumed entries stick around
    // until their TTL elapses too — they're the "already used" signal
    // for a second redemption attempt within the window.
    if (entry.expiresAt < now) {
      store.delete(token);
    }
  }
}

/**
 * Issue a fresh pairing token for the given user.
 */
export function issuePairingToken(userId: string, deviceName: string): {
  token: string;
  expiresAt: Date;
} {
  if (!userId) throw new Error('issuePairingToken: userId is required');
  const now = Date.now();
  sweepExpired(now);
  // 256 bits via two UUIDs. Same shape as the legacy session token so
  // existing crypto / URL-encoding handling stays untouched.
  const token = `${randomUUID()}-${randomUUID()}`;
  const expiresAtMs = now + PAIRING_TOKEN_TTL_MS;
  store.set(token, {
    userId,
    deviceName,
    expiresAt: expiresAtMs,
  });
  return { token, expiresAt: new Date(expiresAtMs) };
}

export type ConsumePairingTokenResult =
  | { kind: 'ok'; userId: string; deviceName: string }
  | { kind: 'unknown' }
  | { kind: 'expired' }
  | { kind: 'already-used' };

/**
 * Atomically redeem a pairing token. The same caller cannot consume
 * twice — the second call returns `'already-used'`. A token that has
 * exceeded its TTL returns `'expired'` (and is dropped from the map).
 * An unknown token returns `'unknown'` (deliberately the same shape
 * as expired-and-swept so the failure modes are indistinguishable to
 * an attacker probing the endpoint).
 */
export function consumePairingToken(token: string): ConsumePairingTokenResult {
  if (!token) return { kind: 'unknown' };
  const now = Date.now();
  // Do NOT sweep before lookup — sweeping first would collapse the
  // `expired` branch into `unknown` because the entry would already
  // be gone by the time we reached the expiry check. We want the
  // store to report `expired` on the first attempt past TTL so
  // observability / logs can tell the two failure modes apart even
  // if the HTTP response is the same. Sweep AFTER on the way out.
  const entry = store.get(token);
  if (!entry) return { kind: 'unknown' };
  if (entry.expiresAt < now) {
    store.delete(token);
    return { kind: 'expired' };
  }
  if (entry.consumedAt !== undefined) return { kind: 'already-used' };
  // Mark used. Keep the row in the map until TTL so a second redemption
  // within the window returns 'already-used' rather than 'unknown'.
  entry.consumedAt = now;
  // Opportunistic sweep so the map stays bounded.
  sweepExpired(now);
  return { kind: 'ok', userId: entry.userId, deviceName: entry.deviceName };
}

/**
 * Test-only hook for resetting the store between vitest runs.
 * NEVER call from production code.
 */
export function __resetPairingTokenStoreForTests(): void {
  store.clear();
}

export const PAIRING_TOKEN_TTL_MS_EXPORTED = PAIRING_TOKEN_TTL_MS;
