import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  userData: '/tmp/skytwin-crdb-test',
}));

// Mock electron BEFORE importing CockroachManager so app.* doesn't blow up in node.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => electronState.userData,
  },
}));

const { CockroachManager } = await import('../cockroach-manager.js');

interface CockroachManagerInternals {
  isCrdbResponding(): Promise<boolean>;
  ensureDatabase(): Promise<void>;
}

interface FakeChild extends ChildProcess {
  exitCode: number | null;
}

function fakeChild(pid: number, emitExitOnKill = true): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    pid,
    exitCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.exitCode = 0;
      if (emitExitOnKill) queueMicrotask(() => child.emit('exit', 0, null));
      return true;
    }),
  });
  return child;
}

function markerPath(args: readonly string[], prefix: string): string {
  const arg = args.find((value) => value.startsWith(prefix));
  if (!arg) throw new Error(`missing ${prefix}`);
  return arg.slice(prefix.length);
}

function writeOwnedMarkers(child: FakeChild, args: readonly string[]): void {
  writeFileSync(markerPath(args, '--pid-file='), String(child.pid));
  writeFileSync(
    markerPath(args, '--listening-url-file='),
    'postgresql://root@127.0.0.1:26257/defaultdb?sslmode=disable',
  );
}

describe('CockroachManager', () => {
  beforeEach(() => {
    electronState.userData = mkdtempSync(join(tmpdir(), 'skytwin-crdb-test-'));
    delete process.env['SKYTWIN_DB_PORT'];
    delete process.env['SKYTWIN_DB_HTTP_PORT'];
  });

  afterEach(() => {
    rmSync(electronState.userData, { recursive: true, force: true });
  });

  it('honors SKYTWIN_DB_PORT for the connection string', () => {
    process.env['SKYTWIN_DB_PORT'] = '29257';
    const mgr = new CockroachManager();
    // Default listen host is 127.0.0.1 (not 'localhost') so we never
    // accidentally bind IPv6 :: on systems whose /etc/hosts maps
    // localhost to the unspecified address — that would expose the
    // --insecure CRDB to the LAN.
    expect(mgr.getConnectionString()).toBe('postgresql://root@127.0.0.1:29257/skytwin?sslmode=disable');
  });

  it('defaults to port 26257 when no env override', () => {
    const mgr = new CockroachManager();
    expect(mgr.getConnectionString()).toContain(':26257/');
  });

  it('binds 127.0.0.1 by default, not localhost', () => {
    const mgr = new CockroachManager();
    expect(mgr.getConnectionString()).toContain('@127.0.0.1:');
    expect(mgr.getConnectionString()).not.toContain('@localhost:');
  });

  it('resolves a per-platform binary path under userData in dev (unpackaged)', () => {
    const mgr = new CockroachManager();
    const bin = mgr.getBinaryPath();
    // In dev (mocked app.isPackaged=false), we fall back to ~/.local/share/skytwin/bin.
    expect(bin).toMatch(/\.local\/share\/skytwin\/bin\/cockroach(\.exe)?$/);
  });

  it('keeps the data dir under app.getPath(userData)', () => {
    const mgr = new CockroachManager();
    expect(mgr.getDataDir()).toBe(join(electronState.userData, 'crdb-data'));
  });

  it('allows explicit port overrides via constructor', () => {
    const mgr = new CockroachManager({ sqlPort: 31000 });
    expect(mgr.getConnectionString()).toContain(':31000/');
  });

  it('does not claim ownership of a pre-existing CockroachDB responder', async () => {
    const mgr = new CockroachManager() as InstanceType<typeof CockroachManager> & CockroachManagerInternals;
    mgr.isCrdbResponding = vi.fn().mockResolvedValue(true);
    mgr.ensureDatabase = vi.fn().mockResolvedValue(undefined);

    await expect(mgr.start()).resolves.toEqual({
      ownership: 'preexisting',
      dataDir: null,
      generation: null,
    });
    expect(mgr.ensureDatabase).not.toHaveBeenCalled();
  });

  it('rejects a foreign responder that wins the port while the child remains live', async () => {
    const spawned = fakeChild(4101);
    const spawnImpl = vi.fn(() => spawned) as unknown as typeof spawn;
    const mgr = new CockroachManager({
      startTimeoutMs: 10,
      spawnImpl,
    }) as InstanceType<typeof CockroachManager> & CockroachManagerInternals;
    mgr.getBinaryPath = vi.fn().mockReturnValue(process.execPath);
    mgr.isCrdbResponding = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);

    await expect(mgr.start()).rejects.toThrow(/owned SQL readiness/);
    expect(spawned.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cleans a timed-out child before a retry establishes fresh ownership', async () => {
    const first = fakeChild(4102);
    const second = fakeChild(4103);
    let starts = 0;
    const spawnImpl = vi.fn((_bin: string, args: readonly string[]) => {
      if (args[0] !== 'start-single-node') {
        const sql = fakeChild(5100 + starts);
        queueMicrotask(() => {
          sql.exitCode = 0;
          sql.emit('exit', 0, null);
        });
        return sql;
      }
      const child = starts++ === 0 ? first : second;
      if (child === second) writeOwnedMarkers(child, args);
      return child;
    }) as unknown as typeof spawn;
    const mgr = new CockroachManager({
      startTimeoutMs: 10,
      spawnImpl,
    }) as InstanceType<typeof CockroachManager> & CockroachManagerInternals;
    mgr.getBinaryPath = vi.fn().mockReturnValue(process.execPath);
    mgr.isCrdbResponding = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);

    await expect(mgr.start()).rejects.toThrow(/owned SQL readiness/);
    (mgr.isCrdbResponding as ReturnType<typeof vi.fn>).mockReset();
    (mgr.isCrdbResponding as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false).mockResolvedValue(true);
    const startup = await mgr.start();

    expect(first.kill).toHaveBeenCalledWith('SIGTERM');
    expect(startup).toMatchObject({ ownership: 'managed-child' });
    expect(startup.generation).toBeGreaterThan(1);
    expect(mgr.isManagedStartCurrent(startup)).toBe(true);
    expect(spawnImpl.mock.calls.filter((call) => call[1]?.[0] === 'start-single-node')).toHaveLength(2);
  });

  it('rejects a capability whose store path does not exactly match the spawned store', async () => {
    const child = fakeChild(4104);
    const spawnImpl = vi.fn((_bin: string, args: readonly string[]) => {
      if (args[0] === 'start-single-node') writeOwnedMarkers(child, args);
      else queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    }) as unknown as typeof spawn;
    const mgr = new CockroachManager({ spawnImpl }) as InstanceType<typeof CockroachManager> &
      CockroachManagerInternals;
    mgr.getBinaryPath = vi.fn().mockReturnValue(process.execPath);
    mgr.isCrdbResponding = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    mgr.ensureDatabase = vi.fn().mockResolvedValue(undefined);
    const startup = await mgr.start();

    expect(
      mgr.isManagedStartCurrent({
        ...startup,
        dataDir: join(electronState.userData, 'other'),
      }),
    ).toBe(false);
  });

  it('does not let an old child exit clear a newer managed generation', async () => {
    const first = fakeChild(4105, false);
    const second = fakeChild(4106);
    let starts = 0;
    const spawnImpl = vi.fn((_bin: string, args: readonly string[]) => {
      const child = starts++ === 0 ? first : second;
      writeOwnedMarkers(child, args);
      return child;
    }) as unknown as typeof spawn;
    const mgr = new CockroachManager({ spawnImpl }) as InstanceType<typeof CockroachManager> &
      CockroachManagerInternals;
    mgr.getBinaryPath = vi.fn().mockReturnValue(process.execPath);
    mgr.isCrdbResponding = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    mgr.ensureDatabase = vi.fn().mockResolvedValue(undefined);
    await mgr.start();
    await mgr.stop();
    (mgr.isCrdbResponding as ReturnType<typeof vi.fn>).mockReset();
    (mgr.isCrdbResponding as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false).mockResolvedValue(true);
    const current = await mgr.start();

    first.emit('exit', 0, null);
    expect(mgr.isManagedStartCurrent(current)).toBe(true);
  });
});
