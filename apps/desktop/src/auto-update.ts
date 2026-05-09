/**
 * auto-update.ts — Auto-update wiring for SkyTwin Desktop.
 *
 * The AutoUpdateController is a pure data-layer orchestrator. It delegates
 * all real update mechanics to an injected UpdateBackend interface, which
 * makes the controller fully testable without spawning Electron or touching
 * the network.
 *
 * Default backend: NoopUpdateBackend — always returns { status: 'no-update' }.
 * Nothing is fetched on a fresh install unless an explicit ElectronUpdaterBackend
 * is wired in (see TODO below).
 *
 * TODO(#188 follow-up): ElectronUpdaterBackend using electron-updater.
 *   import { autoUpdater } from 'electron-updater';
 *   The real backend wires autoUpdater.setFeedURL, calls autoUpdater.checkForUpdates(),
 *   and maps its events to UpdateCheckResult. Land this once E2E testing on a
 *   signed, running app confirms the update channel is stable.
 */

export interface AutoUpdateConfig {
  enabled: boolean;
  /** Update feed URL. Defaults to SKYTWIN_UPDATE_URL env var or the .local placeholder. */
  feedURL: string;
  channel: 'stable' | 'beta';
  /** How often to poll for updates. Default: 6 hours (21_600_000 ms). */
  checkIntervalMs: number;
}

export interface UpdateCheckResult {
  status: 'no-update' | 'available' | 'downloading' | 'ready-to-install' | 'error';
  version?: string;
  error?: string;
}

/** Abstraction over the real electron-updater (or a noop/mock). */
export interface UpdateBackend {
  checkForUpdates(): Promise<UpdateCheckResult>;
}

/** Default backend: never fetches anything. Safe for unsigned/dev builds. */
export class NoopUpdateBackend implements UpdateBackend {
  async checkForUpdates(): Promise<UpdateCheckResult> {
    return { status: 'no-update' };
  }
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6 hours

/**
 * Returns the effective auto-update feed URL.
 *
 * Priority order:
 *   1. Explicit config value (if non-empty)
 *   2. SKYTWIN_UPDATE_URL environment variable
 *   3. Fallback placeholder (no real domain — intentional)
 */
export function resolveFeedURL(configURL?: string): string {
  if (configURL && configURL.length > 0) return configURL;
  const envURL = process.env['SKYTWIN_UPDATE_URL'];
  if (envURL && envURL.length > 0) return envURL;
  return 'https://updates.skytwin.local/';
}

/** Builds a default AutoUpdateConfig from environment variables. */
export function defaultAutoUpdateConfig(): AutoUpdateConfig {
  return {
    enabled: true,
    feedURL: resolveFeedURL(),
    channel: 'stable',
    checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
  };
}

export class AutoUpdateController {
  private readonly config: AutoUpdateConfig;
  private readonly backend: UpdateBackend;
  private latestStatus: UpdateCheckResult = { status: 'no-update' };
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * @param config - Update configuration. Use defaultAutoUpdateConfig() for env-driven defaults.
   * @param backend - Injectable backend. Defaults to NoopUpdateBackend (no network calls).
   */
  constructor(config: AutoUpdateConfig, backend: UpdateBackend = new NoopUpdateBackend()) {
    this.config = config;
    this.backend = backend;
  }

  /**
   * Performs an immediate update check.
   * Always records the result in latestStatus.
   * Returns { status: 'no-update' } when the controller is disabled.
   */
  async checkNow(): Promise<UpdateCheckResult> {
    if (!this.config.enabled) {
      const result: UpdateCheckResult = { status: 'no-update' };
      this.latestStatus = result;
      return result;
    }

    try {
      const result = await this.backend.checkForUpdates();
      this.latestStatus = result;
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const result: UpdateCheckResult = { status: 'error', error: message };
      this.latestStatus = result;
      return result;
    }
  }

  /**
   * Starts a repeating interval that calls checkNow() every checkIntervalMs.
   * Calling this more than once is safe — subsequent calls are ignored.
   */
  schedulePeriodicChecks(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      void this.checkNow();
    }, this.config.checkIntervalMs);
    // Allow Node.js to exit even if the interval is still scheduled.
    if (typeof this.intervalId === 'object' && this.intervalId !== null &&
        'unref' in this.intervalId) {
      (this.intervalId as { unref: () => void }).unref();
    }
  }

  /**
   * Cancels the periodic check interval, if one is running.
   * Safe to call when no interval is active.
   */
  cancelScheduledChecks(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Returns the result of the most recent checkNow() call. */
  getLatestStatus(): UpdateCheckResult {
    return this.latestStatus;
  }

  /** Returns true if a periodic check interval is currently active. */
  isScheduled(): boolean {
    return this.intervalId !== null;
  }
}
