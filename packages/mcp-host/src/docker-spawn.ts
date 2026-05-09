/**
 * docker-spawn.ts — zero-trust Docker container isolation for stdio MCP servers.
 *
 * SCOPE: stdio transport only.
 *
 * HTTP/SSE MCP servers are remote processes — applying --network=none would
 * prevent all connectivity to the server and is therefore impossible. This
 * module is never invoked for http or sse transports. See McpHost.installServer
 * for the guard.
 *
 * PREREQUISITE: The MCP server binary must be resolvable inside the container.
 * v1 mounts the host's npm global prefix directory (typically
 * ~/.npm-global/lib/node_modules or the output of `npm root -g`) into the
 * container at /usr/local/lib/node_modules so that `npx` and `node` can find
 * pre-installed packages without needing internet access during startup.
 *
 * To install an MCP server package for use inside zero-trust containers:
 *   npm install -g <package>          # host install
 *   # then launch the server — the mount makes it visible inside the container
 *
 * Per-server OAuth domain allowlists and sidecar-proxy approaches are deferred
 * to v2 (#183 follow-up).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Writable, Readable } from 'node:stream';
import os from 'node:os';

const execFileAsync = promisify(execFile);

/** Default container image. Node 22 Alpine keeps the image small. */
const DEFAULT_IMAGE = 'node:22-alpine';

/** Default memory cap (MB). Configurable via DockerSpawnConfig. */
const DEFAULT_MEMORY_MB = 512;

/** Default CPU cap (fractional cores). */
const DEFAULT_CPUS = '1';

export interface DockerSpawnConfig {
  /**
   * Docker image to use. Defaults to 'node:22-alpine'.
   * The image must have the MCP server binary (or npx) available.
   */
  image?: string;

  /**
   * The MCP server command to run inside the container (e.g. 'npx', 'node').
   */
  command: string;

  /**
   * Arguments for the command (e.g. ['-y', '@notionhq/notion-mcp-server']).
   */
  args: string[];

  /**
   * Environment variables to pass into the container via -e KEY=VALUE flags.
   * Only keys are logged — values are never logged to prevent PII/secret leakage.
   */
  env?: Record<string, string>;

  /**
   * When true (the default) the host's npm global modules directory is mounted
   * read-only into the container at /usr/local/lib/node_modules. This allows
   * packages installed via `npm install -g` on the host to be found by npx
   * inside the container without network access.
   *
   * Set to false if the image already contains the required packages.
   */
  mountGlobalNodeModules?: boolean;

  /**
   * Memory limit in MB. Defaults to 512.
   * Maps to Docker's --memory flag.
   */
  memoryMb?: number;
}

export interface DockerSpawnResult {
  /**
   * PID of the `docker run` process on the host (not the container process PID).
   */
  pid: number;

  /** Writable stream connected to the container's stdin. */
  stdin: Writable;

  /** Readable stream connected to the container's stdout. */
  stdout: Readable;

  /** Readable stream connected to the container's stderr. */
  stderr: Readable;

  /**
   * Send SIGTERM to the docker run process, then SIGKILL after 3 s.
   * The container is removed automatically due to --rm.
   */
  kill(): Promise<void>;

