import { query } from '../connection.js';

export interface ExternalAgentTokenRow {
  id: string;
  user_id: string;
  token_hash: Buffer;
  scope: string;
  agent_name: string;
  issued_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

export interface CreateExternalAgentTokenInput {
  userId: string;
  tokenHash: Buffer;
  scope: 'read' | 'propose' | 'subscribe';
  agentName: string;
}

/**
 * Repository for external_agent_tokens.
 *
 * Tokens are 32 bytes hex; only the SHA-256 hash is stored.
 * Lookup does: SELECT WHERE token_hash = <hash> AND revoked_at IS NULL.
 */
export const externalAgentTokenRepository = {
  /**
   * Insert a new token row. token_hash is the SHA-256 digest of the raw token.
   * The plaintext token is NEVER stored — the caller must return it to the user
   * and discard it.
   */
  async create(input: CreateExternalAgentTokenInput): Promise<ExternalAgentTokenRow> {
    const result = await query<ExternalAgentTokenRow>(
      `INSERT INTO external_agent_tokens
         (user_id, token_hash, scope, agent_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, token_hash, scope, agent_name,
                 issued_at, revoked_at, last_used_at`,
      [input.userId, input.tokenHash, input.scope, input.agentName],
    );
    const row = result.rows[0];
    if (!row) throw new Error('external_agent_tokens insert returned no row');
    return row;
  },

  /**
   * Look up a non-revoked token by its SHA-256 hash.
   * Returns null if not found or already revoked.
   */
  async findByHash(tokenHash: Buffer): Promise<ExternalAgentTokenRow | null> {
    const result = await query<ExternalAgentTokenRow>(
      `SELECT id, user_id, token_hash, scope, agent_name,
              issued_at, revoked_at, last_used_at
       FROM external_agent_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Update last_used_at to now() for a token row (by id).
   */
  async touchLastUsed(id: string): Promise<void> {
    await query(
      `UPDATE external_agent_tokens SET last_used_at = now() WHERE id = $1`,
      [id],
    );
  },

  /**
   * Revoke a token by its row id. Subsequent findByHash calls return null.
   */
  async revoke(id: string): Promise<void> {
    await query(
      `UPDATE external_agent_tokens SET revoked_at = now() WHERE id = $1`,
      [id],
    );
  },

  /**
   * List all active (non-revoked) tokens for a user, newest first.
   * token_hash is NOT included in list results — only metadata.
   */
  async listForUser(userId: string): Promise<ExternalAgentTokenRow[]> {
    const result = await query<ExternalAgentTokenRow>(
      `SELECT id, user_id, token_hash, scope, agent_name,
              issued_at, revoked_at, last_used_at
       FROM external_agent_tokens
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY issued_at DESC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Find a specific token row by id (for ownership check before revoke).
   */
  async findById(id: string): Promise<ExternalAgentTokenRow | null> {
    const result = await query<ExternalAgentTokenRow>(
      `SELECT id, user_id, token_hash, scope, agent_name,
              issued_at, revoked_at, last_used_at
       FROM external_agent_tokens
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  },
};
