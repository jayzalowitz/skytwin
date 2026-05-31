/**
 * Idle pause controller (#382 P2.2).
 *
 * Wires the existing `IdleBridge` (which already detects OS idle and
 * fires onStateChange) into `ServiceManager.pause()/resume()` so the
 * worker stops polling Gmail / generating decisions when the user
 * walks away. Pre-fix, `idle-bridge.ts` fired transitions into a
 * console log + a renderer IPC that nothing listened to — dead code.
 *
 * Design constraints:
 *
 *   - **Don't fight the user.** If the user manually paused the twin
 *     (kill switch, tray menu) and then goes idle, we don't re-pause
 *     (already paused). When they come back, we don't auto-resume
 *     either — they wanted it off, leave it off.
 *
 *   - **Don't fight the setting.** If the user toggles the
 *     "pause when idle" preference off while we're auto-paused, that
 *     should immediately resume — otherwise the preference change
 *     looks like it did nothing for the next ~30s of polling.
 *
 *   - **Idempotent.** Repeated idle events while already-idle are
 *     no-ops; same for active. The bridge debounces internally but
 *     we don't trust transient state.
 *
 *   - **Side-effects are injectable.** All `pauseServices` /
 *     `resumeServices` / `isCurrentlyPaused` / `getEnabled` are
 *     callbacks the caller supplies, so this module unit-tests
 *     without Electron, `ServiceManager`, or any real I/O.
 */

export type IdlePauseAction = 'pause' | 'resume' | 'noop';

export interface IdlePauseDeps {
  /** Read the current "pause when idle" preference. */
  getEnabled: () => boolean;
  /** True iff the worker / decision generation is currently paused. */
  isCurrentlyPaused: () => boolean;
  /** Async pause — invoked when transitioning into auto-paused. */
  pauseServices: () => Promise<void>;
  /** Async resume — invoked when leaving auto-paused. */
  resumeServices: () => Promise<void>;
}

export class IdlePauseController {
  /**
   * True iff THIS controller is the reason the services are paused.
   * Cleared on manual pause/resume so a user-initiated pause survives
   * an idle/active cycle, and a user-initiated resume isn't immediately
   * undone on the next idle check.
   */
  private autoPausedByIdle = false;

  /**
   * Serializes all pause/resume work. `ServiceManager.pause()` can take
   * several seconds to wait for the worker to exit; if an `active`
   * transition (or a setting change) arrives during that wait, an
   * un-serialized `resume()` could start a fresh worker while the old
   * worker's exit handler is still in flight, leaving the manager's
   * `worker.process` cleared and the new worker orphaned. We chain each
   * operation onto this promise so the state decision AND the async
   * side-effect run atomically with respect to one another. The chain
   * never rejects — a thrown side-effect is swallowed into the link so
   * one failure can't wedge every subsequent transition.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: IdlePauseDeps) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Keep the tail alive even if `fn` throws, so the next enqueue still
    // chains after this one completes rather than off a rejected promise.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  onIdleStateChange(next: 'idle' | 'active'): Promise<IdlePauseAction> {
    return this.enqueue(async () => {
      if (!this.deps.getEnabled()) return 'noop' as const;

      if (next === 'idle') {
        if (this.deps.isCurrentlyPaused()) return 'noop' as const;
        this.autoPausedByIdle = true;
        await this.deps.pauseServices();
        return 'pause' as const;
      }
      // next === 'active'
      if (!this.autoPausedByIdle) return 'noop' as const;
      this.autoPausedByIdle = false;
      await this.deps.resumeServices();
      return 'resume' as const;
    });
  }

  /**
   * Inform the controller that the user manually flipped the pause
   * state via the tray menu / kill switch. We clear the auto-paused
   * flag so the next active transition doesn't override the user.
   * Synchronous flag-clear; the actual pause/resume the user triggered
   * is owned by ServiceManager, not this controller.
   */
  onManualPauseChange(): void {
    this.autoPausedByIdle = false;
  }

  /**
   * If the user disables the setting while we're auto-paused, resume
   * the services immediately — otherwise the preference change
   * appears to do nothing until the next idle/active edge. Serialized
   * through the same queue so it can't race an in-flight pause.
   */
  onEnabledChanged(enabled: boolean): Promise<IdlePauseAction> {
    return this.enqueue(async () => {
      if (!enabled && this.autoPausedByIdle) {
        this.autoPausedByIdle = false;
        await this.deps.resumeServices();
        return 'resume' as const;
      }
      return 'noop' as const;
    });
  }

  /** Exposed for tests + debug UI. */
  isAutoPausedByIdle(): boolean {
    return this.autoPausedByIdle;
  }
}
