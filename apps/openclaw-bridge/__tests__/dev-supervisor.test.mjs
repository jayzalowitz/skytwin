import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');

function waitForReadyPid(proc, seen = new Set()) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ready pid; output so far: ${buffer}`));
    }, 5000);

    function cleanup() {
      clearTimeout(timeout);
      proc.stdout.off('data', onData);
      proc.off('exit', onExit);
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`supervisor exited before ready pid: code=${code} signal=${signal}`));
    }

    function onData(chunk) {
      buffer += chunk.toString();
      for (const match of buffer.matchAll(/TEST_CHILD_READY pid=(\d+)/g)) {
        const pid = Number(match[1]);
        if (!seen.has(pid)) {
          cleanup();
          resolve(pid);
          return;
        }
      }
    }

    proc.stdout.on('data', onData);
    proc.once('exit', onExit);
  });
}

test('dev supervisor restarts the bridge after an unexpected SIGKILL', async () => {
  const supervisor = spawn(process.execPath, ['dev-supervisor.mjs'], {
    cwd: appDir,
    env: {
      ...process.env,
      OPENCLAW_BRIDGE_SERVER: './__tests__/fixtures/sleep-server.mjs',
      OPENCLAW_BRIDGE_RESTART_DELAY_MS: '25',
      OPENCLAW_BRIDGE_RESTART_WINDOW_MS: '10000',
      OPENCLAW_BRIDGE_MAX_RESTARTS: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr = [];
  supervisor.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    const firstPid = await waitForReadyPid(supervisor);
    process.kill(firstPid, 'SIGKILL');

    const secondPid = await waitForReadyPid(supervisor, new Set([firstPid]));

    assert.notEqual(secondPid, firstPid);
    assert.equal(supervisor.exitCode, null, stderr.join(''));
  } finally {
    if (supervisor.exitCode === null) {
      supervisor.kill('SIGTERM');
      await once(supervisor, 'exit');
    }
  }
});

test('dev supervisor falls back to safe defaults for invalid restart config', async () => {
  const supervisor = spawn(process.execPath, ['dev-supervisor.mjs'], {
    cwd: appDir,
    env: {
      ...process.env,
      OPENCLAW_BRIDGE_SERVER: './__tests__/fixtures/exit-server.mjs',
      OPENCLAW_BRIDGE_RESTART_DELAY_MS: '1',
      OPENCLAW_BRIDGE_RESTART_WINDOW_MS: '10000',
      OPENCLAW_BRIDGE_MAX_RESTARTS: 'not-a-number',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const [code] = await once(supervisor, 'exit');
  assert.equal(code, 1);
});

test('dev supervisor SIGKILLs a child that ignores shutdown', async () => {
  const supervisor = spawn(process.execPath, ['dev-supervisor.mjs'], {
    cwd: appDir,
    env: {
      ...process.env,
      OPENCLAW_BRIDGE_SERVER: './__tests__/fixtures/ignore-term-server.mjs',
      OPENCLAW_BRIDGE_STOP_GRACE_MS: '25',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const childPid = await waitForReadyPid(supervisor);
  supervisor.kill('SIGTERM');

  const [code] = await once(supervisor, 'exit');
  assert.equal(code, 0);
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
});
