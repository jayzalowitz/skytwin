import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Orchestration tests for transcribeRecordingChunked (#386).
 *
 * Mocks expo-file-system's File so audioFileToBase64 yields a known
 * base64 string, then drives the chunked upload against a hand-rolled
 * fake SkyTwinApiClient that records calls and can be scripted to fail
 * specific chunks — exercising retry, progress, and cancel without a
 * device or real network.
 */

const mockBase64 = vi.fn<[], Promise<string>>();
vi.mock('expo-file-system', () => ({
  File: class MockFile {
    async base64(): Promise<string> {
      return mockBase64();
    }
  },
}));

import { transcribeRecordingChunked } from '../services/voice-service';
import type { SkyTwinApiClient } from '../services/api-client';

type Ok<T> = { success: true; data: T };
type Err = { success: false; error: string; statusCode?: number };

function ok<T>(data: T): Ok<T> {
  return { success: true, data };
}
function err(error: string, statusCode?: number): Err {
  return statusCode === undefined ? { success: false, error } : { success: false, error, statusCode };
}

/** A fake client that reassembles chunks server-side like the real store. */
function makeFakeClient(opts: {
  failChunkOnce?: number; // index to fail exactly once before succeeding
  failChunkForever?: number; // index that always fails
} = {}) {
  const received = new Map<number, string>();
  let total = 0;
  const failedOnce = new Set<number>();
  const calls = { session: 0, chunk: 0, finalize: 0, cancel: 0 };

  const client = {
    voiceUploadSession: vi.fn(async (_u: string, t: number) => {
      calls.session += 1;
      total = t;
      return ok({ sessionId: 'sess-1' });
    }),
    voiceUploadChunk: vi.fn(async (_u: string, _s: string, index: number, data: string) => {
      calls.chunk += 1;
      if (opts.failChunkForever === index) return err('network drop');
      if (opts.failChunkOnce === index && !failedOnce.has(index)) {
        failedOnce.add(index);
        return err('network drop');
      }
      received.set(index, data);
      const missing: number[] = [];
      for (let i = 0; i < total; i++) if (!received.has(i)) missing.push(i);
      return ok({ received: received.size, total, missing });
    }),
    voiceUploadFinalize: vi.fn(async () => {
      calls.finalize += 1;
      const parts: string[] = [];
      for (let i = 0; i < total; i++) parts.push(received.get(i) ?? '');
      return ok({ transcript: `transcript:${parts.join('')}`, durationBytes: 42 });
    }),
    voiceUploadCancel: vi.fn(async () => {
      calls.cancel += 1;
      return ok({ cancelled: true });
    }),
  } as unknown as SkyTwinApiClient;

  return { client, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const noSleep = async (): Promise<void> => undefined;

describe('transcribeRecordingChunked', () => {
  it('uploads all chunks and finalizes on the happy path', async () => {
    mockBase64.mockResolvedValue('abcdefghij'); // 10 chars
    const { client, calls } = makeFakeClient();
    const progress: number[] = [];

    const result = await transcribeRecordingChunked(client, 'user-1', 'file://x', {
      chunkChars: 4,
      sleep: noSleep,
      onProgress: (p) => progress.push(p.fraction),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transcript).toBe('transcript:abcdefghij');
    expect(calls.session).toBe(1);
    expect(calls.chunk).toBe(3); // 10 chars / 4 = 3 chunks
    expect(calls.finalize).toBe(1);
    // Progress ends at 1.0.
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('retries only the failed chunk, not the whole upload', async () => {
    mockBase64.mockResolvedValue('abcdefghij');
    const { client, calls } = makeFakeClient({ failChunkOnce: 1 });
    let sawRetrying = false;

    const result = await transcribeRecordingChunked(client, 'user-1', 'file://x', {
      chunkChars: 4,
      sleep: noSleep,
      onProgress: (p) => { if (p.retrying) sawRetrying = true; },
    });

    expect(result.ok).toBe(true);
    // 3 chunks + 1 retry of chunk index 1 = 4 chunk calls.
    expect(calls.chunk).toBe(4);
    expect(sawRetrying).toBe(true);
  });

  it('gives up after maxPerChunkRetries and cancels the session', async () => {
    mockBase64.mockResolvedValue('abcdefghij');
    const { client, calls } = makeFakeClient({ failChunkForever: 2 });

    const result = await transcribeRecordingChunked(client, 'user-1', 'file://x', {
      chunkChars: 4,
      maxPerChunkRetries: 2,
      sleep: noSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('network');
    // chunk 0 ok, chunk 1 ok, chunk 2: 1 initial + 2 retries = 3 attempts.
    expect(calls.chunk).toBe(5);
    expect(calls.finalize).toBe(0);
    expect(calls.cancel).toBe(1);
  });

  it('aborts before a chunk when isCancelled() flips, and cancels the session', async () => {
    mockBase64.mockResolvedValue('abcdefghij');
    const { client, calls } = makeFakeClient();
    let calledChunks = 0;

    const result = await transcribeRecordingChunked(client, 'user-1', 'file://x', {
      chunkChars: 4,
      sleep: noSleep,
      isCancelled: () => calledChunks >= 1, // cancel after first chunk
      onProgress: (p) => { calledChunks = p.uploadedChunks; },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/cancelled/i);
    expect(calls.finalize).toBe(0);
    expect(calls.cancel).toBe(1);
  });

  it('surfaces a no-audio error without opening a session', async () => {
    mockBase64.mockResolvedValue('');
    const { client, calls } = makeFakeClient();
    const result = await transcribeRecordingChunked(client, 'user-1', 'file://x', { sleep: noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_audio');
    expect(calls.session).toBe(0);
  });

  it('maps a 503 finalize to whisper_unavailable', async () => {
    mockBase64.mockResolvedValue('abcd');
    const { client } = makeFakeClient();
    (client.voiceUploadFinalize as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err('whisper down', 503),
    );
    const result = await transcribeRecordingChunked(client, 'user-1', 'file://x', {
      chunkChars: 4,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('whisper_unavailable');
  });
});
