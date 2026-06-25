import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = process.env['OPENCLAW_BRIDGE_SERVER']
  ? path.resolve(here, process.env['OPENCLAW_BRIDGE_SERVER'])
  : path.join(here, 'server.mjs');
const restartDelayMs = readIntegerEnv('OPENCLAW_BRIDGE_RESTART_DELAY_MS', 1000, { min: 0 });
const restartWindowMs = readIntegerEnv('OPENCLAW_BRIDGE_RESTART_WINDOW_MS', 60000, { min: 1 });
const maxRestarts = readIntegerEnv('OPENCLAW_BRIDGE_MAX_RESTARTS', 5, { min: 1 });
const stopGraceMs = readIntegerEnv('OPENCLAW_BRIDGE_STOP_GRACE_MS', 5000, { min: 0 });

let child = null;
let stopping = false;
const restartTimes = [];

function readIntegerEnv(name, defaultValue, { min }) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;

  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= min) {
    return parsed;
  }

  console.warn(`[openclaw-bridge:dev] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${defaultValue}`);
  return defaultValue;
}

function pruneRestartWindow(now) {
  while (restartTimes.length > 0 && now - restartTimes[0] > restartWindowMs) {
    restartTimes.shift();
  }
}

function describeExit(code, signal) {
  if (signal) return `signal=${signal}`;
  return `code=${code ?? 'unknown'}`;
}

function startBridge() {
  child = spawn(process.execPath, [serverEntry], {
    cwd: here,
    env: {
      ...process.env,
      BRIDGE_PORT: process.env['BRIDGE_PORT'] ?? '3456',
    },
    stdio: 'inherit',
  });

  child.once('exit', (code, signal) => {
    child = null;

    if (stopping) {
      process.exit(0);
    }

    const now = Date.now();
    restartTimes.push(now);
    pruneRestartWindow(now);

    if (restartTimes.length > maxRestarts) {
      console.error(
        `[openclaw-bridge:dev] bridge exited ${restartTimes.length} times in ${restartWindowMs}ms; giving up after ${describeExit(code, signal)}`,
      );
      process.exit(code && code > 0 ? code : 1);
    }

    console.warn(
      `[openclaw-bridge:dev] bridge exited unexpectedly (${describeExit(code, signal)}); restarting in ${restartDelayMs}ms`,
    );
    setTimeout(startBridge, restartDelayMs);
  });
}

function childHasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function signalChild(proc, signal) {
  if (childHasExited(proc)) return;

  try {
    proc.kill(signal);
  } catch (err) {
    if (err?.code === 'ESRCH') return;
    console.warn(
      `[openclaw-bridge:dev] failed to send ${signal} to bridge child: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function stop(signal) {
  if (stopping) return;
  stopping = true;

  if (!child || childHasExited(child)) {
    process.exit(0);
    return;
  }

  const childToStop = child;
  const forceTimer = setTimeout(() => {
    if (childHasExited(childToStop)) return;
    console.warn(`[openclaw-bridge:dev] bridge child ignored ${signal}; sending SIGKILL`);
    signalChild(childToStop, 'SIGKILL');
  }, stopGraceMs);
  forceTimer.unref();

  childToStop.once('exit', () => clearTimeout(forceTimer));
  signalChild(childToStop, signal);
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

startBridge();
