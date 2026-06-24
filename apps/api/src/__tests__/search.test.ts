/**
 * Tests for GET /api/search — instant memory search.
 *
 * Coverage:
 *   1. Missing / non-UUID userId → 400
 *   2. Empty q → 200 empty results, retrieval not even called
 *   3. Oversized q → 413
 *   4. Happy path → maps SemanticHit[] to results (snippet collapse, source
 *      fallback, empty-content filtered)
 *   5. limit is clamped to [1, MAX_LIMIT]
 *   6. searchSemantic throws → soft-fail to { results: [], degraded: true }
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { mockGetMemoryPortForUser, mockSearchSemantic } = vi.hoisted(() => ({
  mockGetMemoryPortForUser: vi.fn(),
  mockSearchSemantic: vi.fn(),
}));

vi.mock('../memory-setup.js', () => ({
  getMemoryPortForUser: mockGetMemoryPortForUser,
}));

import { createSearchRouter } from '../routes/search.js';

const USER = '11111111-2222-3333-4444-555555555555';

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/search', createSearchRouter());
  return app;
}

async function get(app: Express, path: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  mockGetMemoryPortForUser.mockReset();
  mockSearchSemantic.mockReset();
  mockGetMemoryPortForUser.mockResolvedValue({ port: { searchSemantic: mockSearchSemantic } });
});

describe('GET /api/search', () => {
  it('rejects a missing userId with 400', async () => {
    const { status } = await get(makeApp(), '/api/search?q=hi');
    expect(status).toBe(400);
    expect(mockGetMemoryPortForUser).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID userId with 400', async () => {
    const { status } = await get(makeApp(), '/api/search?userId=nope&q=hi');
    expect(status).toBe(400);
  });

  it('returns empty results (not 400) for an empty query, without touching retrieval', async () => {
    const { status, body } = await get(makeApp(), `/api/search?userId=${USER}&q=%20%20`);
    expect(status).toBe(200);
    expect(body).toEqual({ query: '', results: [] });
    expect(mockGetMemoryPortForUser).not.toHaveBeenCalled();
  });

  it('rejects an oversized query with 413', async () => {
    const big = 'x'.repeat(513);
    const { status } = await get(makeApp(), `/api/search?userId=${USER}&q=${big}`);
    expect(status).toBe(413);
  });

  it('maps hits to results: collapses snippet, falls back source, drops empty content', async () => {
    mockSearchSemantic.mockResolvedValue([
      {
        id: 'page-1',
        score: 0.9,
        content: 'Subject: Invoice\n\n  Your   invoice   is attached.\n',
        source: 'gmail',
        metadata: { domain: 'email' },
      },
      // no source slug → falls back to metadata domain
      { id: 'page-2', score: 0.5, content: 'A calendar note', source: '', metadata: { domain: 'calendar' } },
      // empty content → filtered out
      { id: 'page-3', score: 0.4, content: '   ', source: 'gmail', metadata: {} },
    ]);

    const { status, body } = await get(makeApp(), `/api/search?userId=${USER}&q=invoice`);
    expect(status).toBe(200);
    expect(body.query).toBe('invoice');
    expect(body.results).toEqual([
      { id: 'page-1', snippet: 'Subject: Invoice Your invoice is attached.', source: 'gmail', domain: 'email', score: 0.9 },
      { id: 'page-2', snippet: 'A calendar note', source: 'calendar', domain: 'calendar', score: 0.5 },
    ]);
  });

  it('clamps limit to MAX_LIMIT (25)', async () => {
    mockSearchSemantic.mockResolvedValue([]);
    await get(makeApp(), `/api/search?userId=${USER}&q=hi&limit=999`);
    expect(mockSearchSemantic).toHaveBeenCalledWith('hi', 25);
  });

  it('floors limit at 1 for a non-positive value', async () => {
    mockSearchSemantic.mockResolvedValue([]);
    await get(makeApp(), `/api/search?userId=${USER}&q=hi&limit=0`);
    expect(mockSearchSemantic).toHaveBeenCalledWith('hi', 1);
  });

  it('soft-fails to a degraded empty result set when retrieval throws', async () => {
    mockSearchSemantic.mockRejectedValue(new Error('embedder down'));
    const { status, body } = await get(makeApp(), `/api/search?userId=${USER}&q=hi`);
    expect(status).toBe(200);
    expect(body).toEqual({ query: 'hi', results: [], degraded: true });
  });
});
