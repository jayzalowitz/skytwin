import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * `getEnv()` composes the common child environment. Packaged API/worker pairs
 * replace its persisted service-token fallback with a generation-scoped
 * in-memory credential; source-development pairs retain the stable fallback.
 * Two base invariants are pinned here:
 *
 *  1. `SKYTWIN_SERVICE_TOKEN` is minted per install, persisted 0600, and stable
 *     across calls for source-development and operator-managed services.
 *  2. `SKYTWIN_DEV_AUTH_BYPASS` is pinned to `'false'` AFTER the
 *     `...process.env` spread, so a developer's shell bypass can never be
 *     inherited into a packaged build.
 *  3. Packaged children are pinned to the account-free connection mode and
 *     receive no Microsoft or bundled/default provider credentials.
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
    return {
      getConnectionString: (): string => 'postgresql://root@localhost:26257/skytwin',
      setAuthorityLossHandler: vi.fn(),
    };
  }),
}));

const { ServiceManager } = await import('../service-manager.js');
const { app: electronApp } = await import('electron');

function setPackaged(value: boolean): void {
  (electronApp as unknown as { isPackaged: boolean }).isPackaged = value;
}

/** `getEnv` is private; the test reaches it deliberately rather than
 *  exercising it through a real process fork. */
function envOf(sm: InstanceType<typeof ServiceManager>): Record<string, string> {
  return (sm as unknown as { getEnv(): Record<string, string> }).getEnv();
}

function apiEnvOf(sm: InstanceType<typeof ServiceManager>): Record<string, string> {
  return (sm as unknown as { apiEnv(instanceCapability: string): Record<string, string> })
    .apiEnv('instance-capability');
}

