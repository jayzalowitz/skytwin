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

export interface SourceKeySessionAuthorityInput {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly tokenHash: string;
  readonly expiresAtMs: number;
}

export type SessionAuthorityVerificationResult =
  | Readonly<{ status: 'active' }>
  | Readonly<{ status: 'superseded' }>
  | Readonly<{ status: 'inactive' }>
  | Readonly<{ status: 'unavailable' }>;

export type SessionAuthenticationResult =
  | Readonly<{ status: 'active'; session: SessionRow }>
  | Readonly<{ status: 'inactive' }>
  | Readonly<{ status: 'unavailable' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_HASH = /^[a-f0-9]{64}$/;

/** Exact live-session check shared by API admission and Electron revalidation. */
export async function revalidateSourceKeySessionAuthority(
  input: SourceKeySessionAuthorityInput,
): Promise<SessionAuthorityVerificationResult> {
  if (
    !UUID.test(input.sessionId) || !UUID.test(input.ownerId) ||
    !TOKEN_HASH.test(input.tokenHash) ||
    !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= 0
  ) return Object.freeze({ status: 'inactive' });
  try {
    const result = await query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM sessions
        WHERE id = $1
          AND user_id = $2
          AND token_hash = $3
          AND revoked = false
          AND expires_at > now()
        LIMIT 2`,
      [
        input.sessionId,
        input.ownerId,
        input.tokenHash,
      ],
    );
    const row = result.rows.length === 1 ? result.rows[0] : undefined;
    const persistedExpiry = row === undefined
      ? Number.NaN
      : new Date(row.expires_at).getTime();
    return Object.freeze({
      status: row?.id === input.sessionId && persistedExpiry === input.expiresAtMs
        ? 'active' as const
        : row?.id === input.sessionId && persistedExpiry > input.expiresAtMs
          ? 'superseded' as const
          : 'inactive' as const,
    });
  } catch {
    return Object.freeze({ status: 'unavailable' });
  }
}

export const sessionRepository = {
  revalidateSourceKeyAuthority: revalidateSourceKeySessionAuthority,
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
    if (!TOKEN_HASH.test(tokenHash)) return null;
    const result = await query<SessionRow>(
      `SELECT * FROM sessions
       WHERE token_hash = $1 AND revoked = false
       LIMIT 2`,
      [tokenHash],
    );
    return result.rows.length === 1 ? result.rows[0]! : null;
  },

  /** Atomically authenticates one unambiguous live token and maintains its lease. */
  async authenticateAndMaintain(tokenHash: string): Promise<SessionAuthenticationResult> {
    if (!TOKEN_HASH.test(tokenHash)) return Object.freeze({ status: 'inactive' });
    try {
      const result = await query<SessionRow>(
        `WITH candidates AS MATERIALIZED (
           SELECT id FROM sessions
            WHERE token_hash = $1 AND revoked = false AND expires_at > now()
            LIMIT 2
         ), unique_candidate AS (
           SELECT id FROM candidates
            WHERE (SELECT count(*) FROM candidates) = 1
         )
         UPDATE sessions AS session
            SET last_active_at = now(),
                expires_at = CASE
                  WHEN session.expires_at - now() < INTERVAL '1 day'
                    THEN now() + INTERVAL '7 days'
                  ELSE session.expires_at
                END
           FROM unique_candidate
          WHERE session.id = unique_candidate.id
         RETURNING session.*`,
        [tokenHash],
      );
      if (result.rows.length !== 1) return Object.freeze({ status: 'inactive' });
      return Object.freeze({ status: 'active', session: Object.freeze(result.rows[0]!) });
    } catch {
      return Object.freeze({ status: 'unavailable' });
    }
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
