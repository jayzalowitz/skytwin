import { describe, it, expect } from 'vitest';
import {
  classifyRequest,
  isPrecached,
  isReplayable,
  serializeWrite,
  decideReplayOutcome,
  PRECACHE_URLS,
  MAX_REPLAY_ATTEMPTS,
} from '../sw-policy.js';

const ORIGIN = 'https://localhost:3200';

describe('classifyRequest', () => {
  it('treats navigate-mode requests as navigation (network-first shell)', () => {
    expect(
      classifyRequest({ method: 'GET', url: `${ORIGIN}/`, mode: 'navigate' }, ORIGIN),
    ).toBe('navigation');
    expect(
      classifyRequest({ method: 'GET', url: `${ORIGIN}/decisions`, mode: 'navigate' }, ORIGIN),
    ).toBe('navigation');
  });

  it('treats Accept: text/html GETs as navigation even without mode', () => {
    expect(
      classifyRequest(
        { method: 'GET', url: `${ORIGIN}/`, headers: { accept: 'text/html,*/*' } },
        ORIGIN,
      ),
    ).toBe('navigation');
  });

  it('serves precached assets cache-first', () => {
    expect(classifyRequest({ method: 'GET', url: `${ORIGIN}/js/app.js` }, ORIGIN)).toBe('shell');
    expect(classifyRequest({ method: 'GET', url: `${ORIGIN}/css/styles.css` }, ORIGIN)).toBe('shell');
  });

  it('routes other same-origin GETs to runtime (network-first)', () => {
    expect(
      classifyRequest({ method: 'GET', url: `${ORIGIN}/api/decisions/u1` }, ORIGIN),
    ).toBe('runtime');
  });

  it('queues same-origin mutating API writes', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        classifyRequest({ method: m, url: `${ORIGIN}/api/feedback` }, ORIGIN),
      ).toBe('queueable-write');
    }
  });

  it('does NOT queue OAuth / pairing / stream writes (non-replayable)', () => {
    expect(
      classifyRequest({ method: 'POST', url: `${ORIGIN}/api/sessions/pair/consume` }, ORIGIN),
    ).toBe('passthrough');
    expect(
      classifyRequest({ method: 'POST', url: `${ORIGIN}/api/oauth/google/authorize` }, ORIGIN),
    ).toBe('passthrough');
    expect(
      classifyRequest({ method: 'POST', url: `${ORIGIN}/api/assistant/messages` }, ORIGIN),
    ).toBe('passthrough');
  });

  it('never intercepts cross-origin requests', () => {
    expect(
      classifyRequest({ method: 'GET', url: 'https://fonts.googleapis.com/css2' }, ORIGIN),
    ).toBe('passthrough');
    expect(
      classifyRequest({ method: 'POST', url: 'https://evil.example/api/feedback' }, ORIGIN),
    ).toBe('passthrough');
  });

  it('does not queue non-API writes (e.g. a POST to a non-/api path)', () => {
    expect(
      classifyRequest({ method: 'POST', url: `${ORIGIN}/upload` }, ORIGIN),
    ).toBe('passthrough');
  });

  it('falls back to passthrough on an unparseable URL', () => {
    expect(classifyRequest({ method: 'GET', url: 'http://[' }, ORIGIN)).toBe('passthrough');
  });
});

describe('precache list', () => {
  it('includes the shell entrypoints', () => {
    for (const url of ['/', '/index.html', '/offline.html', '/js/app.js', '/manifest.webmanifest']) {
      expect(PRECACHE_URLS).toContain(url);
    }
  });
  it('isPrecached matches list membership exactly', () => {
    expect(isPrecached('/js/app.js')).toBe(true);
    expect(isPrecached('/js/app.js?v=2')).toBe(false); // query already stripped upstream
    expect(isPrecached('/js/pages/decisions.js')).toBe(false);
  });
});

describe('isReplayable', () => {
  it('allows ordinary mutating endpoints', () => {
    expect(isReplayable('/api/feedback')).toBe(true);
    expect(isReplayable('/api/approvals/req-1/respond')).toBe(true);
    expect(isReplayable('/api/twin/u1/preferences')).toBe(true);
  });
  it('blocks single-use / streamed / time-sensitive endpoints', () => {
    expect(isReplayable('/api/oauth/google/disconnect')).toBe(false);
    expect(isReplayable('/api/sessions/pair/consume')).toBe(false);
    expect(isReplayable('/api/assistant/messages')).toBe(false);
  });
});

describe('serializeWrite', () => {
  it('produces a structured-clone-safe record with a stable shape', () => {
    const w = serializeWrite(
      {
        url: `${ORIGIN}/api/feedback`,
        method: 'post',
        headersEntries: [
          ['Content-Type', 'application/json'],
          ['Authorization', 'Bearer t'],
          ['Content-Length', '42'],
          ['Cookie', 'sid=1'],
        ],
        bodyText: '{"type":"approve"}',
      },
      () => 'fixed-id',
    );
    expect(w.id).toBe('fixed-id');
    expect(w.method).toBe('POST');
    expect(w.body).toBe('{"type":"approve"}');
    expect(w.attempts).toBe(0);
    expect(typeof w.queuedAt).toBe('number');
    // Keeps content-type + authorization (the user's own token)…
    expect(w.headers['content-type']).toBe('application/json');
    expect(w.headers['authorization']).toBe('Bearer t');
    // …drops headers the browser must recompute / that are unsafe to replay.
    expect(w.headers['content-length']).toBeUndefined();
    expect(w.headers['cookie']).toBeUndefined();
  });

  it('defaults a null body and generates an id when none supplied', () => {
    const w = serializeWrite({ url: `${ORIGIN}/api/x`, method: 'DELETE' });
    expect(w.body).toBeNull();
    expect(typeof w.id).toBe('string');
    expect(w.id.length).toBeGreaterThan(0);
  });
});

describe('decideReplayOutcome', () => {
  const base = { id: 'a', url: 'u', method: 'POST', headers: {}, body: null, queuedAt: 0, attempts: 0 };

  it('removes on a successful replay', () => {
    expect(decideReplayOutcome(base, { ok: true, status: 200 })).toBe('remove');
  });

  it('removes (gives up) on a permanent 4xx — it will not fix itself', () => {
    expect(decideReplayOutcome(base, { ok: false, status: 400 })).toBe('remove');
    expect(decideReplayOutcome(base, { ok: false, status: 403 })).toBe('remove');
    expect(decideReplayOutcome(base, { ok: false, status: 404 })).toBe('remove');
  });

  it('retries on transient server / throttle errors under the cap', () => {
    expect(decideReplayOutcome(base, { ok: false, status: 500 })).toBe('retry');
    expect(decideReplayOutcome(base, { ok: false, status: 429 })).toBe('retry');
    expect(decideReplayOutcome(base, { ok: false, status: 408 })).toBe('retry');
  });

  it('retries on a network error until the attempt cap, then drops', () => {
    expect(decideReplayOutcome({ ...base, attempts: 0 }, { networkError: true })).toBe('retry');
    expect(
      decideReplayOutcome({ ...base, attempts: MAX_REPLAY_ATTEMPTS - 1 }, { networkError: true }),
    ).toBe('drop');
  });

  it('drops a transient failure once the attempt cap is reached', () => {
    expect(
      decideReplayOutcome({ ...base, attempts: MAX_REPLAY_ATTEMPTS - 1 }, { ok: false, status: 503 }),
    ).toBe('drop');
  });
});
