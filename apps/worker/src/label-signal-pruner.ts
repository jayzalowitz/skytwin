/**
 * Per-user, per-process throttle for the `email_label_signals` prune pass.
 *
 * Issue #122 follow-up: the table grows unbounded without periodic cleanup
 * (one row per (user, sender, label) tuple, no built-in retention). We don't
 * want a separate maintenance scheduler — the existing polling loop already
 * visits every active user every cycle, so we run prune opportunistically
 * with an in-memory "once per N hours per user" gate.
 *
 * Survives only the worker process lifetime: on restart the throttle map
 * resets and the next poll for each user re-runs prune. That's fine — prune
 * is idempotent (the second consecutive call drops ~0 rows) and cheap when
 * the user is below cap.
 *
 * Pulled out of `index.ts` so the throttle logic is unit-testable without
 * standing up a worker. The actual DB call is injected.
 */

export interface PruneRunner {
  /** Returns the number of rows dropped (any kind) so the caller can log. */
  (userId: string): Promise<number>;
}

export interface PruneThrottleConfig {
  /** Minimum gap between prune calls for the same user. Default 24h. */
  minIntervalMs?: number;
  /** Optional clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build a throttled prune runner.
 *
 * Returns a function the worker can call on every `pollUser` cycle —
 * internally it no-ops if the user was pruned within `minIntervalMs`. On a
 * fresh worker start every user gets pruned on their first poll, then the
 * throttle takes over.
 *
 * Errors from the underlying runner are swallowed (logged via the caller's
 * onError hook). Prune failure must NOT block signal ingestion — the data
 * model staying tidy is best-effort, not load-bearing.
 */
export function createPruneThrottle(
  runner: PruneRunner,
  onError: (userId: string, err: unknown) => void,
  config: PruneThrottleConfig = {},
): (userId: string) => Promise<number | null> {
  const minIntervalMs = config.minIntervalMs ?? 24 * 60 * 60 * 1000;
  const now = config.now ?? Date.now;
  const lastRun = new Map<string, number>();

  return async (userId: string): Promise<number | null> => {
    const last = lastRun.get(userId);
    // First-ever call for this user always runs — no `?? 0` fallback,
    // because at `now()` near 0 the elapsed math would lock out the very
    // first call. The throttle is "have we run THIS user recently?", not
    // "has any time passed since the epoch?".
    if (last !== undefined && now() - last < minIntervalMs) {
      return null;
    }
    // Stamp the timestamp BEFORE awaiting so a slow prune doesn't queue
    // a second call from the next poll cycle. If prune throws we still
    // wait the full interval before retrying — the table can survive
    // 24h of skipped maintenance.
    lastRun.set(userId, now());
    try {
      return await runner(userId);
    } catch (err) {
      onError(userId, err);
      return null;
    }
  };
}
