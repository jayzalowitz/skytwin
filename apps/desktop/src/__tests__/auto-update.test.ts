import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AutoUpdateController,
  NoopUpdateBackend,
  ElectronUpdaterBackend,
  defaultBackend,
  defaultAutoUpdateConfig,
  resolveFeedURL,
  updateStatusFromEvent,
  type AutoUpdateConfig,
  type UpdateBackend,
  type UpdateCheckResult,
  type UpdateStatusListener,
} from '../auto-update.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AutoUpdateConfig> = {}): AutoUpdateConfig {
  return {
    enabled: true,
    // Post-#370 default: null → no override → package.json GitHub
    // publisher takes effect. Tests that exercise the self-hosted
    // override path explicitly set a string via `overrides`.
    feedURL: null,
    channel: 'stable',
    checkIntervalMs: 100, // short interval so timer tests don't take forever
    ...overrides,
  };
}

/** A controllable UpdateBackend for testing. */
class StubBackend implements UpdateBackend {
  public callCount = 0;
  public nextResult: UpdateCheckResult = { status: 'no-update' };
  public shouldThrow = false;
  /** Captured listener from subscribe(); call emit() to push events through it. */
  public subscribeCount = 0;
  public installCount = 0;
  private pushListener: UpdateStatusListener | null = null;

  async checkForUpdates(): Promise<UpdateCheckResult> {
    this.callCount++;
    if (this.shouldThrow) {
      throw new Error('network error');
    }
    return this.nextResult;
  }

  subscribe(onStatus: UpdateStatusListener): void {
    this.subscribeCount++;
    this.pushListener = onStatus;
  }

  /** Simulate a backend push event (download-progress, ready-to-install, …). */
  emit(result: UpdateCheckResult): void {
    this.pushListener?.(result);
  }

  quitAndInstall(): void {
    this.installCount++;
  }
}

// ---------------------------------------------------------------------------
// NoopUpdateBackend
// ---------------------------------------------------------------------------

