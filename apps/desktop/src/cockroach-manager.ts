import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

/**
 * Spawns and supervises the bundled CockroachDB single-node process.
 *
 * Why this exists:
 *   The desktop app used to require the user to install Docker + run
 *   `docker compose up cockroachdb` separately. Docker Desktop is the
 *   single biggest install blocker for non-technical users (size, license,
 *   "open it once after install" gotcha). We now ship the official CRDB
 *   binary directly inside the Electron resources tree and start it as a
 *   child process. No Docker, no system install, no separate setup step.
 *
 * Binary locations:
 *   - Packaged: `<resourcesPath>/cockroach/<platform-arch>/cockroach[.exe]`.
 *     Populated at build time by apps/desktop/scripts/build-single-binary.sh,
 *     which downloads the hash-verified release for every target platform
 *     and lays them out under dist/embedded/cockroach/.
 *   - Dev (unpackaged): falls back to the binary installed by `bin/skytwin-db
 *     install`, which lives under $HOME/.local/share/skytwin/bin/cockroach.
 *     This way `pnpm desktop:dev` doesn't need a per-platform copy of CRDB
 *     baked into apps/desktop.
 *
 * Data directory:
 *   `app.getPath('userData')/crdb-data` — survives across app launches,
 *   respects the user's per-OS Application Support / AppData layout, and
 *   is migrated automatically by Electron when the user moves their home
 *   directory. We never write into Program Files / /Applications etc.
 *
 * Ports:
 *   26257 SQL, 26258 admin UI (26258 instead of CRDB's default 8080 because
 *   8080 collides with practically every other dev tool). Configurable via
 *   SKYTWIN_DB_PORT / SKYTWIN_DB_HTTP_PORT.
 */

interface CockroachManagerOptions {
  sqlPort?: number;
  httpPort?: number;
  listenHost?: string;
  startTimeoutMs?: number;
  spawnImpl?: typeof spawn;
}

export type CockroachStartResult =
  | Readonly<{
      ownership: 'managed-child';
      dataDir: string;
      generation: number;
    }>
  | Readonly<{ ownership: 'preexisting'; dataDir: null; generation: null }>;

interface ManagedAuthority {
  readonly process: ChildProcess;
  readonly generation: number;
  readonly dataDir: string;
  readonly pidFile: string;
  readonly listeningUrlFile: string;
  revoked: boolean;
}

const DEFAULT_SQL_PORT = 26257;
const DEFAULT_HTTP_PORT = 26258;
// 127.0.0.1 instead of 'localhost' so we never accidentally bind IPv6 :: on
// systems whose /etc/hosts maps localhost to the unspecified address. CRDB
// runs --insecure here; broadcasting that to the LAN would be remote root.
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const DEFAULT_START_TIMEOUT_MS = 60_000;
// CRDB's drain can take 30s+ under load (WAL flush, replication completion).
// 5s SIGKILL would corrupt mid-flush.
const GRACEFUL_STOP_TIMEOUT_MS = 30_000;
const FORCED_STOP_TIMEOUT_MS = 2_000;

export class CockroachTerminationError extends Error {
  readonly code = 'COCKROACH_TERMINATION_UNPROVEN';

