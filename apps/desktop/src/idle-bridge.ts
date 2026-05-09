import type { PowerMonitor } from 'electron';

export type IdleState = 'idle' | 'active';

export interface IdleBridgeOptions {
  /** Idle threshold in seconds. Default: 300 (5 minutes). */
  idleThresholdSeconds?: number;
  /** Poll interval in ms when actively checking idle time. Default: 30_000. */
  pollIntervalMs?: number;
  /** Called once on every idle ↔ active transition. */
  onStateChange: (state: IdleState, reason: IdleStateReason) => void;
  /** Injectable for tests; defaults to electron's powerMonitor at runtime. */
  powerMonitor?: PowerMonitorLike;
  /** Logger; defaults to console. */
  logger?: { info: (msg: string, meta?: unknown) => void };
}

export type IdleStateReason =
  | 'idle-threshold'
  | 'idle-resumed'
  | 'lock-screen'
  | 'unlock-screen'
  | 'suspend'
  | 'resume';

/**
 * Subset of Electron's PowerMonitor we actually use. Defining this here
 * lets us inject a fake in tests without pulling Electron into the test
 * runtime, and isolates us from method names that may shift across
 * Electron versions.
 */
export interface PowerMonitorLike {
  getSystemIdleTime(): number;
  on(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', listener: () => void): void;
  off(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', listener: () => void): void;
}

const DEFAULT_THRESHOLD_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Bridges OS-level user-presence signals from Electron's powerMonitor into
 * a single onStateChange callback.
 *
 * Why a polling timer + lock/unlock/suspend/resume events? The
 * `lock-screen` event fires only when the user explicitly locks; macOS
 * users who walk away without locking still need an idle signal, which
 * `getSystemIdleTime()` provides. Suspend/resume catch laptop-lid-close.
 *
 * The bridge is debounced internally — a transition from active to idle
 * fires the callback exactly once, and stays in the new state until a
 * counter-signal arrives. No flapping at the threshold boundary.
 */
export class IdleBridge {
  private readonly thresholdSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly onStateChange: IdleBridgeOptions['onStateChange'];
  private readonly logger: NonNullable<IdleBridgeOptions['logger']>;
  private powerMonitor: PowerMonitorLike | null;

  private state: IdleState = 'active';
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  // Bound listener references for clean removal.
  private boundLock: () => void;
  private boundUnlock: () => void;
  private boundSuspend: () => void;
  private boundResume: () => void;

  constructor(opts: IdleBridgeOptions) {
    this.thresholdSeconds = opts.idleThresholdSeconds ?? DEFAULT_THRESHOLD_SECONDS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onStateChange = opts.onStateChange;
    this.logger = opts.logger ?? {
      info: (msg, meta) => console.info(`[idle-bridge] ${msg}`, meta ?? ''),
    };
    this.powerMonitor = opts.powerMonitor ?? null;

    this.boundLock = () => this.transition('idle', 'lock-screen');
    this.boundUnlock = () => this.transition('active', 'unlock-screen');
    this.boundSuspend = () => this.transition('idle', 'suspend');
    this.boundResume = () => this.transition('active', 'resume');
  }

  /**
   * Begin emitting idle/active transitions. Idempotent — calling start()
   * twice is safe.
   *
   * On Linux/CI/headless or any environment without Electron, the
   * powerMonitor argument may be null; in that case the bridge starts in
   * a no-op state and never fires.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const pm = this.powerMonitor ?? this.tryResolveDefaultPowerMonitor();
    if (pm === null) {
      this.logger.info('powerMonitor unavailable — bridge inert');
      return;
    }
    this.powerMonitor = pm;

    pm.on('lock-screen', this.boundLock);
    pm.on('unlock-screen', this.boundUnlock);
    pm.on('suspend', this.boundSuspend);
    pm.on('resume', this.boundResume);

    this.timer = setInterval(() => this.checkIdle(), this.pollIntervalMs);
    this.logger.info('started', {
      thresholdSeconds: this.thresholdSeconds,
      pollIntervalMs: this.pollIntervalMs,
    });
  }

  /**
   * Tear down listeners and the polling timer. Idempotent.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.powerMonitor !== null) {
      this.powerMonitor.off('lock-screen', this.boundLock);
      this.powerMonitor.off('unlock-screen', this.boundUnlock);
      this.powerMonitor.off('suspend', this.boundSuspend);
      this.powerMonitor.off('resume', this.boundResume);
    }
    this.logger.info('stopped');
  }

  /**
   * Read-only current state — primarily exposed for tests and debug UI.
   */
  getState(): IdleState {
    return this.state;
  }

  private checkIdle(): void {
    if (this.powerMonitor === null) return;
    const idleSeconds = this.powerMonitor.getSystemIdleTime();
    if (idleSeconds >= this.thresholdSeconds && this.state === 'active') {
      this.transition('idle', 'idle-threshold');
    } else if (idleSeconds < this.thresholdSeconds && this.state === 'idle') {
      this.transition('active', 'idle-resumed');
    }
  }

  private transition(next: IdleState, reason: IdleStateReason): void {
    if (this.state === next) return;
    this.state = next;
    this.logger.info(`transition → ${next}`, { reason });
    try {
      this.onStateChange(next, reason);
    } catch (err) {
      this.logger.info('onStateChange handler threw', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private tryResolveDefaultPowerMonitor(): PowerMonitorLike | null {
    try {
      // Lazy require so unit tests and pure-Node callers never load Electron.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('electron') as { powerMonitor?: PowerMonitorLike };
      return mod.powerMonitor ?? null;
    } catch {
      return null;
    }
  }
}
