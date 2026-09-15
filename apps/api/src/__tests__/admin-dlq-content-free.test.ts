import express from 'express';
import type { Express } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { repository, logger } = vi.hoisted(() => ({
  repository: {
    list: vi.fn(),
    countPending: vi.fn(),
    markResolved: vi.fn(),
    findById: vi.fn(),
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const JOB_CODES = new Set(['embedding-backfill', 'legacy-redacted']);

vi.mock('@skytwin/db', () => ({
  workerDeadLetterRepository: repository,
  isWorkerDeadLetterJobCode: (value: unknown) =>
    typeof value === 'string' && JOB_CODES.has(value),
}));
vi.mock('@skytwin/core', () => ({ createLogger: () => logger }));

const { createAdminDlqRouter } = await import('../routes/admin-dlq.js');

const SECRET =
  'password=hunter2 private@example.test prompt=private payload={secret}';
const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  correlation_id: '22222222-2222-4222-8222-222222222222',
  job_code: 'embedding-backfill',
  error_code: 'job-failed',
  attempts: 3,
  status: 'pending',
  dead_lettered_at: new Date('2026-09-15T12:00:00Z'),
  resolved_at: null,
  // A stale or malicious repository object must not restore retired content.
  error_message: SECRET,
  context: { userId: SECRET, credentials: SECRET, prompt: SECRET },
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminDlqRouter());
  return app;
}

async function request(
  app: Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine test server port'));
        return;
      }
      void fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
        .then(async (response) => {
          const payload = await response.json();
          server.close();
          resolve({ status: response.status, body: payload });
        })
        .catch((error) => {
          server.close();
          reject(error);
        });
    });
  });
}

describe('admin DLQ content-free DTO', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.list.mockResolvedValue([ROW]);
    repository.countPending.mockResolvedValue(1);
    repository.markResolved.mockResolvedValue({
      ...ROW,
      status: 'discarded',
      resolved_at: new Date('2026-09-15T13:00:00Z'),
    });
  });

  it('returns lifecycle metadata and codes without retired source content', async () => {
    const response = await request(
      makeApp(),
      'GET',
      '/api/admin/dead-letter?status=all&jobCode=embedding-backfill&limit=20',
    );
    expect(response.status).toBe(200);
    expect(repository.list).toHaveBeenCalledWith({
      status: null,
      jobCode: 'embedding-backfill',
      limit: 20,
    });
    expect(response.body).toEqual({
      deadLetters: [
        {
          id: ROW.id,
          correlationId: ROW.correlation_id,
          jobCode: ROW.job_code,
          errorCode: ROW.error_code,
          attempts: 3,
          status: 'pending',
          deadLetteredAt: '2026-09-15T12:00:00.000Z',
          resolvedAt: null,
        },
      ],
      pendingCount: 1,
    });
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
  });

  it('returns a content-free resolved row and content-free operator log', async () => {
    const response = await request(
      makeApp(),
      'POST',
      `/api/admin/dead-letter/${ROW.id}/resolve`,
      { resolution: 'discarded' },
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(SECRET);
    expect(logger.info).toHaveBeenCalledWith('Dead-letter row resolved', {
      id: ROW.id,
      correlationId: ROW.correlation_id,
      jobCode: ROW.job_code,
      resolution: 'discarded',
    });
  });

  it('rejects free-form job filters without reflecting their bytes', async () => {
    const response = await request(
      makeApp(),
      'GET',
      `/api/admin/dead-letter?jobCode=${encodeURIComponent(SECRET)}`,
    );
    expect(response.status).toBe(400);
    expect(repository.list).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
  });

  it('preserves the legacy jobName filter as a bounded code alias', async () => {
    const response = await request(
      makeApp(),
      'GET',
      '/api/admin/dead-letter?jobName=embedding-backfill',
    );
    expect(response.status).toBe(200);
    expect(repository.list).toHaveBeenCalledWith({
      status: 'pending',
      jobCode: 'embedding-backfill',
    });
  });
});
