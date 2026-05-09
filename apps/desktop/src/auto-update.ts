/**
 * auto-update.ts — Auto-update wiring for SkyTwin Desktop.
 *
 * The AutoUpdateController is a pure data-layer orchestrator. It delegates
 * all real update mechanics to an injected UpdateBackend interface, which
 * makes the controller fully testable without spawning Electron or touching
 * the network.
 *
 * Default backend: resolved at construction time via defaultBackend().
 * When running inside Electron, defaultBackend() returns ElectronUpdaterBackend
 * which uses electron-updater + GitHub Releases (provider: github).
 * In all other contexts (tests, headless.ts, Node.js CLI) it returns
 * NoopUpdateBackend — no network calls, no side effects.
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

/**
 * Real backend: delegates to electron-updater and the GitHub Releases channel.
 *
 * electron-updater reads the publish config from package.json at runtime and
 * uses GH_TOKEN from the environment when publishing. Checking for updates
 * (the read path) works without a token because GitHub Releases are public.
 *
 * autoDownload + autoInstallOnAppQuit are set so a downloaded update is
 * installed silently the next time the user quits — no mid-session surprise.
 */
export class ElectronUpdaterBackend implements UpdateBackend {
  private readonly opts: { channel: 'stable' | 'beta' };

  constructor(opts: { channel: 'stable' | 'beta' } = { channel: 'stable' }) {
    this.opts = opts;
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    // Dynamic require so the module is only resolved inside a real Electron
    // process where the native bindings exist. Static import would cause
    // Node.js to try loading electron-updater's Electron-dependent internals
    // at module parse time, which breaks in test/headless environments.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');

    autoUpdater.channel = this.opts.channel;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.updateInfo) return { status: 'no-update' };
      return { status: 'available', version: result.updateInfo.version };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Lazy backend factory.
 *
 * Returns ElectronUpdaterBackend when running inside Electron
 * (process.versions.electron is truthy). Returns NoopUpdateBackend otherwise —
 * so unit tests, headless.ts, and any non-Electron Node context get a safe,
 * network-free default.
 */
export function defaultBackend(opts?: { channel: 'stable' | 'beta' }): UpdateBackend {
  if (
    typeof process !== 'undefined' &&
    (process.versions as Record<string, string | undefined>)['electron']
  ) {
    return new ElectronUpdaterBackend(opts);
  }
  return new NoopUpdateBackend();
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
   * @param backend - Injectable backend. When omitted, defaultBackend() is called:
   *   ElectronUpdaterBackend in a packaged Electron process, NoopUpdateBackend everywhere else.
   */
  constructor(config: AutoUpdateConfig, backend?: UpdateBackend) {
    this.config = config;
    this.backend = backend ?? defaultBackend({ channel: config.channel });
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
