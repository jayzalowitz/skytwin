/**
 * Tests for /api/voice — STT routes backed by createEmbeddedSttPort (#194 Child 4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { mockTranscribe, mockCreatePort } = vi.hoisted(() => ({
  mockTranscribe: vi.fn(),
  mockCreatePort: vi.fn(),
}));

vi.mock('@skytwin/embedded-llm', () => ({
  createEmbeddedSttPort: mockCreatePort,
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
