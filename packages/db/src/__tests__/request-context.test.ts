import { describe, it, expect } from 'vitest';
import {
  runWithRequestContext,
  getRequestContext,
  getRequestUserId,
  assertUserContext,
  UserContextMismatchError,
} from '../request-context.js';

describe('request-context store (#408)', () => {
  it('exposes the userId to callees within the run scope', () => {
    runWithRequestContext({ userId: 'user-a' }, () => {
      expect(getRequestUserId()).toBe('user-a');
      expect(getRequestContext()).toEqual({ userId: 'user-a' });
    });
  });

  it('carries the userId across async boundaries (await inside the scope)', async () => {
    await runWithRequestContext({ userId: 'user-async' }, async () => {
      // Force a microtask + macrotask hop; AsyncLocalStorage must survive both.
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getRequestUserId()).toBe('user-async');
    });
  });

  it('returns undefined outside any run scope (worker / migration / unit test)', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getRequestUserId()).toBeUndefined();
  });

  it('nested scopes shadow the outer context only for their own subtree', () => {
    runWithRequestContext({ userId: 'outer' }, () => {
      expect(getRequestUserId()).toBe('outer');
      runWithRequestContext({ userId: 'inner' }, () => {
        expect(getRequestUserId()).toBe('inner');
      });
      // Back in the outer subtree.
      expect(getRequestUserId()).toBe('outer');
    });
  });
});

describe('assertUserContext (#408)', () => {
  it('is a no-op when there is no active context (fail-open for workers/seeds)', () => {
    // No surrounding runWithRequestContext — must not throw.
    expect(() => assertUserContext('any-user')).not.toThrow();
  });

  it('passes when the passed userId matches the active context', () => {
    runWithRequestContext({ userId: 'user-a' }, () => {
      expect(() => assertUserContext('user-a')).not.toThrow();
    });
  });

  it('throws UserContextMismatchError on a cross-user attempt', () => {
    runWithRequestContext({ userId: 'user-a' }, () => {
      // A deep callee handed user-b's id while user-a's request is in flight.
      expect(() => assertUserContext('user-b')).toThrow(UserContextMismatchError);
    });
  });

  it('mismatch error carries both ids for server-side logging but the message is generic-safe', () => {
    runWithRequestContext({ userId: 'ctx-user' }, () => {
      try {
        assertUserContext('other-user');
        throw new Error('expected assertUserContext to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(UserContextMismatchError);
        const mismatch = err as UserContextMismatchError;
        expect(mismatch.expectedUserId).toBe('ctx-user');
        expect(mismatch.actualUserId).toBe('other-user');
      }
    });
  });

  it('does not fire on an empty userId — that is the caller/route validation concern', () => {
    runWithRequestContext({ userId: 'user-a' }, () => {
      expect(() => assertUserContext('')).not.toThrow();
    });
  });

  it('survives an async hop before the assertion fires', async () => {
    await runWithRequestContext({ userId: 'user-a' }, async () => {
      await Promise.resolve();
      expect(() => assertUserContext('user-b')).toThrow(UserContextMismatchError);
    });
  });
});
