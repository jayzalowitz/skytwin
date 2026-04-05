import { query } from '../connection.js';

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  device_name: string;
  created_at: Date;
  expires_at: Date;
  last_active_at: Date;
  revoked: boolean;
}

export const sessionRepository = {
  async create(input: {
    userId: string;
    tokenHash: string;
    deviceName?: string;
    expiresAt: Date;
  }): Promise<SessionRow> {
    const result = await query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, device_name, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.userId, input.tokenHash, input.deviceName ?? 'Phone', input.expiresAt],
    );
    return result.rows[0]!;
  },

  async findByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const result = await query<SessionRow>(
      `SELECT * FROM sessions
       WHERE token_hash = $1 AND revoked = false`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  },

  async findActiveByUser(userId: string): Promise<SessionRow[]> {
    const result = await query<SessionRow>(
      `SELECT * FROM sessions
       WHERE user_id = $1 AND revoked = false
       ORDER BY last_active_at DESC`,
      [userId],
    );
    return result.rows;
  },

  async refreshExpiry(id: string, newExpiresAt: Date): Promise<void> {
    await query(
      `UPDATE sessions
       SET expires_at = $1, last_active_at = now()
       WHERE id = $2`,
      [newExpiresAt, id],
    );
  },

  async touchLastActive(id: string): Promise<void> {
    await query(
      `UPDATE sessions SET last_active_at = now() WHERE id = $1`,
      [id],
    );
  },

  async revoke(id: string): Promise<void> {
    await query(
      `UPDATE sessions SET revoked = true WHERE id = $1`,
      [id],
    );
  },

  async revokeAllForUser(userId: string): Promise<number> {
    const result = await query(
      `UPDATE sessions SET revoked = true WHERE user_id = $1 AND revoked = false`,
      [userId],
    );
    return result.rowCount ?? 0;
  },
};