  constructor() {
    super('CockroachDB child termination could not be proven');
    this.name = 'CockroachTerminationError';
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('close', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

export class CockroachManager {
  private process: ChildProcess | null = null;
  private authority: ManagedAuthority | null = null;
  private lifecycleGeneration = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private authorityLossHandler: ((generation: number) => void) | null = null;
  private readonly sqlPort: number;
  private readonly httpPort: number;
  private readonly listenHost: string;
  private readonly startTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;

  constructor(opts: CockroachManagerOptions = {}) {
    this.sqlPort = opts.sqlPort ?? Number(process.env['SKYTWIN_DB_PORT'] ?? DEFAULT_SQL_PORT);
    this.httpPort = opts.httpPort ?? Number(process.env['SKYTWIN_DB_HTTP_PORT'] ?? DEFAULT_HTTP_PORT);
    this.listenHost = opts.listenHost ?? DEFAULT_LISTEN_HOST;
    this.startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.spawnImpl = opts.spawnImpl ?? spawn;
  }

  /**
   * Resolve the cockroach binary path for the current OS+arch.
   * Throws if the binary isn't present — callers should surface that as
   * a clear install-time error rather than a cryptic spawn failure.
   */
  getBinaryPath(): string {
    const platform = process.platform; // 'darwin' | 'linux' | 'win32'
    const arch = process.arch; // 'arm64' | 'x64'
    const subdir = `${platform}-${arch}`;
    const binName = platform === 'win32' ? 'cockroach.exe' : 'cockroach';

    if (app.isPackaged) {
      return join(process.resourcesPath, 'cockroach', subdir, binName);
    }
    // Dev fallback: use the binary installed by `bin/skytwin-db install`.
    // Keeps `pnpm desktop:dev` light — no need to bake CRDB into the
    // unpackaged tree.
    const home = homedir();
    return join(home, '.local', 'share', 'skytwin', 'bin', binName);
  }

  getDataDir(): string {
    const dataDir = join(app.getPath('userData'), 'crdb-data');
    try {
      return realpathSync(dataDir);
    } catch {
      return dataDir;
    }
  }

  getConnectionString(): string {
    return `postgresql://root@${this.listenHost}:${this.sqlPort}/skytwin?sslmode=disable`;
  }

  setAuthorityLossHandler(handler: (generation: number) => void): void {
    this.authorityLossHandler = handler;
  }

  /**
   * Start CockroachDB in single-node mode. A pre-existing responder is
   * reported but never mutated. Only this manager's exact child may receive
   * database initialization, after Cockroach has written fresh PID and
   * listening-URL files for the launch.
   */
  start(): Promise<CockroachStartResult> {
    return this.runSerialized(() => this.startOwned());
  }

  private async startOwned(): Promise<CockroachStartResult> {
    if (await this.isCrdbResponding()) {
      console.log('[crdb] Already running on', `${this.listenHost}:${this.sqlPort}`);
      const authority = this.authority;
      if (authority && this.isAuthorityCurrent(authority)) {
        return this.resultFor(authority);
      }
      // A retained but unattested child must never lend its identity to the
      // process answering the configured port.
      if (this.process) await this.terminateProcess(this.process);
      return Object.freeze({
        ownership: 'preexisting',
        dataDir: null,
        generation: null,
      });
    }

    const bin = this.getBinaryPath();
    if (!existsSync(bin)) {
      throw new Error(
        `CockroachDB binary missing at ${bin}. Run 'bin/skytwin-db install' (dev) or ` +
          `rebuild the desktop bundle (release).`,
      );
    }

    if (this.process) await this.terminateProcess(this.process);

    const dataDir = this.getDataDir();
    mkdirSync(dataDir, { recursive: true });
    const canonicalDataDir = realpathSync(dataDir);

    // Pin the CRDB log dir to userData/crdb-logs so the owned-readiness
    // timeout points at a real location. Without
    // --log-dir, CRDB writes to a default that depends on platform and
    // how the binary was invoked — fine for normal operation, confusing
    // when something fails on first run.
    const logDir = join(app.getPath('userData'), 'crdb-logs');
    mkdirSync(logDir, { recursive: true });
    const runtimeDir = join(app.getPath('userData'), 'crdb-runtime');
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const launchId = randomUUID();
    const pidFile = join(runtimeDir, `${launchId}.pid`);
    const listeningUrlFile = join(runtimeDir, `${launchId}.url`);

    const args = [
      'start-single-node',
      '--insecure',
      `--listen-addr=${this.listenHost}:${this.sqlPort}`,
      `--http-addr=${this.listenHost}:${this.httpPort}`,
      `--store=${canonicalDataDir}`,
      `--log-dir=${logDir}`,
      `--pid-file=${pidFile}`,
      `--listening-url-file=${listeningUrlFile}`,
    ];

    console.log('[crdb] Spawning', bin, args.join(' '));
    const spawnedProcess = this.spawnImpl(bin, args, {
      stdio: 'pipe',
      // Detach=false so child dies if Electron crashes — leaving an
      // orphaned cockroach holding port 26257 is a worse failure mode
      // than the next launch retrying.
      detached: false,
    });
    this.process = spawnedProcess;
    const generation = ++this.lifecycleGeneration;
    let spawnError: Error | null = null;

    this.process.stdout?.on('data', (chunk: Buffer) => {
      console.log(`[crdb] ${chunk.toString().trimEnd()}`);
    });
    this.process.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[crdb] ${chunk.toString().trimEnd()}`);
    });
    this.process.on('error', (error) => {
      spawnError = error;
    });
    this.process.on('exit', (code, signal) => {
      console.log(`[crdb] Exited code=${code} signal=${signal}`);
      const lostGeneration =
        this.authority?.process === spawnedProcess && !this.authority.revoked
          ? this.authority.generation
          : null;
      const wasCurrent = this.process === spawnedProcess || this.authority?.process === spawnedProcess;
      if (this.process === spawnedProcess) this.process = null;
      if (this.authority?.process === spawnedProcess) this.authority = null;
      if (wasCurrent) ++this.lifecycleGeneration;
      this.removeRuntimeFiles(pidFile, listeningUrlFile);
      if (lostGeneration !== null) this.authorityLossHandler?.(lostGeneration);
    });

    const authority: ManagedAuthority = {
      process: spawnedProcess,
      generation,
      dataDir: canonicalDataDir,
      pidFile,
      listeningUrlFile,
      revoked: false,
    };
    try {
      await this.waitForOwnedReady(authority, () => spawnError);
      this.authority = authority;
      if (!this.isAuthorityCurrent(authority)) {
        throw new Error('CockroachDB ownership changed before database initialization');
      }
      return this.resultFor(authority);
    } catch (error) {
      if (this.authority?.process === spawnedProcess) this.authority = null;
      await this.terminateProcess(spawnedProcess);
      this.removeRuntimeFiles(pidFile, listeningUrlFile);
      throw error;
    }
  }

  stop(): Promise<void> {
    return this.runSerialized(() => this.stopOwned());
  }

  private async stopOwned(): Promise<void> {
    if (!this.process) return;
    const proc = this.process;
    const authority = this.authority;
    if (authority?.process === proc) authority.revoked = true;
    ++this.lifecycleGeneration;
    await this.terminateProcess(proc, GRACEFUL_STOP_TIMEOUT_MS);
    if (authority) this.removeRuntimeFiles(authority.pidFile, authority.listeningUrlFile);
  }

  /** Revalidate a previously returned capability against the live managed child. */
  isManagedStartCurrent(startup: CockroachStartResult): boolean {
    const authority = this.authority;
    return (
      startup.ownership === 'managed-child' &&
      authority !== null &&
      !authority.revoked &&
      startup.generation === authority.generation &&
      startup.dataDir === authority.dataDir &&
      this.isAuthorityCurrent(authority)
    );
  }

  private resultFor(authority: ManagedAuthority): CockroachStartResult {
    return Object.freeze({
      ownership: 'managed-child',
      dataDir: authority.dataDir,
      generation: authority.generation,
    });
  }

  private isAuthorityCurrent(authority: ManagedAuthority): boolean {
    if (
      this.authority !== authority ||
      this.process !== authority.process ||
      authority.revoked ||
      childHasExited(authority.process) ||
      authority.process.pid === undefined
    ) {
      return false;
    }
    return this.hasValidStartupProof(authority);
  }

  private hasValidStartupProof(authority: ManagedAuthority): boolean {
    try {
      const pid = Number.parseInt(readFileSync(authority.pidFile, 'utf8').trim(), 10);
      const listeningUrl = new URL(readFileSync(authority.listeningUrlFile, 'utf8').trim());
      return (
        pid === authority.process.pid &&
        listeningUrl.protocol === 'postgresql:' &&
        listeningUrl.hostname === this.listenHost &&
        Number(listeningUrl.port) === this.sqlPort &&
        realpathSync(authority.dataDir) === authority.dataDir
      );
    } catch {
      return false;
    }
  }

  private async waitForOwnedReady(authority: ManagedAuthority, getSpawnError: () => Error | null): Promise<void> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      const spawnError = getSpawnError();
      if (spawnError) throw spawnError;
      if (this.process !== authority.process || childHasExited(authority.process)) {
        throw new Error('CockroachDB managed child exited before ownership was established');
      }
      // Cockroach itself writes both files only after successful startup. The
      // PID binds readiness to this exact ChildProcess, while the URL binds it
      // to the endpoint we will migrate and provision.
      if (this.hasValidStartupProof(authority) && (await this.isCrdbResponding())) {
        if (
          this.process === authority.process &&
          !childHasExited(authority.process) &&
          this.hasValidStartupProof(authority)
        )
          return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `CockroachDB did not establish owned SQL readiness on ${this.listenHost}:${this.sqlPort} ` +
        `within ${this.startTimeoutMs / 1000}s. Check logs in ` +
        `${join(app.getPath('userData'), 'crdb-logs')}.`,
    );
  }

  private async terminateProcess(proc: ChildProcess, timeoutMs = 5_000): Promise<void> {
    const clearProvenExit = (): void => {
      if (this.process === proc) this.process = null;
      if (this.authority?.process === proc) this.authority = null;
    };
    if (childHasExited(proc)) {
      clearProvenExit();
      return;
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      /* the final exit check remains authoritative */
    }
    if (await waitForChildExit(proc, timeoutMs)) {
      clearProvenExit();
      return;
    }
    try {
      proc.kill('SIGKILL');
    } catch {
      /* the final exit check remains authoritative */
    }
    if (!(await waitForChildExit(proc, FORCED_STOP_TIMEOUT_MS))) {
      throw new CockroachTerminationError();
    }
    clearProvenExit();
  }

  private removeRuntimeFiles(...paths: string[]): void {
    for (const path of paths) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Cheap "is something on the port?" check. Used to short-circuit the
   * startup probe — but is NOT trusted as the only signal. A raw TCP
   * listener could be anything (a port-collision with another tool, a
   * malicious local process, a leftover from a previous test). When we
   * see it bound we then run isCrdbResponding() to confirm it's actually
   * our database before treating "running" as a success.
   */
  private async portListening(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({
        host: this.listenHost,
        port: this.sqlPort,
        timeout: 500,
      });
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Real CRDB readiness check: spawns `cockroach sql -e 'SELECT 1'` and
   * accepts the listener only if SQL works AND the binary that's
   * answering is the one we shipped. This protects against (a) a random
   * non-CRDB process holding port 26257, and (b) treating a still-booting
   * CRDB whose TCP listener is up but SQL listener isn't as "ready."
   */
  private async isCrdbResponding(): Promise<boolean> {
    if (!(await this.portListening())) return false;
    const bin = this.getBinaryPath();
    if (!existsSync(bin)) return false;
    return new Promise((resolve) => {
      const proc = this.spawnImpl(
        bin,
        ['sql', '--insecure', '--host', `${this.listenHost}:${this.sqlPort}`, '-e', 'SELECT 1'],
        { stdio: 'pipe' },
      );
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        resolve(false);
      }, 2000);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

}
