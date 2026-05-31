/**
 * Pure SSE reconnect state machine + backoff (#388 P2.8).
 *
 * The streaming client (`sse-client.ts`) owns the fetch + reader loop;
 * this module owns the *decisions* — what the next backoff delay is and
 * what connection state the UI should render — so both are unit-testable
 * without React Native, `fetch`, or a real socket.
 *
 * States:
 *   - `connecting`   — first attempt, no banner yet (initial mount)
 *   - `connected`    — stream open, green dot, no banner
 *   - `reconnecting` — dropped, backing off + retrying, "Reconnecting…" banner
 *   - `disconnected` — explicitly stopped (component unmounted / disconnect())
 *
 * The distinction between `connecting` and `reconnecting` is what lets
 * the Approvals screen show a banner only after a *drop* — a slow first
 * connect shouldn't flash "Reconnecting…" before we've ever connected.
 */

export type SSEConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export interface BackoffOptions {
  minMs: number;
  maxMs: number;
  multiplier: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  minMs: 1_000,
  maxMs: 30_000,
  multiplier: 2,
};

/**
 * Delay before retry attempt N (0-indexed). Attempt 0 is the first
 * reconnect after a drop. Sequence with the defaults:
 *   0→1000, 1→2000, 2→4000, 3→8000, 4→16000, 5→30000, 6+→30000 (capped).
 *
 * Pure + deterministic — no jitter — so the UI countdown and the tests
 * agree exactly. (Jitter matters for thundering-herd against a shared
 * server; SkyTwin's API is single-user-per-install, so a deterministic
 * curve is the right call and far easier to reason about.)
 */
export function nextReconnectDelay(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
): number {
  if (!Number.isFinite(attempt) || attempt < 0) attempt = 0;
  const raw = opts.minMs * Math.pow(opts.multiplier, Math.floor(attempt));
  return Math.min(raw, opts.maxMs);
}

/**
 * Next connection state given the current state and an event. Encodes
 * the rule that a successful open clears the banner, a drop after having
 * connected shows the reconnecting banner, and an explicit stop is
 * terminal.
 */
export function reduceConnectionState(
  current: SSEConnectionState,
  event: 'open' | 'drop' | 'stop',
): SSEConnectionState {
  if (event === 'stop') return 'disconnected';
  if (event === 'open') return 'connected';
  // event === 'drop'
  if (current === 'disconnected') return 'disconnected'; // already stopped — stay
  // A drop before we ever connected stays "connecting" (don't flash the
  // banner on a slow first connect); a drop after connected → reconnecting.
  return current === 'connecting' ? 'connecting' : 'reconnecting';
}
