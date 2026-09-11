import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';

const mocks = vi.hoisted(() => ({
  findByDecisionForUser: vi.fn(),
  deleteForUser: vi.fn(),
  deleteByDecisionForUser: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  decisionRepository: {}, explanationRepository: {},
  inferenceReceiptRepository: mocks,
}));

import { createDecisionsRouter } from '../routes/decisions.js';

const USER = '22222222-2222-4222-8222-222222222222';
const DECISION = '33333333-3333-4333-8333-333333333333';

function app(userId?: string): Express {
  const instance = express();
  instance.use((req, _res, next) => { req.authenticatedUserId = userId; next(); });
  instance.use('/api/decisions', createDecisionsRouter());
  return instance;
}

async function request(instance: Express, method: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = instance.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing address'));
      fetch(`http://127.0.0.1:${address.port}/api/decisions/${DECISION}/receipt`, { method })
        .then(async (response) => {
          const body = await response.json().catch(() => null);
          server.close();
          resolve({ status: response.status, body });
        }).catch(reject);
    });
  });
}

describe('inference receipt routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires an authenticated principal even when development auth bypass is enabled', async () => {
    expect((await request(app(), 'GET')).status).toBe(401);
    expect(mocks.findByDecisionForUser).not.toHaveBeenCalled();
  });

  it('returns only the receipt found through the owner-scoped repository', async () => {
    mocks.findByDecisionForUser.mockResolvedValue({ receipt: { version: 1, status: 'on_device' } });
    const response = await request(app(USER), 'GET');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ receipt: { version: 1, status: 'on_device' }, persistenceTrust: 'trusted' });
    expect(mocks.findByDecisionForUser).toHaveBeenCalledWith(USER, DECISION);
  });

  it('does not disclose whether another user has a receipt', async () => {
    mocks.findByDecisionForUser.mockResolvedValue(null);
    expect((await request(app(USER), 'GET')).status).toBe(404);
  });

  it('deletes only after resolving the receipt through the owner scope', async () => {
    mocks.deleteByDecisionForUser.mockResolvedValue(true);
    expect((await request(app(USER), 'DELETE')).status).toBe(204);
    expect(mocks.deleteByDecisionForUser).toHaveBeenCalledWith(USER, DECISION);
  });
});
