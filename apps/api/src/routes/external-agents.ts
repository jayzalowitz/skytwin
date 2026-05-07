import { Router } from 'express';
import type { Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { externalAgentTokenRepository } from '@skytwin/db';
import { createLogger } from '@skytwin/core';

const log = createLogger('api:external-agents');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_SCOPES = new Set(['read', 'propose', 'subscribe']);

function getUserId(req: Request): string | undefined {
  // Prefer session-auth populated req.user; fall back to query param for dev
  // (mirrors pattern used throughout this codebase)
  const asAny = req as unknown as { user?: { id?: string } };
  const fromUser = asAny.user?.id;
  const fromQuery = typeof req.query['userId'] === 'string' ? req.query['userId'] : undefined;
  return fromUser ?? fromQuery;
}

/**
 * Hash a raw token to the SHA-256 bytes used for DB storage.
 * Tokens are 32 bytes hex; only the hash is persisted (never the plaintext).
 */
function hashToken(rawToken: string): Buffer {
  return createHash('sha256').update(rawToken, 'utf8').digest();
}

export function createExternalAgentsRouter(): Router {
  const router = Router();

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/external-agents/tokens
  // List active (non-revoked) tokens for the requesting user.
  // Token values are NEVER returned — only metadata.
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/tokens', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const rows = await externalAgentTokenRepository.listForUser(userId);
      const tokens = rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        agentName: r.agent_name,
        issuedAt: r.issued_at,
        lastUsedAt: r.last_used_at,
      }));

      res.json({ tokens });
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/external-agents/tokens
  // Issue a new token. Returns the token ONCE (plaintext + metadata).
  // The caller must store the token — it will never be shown again.
  //
  // Body: { scope: 'read' | 'propose' | 'subscribe'; agentName: string }
  // ──────────────────────────────────────────────────────────────────────────
  router.post('/tokens', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as { scope?: unknown; agentName?: unknown };

      if (typeof body.scope !== 'string' || !VALID_SCOPES.has(body.scope)) {
        res.status(400).json({
          error: `scope must be one of: ${[...VALID_SCOPES].join(', ')}`,
        });
        return;
      }

      if (typeof body.agentName !== 'string' || !body.agentName.trim()) {
        res.status(400).json({ error: 'agentName must be a non-empty string' });
        return;
      }

      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);

      const row = await externalAgentTokenRepository.create({
        userId,
        tokenHash,
        scope: body.scope as 'read' | 'propose' | 'subscribe',
        agentName: body.agentName.trim(),
      });

      log.info('External agent token issued', {
        userId,
        tokenId: row.id,
        scope: row.scope,
        agentName: row.agent_name,
      });

      // Return the token ONCE. It will never be shown again.
      res.status(201).json({
        token: rawToken,
        id: row.id,
        scope: row.scope,
        agentName: row.agent_name,
        issuedAt: row.issued_at,
        note: 'Save this token now. It will not be shown again.',
      });
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /api/external-agents/tokens/:id
  // Revoke a token by its row id. Ownership is verified before revocation.
  // Revocation is immediate — subsequent lookups return null.
  // ──────────────────────────────────────────────────────────────────────────
  router.delete('/tokens/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const row = await externalAgentTokenRepository.findById(id);
      if (!row) {
        res.status(404).json({ error: 'Token not found' });
        return;
      }

      if (row.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this token' });
        return;
      }

      await externalAgentTokenRepository.revoke(id);

      log.info('External agent token revoked', {
        userId,
        tokenId: id,
        agentName: row.agent_name,
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
