/**
 * Headless daemon entry point for SkyTwin.
 *
 * Invoked via:
 *   node ./dist/headless.js          (direct)
 *   pnpm --filter @skytwin/desktop headless   (via package.json script)
 *
 * This file intentionally has NO Electron imports. It starts the API and
 * worker as forked Node child processes (see spawnChild → child_process.fork
 * — there is no separate ServiceManager class here despite the name appearing
 * elsewhere), exposes /health on the configured port, and handles SIGTERM
 * for graceful shutdown.
 *
 * The actual Electron window / tray paths in main.ts are NOT touched.
 * (#188 turnkey distribution will provide the binary path resolution and
 * system-level install scripts.)
 */

import * as http from 'http';
import { fork, type ChildProcess } from 'child_process';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Configuration helpers (read at call time, not module load time, so tests
// can set process.env values before calling startHeadless)
// ---------------------------------------------------------------------------

/** Default port for the headless health endpoint. Exported so callers can
 *  fall back to the same value when SKYTWIN_API_PORT is unset or garbage. */
export const DEFAULT_HEADLESS_PORT = 4000;

function resolvePort(): number {
  // parseInt('garbage', 10) === NaN, and server.listen(NaN) throws at runtime.
  // Validate the result; fall back to the default for any non-finite or
  // out-of-range value. 0 is allowed (OS-assigned ephemeral port).
  const raw = process.env['SKYTWIN_API_PORT'];
  if (raw === undefined || raw === '') return DEFAULT_HEADLESS_PORT;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    process.stderr.write(
      `[headless] SKYTWIN_API_PORT="${raw}" is not a valid port; falling back to ${DEFAULT_HEADLESS_PORT}\n`,
    );
    return DEFAULT_HEADLESS_PORT;
  }
  return parsed;
}

function resolveWorkerEntry(): string {
  return process.env['SKYTWIN_WORKER_ENTRY'] ?? join(__dirname, '..', '..', 'worker', 'dist', 'index.js');
}

function resolveApiEntry(): string {
  return process.env['SKYTWIN_API_ENTRY'] ?? join(__dirname, '..', '..', 'api', 'dist', 'index.js');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadlessServer {
  /** The raw http.Server so tests can inject and inspect it. */
  server: http.Server;
  /**
   * The port the health server is bound to. Read via getter so callers see
   * the OS-assigned port after a port:0 listen, not the requested 0.
   * Returns the requested port value before the server has bound.
   */
  readonly port: number;
  /** Perform a graceful shutdown: stop child processes then close the HTTP server. */
  shutdown: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Child process management
// ---------------------------------------------------------------------------

function spawnChild(entryPath: string, label: string): ChildProcess {
  const child = fork(entryPath, [], {
    env: {
      ...(process.env as Record<string, string>),
      DESKTOP_MODE: 'true',
      NODE_ENV: process.env['NODE_ENV'] ?? 'production',
    },
    stdio: 'pipe',
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[${label}] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[${label}] ${chunk.toString()}`);
  });
  child.on('exit', (code) => {
    process.stdout.write(`[headless] ${label} exited with code ${code ?? 'null'}\n`);
  });

  return child;
}

function stopChild(child: ChildProcess | null, label: string): Promise<void> {
  if (!child) return Promise.resolve();
  // Already exited — don't wait 5s for an event that won't fire.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      resolve();
    }, 5000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch {
      process.stderr.write(`[headless] could not send SIGTERM to ${label}\n`);
      clearTimeout(timer);
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

function createHealthServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        service: 'skytwin-headless',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, () => {
    // Read the bound port from address() — the requested `port` is wrong
    // when port:0 (OS-assigned ephemeral). The previous log claimed
    // "listening on port 0" while the real port was something else, which
    // also broke any caller that grepped the log to discover the URL.
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
    process.stdout.write(`[headless] SkyTwin headless daemon listening on port ${actualPort}\n`);
    process.stdout.write(`[headless] Health: http://localhost:${actualPort}/health\n`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Start the headless daemon.
 *
 * Spawns the API and worker child processes (unless noSpawn is true or
 * SKYTWIN_HEADLESS_NO_SPAWN=1 — used by unit tests that want to test the
 * HTTP surface without actually forking Node children), then starts the
 * health server.
 *
 * Returns a HeadlessServer so callers (and tests) can inspect the server
 * and trigger shutdown programmatically.
 *
 * The port is resolved from SKYTWIN_API_PORT at call time (not module load
 * time) so tests can set the env variable before calling this function.
 * Pass port:0 to let the OS assign an ephemeral port.
 */
export function startHeadless(options?: { noSpawn?: boolean; port?: number }): HeadlessServer {
  const noSpawn = options?.noSpawn ?? process.env['SKYTWIN_HEADLESS_NO_SPAWN'] === '1';
  const port = options?.port ?? resolvePort();
  const apiEntry = resolveApiEntry();
  const workerEntry = resolveWorkerEntry();

  let apiProcess: ChildProcess | null = null;
  let workerProcess: ChildProcess | null = null;

  if (!noSpawn) {
    process.stdout.write(`[headless] Starting API from ${apiEntry}\n`);
    apiProcess = spawnChild(apiEntry, 'api');

    process.stdout.write(`[headless] Starting worker from ${workerEntry}\n`);
    workerProcess = spawnChild(workerEntry, 'worker');
  } else {
    process.stdout.write('[headless] noSpawn=true — skipping child process fork\n');
  }

  const server = createHealthServer(port);

  async function shutdown(): Promise<void> {
    process.stdout.write('[headless] Shutting down...\n');
    await Promise.all([
      stopChild(apiProcess, 'api'),
      stopChild(workerProcess, 'worker'),
    ]);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    process.stdout.write('[headless] Shutdown complete\n');
  }

  return {
    server,
    get port() {
      // Defer to the bound address — supports port:0 / OS-assigned ports.
      const addr = server.address();
      return typeof addr === 'object' && addr !== null ? addr.port : port;
    },
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// Signal handling (only when this module is the process entry point)
// ---------------------------------------------------------------------------

// __HEADLESS_MAIN__ is set by the CLI shim (see package.json script) so that
// tests can import startHeadless without attaching signal handlers to the
// test process.
if (process.env['__HEADLESS_MAIN__'] === '1') {
  process.stdout.write('[headless] SkyTwin headless daemon starting\n');
  process.stdout.write(`[headless] PID ${process.pid}\n`);

  const instance = startHeadless({ port: resolvePort() });

  let shuttingDown = false;

  function handleSignal(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[headless] Received ${signal}, shutting down gracefully\n`);
    instance.shutdown().then(() => {
      process.exit(0);
    }).catch((err: unknown) => {
      process.stderr.write(`[headless] Shutdown error: ${String(err)}\n`);
      process.exit(1);
    });
  }

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
}
