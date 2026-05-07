import { createHash, randomBytes } from 'node:crypto';
import { externalAgentTokenRepository } from '@skytwin/db';
import type { ExternalAgentTokenRow } from '@skytwin/db';

export type TokenScope = 'read' | 'propose' | 'subscribe';

export interface ExternalAgentToken {
  /** The opaque 32-byte hex token value. Only returned at issuance — never stored plaintext. */
  token: string;
  userId: string;
  scope: TokenScope;
  agentName: string;
  issuedAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

/**
 * Derive the SHA-256 hash of a raw token for storage / lookup.
 * Tokens are 32 bytes hex; only the hash lands in the DB.
 */
function hashToken(rawToken: string): Buffer {
  return createHash('sha256').update(rawToken, 'utf8').digest();
}

function rowToToken(row: ExternalAgentTokenRow, plaintext?: string | undefined): ExternalAgentToken {
  return {
    token: plaintext ?? '[redacted]',
    userId: row.user_id,
    scope: row.scope as TokenScope,
    agentName: row.agent_name,
    issuedAt: row.issued_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

export const tokenStore = {
  /**
   * Issue a new external-agent token. Returns the plaintext token ONCE —
   * the caller must store it securely (e.g. in Claude Desktop config).
   */
  async issue(input: {
    userId: string;
    scope: TokenScope;
    agentName: string;
  }): Promise<ExternalAgentToken> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const row = await externalAgentTokenRepository.create({
      userId: input.userId,
      tokenHash,
      scope: input.scope,
      agentName: input.agentName,
    });
    return rowToToken(row, rawToken);
  },

  /**
   * Look up a token by its plaintext value.
   * Returns null if the token does not exist or has been revoked.
   * Side-effect: updates last_used_at on a valid hit.
   */
  async lookup(rawToken: string): Promise<ExternalAgentToken | null> {
    const tokenHash = hashToken(rawToken);
    const row = await externalAgentTokenRepository.findByHash(tokenHash);
    if (!row) return null;
    // Touch last_used_at — best effort, non-blocking
    externalAgentTokenRepository.touchLastUsed(row.id).catch(() => {
      // ignore — audit path, non-critical
    });
    return rowToToken(row);
  },

  /**
   * Revoke a token by its row id. Subsequent lookups return null immediately.
   */
  async revoke(id: string): Promise<void> {
    await externalAgentTokenRepository.revoke(id);
  },

  /**
   * List all active (non-revoked) tokens for a user.
   */
  async listForUser(userId: string): Promise<ExternalAgentToken[]> {
    const rows = await externalAgentTokenRepository.listForUser(userId);
    return rows.map((r) => rowToToken(r));
  },

  /**
   * Find the row id for a given plaintext token (needed for revoke by token value).
   */
  async findIdByToken(rawToken: string): Promise<string | null> {
    const tokenHash = hashToken(rawToken);
    const row = await externalAgentTokenRepository.findByHash(tokenHash);
    return row?.id ?? null;
  },
};
