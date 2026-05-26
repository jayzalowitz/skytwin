/**
 * Tests for the connector-health surface (#377).
 *
 * Covers: empty user → no banner; mixed connected/needs_reauth →
 * anyNeedsReauth true; serialization shape the dashboard relies on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mockConnectorHealthRepository = {
  findByUser: vi.fn(),
  upsert: vi.fn(),
};

vi.mock('@skytwin/db', () => ({
  connectorHealthRepository: mockConnectorHealthRepository,
}));

// Ownership middleware would normally pull a session; bypass for unit test.
vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

const { createConnectorsRouter } = await import('../routes/connectors.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/connectors', createConnectorsRouter());
  return app;
}

async function request(
  app: Express,
  method: 'GET',
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req: Partial<express.Request> = {
      method,
      url: path,
      headers: { 'content-type': 'application/json' },
      body: {},
    } as Partial<express.Request>;
    let status = 200;
    let resp: Record<string, unknown> = {};
    const res = {
      status(code: number) { status = code; return res; },
      json(payload: Record<string, unknown>) { resp = payload; resolve({ status, body: resp }); return res; },
      send(payload: unknown) { resp = payload as Record<string, unknown>; resolve({ status, body: resp }); return res; },
      setHeader: () => res,
      end: () => resolve({ status, body: resp }),
    } as unknown as express.Response;
    app(req as express.Request, res as express.Response, (err?: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve({ status, body: resp });
    });
  });
}

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000007';

describe('GET /connectors/:userId/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty connectors map + anyNeedsReauth=false for a user with no health rows', async () => {
    mockConnectorHealthRepository.findByUser.mockResolvedValue([]);
    const app = makeApp();
    const { status, body } = await request(app, 'GET', `/connectors/${USER_ID}/status`);
    expect(status).toBe(200);
    expect(body['userId']).toBe(USER_ID);
    expect(body['connectors']).toEqual({});
    expect(body['anyNeedsReauth']).toBe(false);
  });

  it('serializes every connector, exposes ISO timestamps, and flags anyNeedsReauth when any row is needs_reauth', async () => {
    const successAt = new Date('2026-05-25T12:00:00Z');
    const failureAt = new Date('2026-05-25T13:00:00Z');
    mockConnectorHealthRepository.findByUser.mockResolvedValue([
      {
        user_id: USER_ID,
        connector_name: 'gmail',
        status: 'needs_reauth',
        error_code: 'invalid_grant',
        last_success_at: successAt,
        last_failure_at: failureAt,
        updated_at: failureAt,
      },
      {
        user_id: USER_ID,
        connector_name: 'gcal',
        status: 'connected',
        error_code: null,
        last_success_at: successAt,
        last_failure_at: null,
        updated_at: successAt,
      },
    ]);
    const app = makeApp();
    const { status, body } = await request(app, 'GET', `/connectors/${USER_ID}/status`);
    expect(status).toBe(200);
    const connectors = body['connectors'] as Record<string, Record<string, unknown>>;
    expect(connectors['gmail']).toEqual({
      status: 'needs_reauth',
      errorCode: 'invalid_grant',
      lastSuccessAt: successAt.toISOString(),
      lastFailureAt: failureAt.toISOString(),
    });
    expect(connectors['gcal']).toEqual({
      status: 'connected',
      errorCode: null,
      lastSuccessAt: successAt.toISOString(),
      lastFailureAt: null,
    });
    expect(body['anyNeedsReauth']).toBe(true);
  });

  it('keeps anyNeedsReauth=false when every connector is connected', async () => {
    mockConnectorHealthRepository.findByUser.mockResolvedValue([
      {
        user_id: USER_ID,
        connector_name: 'gmail',
        status: 'connected',
        error_code: null,
        last_success_at: new Date('2026-05-25T12:00:00Z'),
        last_failure_at: null,
        updated_at: new Date('2026-05-25T12:00:00Z'),
      },
    ]);
    const app = makeApp();
    const { status, body } = await request(app, 'GET', `/connectors/${USER_ID}/status`);
    expect(status).toBe(200);
    expect(body['anyNeedsReauth']).toBe(false);
  });

  it('rejects malformed userId with the shared UUID validator (400 invalid_user_id)', async () => {
    const app = makeApp();
    const { status, body } = await request(app, 'GET', '/connectors/not-a-uuid/status');
    expect(status).toBe(400);
    expect(body['error']).toBe('invalid_user_id');
    expect(mockConnectorHealthRepository.findByUser).not.toHaveBeenCalled();
  });
});
