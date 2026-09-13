import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import type { ChildProcess, fork } from 'child_process';
import type { DesktopKeyBroker } from '../key-broker.js';

/**
 * `getEnv()` is the single place the desktop composes the environment for the
 * API, the worker, headless mode, and the idle-miner. Two invariants are
 * load-bearing for a packaged build and are pinned here:
 *
 *  1. `SKYTWIN_SERVICE_TOKEN` is minted per install, persisted 0600, and stable
 *     across calls — it is the only credential the worker / idle-miner have for
 *     the API's `sessionAuth`-guarded `/api/events/ingest`.
 *  2. `SKYTWIN_DEV_AUTH_BYPASS` is pinned to `'false'` AFTER the
 *     `...process.env` spread, so a developer's shell bypass can never be
 *     inherited into a packaged build.
 */

const userDataDir = mkdtempSync(join(tmpdir(), 'skytwin-sm-env-'));

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string): string => userDataDir,
    getAppPath: (): string => process.cwd(),
    isPackaged: false,
  },
}));

vi.mock('../cockroach-manager.js', () => ({
  CockroachManager: vi.fn(function CockroachManager() {
    return { getConnectionString: (): string => 'postgresql://root@localhost:26257/skytwin' };
  }),
}));

const { ServiceManager } = await import('../service-manager.js');

/** `getEnv` is private; the test reaches it deliberately rather than
 *  exercising it through a real process fork. */
function envOf(sm: InstanceType<typeof ServiceManager>): Record<string, string> {
  return (sm as unknown as { getEnv(): Record<string, string> }).getEnv();
}