describe('NoopUpdateBackend', () => {
  it('checkForUpdates() resolves to { status: no-update }', async () => {
    const backend = new NoopUpdateBackend();
    const result = await backend.checkForUpdates();
    expect(result.status).toBe('no-update');
  });

  it('checkForUpdates() never rejects', async () => {
    const backend = new NoopUpdateBackend();
    await expect(backend.checkForUpdates()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// resolveFeedURL
// ---------------------------------------------------------------------------

describe('resolveFeedURL', () => {
  const originalEnv = process.env['SKYTWIN_UPDATE_URL'];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['SKYTWIN_UPDATE_URL'];
    } else {
      process.env['SKYTWIN_UPDATE_URL'] = originalEnv;
    }
  });

  it('returns the explicit config URL when provided', () => {
    const url = resolveFeedURL('https://my-server.example.com/updates/');
    expect(url).toBe('https://my-server.example.com/updates/');
  });

  it('falls back to SKYTWIN_UPDATE_URL env var when no config URL', () => {
    process.env['SKYTWIN_UPDATE_URL'] = 'https://env.example.com/updates/';
    const url = resolveFeedURL('');
    expect(url).toBe('https://env.example.com/updates/');
  });

  it('returns null when neither config nor env var is set (#370: package.json publisher takes over)', () => {
    // Pre-#370 this branch returned the `.local` placeholder. Now it
    // returns null, which signals "leave electron-updater alone" so the
    // GitHub Releases publisher block in apps/desktop/package.json
    // takes effect.
    delete process.env['SKYTWIN_UPDATE_URL'];
    expect(resolveFeedURL('')).toBeNull();
    expect(resolveFeedURL()).toBeNull();
  });

  it('treats an empty SKYTWIN_UPDATE_URL the same as unset (no override → null)', () => {
    process.env['SKYTWIN_UPDATE_URL'] = '';
    expect(resolveFeedURL('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AutoUpdateController — checkNow()
// ---------------------------------------------------------------------------

describe('AutoUpdateController.checkNow()', () => {
  it('returns { status: no-update } when using NoopUpdateBackend (default)', async () => {
    const controller = new AutoUpdateController(makeConfig());
    const result = await controller.checkNow();
    expect(result.status).toBe('no-update');
  });

  it('returns { status: no-update } when enabled:false, without calling the backend', async () => {
    const stub = new StubBackend();
    const controller = new AutoUpdateController(makeConfig({ enabled: false }), stub);
    const result = await controller.checkNow();
    expect(result.status).toBe('no-update');
    expect(stub.callCount).toBe(0);
  });

  it('returns the result from a stub backend that reports an update available', async () => {
    const stub = new StubBackend();
    stub.nextResult = { status: 'available', version: '1.2.0' };
    const controller = new AutoUpdateController(makeConfig(), stub);
    const result = await controller.checkNow();
    expect(result.status).toBe('available');
    expect(result.version).toBe('1.2.0');
  });

  it('wraps a thrown error into { status: error, error: message }', async () => {
    const stub = new StubBackend();
    stub.shouldThrow = true;
    const controller = new AutoUpdateController(makeConfig(), stub);
    const result = await controller.checkNow();
    expect(result.status).toBe('error');
    expect(result.error).toContain('network error');
  });

  it('calls the backend exactly once per checkNow() invocation', async () => {
    const stub = new StubBackend();
    const controller = new AutoUpdateController(makeConfig(), stub);
    await controller.checkNow();
    await controller.checkNow();
    expect(stub.callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AutoUpdateController — getLatestStatus()
// ---------------------------------------------------------------------------

describe('AutoUpdateController.getLatestStatus()', () => {
  it('starts as { status: no-update } before any check', () => {
    const controller = new AutoUpdateController(makeConfig());
    expect(controller.getLatestStatus().status).toBe('no-update');
  });

  it('reflects the most recent check result after checkNow()', async () => {
    const stub = new StubBackend();
    stub.nextResult = { status: 'downloading', version: '2.0.0' };
    const controller = new AutoUpdateController(makeConfig(), stub);
    await controller.checkNow();
    expect(controller.getLatestStatus()).toEqual({ status: 'downloading', version: '2.0.0' });
  });

  it('updates to latest result on subsequent calls', async () => {
    const stub = new StubBackend();
    const controller = new AutoUpdateController(makeConfig(), stub);

    stub.nextResult = { status: 'available', version: '1.1.0' };
    await controller.checkNow();
    expect(controller.getLatestStatus().status).toBe('available');

    stub.nextResult = { status: 'ready-to-install', version: '1.1.0' };
    await controller.checkNow();
    expect(controller.getLatestStatus().status).toBe('ready-to-install');
  });
});

// ---------------------------------------------------------------------------
// AutoUpdateController — schedulePeriodicChecks() / cancelScheduledChecks()
// ---------------------------------------------------------------------------

describe('AutoUpdateController — periodic checks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedulePeriodicChecks() sets a timer (isScheduled returns true)', () => {
    const controller = new AutoUpdateController(makeConfig());
    expect(controller.isScheduled()).toBe(false);
    controller.schedulePeriodicChecks();
    expect(controller.isScheduled()).toBe(true);
    controller.cancelScheduledChecks();
  });

  it('cancelScheduledChecks() clears the timer (isScheduled returns false)', () => {
    const controller = new AutoUpdateController(makeConfig());
    controller.schedulePeriodicChecks();
    controller.cancelScheduledChecks();
    expect(controller.isScheduled()).toBe(false);
  });

  it('cancelScheduledChecks() is safe to call when no timer is active', () => {
    const controller = new AutoUpdateController(makeConfig());
    // Should not throw
    expect(() => controller.cancelScheduledChecks()).not.toThrow();
  });

  it('schedulePeriodicChecks() does not stack duplicate timers when called twice', async () => {
    const stub = new StubBackend();
    const controller = new AutoUpdateController(makeConfig({ checkIntervalMs: 100 }), stub);
    controller.schedulePeriodicChecks();
    controller.schedulePeriodicChecks(); // second call is a no-op

    await vi.advanceTimersByTimeAsync(250);
    // With a 100 ms interval and 250 ms elapsed, exactly 2 ticks expected.
    // If duplicate timers were stacked it would be 4.
    expect(stub.callCount).toBe(2);

    controller.cancelScheduledChecks();
  });

  it('periodic timer invokes checkNow() at each interval', async () => {
    const stub = new StubBackend();
    const controller = new AutoUpdateController(makeConfig({ checkIntervalMs: 100 }), stub);
    controller.schedulePeriodicChecks();

    await vi.advanceTimersByTimeAsync(350);
    expect(stub.callCount).toBe(3);

    controller.cancelScheduledChecks();
  });

  it('after cancel, advancing time does not trigger additional checks', async () => {
    const stub = new StubBackend();
    const controller = new AutoUpdateController(makeConfig({ checkIntervalMs: 100 }), stub);
    controller.schedulePeriodicChecks();
    await vi.advanceTimersByTimeAsync(150);
    const countAtCancel = stub.callCount;
    controller.cancelScheduledChecks();
    await vi.advanceTimersByTimeAsync(300);
    expect(stub.callCount).toBe(countAtCancel);
  });
});

// ---------------------------------------------------------------------------
// defaultAutoUpdateConfig
// ---------------------------------------------------------------------------

describe('defaultAutoUpdateConfig', () => {
  it('returns enabled:true by default', () => {
    const cfg = defaultAutoUpdateConfig();
    expect(cfg.enabled).toBe(true);
  });

  it('returns channel:stable by default', () => {
    const cfg = defaultAutoUpdateConfig();
    expect(cfg.channel).toBe('stable');
  });

  it('checkIntervalMs is 6 hours (21600000 ms)', () => {
    const cfg = defaultAutoUpdateConfig();
    expect(cfg.checkIntervalMs).toBe(6 * 60 * 60 * 1_000);
  });

  it('feedURL defaults to null when env var is unset (#370: lets package.json publisher take effect)', () => {
    const saved = process.env['SKYTWIN_UPDATE_URL'];
    delete process.env['SKYTWIN_UPDATE_URL'];
    const cfg = defaultAutoUpdateConfig();
    expect(cfg.feedURL).toBeNull();
    if (saved !== undefined) process.env['SKYTWIN_UPDATE_URL'] = saved;
  });

  it('feedURL picks up SKYTWIN_UPDATE_URL when set (self-host override path)', () => {
    const saved = process.env['SKYTWIN_UPDATE_URL'];
    process.env['SKYTWIN_UPDATE_URL'] = 'https://updates.self-host.example.com/';
    const cfg = defaultAutoUpdateConfig();
    expect(cfg.feedURL).toBe('https://updates.self-host.example.com/');
    if (saved === undefined) delete process.env['SKYTWIN_UPDATE_URL'];
    else process.env['SKYTWIN_UPDATE_URL'] = saved;
  });
});

// ---------------------------------------------------------------------------
// defaultBackend() — Electron-runtime detection
// ---------------------------------------------------------------------------

describe('defaultBackend()', () => {
  it('returns NoopUpdateBackend when process.versions.electron is unset (test environment)', () => {
    // In Vitest / Node.js, process.versions.electron is not set.
    const backend = defaultBackend();
    expect(backend).toBeInstanceOf(NoopUpdateBackend);
  });

  it('returns NoopUpdateBackend with explicit channel option when not in Electron', () => {
    const backend = defaultBackend({ channel: 'beta' });
    expect(backend).toBeInstanceOf(NoopUpdateBackend);
  });

  it('returns ElectronUpdaterBackend when process.versions.electron is set', () => {
    // Temporarily simulate an Electron process by setting the version string.
    const versions = process.versions as Record<string, string | undefined>;
    const original = versions['electron'];
    versions['electron'] = '30.0.0';
    try {
      const backend = defaultBackend({ channel: 'stable' });
      expect(backend).toBeInstanceOf(ElectronUpdaterBackend);
    } finally {
      // Always restore — never leave the test process in a fake-Electron state.
      if (original === undefined) {
        delete versions['electron'];
      } else {
        versions['electron'] = original;
      }
    }
  });

  it('returns ElectronUpdaterBackend with beta channel when in Electron', () => {
    const versions = process.versions as Record<string, string | undefined>;
    const original = versions['electron'];
    versions['electron'] = '30.0.0';
    try {
      const backend = defaultBackend({ channel: 'beta' });
      expect(backend).toBeInstanceOf(ElectronUpdaterBackend);
    } finally {
      if (original === undefined) {
        delete versions['electron'];
      } else {
        versions['electron'] = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AutoUpdateController — defaultBackend wired via constructor
// ---------------------------------------------------------------------------

describe('AutoUpdateController — omitted backend uses defaultBackend()', () => {
  it('constructs without a backend arg and returns no-update in test env', async () => {
    // In test env (no process.versions.electron), defaultBackend() → Noop.
    const controller = new AutoUpdateController(makeConfig());
    const result = await controller.checkNow();
    expect(result.status).toBe('no-update');
  });

  it('explicit NoopUpdateBackend passed still works (regression guard)', async () => {
    const controller = new AutoUpdateController(makeConfig(), new NoopUpdateBackend());
    const result = await controller.checkNow();
    expect(result.status).toBe('no-update');
  });
});

// ---------------------------------------------------------------------------
// updateStatusFromEvent — pure event → status mapping (no Electron needed)
// ---------------------------------------------------------------------------

describe('updateStatusFromEvent', () => {
  it('maps update-available to { available, version }', () => {
    expect(updateStatusFromEvent('update-available', { version: '1.2.3' })).toEqual({
      status: 'available',
      version: '1.2.3',
    });
  });

  it('maps download-progress to { downloading, downloadPercent } (rounded + clamped)', () => {
    expect(updateStatusFromEvent('download-progress', { percent: 42.7 })).toEqual({
      status: 'downloading',
      downloadPercent: 43,
    });
    // Clamp out-of-range or missing values into 0–100.
    expect(updateStatusFromEvent('download-progress', { percent: -5 }).downloadPercent).toBe(0);
    expect(updateStatusFromEvent('download-progress', { percent: 250 }).downloadPercent).toBe(100);
    expect(updateStatusFromEvent('download-progress', {}).downloadPercent).toBe(0);
  });

  it('maps update-downloaded to { ready-to-install, version }', () => {
    expect(updateStatusFromEvent('update-downloaded', { version: '1.2.3' })).toEqual({
      status: 'ready-to-install',
      version: '1.2.3',
    });
  });

  it('maps error to { error, message } with a fallback message', () => {
    expect(updateStatusFromEvent('error', { message: 'boom' })).toEqual({
      status: 'error',
      error: 'boom',
    });
    expect(updateStatusFromEvent('error', {}).error).toBe('update failed');
  });

  it('maps checking / not-available to no-update', () => {
    expect(updateStatusFromEvent('checking-for-update').status).toBe('no-update');
    expect(updateStatusFromEvent('update-not-available').status).toBe('no-update');
  });
});

// ---------------------------------------------------------------------------
// AutoUpdateController — status stream (onStatus) + backend push events
// ---------------------------------------------------------------------------

describe('AutoUpdateController — onStatus stream', () => {
  it('notifies listeners on every checkNow() result', async () => {
    const backend = new StubBackend();
    backend.nextResult = { status: 'available', version: '2.0.0' };
    const controller = new AutoUpdateController(makeConfig(), backend);
    const seen: UpdateCheckResult[] = [];
    controller.onStatus((r) => seen.push(r));

    await controller.checkNow();

    expect(seen).toEqual([{ status: 'available', version: '2.0.0' }]);
  });

  it('forwards backend push events (download progress → ready-to-install) after start()', () => {
    const backend = new StubBackend();
    const controller = new AutoUpdateController(makeConfig(), backend);
    const seen: UpdateCheckResult[] = [];
    controller.onStatus((r) => seen.push(r));

    controller.start();
    backend.emit({ status: 'downloading', downloadPercent: 50 });
    backend.emit({ status: 'ready-to-install', version: '2.0.0' });

    // start() subscribes to the backend and the pushed events reach the listener.
    expect(backend.subscribeCount).toBe(1);
    expect(seen).toContainEqual({ status: 'downloading', downloadPercent: 50 });
    expect(seen).toContainEqual({ status: 'ready-to-install', version: '2.0.0' });
    // getLatestStatus reflects the most recent push, not just the last poll.
    expect(controller.getLatestStatus()).toEqual({ status: 'ready-to-install', version: '2.0.0' });
  });

  it('unsubscribe() stops further notifications', async () => {
    const backend = new StubBackend();
    const controller = new AutoUpdateController(makeConfig(), backend);
    const seen: UpdateCheckResult[] = [];
    const off = controller.onStatus((r) => seen.push(r));

    await controller.checkNow();
    off();
    await controller.checkNow();

    expect(seen).toHaveLength(1);
  });

  it('a throwing listener does not break the update loop or other listeners', async () => {
    const backend = new StubBackend();
    const controller = new AutoUpdateController(makeConfig(), backend);
    const seen: UpdateCheckResult[] = [];
    controller.onStatus(() => {
      throw new Error('renderer bridge gone');
    });
    controller.onStatus((r) => seen.push(r));

    await expect(controller.checkNow()).resolves.toBeDefined();
    expect(seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AutoUpdateController — start() + installNow()
// ---------------------------------------------------------------------------

describe('AutoUpdateController — start()', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('subscribes once, schedules periodic checks, and fires an immediate check', async () => {
    const backend = new StubBackend();
    const controller = new AutoUpdateController(makeConfig(), backend);

    controller.start();
    await vi.advanceTimersByTimeAsync(0); // flush the immediate checkNow()

    expect(backend.subscribeCount).toBe(1);
    expect(controller.isScheduled()).toBe(true);
    expect(backend.callCount).toBe(1);
    controller.cancelScheduledChecks();
  });

  it('is idempotent — calling start() twice does not double-subscribe', async () => {
    const backend = new StubBackend();
    const controller = new AutoUpdateController(makeConfig(), backend);

    controller.start();
    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.subscribeCount).toBe(1);
    controller.cancelScheduledChecks();
  });

  it('disabled controller does not subscribe or schedule', () => {
    const backend = new StubBackend();
    const controller = new AutoUpdateController(makeConfig({ enabled: false }), backend);

    controller.start();

    expect(backend.subscribeCount).toBe(0);
    expect(controller.isScheduled()).toBe(false);
  });
});

describe('AutoUpdateController — installNow()', () => {
  it('installs and returns true once an update is downloaded (ready-to-install)', async () => {
    const backend = new StubBackend();
    backend.nextResult = { status: 'ready-to-install', version: '1.0.0' };
    const controller = new AutoUpdateController(makeConfig(), backend);
    await controller.checkNow(); // latestStatus → ready-to-install

    const ok = controller.installNow();

    expect(ok).toBe(true);
    expect(backend.installCount).toBe(1);
  });

  it('returns false WITHOUT installing when no payload is downloaded yet', () => {
    // latestStatus defaults to no-update — installing now would be a phantom
    // success that violates the installUpdate() preload contract.
    const backend = new StubBackend();
    const controller = new AutoUpdateController(makeConfig(), backend);

    expect(controller.installNow()).toBe(false);
    expect(backend.installCount).toBe(0);
  });

  it('returns false when the backend cannot install (dev/unsigned build)', async () => {
    // An update is ready, but the backend has no quitAndInstall method —
    // installNow must still report it can't (the method-existence guard).
    const backend: UpdateBackend = {
      checkForUpdates: async () => ({ status: 'ready-to-install', version: '1.0.0' }),
    };
    const controller = new AutoUpdateController(makeConfig(), backend);
    await controller.checkNow(); // latestStatus → ready-to-install

    expect(controller.installNow()).toBe(false);
  });
});
