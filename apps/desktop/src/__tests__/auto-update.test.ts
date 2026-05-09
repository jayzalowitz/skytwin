import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AutoUpdateController,
  NoopUpdateBackend,
  ElectronUpdaterBackend,
  defaultBackend,
  defaultAutoUpdateConfig,
  resolveFeedURL,
  type AutoUpdateConfig,
  type UpdateBackend,
  type UpdateCheckResult,
} from '../auto-update.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AutoUpdateConfig> = {}): AutoUpdateConfig {
  return {
    enabled: true,
    feedURL: 'https://updates.skytwin.local/',
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

  async checkForUpdates(): Promise<UpdateCheckResult> {
    this.callCount++;
    if (this.shouldThrow) {
      throw new Error('network error');
    }
    return this.nextResult;
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

  it('falls back to the .local placeholder when neither is set', () => {
    delete process.env['SKYTWIN_UPDATE_URL'];
    const url = resolveFeedURL('');
    expect(url).toBe('https://updates.skytwin.local/');
  });

  it('does not contain any real production domain in the placeholder', () => {
    delete process.env['SKYTWIN_UPDATE_URL'];
    const url = resolveFeedURL();
    // The placeholder is .local — not a real internet domain.
    expect(url).toMatch(/\.local\//);
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

  it('feedURL defaults to the .local placeholder when env var is unset', () => {
    const saved = process.env['SKYTWIN_UPDATE_URL'];
    delete process.env['SKYTWIN_UPDATE_URL'];
    const cfg = defaultAutoUpdateConfig();
    expect(cfg.feedURL).toMatch(/\.local\//);
    if (saved !== undefined) process.env['SKYTWIN_UPDATE_URL'] = saved;
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
