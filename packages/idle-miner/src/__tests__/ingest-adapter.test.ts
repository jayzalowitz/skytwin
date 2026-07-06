import { describe, it, expect, vi } from 'vitest';
import { toIngestEvent, createHttpSignalEmitter } from '../ingest-adapter.js';
import type { RawSignal } from '@skytwin/shared-types';

const signal = (over: Partial<RawSignal> = {}): RawSignal => ({
  id: 'sig1',
  userId: 'mined-for-this-user',
  rootId: 'root1',
  absPath: '/home/u/Projects/app/package.json',
  relPath: 'app/package.json',
  sizeBytes: 120,
  mtimeMs: 1000,
  extractedAt: new Date(0),
  ...over,
});

function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}
function statusResponse(status: number): Response {
  return { ok: false, status } as Response;
}

describe('toIngestEvent', () => {
  it('wraps a filesystem signal in the fs ingest envelope', () => {
    const ev = toIngestEvent(signal({ mimeType: 'application/json', contentHash: 'abc' }), 'user-1');
    expect(ev).toMatchObject({
      source: 'fs',
      type: 'file_indexed',
      signalId: 'sig1',
      userId: 'user-1',
      rootId: 'root1',
      relPath: 'app/package.json',
      mimeType: 'application/json',
      contentHash: 'abc',
    });
  });

  it('uses file_skipped when the signal carries a skippedReason', () => {
    const ev = toIngestEvent(signal({ skippedReason: 'too_large' }), 'user-1');
    expect(ev.type).toBe('file_skipped');
    expect(ev.skippedReason).toBe('too_large');
  });

  it('nests structuredFields under `extracted` — they cannot shadow OR inject top-level keys (security)', () => {
    // A malicious / accidental file whose extracted metadata is named after
    // envelope keys must not spoof the source, re-attribute the user, or inject
    // arbitrary top-level ingest fields.
    const ev = toIngestEvent(
      signal({
        structuredFields: {
          source: 'gmail', // attempt to shadow the envelope
          userId: 'attacker',
          signalId: 'forged',
          rogue: 'top-level-injection',
          name: 'my-package', // a legitimate extracted field
        },
      }),
      'real-user',
    );
    // The top level is fully controlled — no file-derived key reaches it.
    expect(ev.source).toBe('fs');
    expect(ev.userId).toBe('real-user');
    expect(ev.signalId).toBe('sig1');
    expect('rogue' in ev).toBe(false);
    // Legitimate extracted metadata survives, namespaced under `extracted`.
    expect(ev.extracted).toMatchObject({ name: 'my-package', source: 'gmail', rogue: 'top-level-injection' });
  });

  it('omits `extracted` entirely when there are no structuredFields', () => {
    expect('extracted' in toIngestEvent(signal(), 'u')).toBe(false);
  });

  it('drops oversized extracted metadata rather than ballooning the request body', () => {
    const huge = { blob: 'x'.repeat(70 * 1024) };
    expect('extracted' in toIngestEvent(signal({ structuredFields: huge }), 'u')).toBe(false);
  });

  it('omits optional fields that are absent', () => {
    const ev = toIngestEvent(signal(), 'user-1');
    expect('mimeType' in ev).toBe(false);
    expect('contentHash' in ev).toBe(false);
    expect('skippedReason' in ev).toBe(false);
  });
});

describe('createHttpSignalEmitter', () => {
  const url = 'http://localhost:3200/api/events/ingest';

  it('POSTs the ingest event to the configured URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const emit = createHttpSignalEmitter({ ingestUrl: url, userId: 'u1', fetchImpl });
    await emit(signal());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ source: 'fs', userId: 'u1', signalId: 'sig1' });
  });

  it('never throws on a permanent (4xx) failure — swallows it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(404));
    const emit = createHttpSignalEmitter({ ingestUrl: url, userId: 'u1', fetchImpl, maxRetries: 0 });
    await expect(emit(signal())).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 404 is not retried
  });

  it('never throws on a network error — swallows it', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const emit = createHttpSignalEmitter({ ingestUrl: url, userId: 'u1', fetchImpl, maxRetries: 0 });
    await expect(emit(signal())).resolves.toBeUndefined();
  });

  it('retries a transient (503) then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(503))
      .mockResolvedValueOnce(okResponse());
    const emit = createHttpSignalEmitter({ ingestUrl: url, userId: 'u1', fetchImpl, maxRetries: 1 });
    await emit(signal());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 408 Request Timeout (transient) then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(408))
      .mockResolvedValueOnce(okResponse());
    const emit = createHttpSignalEmitter({ ingestUrl: url, userId: 'u1', fetchImpl, maxRetries: 1 });
    await emit(signal());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a permanent 4xx (e.g. 404 wrong URL) — fails fast, swallowed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(statusResponse(404));
    const emit = createHttpSignalEmitter({ ingestUrl: url, userId: 'u1', fetchImpl, maxRetries: 3 });
    await expect(emit(signal())).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // permanent → not retried despite maxRetries:3
  });
});