describe('ServiceManager.getEnv()', () => {
  const saved = {
    SKYTWIN_DEV_AUTH_BYPASS: process.env['SKYTWIN_DEV_AUTH_BYPASS'],
    SKYTWIN_SERVICE_TOKEN: process.env['SKYTWIN_SERVICE_TOKEN'],
  };

  beforeEach(() => {
    delete process.env['SKYTWIN_DEV_AUTH_BYPASS'];
    delete process.env['SKYTWIN_SERVICE_TOKEN'];
    rmSync(join(userDataDir, 'secrets'), { recursive: true, force: true });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('mints a service token, persists it 0600, and reuses it across calls', () => {
    const sm = new ServiceManager();
    const first = envOf(sm)['SKYTWIN_SERVICE_TOKEN'];

    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const secretFile = join(userDataDir, 'secrets', 'service-token');
    expect(existsSync(secretFile)).toBe(true);
    expect(readFileSync(secretFile, 'utf-8').trim()).toBe(first);
    // Owner read/write only — the token authenticates as the local service.
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);

    // Stable across calls: the API (verifier) and the worker (presenter) are
    // forked from separate getEnv() calls and must agree.
    expect(envOf(new ServiceManager())['SKYTWIN_SERVICE_TOKEN']).toBe(first);
  });

  it('keeps the service token distinct from the session secret', () => {
    const env = envOf(new ServiceManager());
    expect(env['SKYTWIN_SERVICE_TOKEN']).not.toBe(env['SESSION_SECRET']);
  });

  it('honours an explicitly provided SKYTWIN_SERVICE_TOKEN', () => {
    process.env['SKYTWIN_SERVICE_TOKEN'] = 'operator-supplied';
    expect(envOf(new ServiceManager())['SKYTWIN_SERVICE_TOKEN']).toBe('operator-supplied');
  });

  it('pins SKYTWIN_DEV_AUTH_BYPASS=false even when the developer shell sets it to true', () => {
    process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'true';
    const env = envOf(new ServiceManager());
    // Pinned AFTER the ...process.env spread — the shell value loses.
    expect(env['SKYTWIN_DEV_AUTH_BYPASS']).toBe('false');
    expect(env['NODE_ENV']).toBe('production');
  });
});

describe('ServiceManager deletion boundary', () => {
  it('retries reconciliation and neither detects nor attaches an API before success', async () => {
    let resolveFirst!: (value: { success: false; error: 'vault_broker_unavailable' }) => void;
    let resolveSecond!: (value: { success: true; removed: number }) => void;
    const first = new Promise<{ success: false; error: 'vault_broker_unavailable' }>(
      resolve => { resolveFirst = resolve; },
    );
    const second = new Promise<{ success: true; removed: number }>(
      resolve => { resolveSecond = resolve; },
    );
    const reconcilePendingDeletions = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const attachChild = vi.fn();
    const broker = { reconcilePendingDeletions, attachChild } as unknown as DesktopKeyBroker;
    const child = new EventEmitter() as ChildProcess;
    child.connected = true;
    const forkProcess = vi.fn(() => child) as unknown as typeof fork;
    const sm = new ServiceManager(broker, {
      deletionCleanupRetryMs: 0,
      forkProcess,
    });
    const internal = sm as unknown as {
      startApi(): Promise<void>;
      detectExternalApi(): Promise<boolean>;
      ensureEmbeddedRoot(): Promise<string>;
    };
    const detectExternalApi = vi.fn().mockResolvedValue(false);
    internal.detectExternalApi = detectExternalApi;
    internal.ensureEmbeddedRoot = vi.fn().mockResolvedValue(process.cwd());

    const starting = internal.startApi();
    await Promise.resolve();
    expect(detectExternalApi).not.toHaveBeenCalled();
    expect(forkProcess).not.toHaveBeenCalled();
    expect(attachChild).not.toHaveBeenCalled();

    resolveFirst({ success: false, error: 'vault_broker_unavailable' });
    await vi.waitFor(() => expect(reconcilePendingDeletions).toHaveBeenCalledTimes(2));
    expect(detectExternalApi).not.toHaveBeenCalled();
    expect(forkProcess).not.toHaveBeenCalled();
    expect(attachChild).not.toHaveBeenCalled();

    resolveSecond({ success: true, removed: 1 });
    await starting;
    expect(detectExternalApi).toHaveBeenCalledTimes(1);
    expect(forkProcess).toHaveBeenCalledTimes(1);
    expect(attachChild).toHaveBeenCalledWith(child, 'api');
  });

  it('polls the durable ledger so external API deletions converge after startup', async () => {
    const reconcilePendingDeletions = vi.fn()
      .mockResolvedValue({ success: true, removed: 1 });
    const broker = { reconcilePendingDeletions } as unknown as DesktopKeyBroker;
    const sm = new ServiceManager(broker);
    await (sm as unknown as { runHealthCheck(): Promise<void> }).runHealthCheck();
    expect(reconcilePendingDeletions).toHaveBeenCalledTimes(1);
  });

  it('restores running managed children with empty bindings only after reconciliation recovers', async () => {
    const reconcilePendingDeletions = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'vault_broker_unavailable' })
      .mockResolvedValueOnce({ success: true, removed: 1 });
    const attachChild = vi.fn();
    const broker = { reconcilePendingDeletions, attachChild } as unknown as DesktopKeyBroker;
    const sm = new ServiceManager(broker);
    const apiChild = new EventEmitter() as ChildProcess;
    const workerChild = new EventEmitter() as ChildProcess;
    apiChild.connected = true;
    workerChild.connected = true;
    const internal = sm as unknown as {
      api: { process: ChildProcess | null };
      worker: { process: ChildProcess | null };
      runHealthCheck(): Promise<void>;
    };
    internal.api.process = apiChild;
    internal.worker.process = workerChild;

    await internal.runHealthCheck();
    expect(attachChild).not.toHaveBeenCalled();
    await internal.runHealthCheck();
    expect(attachChild).toHaveBeenCalledTimes(2);
    expect(attachChild).toHaveBeenNthCalledWith(1, apiChild, 'api');
    expect(attachChild).toHaveBeenNthCalledWith(2, workerChild, 'worker');
  });
});

// Clean up the temp userData dir once the file's tests are done.
process.on('exit', () => {
  rmSync(userDataDir, { recursive: true, force: true });
});
