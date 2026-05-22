import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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

export class CockroachManager {
  private process: ChildProcess | null = null;
  private readonly sqlPort: number;
  private readonly httpPort: number;
  private readonly listenHost: string;
  private readonly startTimeoutMs: number;

  constructor(opts: CockroachManagerOptions = {}) {
    this.sqlPort = opts.sqlPort ?? Number(process.env['SKYTWIN_DB_PORT'] ?? DEFAULT_SQL_PORT);
    this.httpPort = opts.httpPort ?? Number(process.env['SKYTWIN_DB_HTTP_PORT'] ?? DEFAULT_HTTP_PORT);
    this.listenHost = opts.listenHost ?? DEFAULT_LISTEN_HOST;
    this.startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
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
    return join(app.getPath('userData'), 'crdb-data');
  }

  getConnectionString(): string {
    return `postgresql://root@${this.listenHost}:${this.sqlPort}/skytwin?sslmode=disable`;
  }

  /**
   * Start CockroachDB in single-node mode. Idempotent — returns
   * immediately if the SQL port is already accepting connections.
   */
  async start(): Promise<void> {
    if (await this.isReady()) {
      console.log('[crdb] Already running on', `${this.listenHost}:${this.sqlPort}`);
      return;
    }

    const bin = this.getBinaryPath();
    if (!existsSync(bin)) {
      throw new Error(
        `CockroachDB binary missing at ${bin}. Run 'bin/skytwin-db install' (dev) or ` +
        `rebuild the desktop bundle (release).`,
      );
    }

    const dataDir = this.getDataDir();
    mkdirSync(dataDir, { recursive: true });

    const args = [
      'start-single-node',
      '--insecure',
      `--listen-addr=${this.listenHost}:${this.sqlPort}`,
      `--http-addr=${this.listenHost}:${this.httpPort}`,
      `--store=${dataDir}`,
    ];

    console.log('[crdb] Spawning', bin, args.join(' '));
    this.process = spawn(bin, args, {
      stdio: 'pipe',
      // Detach=false so child dies if Electron crashes — leaving an
      // orphaned cockroach holding port 26257 is a worse failure mode
      // than the next launch retrying.
      detached: false,
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      console.log(`[crdb] ${chunk.toString().trimEnd()}`);
    });
    this.process.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[crdb] ${chunk.toString().trimEnd()}`);
    });
    this.process.on('exit', (code, signal) => {
      console.log(`[crdb] Exited code=${code} signal=${signal}`);
      this.process = null;
    });

    await this.waitForReady();
    await this.ensureDatabase();
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    const proc = this.process;
    this.process = null;

    // Try graceful drain via `cockroach quit` first — drains connections,
    // flushes WAL, finishes pending replication. Falls through to SIGTERM
    // if quit can't reach the node (e.g. it's already shutting down).
    await this.gracefulQuit();

    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already dead
        }
        resolve();
      }, GRACEFUL_STOP_TIMEOUT_MS);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async gracefulQuit(): Promise<void> {
    const bin = this.getBinaryPath();
    if (!existsSync(bin)) return;
    await new Promise<void>((resolve) => {
      const quit = spawn(bin, [
        'node',
        'drain',
        '--insecure',
        '--host', `${this.listenHost}:${this.sqlPort}`,
        '--drain-wait', '10s',
      ], { stdio: 'pipe' });
      // 15s budget for drain — beyond that, SIGTERM will pick up.
      const timer = setTimeout(() => {
        try { quit.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, 15_000);
      quit.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      quit.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * True if something is accepting TCP on the SQL port. Doesn't prove
   * it's our process — but for the start path that's fine: if there's
   * already a CRDB on 26257, spawning another against the same data dir
   * would corrupt it, so we treat "port already bound" as "good enough,
   * don't start a second one".
   */
  private async isReady(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host: this.listenHost, port: this.sqlPort, timeout: 500 });
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

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isReady()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `CockroachDB did not accept connections on ${this.listenHost}:${this.sqlPort} ` +
      `within ${this.startTimeoutMs / 1000}s. Check logs in ${this.getDataDir()}/logs.`,
    );
  }

  /**
   * Ensure the `skytwin` database exists. CRDB doesn't auto-create
   * databases on first connect; the API would die with "database
   * skytwin does not exist" otherwise.
   */
  private async ensureDatabase(): Promise<void> {
    const bin = this.getBinaryPath();
    if (!existsSync(bin)) return;
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(bin, [
        'sql',
        '--insecure',
        '--host', `${this.listenHost}:${this.sqlPort}`,
        '-e', 'CREATE DATABASE IF NOT EXISTS skytwin;',
      ], { stdio: 'pipe' });
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ensureDatabase: cockroach sql exited ${code}`));
      });
      proc.on('error', reject);
    });
  }
}
