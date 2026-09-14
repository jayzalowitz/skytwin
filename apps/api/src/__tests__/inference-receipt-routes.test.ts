import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import { generateKeyPairSync } from 'node:crypto';
import { sha256Hex, signInferenceReceipt, type InferenceReceiptV1 } from '@skytwin/shared-types';

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
const EXPLANATION = '44444444-4444-4444-8444-444444444444';
const RECEIPT = '11111111-1111-4111-8111-111111111111';
const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function receipt(): InferenceReceiptV1 {
  return signInferenceReceipt({
    version: 1, id: RECEIPT, userId: USER, decisionId: DECISION, explanationId: EXPLANATION,
    reasoningMode: 'on_device', provider: 'embedded', model: 'local-model',
    endpointIdentity: 'local://embedded', requestSha256: sha256Hex(Buffer.from('request')),
    responseSha256: sha256Hex(Buffer.from('response')), verifierVersion: 'boundary-v1',
    cost: { basis: 'exact', currency: 'USD', amountMinor: 0 }, status: 'on_device',
    createdAt: '2026-09-10T00:00:00.000Z',
  }, { keyId: 'recorder', privateKeyPem, publicKeyPem });
}

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: RECEIPT, version: 1, decision_id: DECISION, explanation_id: EXPLANATION,
    status: 'on_device', receipt: receipt(), trusted: true,
    created_at: new Date('2026-09-10T00:00:00.000Z'), ...overrides };
}

function app(userId?: string): Express {
  const instance = express();
  instance.use((req, _res, next) => { req.authenticatedUserId = userId; next(); });
  instance.use('/api/decisions', createDecisionsRouter());
  return instance;
}

async function request(
  instance: Express,
  method: string,
  decisionId = DECISION,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = instance.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing address'));
      fetch(`http://127.0.0.1:${address.port}/api/decisions/${decisionId}/receipt`, { method })
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

  it.each(['GET', 'DELETE'])('rejects a malformed decision ID before the %s repository call', async (method) => {
    const response = await request(app(USER), method, 'not-a-uuid');
    expect(response).toEqual({
      status: 400,
      body: { error: 'invalid_decision_id', message: 'Decision ID must be a UUID.' },
    });
    expect(mocks.findByDecisionForUser).not.toHaveBeenCalled();
    expect(mocks.deleteByDecisionForUser).not.toHaveBeenCalled();
  });

  it('returns only the receipt found through the owner-scoped repository', async () => {
    const stored = storedRow();
    mocks.findByDecisionForUser.mockResolvedValue(stored);
    const response = await request(app(USER), 'GET');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ receipt: stored.receipt, persistenceTrust: 'trusted' });
    expect(mocks.findByDecisionForUser).toHaveBeenCalledWith(USER, DECISION);
  });

  it('compares signed and stored UUID identities without hexadecimal case sensitivity', async () => {
    const signed = signInferenceReceipt({
      version: 1, id: RECEIPT.toUpperCase(), userId: USER.toUpperCase(),
      decisionId: DECISION.toUpperCase(), explanationId: EXPLANATION.toUpperCase(),
      reasoningMode: 'on_device', provider: 'embedded', model: 'local-model',
      endpointIdentity: 'local://embedded', requestSha256: sha256Hex(Buffer.from('request')),
      responseSha256: sha256Hex(Buffer.from('response')), verifierVersion: 'boundary-v1',
      cost: { basis: 'exact', currency: 'USD', amountMinor: 0 }, status: 'on_device',
      createdAt: '2026-09-10T00:00:00.000Z',
    }, { keyId: 'recorder', privateKeyPem, publicKeyPem });
    mocks.findByDecisionForUser.mockResolvedValue(storedRow({ receipt: signed }));

    const response = await request(app(USER.toUpperCase()), 'GET', DECISION.toUpperCase());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ receipt: signed, persistenceTrust: 'trusted' });
  });

  it('labels missing or non-true persistence trust as imported and unverified', async () => {
    mocks.findByDecisionForUser.mockResolvedValue(storedRow({ trusted: undefined }));
    expect((await request(app(USER), 'GET')).body).toMatchObject({ persistenceTrust: 'imported_unverified' });
  });

  it.each([
    ['id', { id: '55555555-5555-4555-8555-555555555555' }], ['version', { version: 2 }],
    ['decision', { decision_id: '55555555-5555-4555-8555-555555555555' }],
    ['explanation', { explanation_id: '55555555-5555-4555-8555-555555555555' }],
    ['status', { status: 'conventional' }],
  ])('fails closed on mismatched stored %s', async (_label, override) => {
    mocks.findByDecisionForUser.mockResolvedValue(storedRow(override));
    expect((await request(app(USER), 'GET')).status).toBe(409);
  });

  it('fails closed on malformed or seal-invalid stored metadata', async () => {
    mocks.findByDecisionForUser.mockResolvedValue(storedRow({ receipt: { version: 1 } }));
    expect((await request(app(USER), 'GET')).status).toBe(409);
    const tampered = receipt();
    tampered.model = 'changed-after-signing';
    mocks.findByDecisionForUser.mockResolvedValue(storedRow({ receipt: tampered }));
    expect((await request(app(USER), 'GET')).status).toBe(409);
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
