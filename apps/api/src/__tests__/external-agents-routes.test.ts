import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ─── Mocks ───────────────────────────────────────────────────────────────────
// vi.hoisted ensures mock factories execute before module imports.

const {
  mockTokenRepo,
} = vi.hoisted(() => ({
  mockTokenRepo: {
    create: vi.fn(),
    findByHash: vi.fn(),
    touchLastUsed: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    listForUser: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  externalAgentTokenRepository: mockTokenRepo,
}));

// ─── Import router after mocks ───────────────────────────────────────────────
import { createExternalAgentsRouter } from '../routes/external-agents.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const USER_ID = 'ffffffff-eeee-dddd-cccc-111111111111';
const TOKEN_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function buildApp(userId = USER_ID): Express {
  const app = express();
  app.use(express.json());
  // Inject req.user so ownership resolution works (same pattern as other test suites)
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: userId };
    next();
  });
  app.use('/api/external-agents', createExternalAgentsRouter());
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
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const options: RequestInit = { method, headers };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET /tokens ──────────────────────────────────────────────────────────────
describe('GET /api/external-agents/tokens', () => {
  it('returns an empty array when no tokens exist', async () => {
    mockTokenRepo.listForUser.mockResolvedValueOnce([]);

    const res = await req(buildApp(), 'GET', '/api/external-agents/tokens');
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['tokens']).toEqual([]);
  });

  it('returns token metadata — hash and plaintext never exposed', async () => {
    mockTokenRepo.listForUser.mockResolvedValueOnce([
      {
        id: TOKEN_ID,
        user_id: USER_ID,
        token_hash: Buffer.alloc(32),
        scope: 'read',
        agent_name: 'claude-desktop',
        issued_at: new Date('2026-01-01'),
        revoked_at: null,
        last_used_at: null,
      },
    ]);

    const res = await req(buildApp(), 'GET', '/api/external-agents/tokens');
    expect(res.status).toBe(200);
    const tokens = (res.body as Record<string, unknown>)['tokens'] as unknown[];
    expect(tokens).toHaveLength(1);
    // token_hash must not appear in the response body
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('token_hash');
    const tok = tokens[0] as Record<string, unknown>;
    expect(tok['id']).toBe(TOKEN_ID);
    expect(tok['scope']).toBe('read');
  });
});

// ─── POST /tokens ─────────────────────────────────────────────────────────────
describe('POST /api/external-agents/tokens', () => {
  it('issues a token and returns the plaintext once', async () => {
    mockTokenRepo.create.mockResolvedValueOnce({
      id: TOKEN_ID,
      user_id: USER_ID,
      token_hash: Buffer.alloc(32),
      scope: 'read',
      agent_name: 'cursor',
      issued_at: new Date(),
      revoked_at: null,
      last_used_at: null,
    });

    const res = await req(buildApp(), 'POST', '/api/external-agents/tokens', {
      scope: 'read',
      agentName: 'cursor',
    });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    // 32-byte hex = 64 chars
    expect(typeof body['token']).toBe('string');
    expect((body['token'] as string).length).toBe(64);
    expect(body['scope']).toBe('read');
    expect(body['note']).toContain('Save this token now');
  });

  it('returns 400 for an invalid scope', async () => {
    const res = await req(buildApp(), 'POST', '/api/external-agents/tokens', {
      scope: 'superadmin',
      agentName: 'bad-agent',
    });
    expect(res.status).toBe(400);
    expect((res.body as Record<string, unknown>)['error']).toContain('scope');
  });

  it('returns 400 when agentName is missing', async () => {
    const res = await req(buildApp(), 'POST', '/api/external-agents/tokens', {
      scope: 'read',
    });
    expect(res.status).toBe(400);
    expect((res.body as Record<string, unknown>)['error']).toContain('agentName');
  });
});

// ─── DELETE /tokens/:id ───────────────────────────────────────────────────────
describe('DELETE /api/external-agents/tokens/:id', () => {
  it('revokes a token owned by the requesting user', async () => {
    mockTokenRepo.findById.mockResolvedValueOnce({
      id: TOKEN_ID,
      user_id: USER_ID,
      scope: 'read',
      agent_name: 'claude-desktop',
      issued_at: new Date(),
      revoked_at: null,
      last_used_at: null,
    });

    const res = await req(buildApp(), 'DELETE', `/api/external-agents/tokens/${TOKEN_ID}`);
    expect(res.status).toBe(204);
    expect(mockTokenRepo.revoke).toHaveBeenCalledWith(TOKEN_ID);
  });

  it('returns 403 when the token belongs to a different user', async () => {
    mockTokenRepo.findById.mockResolvedValueOnce({
      id: TOKEN_ID,
      user_id: 'other-user-id',
      scope: 'propose',
      agent_name: 'other-agent',
      issued_at: new Date(),
      revoked_at: null,
      last_used_at: null,
    });

    const res = await req(buildApp(), 'DELETE', `/api/external-agents/tokens/${TOKEN_ID}`);
    expect(res.status).toBe(403);
    expect(mockTokenRepo.revoke).not.toHaveBeenCalled();
  });

  it('returns 404 when the token does not exist', async () => {
    mockTokenRepo.findById.mockResolvedValueOnce(null);

    const res = await req(buildApp(), 'DELETE', `/api/external-agents/tokens/${TOKEN_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-UUID id', async () => {
    const res = await req(buildApp(), 'DELETE', '/api/external-agents/tokens/not-a-uuid');
    expect(res.status).toBe(400);
  });
});
