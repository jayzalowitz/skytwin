import { fork, spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import { CockroachManager, type CockroachStartResult } from './cockroach-manager.js';
import { computeBundleMarker } from './bundle-marker.js';
import { extractionDone, extractionProgress, type ExtractionProgress } from './extraction-progress.js';
import { verifyServiceInstanceProof } from './service-instance-proof.js';

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

interface ApiGeneration {
  readonly generation: number;
  readonly process: ChildProcess;
  readonly instanceCapability: string;
  readonly ingestCredential: string;
  readonly controller: AbortController;
}

export class ChildTerminationError extends Error {
  readonly code = 'CHILD_TERMINATION_UNPROVEN';

  constructor(readonly serviceName: string) {
    super(`${serviceName} child termination could not be proven`);
    this.name = 'ChildTerminationError';
  }
}

const MAX_RESTARTS = 5;
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const SERVICE_TERM_TIMEOUT_MS = 5_000;
const SERVICE_KILL_TIMEOUT_MS = 2_000;
const RESTART_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

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

async function fetchBounded(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs: number,
  authoritySignals: readonly AbortSignal[] = [],
): Promise<Response> {
  const controller = new AbortController();
  let rejectAuthority: ((error: Error) => void) | null = null;
  const authorityLost = new Promise<never>((_resolve, reject) => {
    rejectAuthority = reject;
  });
  const abort = (): void => {
    controller.abort();
    rejectAuthority?.(new Error('request authority was revoked'));
  };
  for (const signal of authoritySignals) signal.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('request timed out'));
      }, timeoutMs);
    });
    if (authoritySignals.some((signal) => signal.aborted)) abort();
    return await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      timeout,
      authorityLost,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const signal of authoritySignals) signal.removeEventListener('abort', abort);
  }
}

