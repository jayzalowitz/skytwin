import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

// Clean up the temp userData dir once the file's tests are done.
process.on('exit', () => {
  rmSync(userDataDir, { recursive: true, force: true });
});
