/**
 * Tests for federation pairing routes (#194 Child 1).
 *
 *   POST /api/federation/pair/start
 *   POST /api/federation/pair/complete
 *   GET  /api/federation/peers/:userId
 *   POST /api/federation/peers/:userId/:peerId/unpair
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const { mockPeerRepository, mockCodeRepository } = vi.hoisted(() => ({
  mockPeerRepository: {
    create: vi.fn(),
    listActive: vi.fn(),
    findById: vi.fn(),
    unpair: vi.fn(),
    markSyncResult: vi.fn(),
  },
  mockCodeRepository: {
    create: vi.fn(),
    findActiveByCode: vi.fn(),
    consume: vi.fn(),
    deleteExpired: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  federationPeerRepository: mockPeerRepository,
  federationPairingCodeRepository: mockCodeRepository,
}));

import { createFederationRouter } from '../routes/federation.js';
import { generateKeyPair } from '../federation/crypto.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_USER_ID = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildApp(userId: string | null = USER_ID): Express {
  const app = express();
  app.use(express.json());
  if (userId !== null) {
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string } }).user = { id: userId };
      next();
    });
  }
  app.use('/api/federation', createFederationRouter());
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

describe('POST /api/federation/pair/start', () => {
  it('returns a 6-digit code, public key, and TTL', async () => {
    mockCodeRepository.create.mockResolvedValue({
      id: 'code-1',
      user_id: USER_ID,
      pairing_code: '123456',
      local_secret_key: 'sk',
      local_public_key: 'pk',
      expires_at: new Date(Date.now() + 600_000),
      created_at: new Date(),
    });

    const { status, body } = await req(buildApp(), 'POST', '/api/federation/pair/start', { userId: USER_ID });
    expect(status).toBe(200);
    expect(body['code']).toMatch(/^\d{6}$/);
    expect(typeof body['publicKey']).toBe('string');
    expect(typeof body['expiresAt']).toBe('string');
    expect(body['ttlSeconds']).toBe(600);
  });

  it('rejects missing userId', async () => {
    const { status, body } = await req(buildApp(), 'POST', '/api/federation/pair/start', {});
    expect(status).toBe(400);
    expect(body['error']).toMatch(/userId required/);
  });
});

describe('POST /api/federation/pair/complete', () => {
  const peerKey = generateKeyPair().publicKeyB64;
  const codeRow = {
    id: 'code-1',
    user_id: USER_ID,
    pairing_code: '123456',
    local_secret_key: 'localSec',
    local_public_key: 'localPub',
    expires_at: new Date(Date.now() + 600_000),
    created_at: new Date(),
  };

  it('persists a peer and consumes the code on success', async () => {
    mockCodeRepository.findActiveByCode.mockResolvedValue(codeRow);
    mockPeerRepository.create.mockResolvedValue({
      id: 'peer-1',
      user_id: USER_ID,
      label: 'Phone',
      peer_public_key: peerKey,
      local_secret_key: 'localSec',
      local_public_key: 'localPub',
      endpoint_url: null,
      paired_at: new Date(),
      last_sync_at: null,
      last_sync_status: 'never',
      last_sync_error: null,
      unpaired_at: null,
    });
    mockCodeRepository.consume.mockResolvedValue(true);

    const { status, body } = await req(buildApp(), 'POST', '/api/federation/pair/complete', {
      userId: USER_ID,
      code: '123456',
      label: 'Phone',
      peerPublicKey: peerKey,
    });

    expect(status).toBe(200);
    expect((body['peer'] as Record<string, unknown>)?.['label']).toBe('Phone');
    expect(mockCodeRepository.consume).toHaveBeenCalledWith('code-1');
    expect(mockPeerRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        label: 'Phone',
        peerPublicKey: peerKey,
        localSecretKey: 'localSec',
        localPublicKey: 'localPub',
      }),
    );
  });

  it('rejects when the code is invalid format', async () => {
    const { status, body } = await req(buildApp(), 'POST', '/api/federation/pair/complete', {
      userId: USER_ID,
      code: 'abc',
      label: 'X',
      peerPublicKey: peerKey,
    });
    expect(status).toBe(400);
    expect(body['error']).toMatch(/6-digit/);
  });

  it('rejects when peerPublicKey is not a 32-byte base64 key', async () => {
    const { status, body } = await req(buildApp(), 'POST', '/api/federation/pair/complete', {
      userId: USER_ID,
      code: '123456',
      label: 'X',
      peerPublicKey: 'too-short',
    });
    expect(status).toBe(400);
    expect(body['error']).toMatch(/32-byte/);
  });

  it('rejects when label is empty or oversized', async () => {
    const r1 = await req(buildApp(), 'POST', '/api/federation/pair/complete', {
      userId: USER_ID,
      code: '123456',
      label: '',
      peerPublicKey: peerKey,
    });
    expect(r1.status).toBe(400);

    const r2 = await req(buildApp(), 'POST', '/api/federation/pair/complete', {
      userId: USER_ID,
      code: '123456',
      label: 'x'.repeat(81),
      peerPublicKey: peerKey,
    });
    expect(r2.status).toBe(400);
  });

  it('returns 404 when code is expired or unknown', async () => {
    mockCodeRepository.findActiveByCode.mockResolvedValue(null);
    const { status, body } = await req(buildApp(), 'POST', '/api/federation/pair/complete', {
      userId: USER_ID,
      code: '123456',
      label: 'X',
      peerPublicKey: peerKey,
    });
    expect(status).toBe(404);
    expect(body['error']).toMatch(/not found or expired/);
  });

  it('rejects when code belongs to a different user', async () => {
    mockCodeRepository.findActiveByCode.mockResolvedValue({
      ...codeRow,
      user_id: OTHER_USER_ID,
    });
    const { status, body } = await req(buildApp(), 'POST', '/api/federation/pair/complete', {
      userId: USER_ID,
      code: '123456',
      label: 'X',
      peerPublicKey: peerKey,
    });
    expect(status).toBe(403);
    expect(body['error']).toMatch(/not for this user/);
  });

  it('rejects malformed endpointUrl when present', async () => {
    mockCodeRepository.findActiveByCode.mockResolvedValue(codeRow);
    const { status } = await req(buildApp(), 'POST', '/api/federation/pair/complete', {
      userId: USER_ID,
      code: '123456',
      label: 'X',
      peerPublicKey: peerKey,
      endpointUrl: 'ftp://nope',
    });
    expect(status).toBe(400);
  });
});

describe('GET /api/federation/peers/:userId', () => {
  it('returns active peers in JSON-friendly shape', async () => {
    mockPeerRepository.listActive.mockResolvedValue([
      {
        id: 'peer-1',
        user_id: USER_ID,
        label: 'Phone',
        peer_public_key: 'pk',
        local_secret_key: 'sec',
        local_public_key: 'lpub',
        endpoint_url: 'https://phone.local:3001',
        paired_at: new Date(),
        last_sync_at: null,
        last_sync_status: 'never',
        last_sync_error: null,
        unpaired_at: null,
      },
    ]);
    const { status, body } = await req(buildApp(), 'GET', `/api/federation/peers/${USER_ID}`);
    expect(status).toBe(200);
    const peers = body['peers'] as Array<Record<string, unknown>>;
    expect(peers.length).toBe(1);
    expect(peers[0]).toMatchObject({
      id: 'peer-1',
      label: 'Phone',
      publicKey: 'pk',
      endpointUrl: 'https://phone.local:3001',
      lastSyncStatus: 'never',
    });
    // The sensitive local_secret_key must NOT appear in the JSON output.
    expect(JSON.stringify(peers[0])).not.toContain('sec');
  });
});

describe('POST /api/federation/peers/:userId/:peerId/unpair', () => {
  it('returns updated:true when a row was soft-unpaired', async () => {
    mockPeerRepository.unpair.mockResolvedValue(true);
    const { status, body } = await req(
      buildApp(),
      'POST',
      `/api/federation/peers/${USER_ID}/peer-1/unpair`,
    );
    expect(status).toBe(200);
    expect(body['updated']).toBe(true);
    expect(mockPeerRepository.unpair).toHaveBeenCalledWith(USER_ID, 'peer-1');
  });

  it('returns updated:false when no matching active row exists', async () => {
    mockPeerRepository.unpair.mockResolvedValue(false);
    const { body } = await req(
      buildApp(),
      'POST',
      `/api/federation/peers/${USER_ID}/peer-1/unpair`,
    );
    expect(body['updated']).toBe(false);
  });
});
