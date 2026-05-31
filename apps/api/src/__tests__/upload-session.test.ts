import { describe, it, expect } from 'vitest';
import { UploadSessionStore } from '../lib/upload-session.js';

const USER = 'aaaaaaaa-bbbb-cccc-dddd-000000000099';

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

describe('UploadSessionStore — open', () => {
  it('mints a session for a valid totalChunks', () => {
    const store = new UploadSessionStore();
    const r = store.open({ userId: USER, totalChunks: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sessionId).toMatch(/^up_/);
    expect(store.size()).toBe(1);
  });

  it('rejects a non-positive / non-integer totalChunks', () => {
    const store = new UploadSessionStore();
    expect(store.open({ userId: USER, totalChunks: 0 }).ok).toBe(false);
    expect(store.open({ userId: USER, totalChunks: -1 }).ok).toBe(false);
    expect(store.open({ userId: USER, totalChunks: 1.5 }).ok).toBe(false);
  });
});

describe('UploadSessionStore — chunk + finalize', () => {
  it('accepts chunks in order and reassembles on finalize', () => {
    const store = new UploadSessionStore();
    const open = store.open({ userId: USER, totalChunks: 3 });
    const sid = open.ok ? open.sessionId : '';
    const parts = ['aaa', 'bbb', 'ccc'].map(b64);

    const a0 = store.addChunk(sid, USER, 0, parts[0]!);
    expect(a0.ok && a0.ack.missing).toEqual([1, 2]);
    store.addChunk(sid, USER, 1, parts[1]!);
    const a2 = store.addChunk(sid, USER, 2, parts[2]!);
    expect(a2.ok && a2.ack.missing).toEqual([]);

    const fin = store.finalize(sid, USER);
    expect(fin.ok).toBe(true);
    if (fin.ok) expect(fin.base64).toBe(parts.join(''));
    // finalize is terminal — the session is consumed.
    expect(store.size()).toBe(0);
  });

  it('reassembles correctly when chunks arrive OUT OF ORDER', () => {
    const store = new UploadSessionStore();
    const sid = (store.open({ userId: USER, totalChunks: 3 }) as { sessionId: string }).sessionId;
    const parts = ['one', 'two', 'three'].map(b64);
    store.addChunk(sid, USER, 2, parts[2]!);
    store.addChunk(sid, USER, 0, parts[0]!);
    store.addChunk(sid, USER, 1, parts[1]!);
    const fin = store.finalize(sid, USER);
    expect(fin.ok && fin.base64).toBe(parts.join(''));
  });

  it('a retried chunk replaces in place and does not double-count size', () => {
    const store = new UploadSessionStore();
    const sid = (store.open({ userId: USER, totalChunks: 2 }) as { sessionId: string }).sessionId;
    store.addChunk(sid, USER, 0, b64('first-attempt'));
    const retry = store.addChunk(sid, USER, 0, b64('second'));
    expect(retry.ok && retry.ack.received).toBe(1); // still one distinct chunk
    store.addChunk(sid, USER, 1, b64('tail'));
    const fin = store.finalize(sid, USER);
    // The retried value wins.
    expect(fin.ok && fin.base64).toBe(b64('second') + b64('tail'));
  });

  it('finalize on a session with gaps returns the missing list', () => {
    const store = new UploadSessionStore();
    const sid = (store.open({ userId: USER, totalChunks: 3 }) as { sessionId: string }).sessionId;
    store.addChunk(sid, USER, 0, b64('x'));
    const fin = store.finalize(sid, USER);
    expect(fin.ok).toBe(false);
    if (!fin.ok) {
      expect(fin.code).toBe('incomplete');
      expect(fin.missing).toEqual([1, 2]);
    }
    // Not consumed — the client can retry the missing chunks.
    expect(store.size()).toBe(1);
  });
});

describe('UploadSessionStore — validation + ownership', () => {
  it('rejects an out-of-range index', () => {
    const store = new UploadSessionStore();
    const sid = (store.open({ userId: USER, totalChunks: 2 }) as { sessionId: string }).sessionId;
    expect(store.addChunk(sid, USER, 2, b64('x')).ok).toBe(false);
    expect(store.addChunk(sid, USER, -1, b64('x')).ok).toBe(false);
  });

  it('rejects non-base64 chunk data', () => {
    const store = new UploadSessionStore();
    const sid = (store.open({ userId: USER, totalChunks: 1 }) as { sessionId: string }).sessionId;
    const r = store.addChunk(sid, USER, 0, 'not base64!!');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_base64');
  });

  it('refuses chunks / finalize for a different userId (ownership)', () => {
    const store = new UploadSessionStore();
    const sid = (store.open({ userId: USER, totalChunks: 1 }) as { sessionId: string }).sessionId;
    const other = 'ffffffff-0000-0000-0000-000000000000';
    expect(store.addChunk(sid, other, 0, b64('x')).ok).toBe(false);
    expect(store.finalize(sid, other).ok).toBe(false);
  });

  it('enforces the max total size cap', () => {
    const store = new UploadSessionStore({ maxTotalBase64: 8 });
    const sid = (store.open({ userId: USER, totalChunks: 2 }) as { sessionId: string }).sessionId;
    expect(store.addChunk(sid, USER, 0, 'AAAA').ok).toBe(true); // 4 chars
    const big = store.addChunk(sid, USER, 1, 'BBBBBBBB'); // would total 12 > 8
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.code).toBe('too_large');
  });
});

describe('UploadSessionStore — TTL + cancel', () => {
  it('sweeps sessions idle past the TTL', () => {
    let t = 1_000;
    const store = new UploadSessionStore({ ttlMs: 100, now: () => t });
    const sid = (store.open({ userId: USER, totalChunks: 1 }) as { sessionId: string }).sessionId;
    expect(store.status(sid, USER)).not.toBeNull();
    t += 101; // advance past TTL
    // Any mutation triggers the sweep.
    const r = store.addChunk(sid, USER, 0, b64('x'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_session');
    expect(store.size()).toBe(0);
  });

  it('keeps a session alive while chunks keep arriving (lastTouched refresh)', () => {
    let t = 0;
    const store = new UploadSessionStore({ ttlMs: 100, now: () => t });
    const sid = (store.open({ userId: USER, totalChunks: 2 }) as { sessionId: string }).sessionId;
    t = 80;
    expect(store.addChunk(sid, USER, 0, b64('x')).ok).toBe(true); // touch resets idle clock
    t = 160; // 80ms since last touch < 100 TTL
    expect(store.addChunk(sid, USER, 1, b64('y')).ok).toBe(true);
  });

  it('cancel drops the session', () => {
    const store = new UploadSessionStore();
    const sid = (store.open({ userId: USER, totalChunks: 1 }) as { sessionId: string }).sessionId;
    expect(store.cancel(sid, USER)).toBe(true);
    expect(store.size()).toBe(0);
    expect(store.cancel(sid, USER)).toBe(false); // already gone
  });
});