async function fetchJsonBounded<T>(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs: number,
  authoritySignals: readonly AbortSignal[] = [],
): Promise<{ response: Response; payload: T | null }> {
  const controller = new AbortController();
  let rejectAuthority: ((error: Error) => void) | null = null;
  const authorityLost = new Promise<never>((_resolve, reject) => {
    rejectAuthority = reject;
  });
  const abort = (): void => {
    controller.abort();
    rejectAuthority?.(new Error('request authority was revoked'));
  };
  for (const signal of authoritySignals) signal.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('request timed out'));
      }, timeoutMs);
    });
    if (authoritySignals.some((signal) => signal.aborted)) abort();
    const request = (async (): Promise<{ response: Response; payload: T | null }> => {
      const response = await fetch(input, { ...init, signal: controller.signal });
      const payload = (await response.json().catch(() => null)) as T | null;
      return { response, payload };
    })();
    return await Promise.race([request, timeout, authorityLost]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const signal of authoritySignals) signal.removeEventListener('abort', abort);
  }
}

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
const BUNDLED_GOOGLE_CLIENT_ID = '594829999930-kpjopcs1pak0rp0omimuegr5ugcv5l8h.apps.googleusercontent.com';

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
    const child = spawn('tar', ['-tzf', tarPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
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
  private api: ManagedProcess = {
    process: null,
    status: 'stopped',
    restartCount: 0,
    failureTimestamps: [],
    external: false,
  };
  private worker: ManagedProcess = {
    process: null,
    status: 'stopped',
    restartCount: 0,
    failureTimestamps: [],
    external: false,
  };
  private web: ManagedProcess = {
    process: null,
    status: 'stopped',
    restartCount: 0,
    failureTimestamps: [],
    external: false,
  };
  private cockroach = new CockroachManager();
  private cockroachStatus: ProcessState = 'stopped';
  private onStatusChange: ((status: ServiceStatus) => void) | null = null;
  private onExtractProgress: ((progress: ExtractionProgress) => void) | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private sampleBootstrapAllowedThisLaunch = false;
  private sampleLaunchEpoch = 0;
  private sampleAbortController: AbortController | null = null;
  private serviceLifecycleTail: Promise<void> = Promise.resolve();
  private activeDatabaseStartup: CockroachStartResult | null = null;
  private apiGeneration: ApiGeneration | null = null;
  private nextApiGeneration = 0;
  private healthCheckInFlight = false;
  private readonly terminatingProcesses = new WeakMap<ChildProcess, Promise<void>>();

  constructor() {
    this.cockroach.setAuthorityLossHandler((generation) => {
      const startup = this.activeDatabaseStartup;
      if (startup?.ownership === 'managed-child' && startup.generation === generation) {
        this.schedulePackagedDatabaseLoss(startup, 'managed CockroachDB child exited');
      }
    });
  }

  private isServiceDatabaseCurrent(startup: CockroachStartResult | null): boolean {
    if (!app.isPackaged) return true;
    return (
      startup?.ownership === 'managed-child' &&
      this.activeDatabaseStartup === startup &&
      this.cockroach.isManagedStartCurrent(startup)
    );
  }

  private invalidatePackagedDatabase(startup: CockroachStartResult, reason: string): boolean {
    if (!app.isPackaged || this.activeDatabaseStartup !== startup) return false;
    console.error(`[crdb] ${reason}; stopping packaged services.`);
    this.activeDatabaseStartup = null;
    this.revokeSampleLaunch();
    this.cockroachStatus = 'error';
    this.emitStatus();
    return true;
  }

  private async stopDataServicesOwned(): Promise<void> {
    const results = await Promise.allSettled([
      this.stopProcess(this.api, 'api'),
      this.stopProcess(this.worker, 'worker'),
      this.stopProcess(this.web, 'web'),
    ]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  private schedulePackagedDatabaseLoss(startup: CockroachStartResult, reason: string): void {
    if (!this.invalidatePackagedDatabase(startup, reason)) return;
    void this.runServiceLifecycle(() => this.stopDataServicesOwned()).catch((error) => {
      console.error('[crdb] Failed to stop services after database authority loss:', error);
    });
  }

  private async requireServiceDatabaseCurrent(
    startup: CockroachStartResult,
    phase: string,
  ): Promise<void> {
    if (this.isServiceDatabaseCurrent(startup)) return;
    this.invalidatePackagedDatabase(startup, `ownership changed ${phase}`);
    await this.stopDataServicesOwned();
    throw new Error(`CockroachDB ownership changed ${phase}`);
  }

  private guardServiceDatabase(startup: CockroachStartResult | null, phase: string): boolean {
    if (this.isServiceDatabaseCurrent(startup)) return true;
    if (startup) this.schedulePackagedDatabaseLoss(startup, `ownership changed ${phase}`);
    return false;
  }

  private async requireApiGenerationCurrent(generation: ApiGeneration, phase: string): Promise<void> {
    if (this.isApiGenerationCurrent(generation)) return;
    await this.stopDataServicesOwned();
    throw new Error(`API process generation changed ${phase}`);
  }

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
          console.log(`[extract] Bundle changed (${markerSource}): ${installed} -> ${currentMarker}. Re-extracting.`);
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
      const child = spawn('tar', ['-xzvf', tarPath, '-C', extractedRoot], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
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
   * Read or generate the per-installation loopback service token used by
   * developer-managed services as `SKYTWIN_SERVICE_TOKEN`.
   *
   * The desktop pins `NODE_ENV=production` for all children, which turns the
   * API's localhost auth bypass OFF. Before this existed, the worker's
   * `forwardSignalToApi()` and the idle-miner's ingest emitter posted to
   * `/api/events/ingest` with no credential at all, so every packaged install
   * 401'd on every signal and ingested nothing. Packaged API generations
   * replace this fallback with a fresh in-memory credential shared only with
   * the worker spawned for that generation.
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
      envOverride !== undefined && envOverride !== '' ? envOverride : BUNDLED_GOOGLE_CLIENT_ID || '';
    const inheritedEnv = { ...process.env } as Record<string, string>;
    if (app.isPackaged) {
      delete inheritedEnv['SKYTWIN_API_INSTANCE_CAPABILITY'];
      delete inheritedEnv['SKYTWIN_SERVICE_TOKEN'];
    }
    return {
      ...inheritedEnv,
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
      API_BASE_URL: 'http://127.0.0.1:3100',
      // A packaged desktop is a local-data product: its services must use
      // the exact database child this launch attested. Shell inheritance is
      // useful in development, but it is not authority to redirect a signed
      // bundle to an arbitrary database.
      DATABASE_URL: app.isPackaged
        ? this.cockroach.getConnectionString()
        : process.env['DATABASE_URL'] || this.cockroach.getConnectionString(),
      // API refuses to start in NODE_ENV=production without this; auto-
      // generate per-install. Persisted across launches.
      SESSION_SECRET: process.env['SESSION_SECRET'] || this.getOrCreateSessionSecret(),
      // Pinned AFTER the `...process.env` spread on purpose: a packaged build
      // must never inherit a developer's shell bypass. Real auth, always.
      SKYTWIN_DEV_AUTH_BYPASS: 'false',
      // Developer fallback. Packaged API/worker generations receive a fresh
      // in-memory ingest credential instead; web children never receive one.
      ...(app.isPackaged
        ? {}
        : {
            SKYTWIN_SERVICE_TOKEN:
              process.env['SKYTWIN_SERVICE_TOKEN'] || this.getOrCreateServiceToken(),
          }),
    };
  }

  private apiEnv(instanceCapability: string, ingestCredential: string): Record<string, string> {
    return {
      ...this.getEnv(),
      SKYTWIN_API_INSTANCE_CAPABILITY: instanceCapability,
      SKYTWIN_SERVICE_TOKEN: ingestCredential,
    };
  }

  private workerEnv(apiGeneration: ApiGeneration | null): Record<string, string> {
    const env = this.getEnv();
    if (apiGeneration && this.isApiGenerationCurrent(apiGeneration)) {
      env['SKYTWIN_SERVICE_TOKEN'] = apiGeneration.ingestCredential;
    } else if (app.isPackaged) {
      throw new Error('Packaged worker startup requires the current API generation');
    }
    delete env['SKYTWIN_API_INSTANCE_CAPABILITY'];
    return env;
  }

  private webEnv(): Record<string, string> {
    const env = this.getEnv();
    delete env['SKYTWIN_API_INSTANCE_CAPABILITY'];
    delete env['SKYTWIN_SERVICE_TOKEN'];
    return env;
  }

  /**
   * Run database migrations against the bundled CRDB. Idempotent — safe to
   * re-run every launch. Pulled into a separate method so startAll() can
   * gate the API on migrations completing.
   */
  private async runMigrations(startup: CockroachStartResult): Promise<boolean> {
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
    // Call the migration package directly from Electron main so asar and
    // pnpm-deploy paths resolve consistently. The package's upOwned() entry
    // creates fixed, non-reconnecting pg clients and rechecks this launch's
    // database capability before each write.
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
      const nativeImport = new Function('p', 'return import(p)') as (
        p: string,
      ) => Promise<{
        upOwned?: (options: {
          connectionString: string;
          authorize: () => boolean;
        }) => Promise<void>;
      }>;
      const mod = await nativeImport(moduleUrl);
      if (typeof mod.upOwned !== 'function') {
        console.error('[migrate] target has no upOwned() export:', script);
        return false;
      }
      if (!this.cockroach.isManagedStartCurrent(startup)) {
        console.error('[migrate] CockroachDB ownership changed before migration; refusing to write.');
        return false;
      }
      await mod.upOwned({
        // Never inherit DATABASE_URL here. The migration capability is for
        // the exact bundled listener attested by CockroachManager.
        connectionString: this.cockroach.getConnectionString(),
        authorize: () => this.cockroach.isManagedStartCurrent(startup),
      });
      if (!this.cockroach.isManagedStartCurrent(startup)) {
        console.error('[migrate] CockroachDB ownership changed during migration; refusing startup.');
        return false;
      }
      console.log('[migrate] complete');
      return true;
    } catch (err) {
      console.error('[migrate] failed:', err);
      return false;
    }
  }

  private beginSampleLaunch(): { epoch: number; signal: AbortSignal } {
    this.sampleAbortController?.abort();
    const controller = new AbortController();
    this.sampleAbortController = controller;
    this.sampleBootstrapAllowedThisLaunch = false;
    const epoch = ++this.sampleLaunchEpoch;
    return { epoch, signal: controller.signal };
  }

  private revokeSampleLaunch(): void {
    this.sampleAbortController?.abort();
    this.sampleAbortController = null;
    this.sampleBootstrapAllowedThisLaunch = false;
    ++this.sampleLaunchEpoch;
  }

  private isSampleLaunchCurrent(epoch: number, signal: AbortSignal, startup: CockroachStartResult): boolean {
    return (
      app.isPackaged &&
      !signal.aborted &&
      epoch === this.sampleLaunchEpoch &&
      this.cockroach.isManagedStartCurrent(startup)
    );
  }

  private isSampleAuthorityCurrent(epoch: number, signal: AbortSignal, startup: CockroachStartResult): boolean {
    return this.sampleBootstrapAllowedThisLaunch && this.isSampleLaunchCurrent(epoch, signal, startup);
  }

  private isApiGenerationCurrent(expected: ApiGeneration): boolean {
    return (
      !this.api.external &&
      this.apiGeneration === expected &&
      this.api.process === expected.process &&
      !expected.controller.signal.aborted &&
      !childHasExited(expected.process)
    );
  }

  private revokeApiGeneration(expected?: ApiGeneration): void {
    const current = this.apiGeneration;
    if (!current || (expected && current !== expected)) return;
    current.controller.abort();
    this.apiGeneration = null;
  }

  private isSampleIngestCurrent(
    startup: CockroachStartResult,
    epoch: number,
    signal: AbortSignal,
    apiGeneration: ApiGeneration,
  ): boolean {
    return this.isSampleAuthorityCurrent(epoch, signal, startup) && this.isApiGenerationCurrent(apiGeneration);
  }

  /**
   * Provision the account-free sample only for a packaged build using its
   * bundled loopback database. The database module enforces the same boundary
   * again before writing and refuses reserved-ID collisions with real users.
   */
  private async provisionPackagedSample(
    startup: CockroachStartResult,
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.isSampleLaunchCurrent(epoch, signal, startup)) return;

    const embeddedRoot = await this.ensureEmbeddedRoot();
    if (!this.isSampleLaunchCurrent(epoch, signal, startup)) return;
    const moduleSymlink = join(
      embeddedRoot,
      'api',
      'node_modules',
      '@skytwin',
      'db',
      'dist',
      'seeds',
      'packaged-sample.js',
    );
    if (!existsSync(moduleSymlink)) {
      console.warn('[sample] Packaged sample module is missing:', moduleSymlink);
      return;
    }

    try {
      const moduleUrl = pathToFileURL(realpathSync(moduleSymlink)).href;
      const nativeImport = new Function('p', 'return import(p)') as (p: string) => Promise<{
        provisionPackagedSample: (env: {
          desktopMode: string | undefined;
          nodeEnv: string | undefined;
          databaseUrl: string | undefined;
          bundledDatabaseUrl: string | undefined;
          databaseOwnership: 'managed-child' | 'preexisting';
          managedDataDir: string | null;
          bundledDataDir: string;
          packaged: boolean;
          authorize: () => boolean;
        }) => Promise<{ created: boolean; userId: string }>;
      }>;
      const mod = await nativeImport(moduleUrl);
      if (!this.isSampleLaunchCurrent(epoch, signal, startup)) return;
      const env = this.getEnv();
      const result = await mod.provisionPackagedSample({
        packaged: app.isPackaged,
        desktopMode: env['DESKTOP_MODE'],
        nodeEnv: env['NODE_ENV'],
        databaseUrl: env['DATABASE_URL'],
        bundledDatabaseUrl: this.cockroach.getConnectionString(),
        databaseOwnership: startup.ownership,
        managedDataDir: startup.dataDir,
        bundledDataDir: this.cockroach.getDataDir(),
        authorize: () => this.isSampleLaunchCurrent(epoch, signal, startup),
      });
      if (!this.isSampleLaunchCurrent(epoch, signal, startup)) return;
      // Retry the versioned fixture on every healthy launch. Each synthetic
      // signal carries a stable signalId, so the normal ingest dedupe path
      // resumes partial bootstraps without duplicating decisions or approvals.
      this.sampleBootstrapAllowedThisLaunch = true;
      console.log(
        result.created ? '[sample] Reserved sample identity provisioned.' : '[sample] Sample identity already present.',
      );
    } catch (err) {
      // Sample availability must not prevent owners from opening their local
      // twin. The guard and transaction fail closed before touching real data.
      console.error('[sample] Provisioning skipped:', err);
    }
  }

  /** Populate a newly-created sample through the authenticated API boundary. */
  private async ingestPackagedSample(
    startup: CockroachStartResult,
    epoch: number,
    signal: AbortSignal,
    apiGeneration: ApiGeneration,
  ): Promise<void> {
    if (!this.isSampleIngestCurrent(startup, epoch, signal, apiGeneration)) return;

    const embeddedRoot = await this.ensureEmbeddedRoot();
    if (!this.isSampleIngestCurrent(startup, epoch, signal, apiGeneration)) return;
    const moduleSymlink = join(
      embeddedRoot,
      'api',
      'node_modules',
      '@skytwin',
      'db',
      'dist',
      'seeds',
      'packaged-sample.js',
    );
    try {
      const moduleUrl = pathToFileURL(realpathSync(moduleSymlink)).href;
      const nativeImport = new Function('p', 'return import(p)') as (p: string) => Promise<{
        ingestPackagedSampleSignals: (options: {
          apiUrl: string;
          serviceToken: string;
          signal: AbortSignal;
          authorizeRequest: () => Promise<boolean>;
        }) => Promise<{ ingested: number; total: number }>;
      }>;
      const mod = await nativeImport(moduleUrl);
      if (!this.isSampleIngestCurrent(startup, epoch, signal, apiGeneration)) return;
      const requestSignal = AbortSignal.any([signal, apiGeneration.controller.signal]);
      if (!this.isSampleIngestCurrent(startup, epoch, requestSignal, apiGeneration)) return;
      const result = await mod.ingestPackagedSampleSignals({
        // Keep the privileged request on the exact origin authenticated by
        // verifyOwnedApi(); localhost could resolve to another IPv6 listener.
        apiUrl: 'http://127.0.0.1:3100',
        serviceToken: apiGeneration.ingestCredential,
        signal: requestSignal,
        authorizeRequest: async () =>
          this.isSampleIngestCurrent(startup, epoch, requestSignal, apiGeneration) &&
          (await this.verifyOwnedApi(apiGeneration, epoch, requestSignal)),
      });
      if (!this.isSampleIngestCurrent(startup, epoch, requestSignal, apiGeneration)) return;
      console.log(`[sample] Ingested ${result.ingested}/${result.total} sample signals.`);
    } catch (err) {
      console.error('[sample] Signal ingestion incomplete:', err);
    }
  }

  /** Prove that the API listener holds this exact spawn's capability. */
  private async verifyOwnedApi(
    expected: ApiGeneration,
    epoch?: number,
    launchSignal?: AbortSignal,
    timeoutMs = HEALTH_REQUEST_TIMEOUT_MS,
  ): Promise<boolean> {
    if (
      launchSignal?.aborted ||
      (epoch !== undefined && epoch !== this.sampleLaunchEpoch) ||
      !this.isApiGenerationCurrent(expected)
    )
      return false;
    const challenge = randomBytes(32).toString('hex');
    try {
      const url = new URL('http://127.0.0.1:3100/api/health/instance');
      url.searchParams.set('challenge', challenge);
      const authoritySignals = launchSignal
        ? [launchSignal, expected.controller.signal]
        : [expected.controller.signal];
      const { response, payload } = await fetchJsonBounded<{
        service?: unknown;
        challenge?: unknown;
        proof?: unknown;
      }>(url, {}, timeoutMs, authoritySignals);
      if (!response.ok) return false;
      return (
        !launchSignal?.aborted &&
        (epoch === undefined || epoch === this.sampleLaunchEpoch) &&
        this.isApiGenerationCurrent(expected) &&
        payload?.service === 'skytwin-api' &&
        payload.challenge === challenge &&
        verifyServiceInstanceProof(expected.instanceCapability, challenge, payload.proof)
      );
    } catch {
      return false;
    }
  }

  /** Run sample ingestion in the background after proving API ownership. */
  private startPackagedSampleIngest(startup: CockroachStartResult, epoch: number, signal: AbortSignal): void {
    const apiGeneration = this.apiGeneration;
    if (!apiGeneration || !this.isSampleIngestCurrent(startup, epoch, signal, apiGeneration)) return;
    void (async () => {
      if (!(await this.verifyOwnedApi(apiGeneration, epoch, signal))) {
        console.warn('[sample] Signal ingestion skipped: API instance could not be authenticated.');
        return;
      }
      if (!this.isSampleIngestCurrent(startup, epoch, signal, apiGeneration)) return;
      await this.ingestPackagedSample(startup, epoch, signal, apiGeneration);
    })().catch((err) => {
      console.error('[sample] Background signal ingestion failed:', err);
    });
  }

  startAll(): Promise<void> {
    return this.runServiceLifecycle(() => this.startAllOwned());
  }

  private async startAllOwned(): Promise<void> {
    this.paused = false;
    this.activeDatabaseStartup = null;
    const { epoch, signal } = this.beginSampleLaunch();
    let startup: CockroachStartResult | null = null;
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
      if (app.isPackaged) {
        this.cockroachStatus = 'error';
        this.emitStatus();
        throw new Error('Packaged startup refused an external API listener');
      }
      console.log('[crdb] External API detected on :3100 — skipping local CockroachDB startup.');
      // In monorepo dev, the external API owns the DB connection and
      // migrations. Treat the dependency as satisfied for tray/status
      // purposes; the API health check below remains the source of truth.
      this.cockroachStatus = 'running';
      this.emitStatus();
    } else {
      startup = await this.startCockroach();
      if (
        app.isPackaged &&
        (startup?.ownership !== 'managed-child' || !this.cockroach.isManagedStartCurrent(startup))
      ) {
        this.cockroachStatus = 'error';
        this.emitStatus();
        throw new Error('Packaged startup requires the desktop-owned CockroachDB instance');
      }
      if (app.isPackaged && startup?.ownership === 'managed-child') {
        this.activeDatabaseStartup = startup;
      }
      // Migrations must complete after CRDB is up but before API starts;
      // otherwise API hits "relation does not exist" on first query and
      // crashlooks until restart-backoff exhausts.
      if (
        this.cockroachStatus === 'running' &&
        startup?.ownership === 'managed-child' &&
        this.cockroach.isManagedStartCurrent(startup)
      ) {
        const migrated = await this.runMigrations(startup);
        if (migrated && this.cockroach.isManagedStartCurrent(startup)) {
          await this.provisionPackagedSample(startup, epoch, signal);
          if (app.isPackaged && !this.cockroach.isManagedStartCurrent(startup)) {
            this.activeDatabaseStartup = null;
            this.revokeSampleLaunch();
            this.cockroachStatus = 'error';
            this.emitStatus();
            throw new Error('CockroachDB ownership changed before packaged services could start');
          }
        } else if (app.isPackaged) {
          this.activeDatabaseStartup = null;
          this.revokeSampleLaunch();
          this.cockroachStatus = 'error';
          this.emitStatus();
          throw new Error('Packaged startup requires migrations on the desktop-owned CockroachDB instance');
        }
      } else if (this.cockroachStatus === 'running' && app.isPackaged) {
        this.activeDatabaseStartup = null;
        this.revokeSampleLaunch();
        this.cockroachStatus = 'error';
        this.emitStatus();
        throw new Error('Packaged startup refused an unowned CockroachDB listener');
      }
    }
    if (app.isPackaged && startup) await this.requireServiceDatabaseCurrent(startup, 'before API startup');
    const apiGeneration = await this.startApi(startup);
    if (app.isPackaged && startup) await this.requireServiceDatabaseCurrent(startup, 'during API startup');
    if (app.isPackaged && (!apiGeneration || !this.isApiGenerationCurrent(apiGeneration))) {
      await this.stopDataServicesOwned();
      throw new Error('Packaged startup requires the desktop-owned API process');
    }
    const apiReady = await this.waitForApi(10000, startup, apiGeneration);
    if (app.isPackaged && startup) await this.requireServiceDatabaseCurrent(startup, 'during API readiness');
    if (app.isPackaged && !apiReady) {
      await this.stopDataServicesOwned();
      throw new Error('Packaged startup could not authenticate the desktop-owned API listener');
    }
    if (apiReady) {
      this.api.restartCount = 0;
      this.api.failureTimestamps = [];
    }
    await this.startWeb(startup, apiGeneration);
    if (app.isPackaged && startup) await this.requireServiceDatabaseCurrent(startup, 'during web startup');
    if (app.isPackaged && apiGeneration) {
      await this.requireApiGenerationCurrent(apiGeneration, 'during web startup');
    }
    await this.startWorker(startup, apiGeneration);
    if (app.isPackaged && startup) await this.requireServiceDatabaseCurrent(startup, 'during worker startup');
    if (app.isPackaged && apiGeneration) {
      await this.requireApiGenerationCurrent(apiGeneration, 'during worker startup');
    }
    setTimeout(() => {
      if (this.worker.status === 'running') {
        this.worker.restartCount = 0;
        this.worker.failureTimestamps = [];
      }
    }, 3000);

    this.startHealthMonitoring(startup);
    if (apiReady && startup?.ownership === 'managed-child' && this.isSampleAuthorityCurrent(epoch, signal, startup)) {
      this.startPackagedSampleIngest(startup, epoch, signal);
    }
  }

  private startHealthMonitoring(startup: CockroachStartResult | null): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = setInterval(() => void this.runHealthCheck(startup), HEALTH_CHECK_INTERVAL_MS);
  }

  private async runHealthCheck(startup: CockroachStartResult | null): Promise<void> {
    if (this.healthCheckInFlight) return;
    this.healthCheckInFlight = true;
    try {
      if (!this.guardServiceDatabase(startup, 'during health monitoring')) return;
      if (this.paused) return;

      // A packaged health response must prove the exact API generation, not
      // merely that some process has occupied the well-known port.
      if (this.api.status === 'running') {
        if (app.isPackaged) {
          const generation = this.apiGeneration;
          if (!generation || !(await this.verifyOwnedApi(generation))) {
            this.schedulePackagedApiIdentityLoss(startup, generation, 'API listener identity changed');
            return;
          }
        } else {
          try {
            const response = await fetchBounded(
              'http://localhost:3100/api/health',
              {},
              HEALTH_REQUEST_TIMEOUT_MS,
            );
            if (!this.guardServiceDatabase(startup, 'during API health check')) return;
            if (!response.ok) this.recordFailure(this.api, 'api');
          } catch {
            this.recordFailure(this.api, 'api');
          }
        }
      }

      // Check worker is still alive (process-level check)
      if (this.worker.status === 'running' && this.worker.process && !this.worker.process.connected) {
        this.recordFailure(this.worker, 'worker');
      }
    } finally {
      this.healthCheckInFlight = false;
    }
  }

  private schedulePackagedApiIdentityLoss(
    startup: CockroachStartResult | null,
    generation: ApiGeneration | null,
    reason: string,
  ): void {
    if (!app.isPackaged || !generation || !this.isApiGenerationCurrent(generation)) return;
    this.revokeApiGeneration(generation);
    this.api.status = 'error';
    this.emitStatus();
    void this.runServiceLifecycle(async () => {
      console.error(`[api] ${reason}; stopping packaged data services.`);
      await this.stopDataServicesOwned();
      if (startup) this.guardServiceDatabase(startup, 'after API listener identity loss');
    }).catch((error) => {
      console.error('[api] Failed to stop services after listener identity loss:', error);
    });
  }

  private recordFailure(managed: ManagedProcess, name: string): void {
    const now = Date.now();
    managed.failureTimestamps.push(now);
    // Trim old timestamps outside the window
    managed.failureTimestamps = managed.failureTimestamps.filter((t) => now - t < FAILURE_WINDOW_MS);

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
  private async startCockroach(): Promise<CockroachStartResult | null> {
    this.cockroachStatus = 'starting';
    this.emitStatus();
    let startup: CockroachStartResult | null = null;
    try {
      startup = await this.cockroach.start();
      this.cockroachStatus = 'running';
    } catch (err) {
      console.error('[crdb] Failed to start:', err);
      this.cockroachStatus = 'error';
      if ((err as { code?: unknown } | null)?.code === 'COCKROACH_TERMINATION_UNPROVEN') {
        this.emitStatus();
        throw err;
      }
    }
    this.emitStatus();
    return startup;
  }

  private async detectExternalApi(): Promise<boolean> {
    if (app.isPackaged) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const res = await fetch('http://localhost:3100/api/health', {
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const payload = (await res.json().catch(() => null)) as {
        service?: unknown;
      } | null;
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

  private async startApi(startup: CockroachStartResult | null = null): Promise<ApiGeneration | null> {
    if (!this.guardServiceDatabase(startup, 'before API spawn')) return null;
    if (this.apiGeneration && this.isApiGenerationCurrent(this.apiGeneration)) return this.apiGeneration;
    this.revokeApiGeneration();
    if (this.api.process) await this.stopProcess(this.api, 'api');
    this.api.status = 'starting';
    this.emitStatus();

    if (await this.detectExternalApi()) {
      if (!this.guardServiceDatabase(startup, 'while detecting the API listener')) return null;
      console.log('[api] External API detected on :3100 — using existing instance, not forking.');
      this.api.external = true;
      this.api.status = 'running';
      this.emitStatus();
      return null;
    }
    this.api.external = false;

    const base = this.getResourcePath();
    const embeddedRoot = await this.ensureEmbeddedRoot();
    if (!this.guardServiceDatabase(startup, 'while resolving the API bundle')) return null;
    // Packaged path uses the pnpm-deployed self-contained bundle —
    // since v0.6.58, extracted to <userData>/embedded/ on first launch
    // from the bundled apps.tar.gz (see ensureEmbeddedRoot). The earlier
    // standalone <resources>/api/ tree had only dist/ and couldn't
    // resolve `express` at runtime; the deployed tree carries its own
    // node_modules.
    const apiEntry = app.isPackaged
      ? join(embeddedRoot, 'api', 'dist', 'index.js')
      : join(base, 'apps', 'api', 'dist', 'index.js');

    let generation: ApiGeneration | null = null;
    try {
      const instanceCapability = randomBytes(32).toString('hex');
      const ingestCredential = randomBytes(32).toString('hex');
      const apiProcess = fork(apiEntry, [], {
        env: this.apiEnv(instanceCapability, ingestCredential),
        stdio: 'pipe',
      });
      this.api.process = apiProcess;
      generation = {
        generation: ++this.nextApiGeneration,
        process: apiProcess,
        instanceCapability,
        ingestCredential,
        controller: new AbortController(),
      };
      this.apiGeneration = generation;

      apiProcess.stdout?.on('data', (data: Buffer) => {
        console.log(`[api] ${data.toString().trim()}`);
      });
      apiProcess.stderr?.on('data', (data: Buffer) => {
        console.error(`[api] ${data.toString().trim()}`);
      });

      const handleApiLoss = (reason: string): void => {
        if (this.api.process !== apiProcess) return;
        if (this.terminatingProcesses.has(apiProcess)) return;
        if (generation) this.revokeApiGeneration(generation);
        this.api.process = null;
        this.api.status = 'stopped';
        this.emitStatus();
        if (!this.paused && this.guardServiceDatabase(startup, 'before API restart')) {
          this.api.restartCount++;
          this.recordFailure(this.api, 'api');
          if ((this.api.status as ProcessState) !== 'error') {
            const delay = this.getRestartDelay(this.api.restartCount);
            console.log(
              `[api] ${reason}; restarting in ${delay}ms (attempt ${this.api.restartCount})...`,
            );
            void this.restartDataServicesAfterApiExit(startup, delay).catch((error) => {
              console.error('[api] Safe restart failed:', error);
            });
          }
        }
      };
      apiProcess.on('error', (error) => {
        console.error('[api] Child process error:', error);
        handleApiLoss('child process error');
      });
      apiProcess.on('exit', (code) => {
        console.log(`[api] Process exited with code ${code}`);
        handleApiLoss(`process exited with code ${code}`);
      });

      this.api.status = 'running';
      this.emitStatus();
      if (!this.guardServiceDatabase(startup, 'after API spawn')) {
        void this.stopProcess(this.api, 'api');
        return null;
      }
      return generation;
    } catch (err) {
      if (generation) this.revokeApiGeneration(generation);
      console.error('[api] Failed to start:', err);
      this.api.status = 'error';
      this.emitStatus();
      return null;
    }
  }

  private restartDataServicesAfterApiExit(
    startup: CockroachStartResult | null,
    delayMs: number,
  ): Promise<void> {
    return this.runServiceLifecycle(async () => {
      if (!app.isPackaged) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        await this.startApi(startup);
        return;
      }
      await this.stopDataServicesOwned();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!this.guardServiceDatabase(startup, 'before API generation restart')) return;
      const generation = await this.startApi(startup);
      if (!generation || !(await this.waitForApi(10_000, startup, generation))) {
        await this.stopDataServicesOwned();
        throw new Error('Replacement API generation could not prove listener ownership');
      }
      await this.startWeb(startup, generation);
      await this.startWorker(startup, generation);
      this.startHealthMonitoring(startup);
      const sampleSignal = this.sampleAbortController?.signal;
      if (
        startup?.ownership === 'managed-child' &&
        sampleSignal &&
        this.isSampleAuthorityCurrent(this.sampleLaunchEpoch, sampleSignal, startup)
      ) {
        this.startPackagedSampleIngest(startup, this.sampleLaunchEpoch, sampleSignal);
      }
    });
  }

  private async startWeb(
    startup: CockroachStartResult | null = null,
    apiGeneration: ApiGeneration | null = null,
  ): Promise<void> {
    if (!this.guardServiceDatabase(startup, 'before web spawn')) return;
    if (app.isPackaged && (!apiGeneration || !this.isApiGenerationCurrent(apiGeneration))) return;
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
    if (!this.guardServiceDatabase(startup, 'while resolving the web bundle')) return;
    if (app.isPackaged && (!apiGeneration || !this.isApiGenerationCurrent(apiGeneration))) return;
    const webEntry = app.isPackaged
      ? join(embeddedRoot, 'web', 'dist', 'index.js')
      : join(base, 'apps', 'web', 'dist', 'index.js');

    try {
      const webProcess = fork(webEntry, [], {
        env: { ...this.webEnv(), WEB_PORT: '3200' },
        stdio: 'pipe',
      });
      this.web.process = webProcess;

      webProcess.stdout?.on('data', (data: Buffer) => {
        console.log(`[web] ${data.toString().trim()}`);
      });
      webProcess.stderr?.on('data', (data: Buffer) => {
        console.error(`[web] ${data.toString().trim()}`);
      });

      webProcess.on('exit', (code) => {
        console.log(`[web] Process exited with code ${code}`);
        if (this.web.process !== webProcess) return;
        if (this.terminatingProcesses.has(webProcess)) return;
        this.web.process = null;
        this.web.status = 'stopped';
        this.emitStatus();
        if (
          code !== 0 &&
          !this.paused &&
          this.guardServiceDatabase(startup, 'before web restart') &&
          (!app.isPackaged || (apiGeneration && this.isApiGenerationCurrent(apiGeneration)))
        ) {
          this.web.restartCount++;
          this.recordFailure(this.web, 'web');
          if ((this.web.status as ProcessState) !== 'error') {
            const delay = this.getRestartDelay(this.web.restartCount);
            console.log(`[web] Restarting in ${delay}ms (attempt ${this.web.restartCount})...`);
            setTimeout(() => {
              if (this.guardServiceDatabase(startup, 'before delayed web restart')) {
                void this.startWeb(startup, apiGeneration);
              }
            }, delay);
          }
        }
      });

      this.web.status = 'running';
      this.emitStatus();
      if (
        !this.guardServiceDatabase(startup, 'after web spawn') ||
        (app.isPackaged && (!apiGeneration || !this.isApiGenerationCurrent(apiGeneration)))
      ) {
        void this.stopProcess(this.web, 'web');
      }
    } catch (err) {
      console.error('[web] Failed to start:', err);
      this.web.status = 'error';
      this.emitStatus();
    }
  }

  private async startWorker(
    startup: CockroachStartResult | null = null,
    apiGeneration: ApiGeneration | null = null,
  ): Promise<void> {
    if (!this.guardServiceDatabase(startup, 'before worker spawn')) return;
    if (app.isPackaged && (!apiGeneration || !this.isApiGenerationCurrent(apiGeneration))) return;
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
    if (!this.guardServiceDatabase(startup, 'while resolving the worker bundle')) return;
    if (app.isPackaged && (!apiGeneration || !this.isApiGenerationCurrent(apiGeneration))) return;
    // See apiEntry comment above — same reasoning for worker.
    const workerEntry = app.isPackaged
      ? join(embeddedRoot, 'worker', 'dist', 'index.js')
      : join(base, 'apps', 'worker', 'dist', 'index.js');

    try {
      const workerProcess = fork(workerEntry, [], {
        env: this.workerEnv(apiGeneration),
        stdio: 'pipe',
      });
      this.worker.process = workerProcess;

      workerProcess.stdout?.on('data', (data: Buffer) => {
        console.log(`[worker] ${data.toString().trim()}`);
      });
      workerProcess.stderr?.on('data', (data: Buffer) => {
        console.error(`[worker] ${data.toString().trim()}`);
      });

      workerProcess.on('exit', (code) => {
        console.log(`[worker] Process exited with code ${code}`);
        if (this.worker.process !== workerProcess) return;
        if (this.terminatingProcesses.has(workerProcess)) return;
        this.worker.process = null;
        this.worker.status = 'stopped';
        this.emitStatus();
        if (
          code !== 0 &&
          !this.paused &&
          this.guardServiceDatabase(startup, 'before worker restart') &&
          (!app.isPackaged || (apiGeneration && this.isApiGenerationCurrent(apiGeneration)))
        ) {
          this.worker.restartCount++;
          this.recordFailure(this.worker, 'worker');
          if ((this.worker.status as ProcessState) !== 'error') {
            const delay = this.getRestartDelay(this.worker.restartCount);
            console.log(`[worker] Restarting in ${delay}ms (attempt ${this.worker.restartCount})...`);
            setTimeout(() => {
              if (this.guardServiceDatabase(startup, 'before delayed worker restart')) {
                void this.startWorker(startup, apiGeneration);
              }
            }, delay);
          }
        }
      });

      this.worker.status = 'running';
      this.emitStatus();
      if (
        !this.guardServiceDatabase(startup, 'after worker spawn') ||
        (app.isPackaged && (!apiGeneration || !this.isApiGenerationCurrent(apiGeneration)))
      ) {
        void this.stopProcess(this.worker, 'worker');
      }
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
    await this.startWorker(this.activeDatabaseStartup, this.apiGeneration);
  }

  isPaused(): boolean {
    return this.paused;
  }

  private stopProcess(managed: ManagedProcess, name: string): Promise<void> {
    if (!managed.process) return Promise.resolve();

    const proc = managed.process;
    const existing = this.terminatingProcesses.get(proc);
    if (existing) return existing;
    if (managed === this.api && this.apiGeneration?.process === proc) {
      this.revokeApiGeneration(this.apiGeneration);
    }
    let termination!: Promise<void>;
    termination = this.stopProcessOwned(managed, name, proc).finally(() => {
      if (this.terminatingProcesses.get(proc) === termination) {
        this.terminatingProcesses.delete(proc);
      }
    });
    this.terminatingProcesses.set(proc, termination);
    return termination;
  }

  private async stopProcessOwned(
    managed: ManagedProcess,
    name: string,
    proc: ChildProcess,
  ): Promise<void> {
    if (process.platform === 'win32') {
      // Windows: SIGTERM is unreliable, use taskkill for force termination
      try {
        if (proc.pid) {
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
          console.log(`[${name}] Terminated via taskkill (PID ${proc.pid})`);
        }
      } catch {
        // The final exit check below remains authoritative.
        console.warn(`[${name}] taskkill failed — awaiting process exit proof`);
      }

      if (!(await waitForChildExit(proc, SERVICE_KILL_TIMEOUT_MS))) {
        managed.status = 'error';
        this.emitStatus();
        throw new ChildTerminationError(name);
      }
    } else {
      // Unix (macOS/Linux): graceful SIGTERM then force SIGKILL
      try {
        proc.kill('SIGTERM');
      } catch {
        // The final exit check below remains authoritative.
      }
      if (!(await waitForChildExit(proc, SERVICE_TERM_TIMEOUT_MS))) {
        try {
          proc.kill('SIGKILL');
          console.warn(`[${name}] Force-killed after 5s timeout`);
        } catch {
          // The final exit check below remains authoritative.
        }
        if (!(await waitForChildExit(proc, SERVICE_KILL_TIMEOUT_MS))) {
          managed.status = 'error';
          this.emitStatus();
          throw new ChildTerminationError(name);
        }
      }
    }

    if (managed.process === proc) managed.process = null;
    managed.status = 'stopped';
  }

  stopAll(): Promise<void> {
    this.revokeSampleLaunch();
    this.activeDatabaseStartup = null;
    return this.runServiceLifecycle(() => this.stopAllOwned());
  }

  private async stopAllOwned(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Stop API/worker/web first so their open DB connections drain before
    // we bring down CockroachDB — otherwise CRDB logs a flurry of "client
    // disconnected" messages and the API logs "connection reset" on the
    // last in-flight query, both of which are noise for the user.
    try {
      await this.stopDataServicesOwned();
    } catch (error) {
      // Keep the database endpoint occupied by its proven child while an API
      // or worker may still be alive. Releasing the SQL port here could let a
      // replacement listener receive reconnects from that unproven process.
      this.emitStatus();
      throw error;
    }
    try {
      await this.cockroach.stop();
      this.cockroachStatus = 'stopped';
    } catch (err) {
      console.error('[crdb] stop failed:', err);
      this.cockroachStatus = 'error';
      this.emitStatus();
      throw err;
    }
    this.emitStatus();
  }

  private runServiceLifecycle(operation: () => Promise<void>): Promise<void> {
    const run = this.serviceLifecycleTail.then(operation, operation);
    this.serviceLifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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

    return {
      api: apiState,
      worker: workerState,
      cockroach: cockroachState,
      overall,
    };
  }

  getUptime(): number {
    return process.uptime();
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus());
  }

  private async waitForApi(
    timeoutMs: number,
    startup: CockroachStartResult | null = null,
    expectedGeneration: ApiGeneration | null = null,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.guardServiceDatabase(startup, 'during API readiness')) return false;
      const remainingMs = Math.max(1, deadline - Date.now());
      if (app.isPackaged) {
        if (!expectedGeneration || !this.isApiGenerationCurrent(expectedGeneration)) return false;
        if (
          await this.verifyOwnedApi(
            expectedGeneration,
            undefined,
            undefined,
            Math.min(HEALTH_REQUEST_TIMEOUT_MS, remainingMs),
          )
        ) {
          return true;
        }
      } else {
        try {
          const response = await fetchBounded(
            'http://localhost:3100/api/health',
            {},
            Math.min(HEALTH_REQUEST_TIMEOUT_MS, remainingMs),
          );
          if (!this.guardServiceDatabase(startup, 'during API readiness')) return false;
          if (response.ok) return true;
        } catch {
          // API not ready yet
        }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
      if (!this.guardServiceDatabase(startup, 'during API readiness')) return false;
    }
    console.warn('[api] Authenticated readiness check timed out');
    return false;
  }
}
