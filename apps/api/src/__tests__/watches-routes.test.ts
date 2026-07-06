import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// Mock only the repository (@skytwin/db). The real @skytwin/routines parser and
// the real validate-uuid / require-ownership middleware run, so the test
// exercises the actual parse + validation glue.
const { mockWatchRepository, mockWatchRunRepository } = vi.hoisted(() => ({
  mockWatchRepository: {
    create: vi.fn(),
    listForUser: vi.fn(),
    getForUser: vi.fn(),
    setStatus: vi.fn(),
    updateSpec: vi.fn(),
    delete: vi.fn(),
  },
  mockWatchRunRepository: {
    listForWatch: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  watchRepository: mockWatchRepository,
  watchRunRepository: mockWatchRunRepository,
}));

import { createWatchesRouter } from '../routes/watches.js';

const USER = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const WATCH = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/watches', createWatchesRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const options: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) options.body = JSON.stringify(body);
      fetch(url, options)
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

const fakeWatch = {
  id: WATCH,
  userId: USER,
  name: 'Daily email digest',
  status: 'active',
  filter: { keywords: ['email'] },
};

describe('watches routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('POST /parse (preview)', () => {
    it('parses a natural-language routine into a spec', async () => {
      const res = await request(buildApp(), 'POST', '/api/watches/parse', {
        text: 'every morning summarize my email',
      });
      expect(res.status).toBe(200);
      const b = res.body as { matched: boolean; spec?: { cadence: string; action: string } };
      expect(b.matched).toBe(true);
      expect(b.spec?.cadence).toBe('daily');
      expect(b.spec?.action).toBe('digest');
    });

    it('returns matched:false for ordinary chat', async () => {
      const res = await request(buildApp(), 'POST', '/api/watches/parse', {
        text: 'what meetings do I have today?',
      });
      expect(res.status).toBe(200);
      expect((res.body as { matched: boolean }).matched).toBe(false);
    });

    it('400s when text is missing', async () => {
      const res = await request(buildApp(), 'POST', '/api/watches/parse', {});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /:userId (create)', () => {
    it('creates a watch from natural language', async () => {
      mockWatchRepository.create.mockResolvedValue(fakeWatch);
      const res = await request(buildApp(), 'POST', `/api/watches/${USER}`, {
        text: 'every morning summarize my email',
      });
      expect(res.status).toBe(201);
      expect(mockWatchRepository.create).toHaveBeenCalledTimes(1);
      const arg = mockWatchRepository.create.mock.calls[0]![0];
      expect(arg.userId).toBe(USER);
      expect(arg.spec.cadence).toBe('daily');
      expect(arg.status).toBe('active');
      expect(arg.nextRunAt).toBeInstanceOf(Date); // active → due now
    });

    it('rejects non-routine text with 400', async () => {
      const res = await request(buildApp(), 'POST', `/api/watches/${USER}`, {
        text: 'draft a reply to Sarah',
      });
      expect(res.status).toBe(400);
      expect(mockWatchRepository.create).not.toHaveBeenCalled();
    });

    it('creates a watch from a confirmed structured spec', async () => {
      mockWatchRepository.create.mockResolvedValue(fakeWatch);
      const res = await request(buildApp(), 'POST', `/api/watches/${USER}`, {
        spec: { name: 'Weekly calendar', cadence: 'weekly', action: 'digest', filter: { sources: ['google_calendar'] } },
        sourceText: 'weekly calendar recap',
      });
      expect(res.status).toBe(201);
      expect(mockWatchRepository.create.mock.calls[0]![0].spec.cadence).toBe('weekly');
    });

    it('400s on an invalid spec (bad cadence)', async () => {
      const res = await request(buildApp(), 'POST', `/api/watches/${USER}`, {
        spec: { name: 'x', cadence: 'yearly', action: 'digest' },
      });
      expect(res.status).toBe(400);
    });

    it('400s on an invalid spec action', async () => {
      const res = await request(buildApp(), 'POST', `/api/watches/${USER}`, {
        spec: { name: 'x', cadence: 'daily', action: 'send_email' },
      });
      expect(res.status).toBe(400);
    });

    it('400s when neither text nor spec is provided', async () => {
      const res = await request(buildApp(), 'POST', `/api/watches/${USER}`, {});
      expect(res.status).toBe(400);
    });

    it('400s on an invalid create status (no silent default to active)', async () => {
      const res = await request(buildApp(), 'POST', `/api/watches/${USER}`, {
        text: 'every morning summarize my email',
        status: 'bogus',
      });
      expect(res.status).toBe(400);
      expect(mockWatchRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a filter with non-string entries', async () => {
      const res = await request(buildApp(), 'POST', `/api/watches/${USER}`, {
        spec: { name: 'x', cadence: 'daily', action: 'digest', filter: { keywords: [{ nested: 1 }] } },
      });
      expect(res.status).toBe(400);
    });

    it('caps and normalizes filter entries, dropping unknown keys', async () => {
      mockWatchRepository.create.mockResolvedValue(fakeWatch);
      await request(buildApp(), 'POST', `/api/watches/${USER}`, {
        spec: {
          name: 'x',
          cadence: 'daily',
          action: 'digest',
          filter: { keywords: [' Budget ', ''], junk: 'dropped', domains: ['finance'] },
        },
      });
      const filter = mockWatchRepository.create.mock.calls[0]![0].spec.filter;
      expect(filter.keywords).toEqual(['Budget']); // trimmed, empty dropped
      expect(filter.domains).toEqual(['finance']);
      expect((filter as Record<string, unknown>).junk).toBeUndefined(); // unknown key dropped
    });

    it('forces an all-match watch to draft (never fires on the whole stream) with a warning', async () => {
      mockWatchRepository.create.mockResolvedValue({ ...fakeWatch, status: 'draft' });
      const res = await request(buildApp(), 'POST', `/api/watches/${USER}`, {
        text: 'every day summarize', // no source/sender/keyword → matches everything
      });
      expect(res.status).toBe(201);
      expect(mockWatchRepository.create.mock.calls[0]![0].status).toBe('draft');
      const b = res.body as { warnings: string[] };
      expect(b.warnings.some((w) => /matches every signal/i.test(w))).toBe(true);
    });

    it('400s on a non-UUID userId (validator)', async () => {
      const res = await request(buildApp(), 'POST', '/api/watches/not-a-uuid', {
        text: 'every morning summarize my email',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET / PATCH / DELETE', () => {
    it('lists a user’s watches', async () => {
      mockWatchRepository.listForUser.mockResolvedValue([fakeWatch]);
      const res = await request(buildApp(), 'GET', `/api/watches/${USER}`);
      expect(res.status).toBe(200);
      expect((res.body as { watches: unknown[] }).watches).toHaveLength(1);
    });

    it('lists recent runs for a watch', async () => {
      mockWatchRepository.getForUser.mockResolvedValue(fakeWatch);
      mockWatchRunRepository.listForWatch.mockResolvedValue([
        {
          id: 'run-1',
          watch_id: WATCH,
          user_id: USER,
          ran_at: new Date('2026-07-06T09:00:00Z'),
          action: 'digest',
          matched_count: 2,
          summary: 'Matched 2 signals',
          matched_refs: ['sig-1', 'sig-2'],
        },
      ]);
      const res = await request(buildApp(), 'GET', `/api/watches/${USER}/${WATCH}/runs?limit=5`);
      expect(res.status).toBe(200);
      expect(mockWatchRunRepository.listForWatch).toHaveBeenCalledWith(WATCH, USER, 5);
      expect((res.body as { runs: unknown[] }).runs).toHaveLength(1);
    });

    it('404s run history for a watch the user does not own', async () => {
      mockWatchRepository.getForUser.mockResolvedValue(null);
      const res = await request(buildApp(), 'GET', `/api/watches/${USER}/${WATCH}/runs`);
      expect(res.status).toBe(404);
      expect(mockWatchRunRepository.listForWatch).not.toHaveBeenCalled();
    });

    it('pauses a watch via PATCH {status}', async () => {
      mockWatchRepository.setStatus.mockResolvedValue({ ...fakeWatch, status: 'paused' });
      const res = await request(buildApp(), 'PATCH', `/api/watches/${USER}/${WATCH}`, { status: 'paused' });
      expect(res.status).toBe(200);
      expect(mockWatchRepository.setStatus).toHaveBeenCalledWith(WATCH, USER, 'paused', null);
    });

    it('resuming a watch schedules a next run', async () => {
      mockWatchRepository.getForUser.mockResolvedValue(fakeWatch);
      mockWatchRepository.setStatus.mockResolvedValue({ ...fakeWatch, status: 'active' });
      await request(buildApp(), 'PATCH', `/api/watches/${USER}/${WATCH}`, { status: 'active' });
      const call = mockWatchRepository.setStatus.mock.calls[0]!;
      expect(call[2]).toBe('active');
      expect(call[3]).toBeInstanceOf(Date);
    });

    it('rejects activating an all-match draft watch', async () => {
      mockWatchRepository.getForUser.mockResolvedValue({ ...fakeWatch, status: 'draft', filter: {} });
      const res = await request(buildApp(), 'PATCH', `/api/watches/${USER}/${WATCH}`, { status: 'active' });
      expect(res.status).toBe(400);
      expect(mockWatchRepository.setStatus).not.toHaveBeenCalled();
    });

    it('400s on an invalid status', async () => {
      const res = await request(buildApp(), 'PATCH', `/api/watches/${USER}/${WATCH}`, { status: 'bogus' });
      expect(res.status).toBe(400);
    });

    it('404s when patching a watch that does not exist', async () => {
      mockWatchRepository.setStatus.mockResolvedValue(null);
      const res = await request(buildApp(), 'PATCH', `/api/watches/${USER}/${WATCH}`, { status: 'paused' });
      expect(res.status).toBe(404);
    });

    it('edits a watch spec and source text', async () => {
      mockWatchRepository.getForUser.mockResolvedValue(fakeWatch);
      mockWatchRepository.updateSpec.mockResolvedValue({ ...fakeWatch, name: 'Edited watch' });
      const spec = {
        name: 'Edited watch',
        cadence: 'daily',
        action: 'digest',
        filter: { keywords: ['finance'] },
      };
      const res = await request(buildApp(), 'PATCH', `/api/watches/${USER}/${WATCH}`, {
        spec,
        sourceText: 'every morning summarize finance',
      });
      expect(res.status).toBe(200);
      expect(mockWatchRepository.updateSpec).toHaveBeenCalledWith(
        WATCH,
        USER,
        spec,
        'every morning summarize finance',
      );
    });

    it('rejects editing an active watch into an all-match filter', async () => {
      mockWatchRepository.getForUser.mockResolvedValue({ ...fakeWatch, status: 'active' });
      const res = await request(buildApp(), 'PATCH', `/api/watches/${USER}/${WATCH}`, {
        spec: { name: 'Too broad', cadence: 'daily', action: 'digest', filter: {} },
      });
      expect(res.status).toBe(400);
      expect(mockWatchRepository.updateSpec).not.toHaveBeenCalled();
    });

    it('400s on a non-UUID watchId', async () => {
      const res = await request(buildApp(), 'PATCH', `/api/watches/${USER}/not-a-uuid`, { status: 'paused' });
      expect(res.status).toBe(400);
    });

    it('deletes a watch (204)', async () => {
      mockWatchRepository.delete.mockResolvedValue(true);
      const res = await request(buildApp(), 'DELETE', `/api/watches/${USER}/${WATCH}`);
      expect(res.status).toBe(204);
    });

    it('404s when deleting a watch that does not exist', async () => {
      mockWatchRepository.delete.mockResolvedValue(false);
      const res = await request(buildApp(), 'DELETE', `/api/watches/${USER}/${WATCH}`);
      expect(res.status).toBe(404);
    });
  });
});
