import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BACKOFF,
  nextReconnectDelay,
  reduceConnectionState,
  type SSEConnectionState,
} from '../services/sse-reconnect';

describe('nextReconnectDelay', () => {
  it('produces the exponential sequence capped at maxMs', () => {
    const seq = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => nextReconnectDelay(n));
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('clamps negative / non-finite attempts to the floor', () => {
    // Garbage input (negative, NaN, Infinity) is treated as "no info" →
    // retry promptly from the floor rather than waiting the full cap.
    expect(nextReconnectDelay(-1)).toBe(DEFAULT_BACKOFF.minMs);
    expect(nextReconnectDelay(Number.NaN)).toBe(DEFAULT_BACKOFF.minMs);
    expect(nextReconnectDelay(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BACKOFF.minMs);
  });

  it('honours custom backoff options', () => {
    const opts = { minMs: 500, maxMs: 4000, multiplier: 3 };
    expect(nextReconnectDelay(0, opts)).toBe(500);
    expect(nextReconnectDelay(1, opts)).toBe(1500);
    expect(nextReconnectDelay(2, opts)).toBe(4000); // 4500 capped to 4000
    expect(nextReconnectDelay(3, opts)).toBe(4000);
  });
});

describe('reduceConnectionState', () => {
  it('open → connected from any non-terminal state', () => {
    const states: SSEConnectionState[] = ['connecting', 'reconnecting', 'connected'];
    for (const s of states) {
      expect(reduceConnectionState(s, 'open')).toBe('connected');
    }
  });

  it('drop after connected → reconnecting (banner shows)', () => {
    expect(reduceConnectionState('connected', 'drop')).toBe('reconnecting');
  });

  it('drop before ever connecting stays "connecting" (no premature banner)', () => {
    expect(reduceConnectionState('connecting', 'drop')).toBe('connecting');
  });

  it('drop while already reconnecting stays reconnecting', () => {
    expect(reduceConnectionState('reconnecting', 'drop')).toBe('reconnecting');
  });

  it('stop is terminal from any state', () => {
    const states: SSEConnectionState[] = ['connecting', 'connected', 'reconnecting', 'disconnected'];
    for (const s of states) {
      expect(reduceConnectionState(s, 'stop')).toBe('disconnected');
    }
  });

  it('drop after stop stays disconnected (no zombie reconnect banner)', () => {
    expect(reduceConnectionState('disconnected', 'drop')).toBe('disconnected');
  });

  it('open after stop stays disconnected (terminal — no UI re-flip on a late fetch)', () => {
    // A fetch that resolves after disconnect()/unmount must not flip the
    // UI back to connected. `disconnected` is terminal for ALL events.
    expect(reduceConnectionState('disconnected', 'open')).toBe('disconnected');
  });

  it('models a full disconnect → reconnect cycle', () => {
    let s: SSEConnectionState = 'connecting';
    s = reduceConnectionState(s, 'open'); // connected
    expect(s).toBe('connected');
    s = reduceConnectionState(s, 'drop'); // reconnecting (banner)
    expect(s).toBe('reconnecting');
    s = reduceConnectionState(s, 'open'); // connected again (banner clears)
    expect(s).toBe('connected');
    s = reduceConnectionState(s, 'stop'); // disconnected
    expect(s).toBe('disconnected');
  });
});
