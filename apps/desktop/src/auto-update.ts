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
  /**
   * Override the update feed URL the way `electron-updater`'s
   * `autoUpdater.setFeedURL(...)` does. When `null` (the default
   * post-#370) the publisher block in `apps/desktop/package.json` —
   * `provider: github`, `owner: jayzalowitz`, `repo: skytwin` —
   * takes effect; electron-updater pulls release metadata from
   * GitHub Releases without any extra config. Set this to a
   * non-empty string (via `SKYTWIN_UPDATE_URL`) only when you're
   * self-hosting your own update server and want to override the
   * GitHub publisher.
   *
   * Pre-#370, this field defaulted to `https://updates.skytwin.local/`
   * — a non-existent domain — and was never plumbed into
   * `electron-updater` anyway, so the field was decorative AND the
   * placeholder it carried would have been actively wrong if it
   * had been wired up.
   */
  feedURL: string | null;
  channel: 'stable' | 'beta';
  /** How often to poll for updates. Default: 6 hours (21_600_000 ms). */
  checkIntervalMs: number;
}

export interface UpdateCheckResult {
  status: 'no-update' | 'available' | 'downloading' | 'ready-to-install' | 'error';
  version?: string;
  /** 0–100, present only while `status === 'downloading'`. */
  downloadPercent?: number;
  error?: string;
}

/** A status push from the update backend (the renderer-facing event stream). */
export type UpdateStatusListener = (result: UpdateCheckResult) => void;

/**
 * Abstraction over the real electron-updater (or a noop/mock).
 *
 * `checkForUpdates` is the one-shot poll. `subscribe` (optional) wires the
 * backend's push events — available → downloading(%) → ready-to-install /
 * error — so the controller can surface progress to the user instead of
 * silently downloading in the background. `quitAndInstall` (optional)
 * applies a downloaded update immediately.
 */
export interface UpdateBackend {
  checkForUpdates(): Promise<UpdateCheckResult>;
  subscribe?(onStatus: UpdateStatusListener): void;
  quitAndInstall?(): void;
}

/**
 * Pure mapping from an electron-updater event name + payload to our
 * UpdateCheckResult. Extracted so the event→status translation is unit-tested
 * without spawning Electron (the ElectronUpdaterBackend just forwards events
 * through this).
 */
export function updateStatusFromEvent(
  event: 'checking-for-update' | 'update-available' | 'update-not-available' | 'download-progress' | 'update-downloaded' | 'error',
  payload?: { version?: string; percent?: number; message?: string },
): UpdateCheckResult {
  switch (event) {
    case 'update-available':
      return { status: 'available', version: payload?.version };
    case 'download-progress':
      return {
        status: 'downloading',
        downloadPercent: Math.max(0, Math.min(100, Math.round(payload?.percent ?? 0))),
      };
    case 'update-downloaded':
      return { status: 'ready-to-install', version: payload?.version };
    case 'error':
      return { status: 'error', error: payload?.message ?? 'update failed' };
    case 'checking-for-update':
    case 'update-not-available':
    default:
      return { status: 'no-update' };
  }
}

