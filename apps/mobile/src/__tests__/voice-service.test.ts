import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Voice service unit tests (#179).
 *
 * Mocks `expo-file-system`'s `File` class so we can drive
 * `audioFileToBase64` without a native runtime, and mocks `fetch` for
 * the `transcribeRecording` orchestration. Mirrors the inlined-class
 * test pattern from `api-client.test.ts` to avoid pulling React Native
 * imports into Node's test runner.
 */

// ────────────────────────────────────────────────
// Mocks (set up BEFORE imports under test so the module sees them)
// ────────────────────────────────────────────────

const mockBase64 = vi.fn<[], Promise<string>>();
const mockFileCtor = vi.fn<[string], void>();

vi.mock('expo-file-system', () => ({
  File: class MockFile {
    constructor(uri: string) {
      mockFileCtor(uri);
    }
    async base64(): Promise<string> {
      return mockBase64();
    }
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Inlined API client mirroring api-client.ts so we don't have to import
// the real one (which pulls fetch typings + builds the request layer
// we're already mocking with stubGlobal). This matches the pattern at
// `api-client.test.ts:23` — keeps the test hermetic.
class TestApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async transcribeVoice(userId: string, audioBase64: string, language?: string) {
    const body: Record<string, string> = { userId, audioBase64 };
    if (language) body['language'] = language;
    try {
      const response = await fetch(`${this.baseUrl}/api/voice/transcribe`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const errorMsg =
          typeof data === 'object' && data !== null && 'error' in data
            ? String((data as Record<string, unknown>)['error'])
            : `HTTP ${response.status}`;
        return { success: false as const, error: errorMsg, statusCode: response.status };
      }
      return { success: true as const, data: data as { transcript: string; durationBytes: number } };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : 'Network error' };
    }
  }
}

// ────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────

describe('audioFileToBase64', () => {
  beforeEach(() => {
    mockBase64.mockReset();
    mockFileCtor.mockReset();
  });

  it('returns no_audio when uri is null', async () => {
    const { audioFileToBase64 } = await import('../services/voice-service');
    const result = await audioFileToBase64(null);
    expect(result).toEqual({
      ok: false,
      code: 'no_audio',
      message: expect.stringContaining('No audio'),
    });
    expect(mockFileCtor).not.toHaveBeenCalled();
  });

  it('returns no_audio when uri is empty string', async () => {
    const { audioFileToBase64 } = await import('../services/voice-service');
    const result = await audioFileToBase64('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_audio');
  });

  it('returns the base64 payload when File.base64() resolves', async () => {
    mockBase64.mockResolvedValue('YmFzZTY0LWF1ZGlv');
    const { audioFileToBase64 } = await import('../services/voice-service');
    const result = await audioFileToBase64('file:///tmp/recording.m4a');
    expect(result).toEqual({ ok: true, data: 'YmFzZTY0LWF1ZGlv' });
    expect(mockFileCtor).toHaveBeenCalledWith('file:///tmp/recording.m4a');
  });

  it('returns no_audio when File.base64() returns empty string', async () => {
    mockBase64.mockResolvedValue('');
    const { audioFileToBase64 } = await import('../services/voice-service');
    const result = await audioFileToBase64('file:///tmp/empty.m4a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_audio');
  });

  it('returns read_failed when File.base64() rejects', async () => {
    mockBase64.mockRejectedValue(new Error('ENOENT'));
    const { audioFileToBase64 } = await import('../services/voice-service');
    const result = await audioFileToBase64('file:///tmp/missing.m4a');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('read_failed');
      expect(result.message).toContain('ENOENT');
    }
  });
});

describe('transcribeRecording', () => {
  beforeEach(() => {
    mockBase64.mockReset();
    mockFileCtor.mockReset();
    mockFetch.mockReset();
  });

  it('returns the transcript on a 200 response', async () => {
    mockBase64.mockResolvedValue('YQ==');
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ transcript: 'hello twin', durationBytes: 12345 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { transcribeRecording } = await import('../services/voice-service');
    const client = new TestApiClient('http://desktop.local', 'tok') as unknown as Parameters<typeof transcribeRecording>[0];
    const outcome = await transcribeRecording(client, 'user-1', 'file:///tmp/a.m4a');
    expect(outcome).toEqual({ ok: true, transcript: 'hello twin', durationBytes: 12345 });
  });

  it('forwards the language code in the request body when set', async () => {
    mockBase64.mockResolvedValue('YQ==');
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ transcript: 'bonjour', durationBytes: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const { transcribeRecording } = await import('../services/voice-service');
    const client = new TestApiClient('http://desktop.local', 'tok') as unknown as Parameters<typeof transcribeRecording>[0];
    await transcribeRecording(client, 'user-1', 'file:///tmp/a.m4a', 'fr');
    const sentBody = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as Record<string, string>;
    expect(sentBody['language']).toBe('fr');
  });

  it('surfaces 503 whisper-unavailable with a stable code', async () => {
    mockBase64.mockResolvedValue('YQ==');
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'whisper-cli not available on this server' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { transcribeRecording } = await import('../services/voice-service');
    const client = new TestApiClient('http://desktop.local', 'tok') as unknown as Parameters<typeof transcribeRecording>[0];
    const outcome = await transcribeRecording(client, 'user-1', 'file:///tmp/a.m4a');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('whisper_unavailable');
      expect(outcome.message).toContain('whisper');
    }
  });

  it('surfaces a 413 too-large error as unknown (the message carries the detail)', async () => {
    mockBase64.mockResolvedValue('YQ==');
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'audio too large (max 25MB)' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { transcribeRecording } = await import('../services/voice-service');
    const client = new TestApiClient('http://desktop.local', 'tok') as unknown as Parameters<typeof transcribeRecording>[0];
    const outcome = await transcribeRecording(client, 'user-1', 'file:///tmp/a.m4a');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('unknown');
      expect(outcome.message).toContain('25MB');
    }
  });

  it('short-circuits with no_audio when the URI is missing — never hits fetch', async () => {
    const { transcribeRecording } = await import('../services/voice-service');
    const client = new TestApiClient('http://desktop.local', 'tok') as unknown as Parameters<typeof transcribeRecording>[0];
    const outcome = await transcribeRecording(client, 'user-1', null);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('no_audio');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces network failure as code=network', async () => {
    mockBase64.mockResolvedValue('YQ==');
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    const { transcribeRecording } = await import('../services/voice-service');
    const client = new TestApiClient('http://desktop.local', 'tok') as unknown as Parameters<typeof transcribeRecording>[0];
    const outcome = await transcribeRecording(client, 'user-1', 'file:///tmp/a.m4a');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('network');
  });
});
