/**
 * Tests for the embedded-llm download API routes (#187 AC#2).
 *
 * The downloader's actual byte-streaming logic lives in
 * `embedded-llm/downloader.ts` and would require a real HTTP server +
 * filesystem to test end-to-end. These tests cover the route layer:
 * input validation, repository handoff, and the rowToJson shape (which
 * the polling UI depends on).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { mockRepo, mockStartDownload, mockPauseDownload, mockCancelDownload } = vi.hoisted(() => ({
  mockRepo: {
    findById: vi.fn(),
    listForUser: vi.fn(),
  },
  mockStartDownload: vi.fn(),
  mockPauseDownload: vi.fn(),
  mockCancelDownload: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  modelDownloadRepository: mockRepo,
}));

vi.mock('../embedded-llm/downloader.js', () => ({
  startDownload: mockStartDownload,
  pauseDownload: mockPauseDownload,
  cancelDownload: mockCancelDownload,
  resolveModelDir: () => '/tmp/skytwin-models',
}));

import { createEmbeddedLlmRouter } from '../routes/embedded-llm.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DOWNLOAD_ID = 'dddddddd-eeee-ffff-aaaa-111111111111';

const SAMPLE_ROW = {
  id: DOWNLOAD_ID,
  user_id: USER_ID,
  model_id: 'qwen-2.5-3b-q4',
  target_path: '/tmp/skytwin-models/qwen-2.5-3b-q4.gguf',
  total_bytes: 2_000_000_000,
  bytes_downloaded: 1_000_000_000,
  sha256_expected: '0'.repeat(64),
  status: 'downloading' as const,
  error: null,
  started_at: new Date('2026-05-09T01:00:00Z'),
  paused_at: null,
  completed_at: null,
};

function buildApp(userId: string | null = USER_ID): Express {
  const app = express();
  app.use(express.json());
  if (userId !== null) {
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string } }).user = { id: userId };
      next();
    });
  }
  app.use('/api/embedded-llm', createEmbeddedLlmRouter());
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
});

describe('GET /api/embedded-llm/model-dir', () => {
  it('returns the resolved model directory', async () => {
    const { status, body } = await req(buildApp(), 'GET', '/api/embedded-llm/model-dir');
    expect(status).toBe(200);
    expect(body['modelDir']).toBe('/tmp/skytwin-models');
  });
});

describe('POST /api/embedded-llm/downloads/start', () => {
  it('starts a download and returns row + resumed flag', async () => {
    mockStartDownload.mockResolvedValue({ download: SAMPLE_ROW, resumed: false });
    const { status, body } = await req(buildApp(), 'POST', '/api/embedded-llm/downloads/start', {
      userId: USER_ID,
      modelId: 'qwen-2.5-3b-q4',
    });
    expect(status).toBe(200);
    expect(body['resumed']).toBe(false);
    const dl = body['download'] as Record<string, unknown>;
    expect(dl['id']).toBe(DOWNLOAD_ID);
    expect(dl['percent']).toBe(50);
    expect(dl['status']).toBe('downloading');
  });

  it('signals resumed=true when continuing a partial', async () => {
    mockStartDownload.mockResolvedValue({ download: SAMPLE_ROW, resumed: true });
    const { body } = await req(buildApp(), 'POST', '/api/embedded-llm/downloads/start', {
      userId: USER_ID,
      modelId: 'qwen-2.5-3b-q4',
    });
    expect(body['resumed']).toBe(true);
  });

  it('rejects missing userId', async () => {
    const { status } = await req(buildApp(), 'POST', '/api/embedded-llm/downloads/start', {
      modelId: 'qwen-2.5-3b-q4',
    });
    expect(status).toBe(400);
  });

  it('rejects missing modelId', async () => {
    const { status } = await req(buildApp(), 'POST', '/api/embedded-llm/downloads/start', {
      userId: USER_ID,
    });
    expect(status).toBe(400);
  });

  it('returns 404 when model id is not in the registry', async () => {
    mockStartDownload.mockRejectedValue(new Error('unknown model id: not-real'));
    const { status, body } = await req(buildApp(), 'POST', '/api/embedded-llm/downloads/start', {
      userId: USER_ID,
      modelId: 'not-real',
    });
    expect(status).toBe(404);
    expect(body['error']).toMatch(/unknown model id/);
  });
});

describe('GET /api/embedded-llm/downloads/:id', () => {
  it('returns the row in JSON-friendly shape', async () => {
    mockRepo.findById.mockResolvedValue(SAMPLE_ROW);
    const { status, body } = await req(
      buildApp(),
      'GET',
      `/api/embedded-llm/downloads/${DOWNLOAD_ID}`,
    );
    expect(status).toBe(200);
    const dl = body['download'] as Record<string, unknown>;
    expect(dl['percent']).toBe(50);
    expect(dl['totalBytes']).toBe(2_000_000_000);
    expect(dl['bytesDownloaded']).toBe(1_000_000_000);
    // sha256_expected must NOT appear in JSON output (hashes leak info
    // about which artifact endpoint is being downloaded).
    expect(JSON.stringify(dl)).not.toContain('sha256');
  });

  it('returns 404 when download not found', async () => {
    mockRepo.findById.mockResolvedValue(null);
    const { status } = await req(
      buildApp(),
      'GET',
      `/api/embedded-llm/downloads/${DOWNLOAD_ID}`,
    );
    expect(status).toBe(404);
  });

  it('caps percent at 100 for over-fetched downloads', async () => {
    // Edge case: bytes_downloaded > total_bytes when Content-Length
    // was wrong and we kept reading. UI shouldn't show 103%.
    mockRepo.findById.mockResolvedValue({
      ...SAMPLE_ROW,
      bytes_downloaded: 2_100_000_000,
    });
    const { body } = await req(
      buildApp(),
      'GET',
      `/api/embedded-llm/downloads/${DOWNLOAD_ID}`,
    );
    const dl = body['download'] as Record<string, unknown>;
    expect(dl['percent']).toBe(100);
  });

  it('reports 0% for a pending download with totalBytes>0', async () => {
    mockRepo.findById.mockResolvedValue({
      ...SAMPLE_ROW,
      status: 'pending',
      bytes_downloaded: 0,
    });
    const { body } = await req(
      buildApp(),
      'GET',
      `/api/embedded-llm/downloads/${DOWNLOAD_ID}`,
    );
    const dl = body['download'] as Record<string, unknown>;
    expect(dl['percent']).toBe(0);
  });
});

describe('GET /api/embedded-llm/downloads/user/:userId', () => {
  it('returns the user list', async () => {
    mockRepo.listForUser.mockResolvedValue([SAMPLE_ROW]);
    const { status, body } = await req(
      buildApp(),
      'GET',
      `/api/embedded-llm/downloads/user/${USER_ID}`,
    );
    expect(status).toBe(200);
    const downloads = body['downloads'] as Array<Record<string, unknown>>;
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.['percent']).toBe(50);
  });
});

describe('POST /api/embedded-llm/downloads/:id/pause', () => {
  it('returns ok=true on successful pause', async () => {
    mockPauseDownload.mockResolvedValue(true);
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/embedded-llm/downloads/${DOWNLOAD_ID}/pause`,
    );
    expect(status).toBe(200);
    expect(body['ok']).toBe(true);
    expect(mockPauseDownload).toHaveBeenCalledWith(DOWNLOAD_ID);
  });

  it('returns ok=false when row is not pausable', async () => {
    mockPauseDownload.mockResolvedValue(false);
    const { body } = await req(
      buildApp(),
      'POST',
      `/api/embedded-llm/downloads/${DOWNLOAD_ID}/pause`,
    );
    expect(body['ok']).toBe(false);
  });
});

describe('POST /api/embedded-llm/downloads/:id/resume', () => {
  it('re-enters startDownload for the row\'s (user, model)', async () => {
    mockRepo.findById.mockResolvedValue({ ...SAMPLE_ROW, status: 'paused' });
    mockStartDownload.mockResolvedValue({
      download: { ...SAMPLE_ROW, status: 'downloading' },
      resumed: true,
    });
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/embedded-llm/downloads/${DOWNLOAD_ID}/resume`,
    );
    expect(status).toBe(200);
    expect(body['resumed']).toBe(true);
    expect(mockStartDownload).toHaveBeenCalledWith(USER_ID, 'qwen-2.5-3b-q4');
  });

  it('returns 404 when download not found', async () => {
    mockRepo.findById.mockResolvedValue(null);
    const { status } = await req(
      buildApp(),
      'POST',
      `/api/embedded-llm/downloads/${DOWNLOAD_ID}/resume`,
    );
    expect(status).toBe(404);
  });
});

describe('POST /api/embedded-llm/downloads/:id/cancel', () => {
  it('returns ok=true on successful cancel', async () => {
    mockCancelDownload.mockResolvedValue(true);
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/embedded-llm/downloads/${DOWNLOAD_ID}/cancel`,
    );
    expect(status).toBe(200);
    expect(body['ok']).toBe(true);
  });
});
