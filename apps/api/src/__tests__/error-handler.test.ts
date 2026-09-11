/**
 * Unit tests for the hardened global error handler (#367).
 *
 * Pre-fix, `app.use((err) => res.json({ message: err.message }))` leaked
 * the underlying pg error string ("could not parse … as type uuid",
 * including the `$1` parameter index) to clients whenever
 * `NODE_ENV=development`. The handler now always returns a safe generic
 * body regardless of NODE_ENV.
 *
 * We assert the contract against the exported middleware factory used by
 * `apps/api/src/index.ts`; importing the entrypoint itself would start the
 * server and other process-level side effects.
 */

import { describe, it, expect } from 'vitest';
import express, { type Express } from 'express';
import type { Logger } from '@skytwin/core';
import { createGlobalErrorHandler } from '../global-error-handler.js';

/**
 * Builds an app with the same error-handler contract as the one in
 * `apps/api/src/index.ts`. If we ever change the handler shape there,
 * this fixture must change in lockstep — that's the point.
 */
function buildAppWithThrowingRoute(
  thrower: () => never,
  logger: Pick<Logger, 'error'> = { error: () => undefined },
): Express {
  const app = express();
  app.use(express.json());
  app.get('/boom', (_req, _res, next) => {
    try {
      thrower();
    } catch (err) {
      next(err);
    }
  });
  app.use(createGlobalErrorHandler(logger));
  return app;
}

async function httpGet(
  app: Express,
  path: string,
): Promise<{ status: number; body: unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}${path}`)
        .then(async (res) => {
          const text = await res.text();
          let body: unknown = null;
          try { body = JSON.parse(text); } catch { /* leave null */ }
          server.close();
          resolve({ status: res.status, body, text });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('global error handler (#367)', () => {
  it('returns a safe generic message for a pg-shaped UUID parse error', async () => {
    const app = buildAppWithThrowingRoute(() => {
      const err: Error & { code?: string } = new Error(
        'error in argument for $1: could not parse "test-user" as type uuid: uuid: incorrect UUID length: test-user',
      );
      err.code = '22P02';
      throw err;
    });
    const res = await httpGet(app, '/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'internal_error',
      message: 'Something went wrong on our end.',
    });
  });

  it('never leaks pg internals in the response body', async () => {
    const app = buildAppWithThrowingRoute(() => {
      throw new Error(
        'error in argument for $1: could not parse "x" as type uuid: uuid: incorrect UUID length: x',
      );
    });
    const res = await httpGet(app, '/boom');
    expect(res.text).not.toMatch(/could not parse/i);
    expect(res.text).not.toMatch(/as type uuid/i);
    expect(res.text).not.toMatch(/error in argument for \$/i);
  });

  it('returns the same safe body for any unhandled Error (not just pg)', async () => {
    const app = buildAppWithThrowingRoute(() => {
      throw new Error('totally unrelated internal explosion with secret keys: ABC123');
    });
    const res = await httpGet(app, '/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'internal_error',
      message: 'Something went wrong on our end.',
    });
    expect(res.text).not.toMatch(/ABC123/);
    expect(res.text).not.toMatch(/secret/i);
  });

  it('does not send provider-controlled messages, bodies, or stacks to the logger', async () => {
    const marker = 'provider-secret-marker-7f3c';
    const logCalls: unknown[] = [];
    const app = buildAppWithThrowingRoute(
      () => {
        throw Object.assign(new Error(marker), {
          stack: `stack:${marker}`,
          body: marker,
          response: { body: marker },
          statusCode: 502,
        });
      },
      { error: (...args: unknown[]) => { logCalls.push(args); } },
    );

    await httpGet(app, '/boom');
    expect(logCalls).toEqual([
      ['Unhandled API request error', { errorCode: 'upstream_unavailable' }],
    ]);
    expect(JSON.stringify(logCalls)).not.toContain(marker);
  });
});
