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

  constructor(private readonly deps: IdlePauseDeps) {}

  async onIdleStateChange(next: 'idle' | 'active'): Promise<IdlePauseAction> {
    if (!this.deps.getEnabled()) return 'noop';

    if (next === 'idle') {
      if (this.deps.isCurrentlyPaused()) return 'noop';
      this.autoPausedByIdle = true;
      await this.deps.pauseServices();
      return 'pause';
    }
    // next === 'active'
    if (!this.autoPausedByIdle) return 'noop';
    this.autoPausedByIdle = false;
    await this.deps.resumeServices();
    return 'resume';
  }

  /**
   * Inform the controller that the user manually flipped the pause
   * state via the tray menu / kill switch. We clear the auto-paused
   * flag so the next active transition doesn't override the user.
   */
  onManualPauseChange(): void {
    this.autoPausedByIdle = false;
  }

  /**
   * If the user disables the setting while we're auto-paused, resume
   * the services immediately — otherwise the preference change
   * appears to do nothing until the next idle/active edge.
   */
  async onEnabledChanged(enabled: boolean): Promise<IdlePauseAction> {
    if (!enabled && this.autoPausedByIdle) {
      this.autoPausedByIdle = false;
      await this.deps.resumeServices();
      return 'resume';
    }
    return 'noop';
  }

  /** Exposed for tests + debug UI. */
  isAutoPausedByIdle(): boolean {
    return this.autoPausedByIdle;
  }
}
