/**
 * Unit tests for the shared UUID validation middleware (#367).
 *
 * Covers:
 *   - `isValidUserId` accepts canonical UUIDs and rejects malformed input
 *     across the shapes that historically reached pg and produced the
 *     "could not parse … as type uuid" leak.
 *   - `bindUserIdParamValidator` short-circuits malformed `:userId`
 *     segments with a clean 400 and JSON body — without ever calling
 *     `next()` (so the route handler / pg never see the bad value).
 *   - The valid case passes through to `next()` and reaches the handler.
 */

import { describe, it, expect, vi } from 'vitest';
import express, { type Express } from 'express';

import {
  isValidUserId,
  UUID_REGEX,
  bindUserIdParamValidator,
} from '../middleware/validate-uuid.js';

const GOOD = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';

describe('isValidUserId', () => {
  it('returns true for a canonical lower-case UUID', () => {
    expect(isValidUserId(GOOD)).toBe(true);
  });

  it('returns true for an upper-case UUID (CRDB tolerates either)', () => {
    expect(isValidUserId(GOOD.toUpperCase())).toBe(true);
  });

  it('returns false for the literal string "test-user" (the repro from #367)', () => {
    expect(isValidUserId('test-user')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isValidUserId('')).toBe(false);
  });

  it('returns false for undefined and null', () => {
    expect(isValidUserId(undefined)).toBe(false);
    expect(isValidUserId(null)).toBe(false);
  });

  it('returns false for a UUID with trailing whitespace', () => {
    expect(isValidUserId(`${GOOD} `)).toBe(false);
  });

  it('returns false for a UUID with extra trailing characters', () => {
    expect(isValidUserId(`${GOOD}-extra`)).toBe(false);
  });

  it('returns false for a non-string value', () => {
    expect(isValidUserId(123 as unknown)).toBe(false);
    expect(isValidUserId({} as unknown)).toBe(false);
  });
});

describe('UUID_REGEX', () => {
  it('matches the canonical UUID shape', () => {
    expect(UUID_REGEX.test(GOOD)).toBe(true);
  });

  it('rejects shapes that pg would parse as invalid', () => {
    for (const bad of ['test', '12345678-1234-1234-1234-12345678901', '', 'not-a-uuid']) {
      expect(UUID_REGEX.test(bad)).toBe(false);
    }
  });
});

/**
 * Lightweight HTTP test helper — mirrors the pattern in
 * routines-routes.test.ts so we don't pull in supertest just for these
 * three integration assertions.
 */
async function httpRequest(
  app: Express,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url, { method })
        .then(async (res) => {
          const body = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('bindUserIdParamValidator', () => {
  function buildApp(): { app: Express; handler: ReturnType<typeof vi.fn> } {
    const app = express();
    const router = express.Router();
    bindUserIdParamValidator(router);
    const handler = vi.fn();
    router.get('/:userId', (_req, res) => {
      handler();
      res.status(200).json({ ok: true });
    });
    app.use('/api/things', router);
    return { app, handler };
  }

  it('returns 400 invalid_user_id when :userId is not a UUID', async () => {
    const { app, handler } = buildApp();
    const res = await httpRequest(app, 'GET', '/api/things/test-user');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'invalid_user_id',
      message: 'User ID must be a UUID.',
    });
    // Critical: handler must NOT have been invoked — otherwise the bad
    // value would have reached pg and caused the SQL leak this fixes.
    expect(handler).not.toHaveBeenCalled();
  });

  it('never leaks pg-style "could not parse … as type uuid" wording', async () => {
    const { app } = buildApp();
    const res = await httpRequest(app, 'GET', '/api/things/not-a-uuid');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/could not parse/i);
    expect(body).not.toMatch(/as type uuid/i);
    expect(body).not.toMatch(/error in argument for \$/i);
  });

  it('passes through to the route handler when :userId is valid', async () => {
    const { app, handler } = buildApp();
    const res = await httpRequest(app, 'GET', `/api/things/${GOOD}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
