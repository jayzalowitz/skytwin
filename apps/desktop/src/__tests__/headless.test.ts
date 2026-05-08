import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';

/**
 * Unit tests for the headless daemon entry point.
 *
 * We use noSpawn:true and port:0 so no child processes are actually forked
 * and the OS assigns an ephemeral port — no EADDRINUSE conflicts.
 */

import { startHeadless } from '../headless.js';
import type { HeadlessServer } from '../headless.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the OS-assigned port after the server emits its 'listening' event. */
function waitForListening(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    if (server.listening) {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
        return;
      }
    }
    server.once('listening', () => {
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? addr.port : 0);
    });
  });
}

/** Perform a GET request and return { statusCode, body }. */
async function get(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startHeadless — module API', () => {
  it('is importable and exports startHeadless as a function', () => {
    expect(typeof startHeadless).toBe('function');
  });

  it('returns an object with server, port, and shutdown properties', async () => {
    const instance = startHeadless({ noSpawn: true, port: 0 });
    try {
      expect(instance).toHaveProperty('server');
      expect(instance).toHaveProperty('port');
      expect(instance).toHaveProperty('shutdown');
      expect(typeof instance.shutdown).toBe('function');
    } finally {
      await instance.shutdown();
    }
  });

  it('server is an instance of http.Server', async () => {
    const instance = startHeadless({ noSpawn: true, port: 0 });
    try {
      expect(instance.server).toBeInstanceOf(http.Server);
    } finally {
      await instance.shutdown();
    }
  });
});

describe('startHeadless — /health endpoint', () => {
  let instance: HeadlessServer | null = null;

  afterEach(async () => {
    if (instance) {
      await instance.shutdown();
      instance = null;
    }
  });

  it('GET /health responds 200 with status:ok', async () => {
    instance = startHeadless({ noSpawn: true, port: 0 });
    const port = await waitForListening(instance.server);
    const { statusCode, body } = await get(`http://localhost:${port}/health`);
    expect(statusCode).toBe(200);
    const parsed: unknown = JSON.parse(body);
    expect(parsed).toMatchObject({ status: 'ok', service: 'skytwin-headless' });
  });

  it('GET /health response includes timestamp and uptime', async () => {
    instance = startHeadless({ noSpawn: true, port: 0 });
    const port = await waitForListening(instance.server);
    const { body } = await get(`http://localhost:${port}/health`);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(typeof parsed['timestamp']).toBe('string');
    expect(typeof parsed['uptime']).toBe('number');
  });

  it('GET /unknown responds 404', async () => {
    instance = startHeadless({ noSpawn: true, port: 0 });
    const port = await waitForListening(instance.server);
    const { statusCode } = await get(`http://localhost:${port}/unknown-route`);
    expect(statusCode).toBe(404);
  });
});

describe('startHeadless — shutdown', () => {
  it('shutdown() closes the http server cleanly', async () => {
    const instance = startHeadless({ noSpawn: true, port: 0 });
    const port = await waitForListening(instance.server);

    await instance.shutdown();

    // Server should no longer accept connections after shutdown.
    await expect(get(`http://localhost:${port}/health`)).rejects.toThrow();
  });

  it('shutdown() resolves (does not hang) with noSpawn:true', async () => {
    const instance = startHeadless({ noSpawn: true, port: 0 });
    await waitForListening(instance.server);

    await expect(instance.shutdown()).resolves.toBeUndefined();
  });
});
