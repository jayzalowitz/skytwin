/**
 * Tests for /api/voice — STT routes backed by createEmbeddedSttPort (#194 Child 4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { mockTranscribe, mockSynthesize, mockCreatePort, mockCreateTtsPort } = vi.hoisted(() => ({
  mockTranscribe: vi.fn(),
  mockSynthesize: vi.fn(),
  mockCreatePort: vi.fn(),
  mockCreateTtsPort: vi.fn(),
}));

vi.mock('@skytwin/embedded-llm', () => ({
  createEmbeddedSttPort: mockCreatePort,
  createEmbeddedTtsPort: mockCreateTtsPort,
}));

import { _resetVoicePortCache, createVoiceRouter } from '../routes/voice.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildApp(userId: string | null = USER_ID): Express {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  if (userId !== null) {
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string } }).user = { id: userId };
      next();
    });
  }
  app.use('/api/voice', createVoiceRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function req(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { server.close(); reject(new Error('no port')); return; }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const opts: RequestInit = { method, headers };
      if (body !== undefined) opts.body = JSON.stringify(body);
      fetch(url, opts).then(async (res) => {
        const json = await res.json().catch(() => null);
        server.close();
        resolve({ status: res.status, body: json as Record<string, unknown> });
      }).catch((err) => { server.close(); reject(err); });
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetVoicePortCache();
  // Default TTS mock — most tests don't care about TTS, they just need
  // `getTtsPort()` to resolve to *something*. Tests that exercise the
  // synthesize path override this with their own mock.
  mockCreateTtsPort.mockResolvedValue({
    capabilities: { available: false, voices: [] },
    synthesize: mockSynthesize,
  });
});

describe('GET /api/voice/capabilities/:userId', () => {
  it('reports availability and supported formats', async () => {
    mockCreatePort.mockResolvedValue({
      capabilities: { available: true, supportedFormats: ['wav', 'mp3'] },
      transcribe: mockTranscribe,
    });
    const { status, body } = await req(buildApp(), 'GET', `/api/voice/capabilities/${USER_ID}`);
    expect(status).toBe(200);
    expect(body['available']).toBe(true);
    expect(body['supportedFormats']).toEqual(['wav', 'mp3']);
  });

  it('reports false when whisper is not available', async () => {
    mockCreatePort.mockResolvedValue({
      capabilities: { available: false, supportedFormats: [] },
      transcribe: mockTranscribe,
    });
    const { body } = await req(buildApp(), 'GET', `/api/voice/capabilities/${USER_ID}`);
    expect(body['available']).toBe(false);
  });
});

describe('POST /api/voice/transcribe', () => {
  it('returns transcript on the happy path', async () => {
    mockCreatePort.mockResolvedValue({
      capabilities: { available: true, supportedFormats: ['wav'] },
      transcribe: mockTranscribe,
    });
    mockTranscribe.mockResolvedValue('hello world');
    const audioBase64 = Buffer.from('FAKE_AUDIO').toString('base64');
    const { status, body } = await req(buildApp(), 'POST', '/api/voice/transcribe', {
      userId: USER_ID,
      audioBase64,
      language: 'en',
    });
    expect(status).toBe(200);
    expect(body['transcript']).toBe('hello world');
    expect(mockTranscribe).toHaveBeenCalledWith(expect.any(Buffer), { language: 'en' });
  });

  it('omits language option when not provided', async () => {
    mockCreatePort.mockResolvedValue({
      capabilities: { available: true, supportedFormats: ['wav'] },
      transcribe: mockTranscribe,
    });
    mockTranscribe.mockResolvedValue('ok');
    await req(buildApp(), 'POST', '/api/voice/transcribe', {
      userId: USER_ID,
      audioBase64: Buffer.from('A').toString('base64'),
    });
    expect(mockTranscribe).toHaveBeenCalledWith(expect.any(Buffer), {});
  });

  it('returns 503 when whisper is not available', async () => {
    mockCreatePort.mockResolvedValue({
      capabilities: { available: false, supportedFormats: [] },
      transcribe: mockTranscribe,
    });
    const { status, body } = await req(buildApp(), 'POST', '/api/voice/transcribe', {
      userId: USER_ID,
      audioBase64: Buffer.from('A').toString('base64'),
    });
    expect(status).toBe(503);
    expect(body['error']).toMatch(/not available/);
  });

  it('rejects missing userId', async () => {
    const { status } = await req(buildApp(), 'POST', '/api/voice/transcribe', {
      audioBase64: Buffer.from('A').toString('base64'),
    });
    expect(status).toBe(400);
  });

  it('rejects empty or non-base64 audio', async () => {
    const r1 = await req(buildApp(), 'POST', '/api/voice/transcribe', {
      userId: USER_ID,
      audioBase64: '',
    });
    expect(r1.status).toBe(400);

    const r2 = await req(buildApp(), 'POST', '/api/voice/transcribe', {
      userId: USER_ID,
      audioBase64: '!!!not-base64!!!',
    });
    expect(r2.status).toBe(400);
  });

  it('rejects audio above the size cap', async () => {
    // 26MB of base64 — well over the 25MB decoded cap.
    const oversized = 'A'.repeat(40 * 1024 * 1024);
    const { status } = await req(buildApp(), 'POST', '/api/voice/transcribe', {
      userId: USER_ID,
      audioBase64: oversized,
    });
    expect(status).toBe(413);
  });
});

describe('GET /api/voice/capabilities/:userId — TTS surface (#187 AC#4)', () => {
  it('reports stt + tts capability blocks alongside the legacy fields', async () => {
    mockCreatePort.mockResolvedValue({
      capabilities: { available: true, supportedFormats: ['wav'] },
      transcribe: mockTranscribe,
    });
    mockCreateTtsPort.mockResolvedValue({
      capabilities: { available: true, voices: ['en_US-amy-medium'] },
      synthesize: mockSynthesize,
    });
    const { status, body } = await req(buildApp(), 'GET', `/api/voice/capabilities/${USER_ID}`);
    expect(status).toBe(200);
    // Nested blocks
    expect(body['stt']).toEqual({ available: true, supportedFormats: ['wav'] });
    expect(body['tts']).toEqual({ available: true, voices: ['en_US-amy-medium'] });
    // Legacy fields preserved for older clients
    expect(body['available']).toBe(true);
    expect(body['supportedFormats']).toEqual(['wav']);
  });
});

describe('POST /api/voice/synthesize (#187 AC#4)', () => {
  it('returns base64-encoded WAV on the happy path', async () => {
    mockCreateTtsPort.mockResolvedValue({
      capabilities: { available: true, voices: ['en_US-amy-medium'] },
      synthesize: mockSynthesize,
    });
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03]); // 'RIFF...'
    mockSynthesize.mockResolvedValue(wav);

    const { status, body } = await req(buildApp(), 'POST', '/api/voice/synthesize', {
      userId: USER_ID,
      text: 'hello twin',
    });
    expect(status).toBe(200);
    expect(body['audioBase64']).toBe(wav.toString('base64'));
    expect(body['durationBytes']).toBe(wav.length);
    expect(body['voice']).toBe('en_US-amy-medium');
    expect(mockSynthesize).toHaveBeenCalledWith('hello twin', {});
  });

  it('forwards a caller-provided voice option to the port', async () => {
    mockCreateTtsPort.mockResolvedValue({
      capabilities: { available: true, voices: ['en_US-amy-medium'] },
      synthesize: mockSynthesize,
    });
    mockSynthesize.mockResolvedValue(Buffer.from('RIFF'));
    await req(buildApp(), 'POST', '/api/voice/synthesize', {
      userId: USER_ID,
      text: 'hi',
      voice: 'en_US-amy-medium',
    });
    expect(mockSynthesize).toHaveBeenCalledWith('hi', { voice: 'en_US-amy-medium' });
  });

  it('returns 503 when piper is not available', async () => {
    mockCreateTtsPort.mockResolvedValue({
      capabilities: { available: false, voices: [] },
      synthesize: mockSynthesize,
    });
    const { status, body } = await req(buildApp(), 'POST', '/api/voice/synthesize', {
      userId: USER_ID,
      text: 'hi',
    });
    expect(status).toBe(503);
    expect(body['error']).toMatch(/not available/);
    expect(body['hint']).toMatch(/piper/);
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('rejects missing userId', async () => {
    const { status } = await req(buildApp(), 'POST', '/api/voice/synthesize', {
      text: 'hi',
    });
    expect(status).toBe(400);
  });

  it('rejects empty text', async () => {
    const { status } = await req(buildApp(), 'POST', '/api/voice/synthesize', {
      userId: USER_ID,
      text: '',
    });
    expect(status).toBe(400);
  });

  it('rejects text exceeding the 8000-char ceiling', async () => {
    const { status, body } = await req(buildApp(), 'POST', '/api/voice/synthesize', {
      userId: USER_ID,
      text: 'x'.repeat(8001),
    });
    expect(status).toBe(413);
    expect(body['error']).toMatch(/too long/);
  });
});
