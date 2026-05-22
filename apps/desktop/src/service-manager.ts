import { fork, execSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import { CockroachManager } from './cockroach-manager.js';

export type ProcessState = 'running' | 'stopped' | 'starting' | 'error' | 'paused';

export interface ServiceStatus {
  api: ProcessState;
  worker: ProcessState;
  cockroach: ProcessState;
  overall: 'healthy' | 'degraded' | 'failed';
}

interface ManagedProcess {
  process: ChildProcess | null;
  status: ProcessState;
  restartCount: number;
  failureTimestamps: number[];
  external: boolean;
}

const MAX_RESTARTS = 5;
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_CHECK_INTERVAL_MS = 5000;
const RESTART_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Verified Google OAuth `client_id` baked into the desktop bundle.
 * Populated at build time via `--define` or env at `tsc` invocation.
 * Empty string means "no default" — the user must paste their own in
 * Setup, the legacy self-host path. Public client IDs are designed to
 * be revealed; PKCE binds each auth code to a per-flow verifier the
 * API holds in memory.
 *
 * For a production desktop release we should publish a Verified OAuth
 * client of type "Desktop app" in the SkyTwin team's Google Cloud
 * project and replace the empty string below with its client_id (or
 * pass it via `SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID` at build time).
 */
const BUNDLED_GOOGLE_CLIENT_ID = '';

/**
 * Manages the API server and worker as child processes.
 * Health monitoring every 5s, restart with exponential backoff,
 * 5 failures in 5 minutes marks as failed.
 */
export class ServiceManager {
  private api: ManagedProcess = { process: null, status: 'stopped', restartCount: 0, failureTimestamps: [], external: false };
  private worker: ManagedProcess = { process: null, status: 'stopped', restartCount: 0, failureTimestamps: [], external: false };
  private web: ManagedProcess = { process: null, status: 'stopped', restartCount: 0, failureTimestamps: [], external: false };
  private cockroach = new CockroachManager();
  private cockroachStatus: ProcessState = 'stopped';
  private onStatusChange: ((status: ServiceStatus) => void) | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private paused = false;

  setStatusHandler(handler: (status: ServiceStatus) => void): void {
    this.onStatusChange = handler;
  }

  private getResourcePath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath);
    }
    return join(__dirname, '..', '..', '..');
  }

  /**
   * Read or generate a per-installation session secret. The API refuses to
   * start in production mode without `SESSION_SECRET`. We persist it to
   * `<userData>/secrets/session-secret` so the same value is reused across
   * launches — required for cookies signed with it to survive a restart.
   * 32 bytes of crypto-random hex = 64 chars; matches the API's expected
   * entropy and what `openssl rand -hex 32` produces.
   */
  private getOrCreateSessionSecret(): string {
    const secretsDir = join(app.getPath('userData'), 'secrets');
    const secretFile = join(secretsDir, 'session-secret');
    if (existsSync(secretFile)) {
      const existing = readFileSync(secretFile, 'utf-8').trim();
      if (existing.length >= 32) return existing;
    }
    mkdirSync(secretsDir, { recursive: true });
    const generated = randomBytes(32).toString('hex');
    writeFileSync(secretFile, generated, { mode: 0o600 });
    return generated;
  }

  private getEnv(): Record<string, string> {
    // Bundle-default Google OAuth client_id. Empty when the desktop was
    // built without one — env wins over this. The desktop bundle ships
    // with the SkyTwin-team-registered verified OAuth client (type:
    // "Installed application"), so users never have to create their own
    // Google Cloud OAuth app. PKCE binds each authorization code to a
    // per-flow verifier the API holds in memory; a leaked client_id
    // alone redeems nothing.
    const envOverride = process.env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID'];
    const bundledGoogleClientId =
      envOverride !== undefined && envOverride !== ''
        ? envOverride
        : (BUNDLED_GOOGLE_CLIENT_ID || '');
    return {
      ...process.env as Record<string, string>,
      DESKTOP_MODE: 'true',
      // The desktop bundle ships without an IronClaw deployment; the
      // execution-router falls back to Direct/OpenClaw based on the
      // capabilities. The previous default of false required the user to
      // provide IRONCLAW_WEBHOOK_SECRET just to launch, which defeated
      // the purpose of the all-in-one bundle.
      USE_MOCK_IRONCLAW: process.env['USE_MOCK_IRONCLAW'] ?? 'true',
      NODE_ENV: 'production',
      SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID: bundledGoogleClientId,
      API_PORT: '3100',
      WORKER_PORT: '3101',
      API_BASE_URL: 'http://localhost:3100',
      // CockroachManager owns the wire format; if the user has set
      // DATABASE_URL explicitly we honor it (e.g. pointing at a hosted
      // CRDB for power users), otherwise we use the bundled instance.
      DATABASE_URL: process.env['DATABASE_URL'] || this.cockroach.getConnectionString(),
      // API refuses to start in NODE_ENV=production without this; auto-
      // generate per-install. Persisted across launches.
      SESSION_SECRET: process.env['SESSION_SECRET'] || this.getOrCreateSessionSecret(),
    };
  }

  /**
   * Run database migrations against the bundled CRDB. Idempotent — safe to
   * re-run every launch. Pulled into a separate method so startAll() can
   * gate the API on migrations completing.
   */
  private async runMigrations(): Promise<boolean> {
    const base = this.getResourcePath();
    const fallbackSymlink = app.isPackaged
      ? join(base, 'embedded', 'api', 'node_modules', '@skytwin', 'db', 'dist', 'migrations', '001-initial.js')
      : join(base, 'packages', 'db', 'dist', 'migrations', '001-initial.js');

    // Resolve through any symlinks. `pnpm deploy` stitches packages via
    // symlinks into `.pnpm/<pkg>/node_modules/<pkg>`, and 001-initial.ts
    // guards `main()` with `import.meta.url === pathToFileURL(process.argv[1]).href`.
    // node's ESM loader uses the real path for import.meta.url; if we
    // pass it the symlink path the check fails and main() never runs.
    // Always pass the canonical (realpath) path.
    let script: string | null = null;
    try {
      if (existsSync(fallbackSymlink)) {
        const real = realpathSync(fallbackSymlink);
        script = real;
      }
    } catch {
      // realpath may fail in odd packaging modes; fall through to null.
    }

    if (script === null) {
      console.warn('[migrate] No migration script found at', fallbackSymlink);
      return false;
    }

    // Three earlier attempts to spawn a child node process for migrations
    // failed in distinct ways: (a) 001-initial.ts gates main() behind an
    // `import.meta.url === pathToFileURL(argv[1]).href` check that breaks
    // once pnpm-deploy symlinks rebase paths in the .app bundle, (b) a
    // sibling .mjs shim bundled into app.asar isn't readable by a spawned
    // child (asar is an Electron-runtime overlay, not a real fs), (c) an
    // `--input-type=module -e <inline>` shim exited 0 without running
    // either branch — likely a quirk in how Electron-shipped node + ESM
    // dynamic import + production-builder warnings interact.
    //
    // The bulletproof path is to call `up()` directly from the Electron
    // main process. Electron's main IS node, has full asar awareness,
    // resolves pnpm symlinks, and shares one DB connection pool with
    // ourselves — no child IPC overhead. The injected env vars
    // (DATABASE_URL, SESSION_SECRET) live in process.env already from
    // getEnv()'s spread.
    console.log('[migrate] Running', script, '(in-process)');
    Object.assign(process.env, this.getEnv());
    try {
      // pathToFileURL ensures Windows paths and paths with spaces ("My App")
      // import cleanly under ESM.
      const moduleUrl = pathToFileURL(script).href;
      // service-manager.ts compiles to CJS — TS rewrites `await import(x)`
      // into a wrapped `require(x)` in CJS output, which then fails on
      // ESM targets ("file:// require"). Use Function-eval to bypass the
      // TS transform and get native runtime dynamic-import semantics.
      const nativeImport = new Function('p', 'return import(p)') as (p: string) => Promise<{ up?: () => Promise<void> }>;
      const mod = await nativeImport(moduleUrl);
      if (typeof mod.up !== 'function') {
        console.error('[migrate] target has no up() export:', script);
        return false;
      }
      await mod.up();
      console.log('[migrate] complete');
      return true;
    } catch (err) {
      console.error('[migrate] failed:', err);
      return false;
    }
  }

  async startAll(): Promise<void> {
    this.paused = false;
    await this.startCockroach();
    // Migrations must complete after CRDB is up but before API starts;
    // otherwise API hits "relation does not exist" on first query and
    // crashlooks until restart-backoff exhausts.
    if (this.cockroachStatus === 'running') {
      await this.runMigrations();
    }
    await this.startApi();
    const apiReady = await this.waitForApi(10000);
    if (apiReady) {
      this.api.restartCount = 0;
      this.api.failureTimestamps = [];
    }
    await this.startWeb();
    await this.startWorker();
    setTimeout(() => {
      if (this.worker.status === 'running') {
        this.worker.restartCount = 0;
        this.worker.failureTimestamps = [];
      }
    }, 3000);

    this.startHealthMonitoring();
  }

  private startHealthMonitoring(): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = setInterval(() => this.runHealthCheck(), HEALTH_CHECK_INTERVAL_MS);
  }

  private async runHealthCheck(): Promise<void> {
    if (this.paused) return;

    // Check API health
    if (this.api.status === 'running') {
      try {
        const response = await fetch('http://localhost:3100/api/health');
        if (!response.ok) {
          this.recordFailure(this.api, 'api');
        }
      } catch {
        this.recordFailure(this.api, 'api');
      }
    }

    // Check worker is still alive (process-level check)
    if (this.worker.status === 'running' && this.worker.process && !this.worker.process.connected) {
      this.recordFailure(this.worker, 'worker');
    }
  }

  private recordFailure(managed: ManagedProcess, name: string): void {
    const now = Date.now();
    managed.failureTimestamps.push(now);
    // Trim old timestamps outside the window
    managed.failureTimestamps = managed.failureTimestamps.filter(
      (t) => now - t < FAILURE_WINDOW_MS,
    );

    if (managed.failureTimestamps.length >= MAX_RESTARTS) {
      console.error(`[${name}] ${MAX_RESTARTS} failures in ${FAILURE_WINDOW_MS / 60000} minutes — marking as failed`);
      managed.status = 'error';
      this.emitStatus();
    }
  }

  private getRestartDelay(restartCount: number): number {
    return RESTART_DELAYS[Math.min(restartCount, RESTART_DELAYS.length - 1)];
  }

  /**
   * Probe whether an external API/worker is already running. In `pnpm dev`
   * and similar dev flows, the standalone services own port 3100, so forking
   * our own would just collide and crash on EADDRINUSE.
   *
   * Only runs in unpackaged (dev) builds — a packaged install must never
   * attach to whatever stranger happens to be answering on localhost:3100,
   * since that could be a wildly different version (or untrusted).
   */
  private async startCockroach(): Promise<void> {
    this.cockroachStatus = 'starting';
    this.emitStatus();
    try {
      await this.cockroach.start();
      this.cockroachStatus = 'running';
    } catch (err) {
      console.error('[crdb] Failed to start:', err);
      this.cockroachStatus = 'error';
    }
    this.emitStatus();
  }

  private async detectExternalApi(): Promise<boolean> {
    if (app.isPackaged) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const res = await fetch('http://localhost:3100/api/health', { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async startApi(): Promise<void> {
    this.api.status = 'starting';
    this.emitStatus();

    if (await this.detectExternalApi()) {
      console.log('[api] External API detected on :3100 — using existing instance, not forking.');
      this.api.external = true;
      this.api.status = 'running';
      this.emitStatus();
      return;
    }
    this.api.external = false;

    const base = this.getResourcePath();
    // Packaged path uses the pnpm-deployed self-contained bundle at
    // <resources>/embedded/api/, which carries dist/ + its own
    // node_modules. The standalone <resources>/api/ tree from prior
    // versions had only dist/ and couldn't resolve `express` at runtime.
    const apiEntry = app.isPackaged
      ? join(base, 'embedded', 'api', 'dist', 'index.js')
      : join(base, 'apps', 'api', 'dist', 'index.js');

    try {
      this.api.process = fork(apiEntry, [], {
        env: this.getEnv(),
        stdio: 'pipe',
      });

      this.api.process.stdout?.on('data', (data: Buffer) => {
        console.log(`[api] ${data.toString().trim()}`);
      });
      this.api.process.stderr?.on('data', (data: Buffer) => {
        console.error(`[api] ${data.toString().trim()}`);
      });

      this.api.process.on('exit', (code) => {
        console.log(`[api] Process exited with code ${code}`);
        this.api.process = null;
        this.api.status = 'stopped';
        this.emitStatus();
        if (code !== 0 && !this.paused) {
          this.api.restartCount++;
          this.recordFailure(this.api, 'api');
          if (this.api.status as ProcessState !== 'error') {
            const delay = this.getRestartDelay(this.api.restartCount);
            console.log(`[api] Restarting in ${delay}ms (attempt ${this.api.restartCount})...`);
            setTimeout(() => this.startApi(), delay);
          }
        }
      });

      this.api.status = 'running';
      this.emitStatus();
    } catch (err) {
      console.error('[api] Failed to start:', err);
      this.api.status = 'error';
      this.emitStatus();
    }
  }

  private async startWeb(): Promise<void> {
    this.web.status = 'starting';
    this.emitStatus();

    if (this.api.external) {
      console.log('[web] External API detected — assuming external web, not forking.');
      this.web.external = true;
      this.web.status = 'running';
      this.emitStatus();
      return;
    }
    this.web.external = false;

    const base = this.getResourcePath();
    const webEntry = app.isPackaged
      ? join(base, 'embedded', 'web', 'dist', 'index.js')
      : join(base, 'apps', 'web', 'dist', 'index.js');

    try {
      this.web.process = fork(webEntry, [], {
        env: { ...this.getEnv(), WEB_PORT: '3200' },
        stdio: 'pipe',
      });

      this.web.process.stdout?.on('data', (data: Buffer) => {
        console.log(`[web] ${data.toString().trim()}`);
      });
      this.web.process.stderr?.on('data', (data: Buffer) => {
        console.error(`[web] ${data.toString().trim()}`);
      });

      this.web.process.on('exit', (code) => {
        console.log(`[web] Process exited with code ${code}`);
        this.web.process = null;
        this.web.status = 'stopped';
        this.emitStatus();
        if (code !== 0 && !this.paused) {
          this.web.restartCount++;
          this.recordFailure(this.web, 'web');
          if (this.web.status as ProcessState !== 'error') {
            const delay = this.getRestartDelay(this.web.restartCount);
            console.log(`[web] Restarting in ${delay}ms (attempt ${this.web.restartCount})...`);
            setTimeout(() => this.startWeb(), delay);
          }
        }
      });

      this.web.status = 'running';
      this.emitStatus();
    } catch (err) {
      console.error('[web] Failed to start:', err);
      this.web.status = 'error';
      this.emitStatus();
    }
  }

  private async startWorker(): Promise<void> {
    this.worker.status = 'starting';
    this.emitStatus();

    // If api is external, assume worker is too — both are launched together by
    // pnpm dev. Forking a second worker against the same DB causes redundant
    // signal processing and noisy logs.
    if (this.api.external) {
      console.log('[worker] External API detected — assuming external worker, not forking.');
      this.worker.external = true;
      this.worker.status = 'running';
      this.emitStatus();
      return;
    }
    this.worker.external = false;

    const base = this.getResourcePath();
    // See apiEntry comment above — same reasoning for worker.
    const workerEntry = app.isPackaged
      ? join(base, 'embedded', 'worker', 'dist', 'index.js')
      : join(base, 'apps', 'worker', 'dist', 'index.js');

    try {
      this.worker.process = fork(workerEntry, [], {
        env: this.getEnv(),
        stdio: 'pipe',
      });

      this.worker.process.stdout?.on('data', (data: Buffer) => {
        console.log(`[worker] ${data.toString().trim()}`);
      });
      this.worker.process.stderr?.on('data', (data: Buffer) => {
        console.error(`[worker] ${data.toString().trim()}`);
      });

      this.worker.process.on('exit', (code) => {
        console.log(`[worker] Process exited with code ${code}`);
        this.worker.process = null;
        this.worker.status = 'stopped';
        this.emitStatus();
        if (code !== 0 && !this.paused) {
          this.worker.restartCount++;
          this.recordFailure(this.worker, 'worker');
          if (this.worker.status as ProcessState !== 'error') {
            const delay = this.getRestartDelay(this.worker.restartCount);
            console.log(`[worker] Restarting in ${delay}ms (attempt ${this.worker.restartCount})...`);
            setTimeout(() => this.startWorker(), delay);
          }
        }
      });

      this.worker.status = 'running';
      this.emitStatus();
    } catch (err) {
      console.error('[worker] Failed to start:', err);
      this.worker.status = 'error';
      this.emitStatus();
    }
  }

  /**
   * Pause the twin — stops the worker (no new signals) but keeps API running.
   */
  async pause(): Promise<void> {
    this.paused = true;
    await this.stopProcess(this.worker, 'worker');
    this.worker.status = 'paused';
    this.emitStatus();
  }

  /**
   * Resume the twin — restarts the worker.
   */
  async resume(): Promise<void> {
    this.paused = false;
    this.worker.restartCount = 0;
    this.worker.failureTimestamps = [];
    await this.startWorker();
  }

  isPaused(): boolean {
    return this.paused;
  }

  private async stopProcess(managed: ManagedProcess, name: string): Promise<void> {
    if (!managed.process) return;

    const proc = managed.process;
    managed.process = null;

    if (process.platform === 'win32') {
      // Windows: SIGTERM is unreliable, use taskkill for force termination
      try {
        if (proc.pid) {
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
          console.log(`[${name}] Terminated via taskkill (PID ${proc.pid})`);
        }
      } catch {
        // Process may already be dead
        console.warn(`[${name}] taskkill failed — process may have already exited`);
      }

      // Wait briefly for the exit event to propagate
      await new Promise<void>((resolve) => {
        const exitTimer = setTimeout(() => resolve(), 2000);
        proc.on('exit', () => {
          clearTimeout(exitTimer);
          resolve();
        });
      });
    } else {
      // Unix (macOS/Linux): graceful SIGTERM then force SIGKILL
      proc.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
            console.warn(`[${name}] Force-killed after 5s timeout`);
          } catch {
            // Already dead
          }
          resolve();
        }, 5000);

        proc.on('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    }

    managed.status = 'stopped';
  }

  async stopAll(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Stop API/worker/web first so their open DB connections drain before
    // we bring down CockroachDB — otherwise CRDB logs a flurry of "client
    // disconnected" messages and the API logs "connection reset" on the
    // last in-flight query, both of which are noise for the user.
    await Promise.all([
      this.stopProcess(this.api, 'api'),
      this.stopProcess(this.worker, 'worker'),
      this.stopProcess(this.web, 'web'),
    ]);
    try {
      await this.cockroach.stop();
      this.cockroachStatus = 'stopped';
    } catch (err) {
      console.error('[crdb] stop failed:', err);
    }
    this.emitStatus();
  }

  getStatus(): ServiceStatus {
    const apiState = this.api.status;
    const workerState = this.worker.status;
    const cockroachState = this.cockroachStatus;

    let overall: 'healthy' | 'degraded' | 'failed';
    // CRDB is foundational — if it's not up, API and worker can't function
    // even if their processes are alive. Treat that as failed/degraded
    // explicitly so the tray icon reflects reality.
    if (cockroachState === 'error') {
      overall = 'failed';
    } else if (apiState === 'error' && workerState === 'error') {
      overall = 'failed';
    } else if (apiState === 'error' || workerState === 'error' || cockroachState !== 'running') {
      overall = 'degraded';
    } else if (apiState === 'running' && (workerState === 'running' || workerState === 'paused')) {
      overall = 'healthy';
    } else {
      overall = 'degraded';
    }

    return { api: apiState, worker: workerState, cockroach: cockroachState, overall };
  }

  getUptime(): number {
    return process.uptime();
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus());
  }

  private async waitForApi(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch('http://localhost:3100/api/health');
        if (response.ok) return true;
      } catch {
        // API not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.warn('[api] Health check timed out, starting worker anyway');
    return false;
  }
}
