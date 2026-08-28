import { fork, spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import { CockroachManager } from './cockroach-manager.js';
import { computeBundleMarker } from './bundle-marker.js';
import {
  extractionDone,
  extractionProgress,
  type ExtractionProgress,
} from './extraction-progress.js';

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
 * Google OAuth `client_id` baked into the desktop bundle.
 *
 * Registered in the SkyTwin Google Cloud project (`skytwin-492700`) as
 * an OAuth client of type "Desktop app", created 2026-05-22. PKCE
 * binds each auth code to a per-flow verifier the API holds in memory;
 * the public client_id alone redeems nothing. The token redirect
 * lands on `http://127.0.0.1:NNNN/api/oauth/google/callback` and never
 * traverses our infrastructure — tokens stay on the user's machine,
 * encrypted by `credential-vault`.
 *
 * Override at build time via `SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID` env if
 * shipping a forked SkyTwin build that should consent under a
 * different brand.
 */
const BUNDLED_GOOGLE_CLIENT_ID =
  '594829999930-kpjopcs1pak0rp0omimuegr5ugcv5l8h.apps.googleusercontent.com';

/**
 * Manages the API server and worker as child processes.
 * Health monitoring every 5s, restart with exponential backoff,
 * 5 failures in 5 minutes marks as failed.
 */
/**
 * Spawn `tar -tzf <path>` and count the newlines in its stdout.
 * Resolves with the entry count, rejects on a non-zero exit. Used by
 * the extraction-progress denominator (#383); see `ensureEmbeddedRoot`.
 */
function countTarFiles(tarPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-tzf', tarPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    let count = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 0x0a) count++;
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(count);
      else reject(new Error(`tar -tzf exited with code ${code}`));
    });
  });
}

export class ServiceManager {
  private api: ManagedProcess = { process: null, status: 'stopped', restartCount: 0, failureTimestamps: [], external: false };
  private worker: ManagedProcess = { process: null, status: 'stopped', restartCount: 0, failureTimestamps: [], external: false };
  private web: ManagedProcess = { process: null, status: 'stopped', restartCount: 0, failureTimestamps: [], external: false };
  private cockroach = new CockroachManager();
  private cockroachStatus: ProcessState = 'stopped';
  private onStatusChange: ((status: ServiceStatus) => void) | null = null;
  private onExtractProgress: ((progress: ExtractionProgress) => void) | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private paused = false;

  setStatusHandler(handler: (status: ServiceStatus) => void): void {
    this.onStatusChange = handler;
  }

  /**
   * Register a handler for first-launch tar-extraction progress (#383).
   * Called many times during the unpack (one event per ~50 files) plus a
   * final "Ready!" event once tar exits. Main process forwards each event
   * to the splash window so the user sees a progress bar instead of an
   * uninformative spinner.
   */
  setExtractProgressHandler(handler: (progress: ExtractionProgress) => void): void {
    this.onExtractProgress = handler;
  }

  private emitExtractProgress(progress: ExtractionProgress): void {
    if (this.onExtractProgress) {
      try {
        this.onExtractProgress(progress);
      } catch (err) {
        console.warn('[extract] progress handler threw', err);
      }
    }
  }