describe('ServiceManager.getEnv()', () => {
  const saved = {
    SKYTWIN_DEV_AUTH_BYPASS: process.env['SKYTWIN_DEV_AUTH_BYPASS'],
    SKYTWIN_SERVICE_TOKEN: process.env['SKYTWIN_SERVICE_TOKEN'],
    SKYTWIN_RELEASE_EVIDENCE_NONCE: process.env['SKYTWIN_RELEASE_EVIDENCE_NONCE'],
    SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE: process.env['SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE'],
    SKYTWIN_RELEASE_EVIDENCE_RENDERER_PROOF: process.env['SKYTWIN_RELEASE_EVIDENCE_RENDERER_PROOF'],
    SKYTWIN_GOOGLE_CONNECTION_MODE: process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'],
    SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID: process.env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID'],
    GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'],
    GOOGLE_CLIENT_SECRET: process.env['GOOGLE_CLIENT_SECRET'],
    MICROSOFT_CLIENT_ID: process.env['MICROSOFT_CLIENT_ID'],
    MICROSOFT_CLIENT_SECRET: process.env['MICROSOFT_CLIENT_SECRET'],
    MICROSOFT_REDIRECT_URI: process.env['MICROSOFT_REDIRECT_URI'],
    MICROSOFT_TENANT: process.env['MICROSOFT_TENANT'],
    SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID: process.env['SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID'],
  };

  beforeEach(() => {
    setPackaged(false);
    delete process.env['SKYTWIN_DEV_AUTH_BYPASS'];
    delete process.env['SKYTWIN_SERVICE_TOKEN'];
    delete process.env['SKYTWIN_RELEASE_EVIDENCE_NONCE'];
    delete process.env['SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE'];
    delete process.env['SKYTWIN_RELEASE_EVIDENCE_RENDERER_PROOF'];
    delete process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'];
    delete process.env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID'];
    delete process.env['GOOGLE_CLIENT_ID'];
    delete process.env['GOOGLE_CLIENT_SECRET'];
    delete process.env['MICROSOFT_CLIENT_ID'];
    delete process.env['MICROSOFT_CLIENT_SECRET'];
    delete process.env['MICROSOFT_REDIRECT_URI'];
    delete process.env['MICROSOFT_TENANT'];
    delete process.env['SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID'];
    rmSync(join(userDataDir, 'secrets'), { recursive: true, force: true });
  });

  afterEach(() => {
    setPackaged(false);
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

    // Stable fallback for separately managed source-development services.
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

  it('keeps the source-development API credential stable across API generations', () => {
    const sm = new ServiceManager();
    const first = apiEnvOf(sm)['SKYTWIN_SERVICE_TOKEN'];
    const second = apiEnvOf(sm)['SKYTWIN_SERVICE_TOKEN'];

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);

    process.env['SKYTWIN_SERVICE_TOKEN'] = 'operator-supplied';
    expect(apiEnvOf(new ServiceManager())['SKYTWIN_SERVICE_TOKEN']).toBe('operator-supplied');
  });

  it('pins SKYTWIN_DEV_AUTH_BYPASS=false even when the developer shell sets it to true', () => {
    process.env['SKYTWIN_DEV_AUTH_BYPASS'] = 'true';
    const env = envOf(new ServiceManager());
    // Pinned AFTER the ...process.env spread — the shell value loses.
    expect(env['SKYTWIN_DEV_AUTH_BYPASS']).toBe('false');
    expect(env['NODE_ENV']).toBe('production');
  });

  it('forces packaged children into disabled Google mode despite inherited opt-in and credentials', () => {
    setPackaged(true);
    process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'] = 'experimental';
    process.env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID'] = 'launcher-default-client';
    process.env['GOOGLE_CLIENT_ID'] = 'launcher-client';
    process.env['GOOGLE_CLIENT_SECRET'] = 'launcher-secret';
    process.env['MICROSOFT_CLIENT_ID'] = 'launcher-microsoft-client';
    process.env['MICROSOFT_CLIENT_SECRET'] = 'launcher-microsoft-secret';
    process.env['MICROSOFT_REDIRECT_URI'] = 'https://launcher.example/microsoft/callback';
    process.env['MICROSOFT_TENANT'] = 'launcher-tenant';
    process.env['SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID'] = 'launcher-microsoft-default';

    const env = envOf(new ServiceManager());

    expect(env['SKYTWIN_GOOGLE_CONNECTION_MODE']).toBe('disabled');
    expect(env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID']).toBe('');
    // Operator credentials may remain inherited, but cannot enable Google: the
    // typed mode above is the downstream runtime authority.
    expect(env['GOOGLE_CLIENT_ID']).toBe('launcher-client');
    expect(env['GOOGLE_CLIENT_SECRET']).toBe('launcher-secret');
    expect(env['MICROSOFT_CLIENT_ID']).toBe('');
    expect(env['MICROSOFT_CLIENT_SECRET']).toBe('');
    expect(env['MICROSOFT_REDIRECT_URI']).toBe('');
    expect(env['MICROSOFT_TENANT']).toBe('');
    expect(env['SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID']).toBe('');
  });

  it('retains an explicit experimental opt-in for source-development children', () => {
    process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'] = 'experimental';
    process.env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID'] = 'operator-client';
    process.env['MICROSOFT_CLIENT_ID'] = 'operator-microsoft-client';
    process.env['MICROSOFT_CLIENT_SECRET'] = 'operator-microsoft-secret';
    process.env['MICROSOFT_TENANT'] = 'operator-tenant';

    const env = envOf(new ServiceManager());

    expect(env['SKYTWIN_GOOGLE_CONNECTION_MODE']).toBe('experimental');
    expect(env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID']).toBe('operator-client');
    expect(env['MICROSOFT_CLIENT_ID']).toBe('operator-microsoft-client');
    expect(env['MICROSOFT_CLIENT_SECRET']).toBe('operator-microsoft-secret');
    expect(env['MICROSOFT_TENANT']).toBe('operator-tenant');
  });

  it('leaves optional Microsoft inputs absent in source development when unset', () => {
    const env = envOf(new ServiceManager());

    expect(env['MICROSOFT_CLIENT_ID']).toBeUndefined();
    expect(env['MICROSOFT_CLIENT_SECRET']).toBeUndefined();
    expect(env['MICROSOFT_REDIRECT_URI']).toBeUndefined();
    expect(env['MICROSOFT_TENANT']).toBeUndefined();
    expect(env['SKYTWIN_DEFAULT_MICROSOFT_CLIENT_ID']).toBeUndefined();
  });

  it('keeps renderer-proof authority out of every service child environment', () => {
    process.env['SKYTWIN_RELEASE_EVIDENCE_NONCE'] = 'api-attribution';
    process.env['SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE'] = 'renderer-authority';
    process.env['SKYTWIN_RELEASE_EVIDENCE_RENDERER_PROOF'] = '/private/proof.json';
    const env = envOf(new ServiceManager());
    expect(env['SKYTWIN_RELEASE_EVIDENCE_NONCE']).toBe('api-attribution');
    expect(env['SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE']).toBeUndefined();
    expect(env['SKYTWIN_RELEASE_EVIDENCE_RENDERER_PROOF']).toBeUndefined();
  });
});

// Clean up the temp userData dir once the file's tests are done.
process.on('exit', () => {
  rmSync(userDataDir, { recursive: true, force: true });
});