  /**
   * Resolves when the docker run process exits.
   */
  waitExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Check whether the docker CLI is available in PATH.
 *
 * Uses `which` on POSIX and `where` on win32. Returns false (rather than
 * throwing) so callers can fall back gracefully.
 */
export async function isDockerAvailable(): Promise<boolean> {
  const checkCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(checkCmd, ['docker']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the host's npm global node_modules directory.
 *
 * Falls back to ~/.npm-global/lib/node_modules if `npm root -g` fails.
 * The result is used as the read-only bind-mount source for the container.
 */
async function getNpmGlobalModulesDir(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('npm', ['root', '-g']);
    const dir = stdout.trim();
    if (dir) return dir;
  } catch {
    // fall through to default
  }
  return `${os.homedir()}/.npm-global/lib/node_modules`;
}

/**
 * Spawn an MCP server process inside a Docker container with --network=none.
 *
 * The returned streams (stdin/stdout/stderr) are suitable for use as the
 * underlying I/O for DockerStdioTransport.
 *
 * Security properties:
 * - --network=none  — no network access from inside the container
 * - --rm            — container filesystem cleaned up on exit
 * - --init          — proper PID 1 / signal propagation
 * - --memory        — memory cap (default 512 MB)
 * - --cpus          — CPU cap (default 1)
 * - --user          — runs as the host uid:gid, never as root
 * - --read-only     — filesystem is read-only (tmpfs for /tmp provided)
 * - --cap-drop ALL  — drops all Linux capabilities
 * - --security-opt no-new-privileges — prevents privilege escalation
 *
 * @throws if docker is not in PATH or if the spawn fails immediately.
 */
export function spawnInDockerNoNetwork(config: DockerSpawnConfig): DockerSpawnResult {
  const image = config.image ?? DEFAULT_IMAGE;
  const memoryMb = config.memoryMb ?? DEFAULT_MEMORY_MB;

  // Build the docker argv synchronously — mount discovery is async but we use
  // a cached default. For async mount resolution callers should use
  // spawnInDockerNoNetworkAsync (see below). This synchronous variant uses a
  // best-effort default path for the global modules mount.
  const globalModulesFallback = `${os.homedir()}/.npm-global/lib/node_modules`;

  const dockerArgs = buildDockerArgs({
    image,
    command: config.command,
    args: config.args,
    env: config.env,
    mountGlobalNodeModules: config.mountGlobalNodeModules,
    globalModulesDir: globalModulesFallback,
    memoryMb,
  });

  // Only log image, args count, and env key count — never full args or env values.
  // Full args can contain API keys passed as positional parameters.
  const envKeyCount = config.env ? Object.keys(config.env).length : 0;
  process.stderr.write(
    `[docker-spawn] spawning image=${image} args=${config.args.length} envKeys=${envKeyCount}\n`,
  );

  const child = spawn('docker', dockerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  if (!child.pid) {
    throw new Error('[docker-spawn] Failed to spawn docker process — docker may not be in PATH');
  }

  return {
    pid: child.pid,
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    kill: () => killChild(child),
    waitExit: () => waitForExit(child),
  };
}

/**
 * Async variant of spawnInDockerNoNetwork that resolves the npm global modules
 * directory via `npm root -g` before spawning. Prefer this over the sync
 * variant in production paths.
 */
export async function spawnInDockerNoNetworkAsync(
  config: DockerSpawnConfig,
): Promise<DockerSpawnResult> {
  const image = config.image ?? DEFAULT_IMAGE;
  const memoryMb = config.memoryMb ?? DEFAULT_MEMORY_MB;

  const globalModulesDir =
    config.mountGlobalNodeModules === false
      ? ''
      : await getNpmGlobalModulesDir();

  const dockerArgs = buildDockerArgs({
    image,
    command: config.command,
    args: config.args,
    env: config.env,
    mountGlobalNodeModules: config.mountGlobalNodeModules,
    globalModulesDir,
    memoryMb,
  });

  const envKeyCount = config.env ? Object.keys(config.env).length : 0;
  process.stderr.write(
    `[docker-spawn] spawning image=${image} args=${config.args.length} envKeys=${envKeyCount}\n`,
  );

  const child = spawn('docker', dockerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  if (!child.pid) {
    throw new Error('[docker-spawn] Failed to spawn docker process — docker may not be in PATH');
  }

  return {
    pid: child.pid,
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    kill: () => killChild(child),
    waitExit: () => waitForExit(child),
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────────

interface BuildDockerArgsOptions {
  image: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  mountGlobalNodeModules?: boolean;
  globalModulesDir: string;
  memoryMb: number;
}

/**
 * Builds the full docker run argv array.
 *
 * Exported for testing — production code calls spawnInDockerNoNetwork.
 */
export function buildDockerArgs(opts: BuildDockerArgsOptions): string[] {
  const {
    image,
    command,
    args,
    env,
    mountGlobalNodeModules,
    globalModulesDir,
    memoryMb,
  } = opts;

  const shouldMount = mountGlobalNodeModules !== false && globalModulesDir !== '';

  // uid:gid — ensures files created inside the container are owned by the
  // host user, and prevents running as root (Docker default uid=0).
  const uid = process.getuid ? process.getuid() : 1000;
  const gid = process.getgid ? process.getgid() : 1000;

  const dockerArgv: string[] = [
    'run',
    '--network=none',
    '--rm',
    '--interactive',
    '--init',
    `--memory=${memoryMb}m`,
    `--cpus=${DEFAULT_CPUS}`,
    `--user=${uid}:${gid}`,
    '--read-only',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
  ];

  // Mount host's global node_modules read-only so pre-installed packages are visible.
  if (shouldMount) {
    dockerArgv.push(`--volume=${globalModulesDir}:/usr/local/lib/node_modules:ro`);
  }

  // Environment variables — -e KEY=VALUE.
  // We only log key count, never values.
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      dockerArgv.push(`-e`, `${key}=${value}`);
    }
  }

  dockerArgv.push(image, command, ...args);

  return dockerArgv;
}

async function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }

    const exitTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 3_000);

    child.once('exit', () => {
      clearTimeout(exitTimer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(exitTimer);
      resolve();
    }
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: null });
      return;
    }
    child.once('exit', (code, signal) => {
      resolve({ code, signal: signal as NodeJS.Signals | null });
    });
  });
}