/** Default backend: never fetches anything. Safe for unsigned/dev builds. */
export class NoopUpdateBackend implements UpdateBackend {
  async checkForUpdates(): Promise<UpdateCheckResult> {
    return { status: 'no-update' };
  }
  subscribe(_onStatus: UpdateStatusListener): void {
    /* no events ever fire in the noop backend */
  }
  quitAndInstall(): void {
    /* nothing to install */
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
  private readonly opts: { channel: 'stable' | 'beta'; feedURL?: string | null };
  private subscribed = false;

  constructor(opts: { channel: 'stable' | 'beta'; feedURL?: string | null } = { channel: 'stable' }) {
    this.opts = opts;
  }

  /**
   * Wire electron-updater's push events to `onStatus`. Idempotent: a second
   * call is a no-op so re-running startApp() never stacks duplicate listeners
   * (the autoUpdater EventEmitter is a process-global singleton). Each event is
   * normalized through `updateStatusFromEvent` so the renderer sees the same
   * UpdateCheckResult shape `checkForUpdates` returns.
   */
  subscribe(onStatus: UpdateStatusListener): void {
    if (this.subscribed) return;
    this.subscribed = true;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.on('update-available', (info: { version?: string }) =>
      onStatus(updateStatusFromEvent('update-available', { version: info?.version })),
    );
    autoUpdater.on('download-progress', (p: { percent?: number }) =>
      onStatus(updateStatusFromEvent('download-progress', { percent: p?.percent })),
    );
    autoUpdater.on('update-downloaded', (info: { version?: string }) =>
      onStatus(updateStatusFromEvent('update-downloaded', { version: info?.version })),
    );
    autoUpdater.on('error', (err: Error) =>
      onStatus(updateStatusFromEvent('error', { message: err?.message ?? String(err) })),
    );
  }

  /**
   * Apply a downloaded update now: quit the app and relaunch into the installer.
   * Only meaningful once an `update-downloaded` event has fired; calling it
   * earlier is a no-op inside electron-updater.
   */
  quitAndInstall(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.quitAndInstall();
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

    // #370: only call setFeedURL when the caller actually supplied an
    // override. The default path leaves autoUpdater alone so the
    // publisher config from apps/desktop/package.json (provider: github,
    // owner: jayzalowitz, repo: skytwin) takes effect — that's the
    // launch path. Self-hosters who want to point at their own update
    // server set SKYTWIN_UPDATE_URL on the desktop process; that value
    // flows through to here and overrides the GitHub publisher.
    if (this.opts.feedURL && this.opts.feedURL.length > 0) {
      autoUpdater.setFeedURL({ provider: 'generic', url: this.opts.feedURL });
    }

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
export function defaultBackend(opts?: { channel: 'stable' | 'beta'; feedURL?: string | null }): UpdateBackend {
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
 * Returns the configured auto-update feed-URL override, or `null` when
 * none is set. The `null` default is what lets electron-updater fall
 * back to the GitHub Releases publisher block in
 * `apps/desktop/package.json`.
 *
 * Priority order:
 *   1. Explicit `configURL` argument (non-empty string)
 *   2. `SKYTWIN_UPDATE_URL` environment variable (non-empty string)
 *   3. `null` — no override; package.json publisher takes effect
 *
 * Pre-#370 the third branch returned `'https://updates.skytwin.local/'`
 * — a non-existent placeholder domain that would have caused DNS
 * failures on every poll if it had ever been plumbed through (it
 * wasn't). The placeholder is gone; the null fallback is the
 * documented "use the publisher config" signal.
 */
export function resolveFeedURL(configURL?: string): string | null {
  if (configURL && configURL.length > 0) return configURL;
  const envURL = process.env['SKYTWIN_UPDATE_URL'];
  if (envURL && envURL.length > 0) return envURL;
  return null;
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
  private readonly statusListeners = new Set<UpdateStatusListener>();
  private subscribedToBackend = false;

  /**
   * @param config - Update configuration. Use defaultAutoUpdateConfig() for env-driven defaults.
   * @param backend - Injectable backend. When omitted, defaultBackend() is called:
   *   ElectronUpdaterBackend in a packaged Electron process, NoopUpdateBackend everywhere else.
   */
  constructor(config: AutoUpdateConfig, backend?: UpdateBackend) {
    this.config = config;
    // Propagate feedURL into the backend so the override (when set)
    // actually reaches electron-updater. Pre-#370 the config field was
    // decorative; now it's load-bearing for self-hosters who set
    // SKYTWIN_UPDATE_URL.
    this.backend = backend ?? defaultBackend({
      channel: config.channel,
      feedURL: config.feedURL,
    });
  }

  /**
   * Performs an immediate update check.
   * Always records the result in latestStatus.
   * Returns { status: 'no-update' } when the controller is disabled.
   */
  async checkNow(): Promise<UpdateCheckResult> {
    if (!this.config.enabled) {
      return this.recordAndNotify({ status: 'no-update' });
    }

    try {
      return this.recordAndNotify(await this.backend.checkForUpdates());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return this.recordAndNotify({ status: 'error', error: message });
    }
  }

  /**
   * Record `result` as the latest status and fan it out to every registered
   * listener. The single funnel for status changes — both the one-shot
   * `checkNow()` poll and the backend's push events (download progress,
   * ready-to-install) flow through here, so `getLatestStatus()` and the
   * renderer stream never disagree. A throwing listener can't take down the
   * others or the update flow.
   */
  private recordAndNotify(result: UpdateCheckResult): UpdateCheckResult {
    this.latestStatus = result;
    for (const listener of this.statusListeners) {
      try {
        listener(result);
      } catch {
        /* a misbehaving renderer-bridge listener must not break the update loop */
      }
    }
    return result;
  }

  /**
   * Register a listener for status changes (initial check, periodic checks, and
   * the backend's push events). Returns an unsubscribe function. main.ts uses
   * this to forward status to the renderer over IPC.
   */
  onStatus(listener: UpdateStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Begin the full update lifecycle: subscribe to the backend's push events
   * (so download progress + ready-to-install surface to listeners), schedule
   * periodic polling, and fire one immediate check. Disabled controllers and
   * backends without `subscribe` (the noop backend) degrade gracefully — the
   * call is still safe and idempotent.
   */
  start(): void {
    if (!this.config.enabled) return;
    if (!this.subscribedToBackend && typeof this.backend.subscribe === 'function') {
      this.subscribedToBackend = true;
      this.backend.subscribe((result) => this.recordAndNotify(result));
    }
    this.schedulePeriodicChecks();
    void this.checkNow();
  }

  /**
   * Apply a downloaded update now (quit + relaunch into the installer). Returns
   * false — and does NOT call the backend — unless a payload is actually
   * downloaded (`getLatestStatus().status === 'ready-to-install'`) AND the
   * backend can install (the noop backend in a dev/unsigned build can't). This
   * matches the documented `installUpdate()` preload contract: a caller that
   * gets `false` knows nothing was installed and can keep the "restart to
   * update" affordance honest, rather than reporting a phantom success.
   */
  installNow(): boolean {
    if (typeof this.backend.quitAndInstall !== 'function') return false;
    if (this.latestStatus.status !== 'ready-to-install') return false;
    this.backend.quitAndInstall();
    return true;
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
