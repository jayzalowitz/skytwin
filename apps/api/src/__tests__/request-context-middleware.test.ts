import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requestContext } from '../middleware/request-context.js';
import { getRequestUserId } from '@skytwin/db';

/**
 * Tests for the request-context middleware (#408).
 *
 * Uses the REAL @skytwin/db AsyncLocalStorage store (not a mock) so the test
 * proves the middleware actually installs a context that deep callees observe.
 */

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    params: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('requestContext middleware (#408)', () => {
  it('installs the authenticated userId so next() and its callees observe it', () => {
    const req = mockReq({ authenticatedUserId: 'auth-user' });
    const res = mockRes();
    let observed: string | undefined;
    const next: NextFunction = () => {
      observed = getRequestUserId();
    };

    requestContext(req, res, next);
    expect(observed).toBe('auth-user');
  });

  it('prefers the authenticated identity over the route param', () => {
    const req = mockReq({
      authenticatedUserId: 'auth-user',
      params: { userId: 'param-user' } as Request['params'],
    });
    let observed: string | undefined;
    requestContext(req, mockRes(), () => {
      observed = getRequestUserId();
    });
    expect(observed).toBe('auth-user');
  });

  it('falls back to the route param when there is no authenticated identity (dev bypass)', () => {
    const req = mockReq({ params: { userId: 'param-user' } as Request['params'] });
    let observed: string | undefined;
    requestContext(req, mockRes(), () => {
      observed = getRequestUserId();
    });
    expect(observed).toBe('param-user');
  });

  it('does NOT trust body or query userId for the context', () => {
    const req = mockReq({
      body: { userId: 'body-user' },
      query: { userId: 'query-user' } as Request['query'],
    });
    let observed: string | undefined;
    requestContext(req, mockRes(), () => {
      observed = getRequestUserId();
    });
    // No authenticated id, no route param → no context installed.
    expect(observed).toBeUndefined();
  });

  it('runs next() with no context when no userId can be resolved (catalog routes)', () => {
    const req = mockReq();
    const next = vi.fn(() => {
      expect(getRequestUserId()).toBeUndefined();
    });
    requestContext(req, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('always calls next exactly once', () => {
    const next = vi.fn();
    requestContext(mockReq({ authenticatedUserId: 'u' }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