  private getResourcePath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath);
    }
    return join(__dirname, '..', '..', '..');
  }

  /**
   * The embedded api/worker/web trees are no longer shipped as loose files
   * under `<resources>/embedded/{api,worker,web}/`. Build-single-binary.sh
   * packs them into a single `apps.tar.gz` so the .dmg/.exe/.AppImage
   * carries one file instead of ~10,000 small ones (the file count was
   * the primary Windows CI bottleneck — NTFS small-file writes during
   * electron-builder's win-unpacked copy step + Defender RT-scan races
   * on the resulting .nsis.7z, see PR #350 history).
   *
   * On first launch — or whenever the shipped bundle differs from the one
   * already extracted — extract the tarball into `<userData>/embedded/` and
   * write a `.version` marker so subsequent launches no-op. The marker is the
   * bundle's content hash, NOT the app version (see `bundle-marker.ts` for
   * why the version was the wrong key). Tar is in System32 on Win10 1803+,
   * /usr/bin on macOS/Linux. No additional bundled tooling.
   *
   * Returns the absolute path that callers should use in place of the
   * old `join(getResourcePath(), 'embedded', ...)` constructions.
   */
  private extractedEmbeddedRoot: string | null = null;

  private async ensureEmbeddedRoot(): Promise<string> {
    if (this.extractedEmbeddedRoot) return this.extractedEmbeddedRoot;

    if (!app.isPackaged) {
      // Dev mode: embedded apps live in the workspace tree, never tarballed.
      this.extractedEmbeddedRoot = join(this.getResourcePath(), 'embedded');
      // In dev we don't actually use this path (startApi etc. use
      // apps/api/dist directly), but cache something sensible.
      return this.extractedEmbeddedRoot;
    }

    const extractedRoot = join(app.getPath('userData'), 'embedded');
    const marker = join(extractedRoot, '.version');
    const tarPath = join(process.resourcesPath, 'embedded', 'apps.tar.gz');
    // NOT app.getVersion(): the desktop package.json version was frozen at
    // 0.3.0 since PR #31, so a user who upgraded via a newer .dmg kept the
    // marker match and silently ran the new shell against the old extracted
    // backend. computeBundleMarker() keys off the bundle's own content hash
    // (bundle-manifest.json#bundleId) instead. See bundle-marker.ts.
    const { marker: currentMarker, source: markerSource } = computeBundleMarker({
      manifestPath: join(process.resourcesPath, 'embedded', 'bundle-manifest.json'),
      tarPath,
      appVersion: app.getVersion(),
    });

    if (existsSync(marker)) {
      try {
        const installed = readFileSync(marker, 'utf-8').trim();
        if (installed === currentMarker) {
          // Up to date — sanity-check the api entry exists before declaring
          // the cache hot (partial extractions from a prior crash would
          // leave the marker present but the tree incomplete).
          if (existsSync(join(extractedRoot, 'api', 'dist', 'index.js'))) {
            this.extractedEmbeddedRoot = extractedRoot;
            return extractedRoot;
          }
          console.warn('[extract] Marker matches but api/dist/index.js missing — re-extracting.');
        } else {
          console.log(
            `[extract] Bundle changed (${markerSource}): ${installed} -> ${currentMarker}. Re-extracting.`,
          );
        }
      } catch {
        // Marker unreadable — fall through to re-extract.
      }
      // Stale or partial — wipe before re-extracting so leftover files
      // from the prior version can't shadow the new bundle (e.g. an
      // obsolete migration script still resolving at the old path).
      try {
        rmSync(extractedRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn('[extract] Could not wipe stale extracted tree:', err);
      }
    }

    if (!existsSync(tarPath)) {
      throw new Error(
        `Embedded apps tarball missing at ${tarPath}. This means the bundle was assembled without running build-single-binary.sh, or the extraResources filter in apps/desktop/package.json no longer points at apps.tar.gz.`,
      );
    }

    mkdirSync(extractedRoot, { recursive: true });

    console.log(`[extract] Unpacking embedded apps from ${tarPath} -> ${extractedRoot}`);
    const t0 = Date.now();

    // Pre-count the entries in the tarball so the progress bar has a
    // real denominator. `tar -tzf` lists without extracting; one line
    // per archive member. Fast — ~500ms for a 45MB tarball — and only
    // runs on first launch + version bumps, so the cost is well below
    // the cold-load budget. If counting fails for any reason we fall
    // back to a "spinner-style" indeterminate UI by passing totalFiles=0.
    let totalFiles = 0;
    try {
      totalFiles = await countTarFiles(tarPath);
    } catch (err) {
      console.warn('[extract] file-count probe failed; progress will be indeterminate', err);
    }
    this.emitExtractProgress(extractionProgress(0, totalFiles));

    await new Promise<void>((resolve, reject) => {
      // -x extract, -z gunzip, -v verbose (one line per member, which
      // is how we count progress), -f file, -C cd-into. System tar on
      // all three platforms accepts this flag set (bsdtar on
      // macOS/Windows, gnu tar on Linux). stderr inherited so any
      // extraction error still surfaces in the user-facing console.
      const child = spawn(
        'tar',
        ['-xzvf', tarPath, '-C', extractedRoot],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let filesExtracted = 0;
      let lastEmittedPercent = -1;
      child.stdout?.on('data', (chunk: Buffer) => {
        // Each newline = one extracted member. Counting newlines (not
        // splitting + filtering empties) is the cheapest path and is
        // accurate for tar's line-buffered verbose output.
        for (const byte of chunk) {
          if (byte === 0x0a) filesExtracted++;
        }
        const progress = extractionProgress(filesExtracted, totalFiles);
        // Throttle to "percent changed" so a 10k-file tarball doesn't
        // fire 10k IPCs — we only need ~100 ticks max for the UI.
        if (progress.percent !== lastEmittedPercent) {
          lastEmittedPercent = progress.percent;
          this.emitExtractProgress(progress);
        }
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exited with code ${code}`));
      });
    });
    this.emitExtractProgress(extractionDone());
    writeFileSync(marker, currentMarker);
    console.log(`[extract] Done in ${Date.now() - t0}ms`);

    this.extractedEmbeddedRoot = extractedRoot;
    return extractedRoot;
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
    return this.getOrCreateSecret('session-secret');
  }

  /**
   * Read or generate the per-installation loopback service token handed to
   * every managed child process as `SKYTWIN_SERVICE_TOKEN`.
   *
   * The desktop pins `NODE_ENV=production` for all children, which turns the
   * API's localhost auth bypass OFF. Before this existed, the worker's
   * `forwardSignalToApi()` and the idle-miner's ingest emitter posted to
   * `/api/events/ingest` with no credential at all, so every packaged install
   * 401'd on every signal and ingested nothing. Same mint, same file
   * conventions as the session secret — one value covers the API (verifier)
   * and the worker + idle-miner (presenters), because they all read the env
   * produced by `getEnv()`.
   */
  private getOrCreateServiceToken(): string {
    return this.getOrCreateSecret('service-token');
  }

  /**
   * Shared read-or-mint for a 32-byte hex secret persisted under
   * `<userData>/secrets/<name>` with owner-only (0600) permissions.
   */
  private getOrCreateSecret(name: string): string {
    const secretsDir = join(app.getPath('userData'), 'secrets');
    const secretFile = join(secretsDir, name);
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
      // Pinned AFTER the `...process.env` spread on purpose: a packaged build
      // must never inherit a developer's shell bypass. Real auth, always.
      SKYTWIN_DEV_AUTH_BYPASS: 'false',
      // Loopback service credential. The API verifies it; the worker and the
      // idle-miner present it on `/api/events/ingest`. Without it, a packaged
      // install (NODE_ENV=production, bypass off) 401s every ingest POST.
      SKYTWIN_SERVICE_TOKEN:
        process.env['SKYTWIN_SERVICE_TOKEN'] || this.getOrCreateServiceToken(),
    };
  }

  /**
   * Run database migrations against the bundled CRDB. Idempotent — safe to
   * re-run every launch. Pulled into a separate method so startAll() can
   * gate the API on migrations completing.
   */
  private async runMigrations(): Promise<boolean> {
    const base = this.getResourcePath();
    const embeddedRoot = await this.ensureEmbeddedRoot();
    const fallbackSymlink = app.isPackaged
      ? join(embeddedRoot, 'api', 'node_modules', '@skytwin', 'db', 'dist', 'migrations', '001-initial.js')
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
    // Extract the bundled embedded apps tarball before anything else so
    // every downstream method (CockroachManager, runMigrations, startApi,
    // startWeb, startWorker) sees a populated <userData>/embedded/ tree.
    // No-op after the first launch except on version bumps.
    if (app.isPackaged) {
      try {
        await this.ensureEmbeddedRoot();
      } catch (err) {
        console.error('[startup] Failed to extract embedded apps:', err);
        // Re-throw so the splash/UI surfaces the error rather than
        // entering a degraded state where API/worker silently fail to
        // resolve their entry points.
        throw err;
      }
    }
    if (await this.waitForExternalApi(10000)) {
      console.log('[crdb] External API detected on :3100 — skipping local CockroachDB startup.');
      // In monorepo dev, the external API owns the DB connection and
      // migrations. Treat the dependency as satisfied for tray/status
      // purposes; the API health check below remains the source of truth.
      this.cockroachStatus = 'running';
      this.emitStatus();
    } else {
      await this.startCockroach();
      // Migrations must complete after CRDB is up but before API starts;
      // otherwise API hits "relation does not exist" on first query and
      // crashlooks until restart-backoff exhausts.
      if (this.cockroachStatus === 'running') {
        await this.runMigrations();
      }
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
      if (!res.ok) return false;
      const payload = (await res.json().catch(() => null)) as { service?: unknown } | null;
      return payload?.service === 'skytwin-api';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForExternalApi(timeoutMs: number): Promise<boolean> {
    if (app.isPackaged) return false;
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.detectExternalApi()) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    return false;
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
    const embeddedRoot = await this.ensureEmbeddedRoot();
    // Packaged path uses the pnpm-deployed self-contained bundle —
    // since v0.6.58, extracted to <userData>/embedded/ on first launch
    // from the bundled apps.tar.gz (see ensureEmbeddedRoot). The earlier
    // standalone <resources>/api/ tree had only dist/ and couldn't
    // resolve `express` at runtime; the deployed tree carries its own
    // node_modules.
    const apiEntry = app.isPackaged
      ? join(embeddedRoot, 'api', 'dist', 'index.js')
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
    const embeddedRoot = await this.ensureEmbeddedRoot();
    const webEntry = app.isPackaged
      ? join(embeddedRoot, 'web', 'dist', 'index.js')
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
    const embeddedRoot = await this.ensureEmbeddedRoot();
    // See apiEntry comment above — same reasoning for worker.
    const workerEntry = app.isPackaged
      ? join(embeddedRoot, 'worker', 'dist', 'index.js')
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
