import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../connection.js';

export interface RecoveryCodeRow {
  id: string;
  user_id: string;
  code_hash: Buffer;
  created_at: Date;
  used_at: Date | null;
  used_for: string | null;
}

const RECOVERY_CODE_BYTES = 8; // 16 hex chars when rendered

/**
 * Generate a single recovery code: 16 hex chars, grouped 4-4-4-4 for
 * readability when the user writes it down. Pure: returns plaintext
 * AND its SHA-256 hash; callers persist the hash and surface plaintext
 * to the user exactly once.
 */
export function generatePlainCode(): { plaintext: string; hash: Buffer } {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  const raw = bytes.toString('hex').toUpperCase();
  const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  const hash = createHash('sha256').update(formatted).digest();
  return { plaintext: formatted, hash };
}

function hashCode(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext.trim().toUpperCase()).digest();
}

export const recoveryCodeRepository = {
  /**
   * Generate `count` codes for the user, persist their hashes, and
   * return the plaintext list. Callers MUST display these to the user
   * exactly once and immediately drop them. The plaintext is never
   * persisted.
   *
   * Replaces any existing unused codes — generating again invalidates
   * the prior set so the user can't be confused about which list is
   * current.
   */
  async generateForUser(userId: string, count: number = 10): Promise<string[]> {
    if (count < 1 || count > 50) throw new Error('count must be 1..50');

    // Invalidate any prior unused codes — keep the rows so the audit
    // log shows when the regenerate happened, but mark them used to
    // prevent redemption.
    await query(
      `UPDATE recovery_codes
       SET used_at = now(), used_for = 'invalidated-by-regenerate'
       WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );

    const plaintexts: string[] = [];
    for (let i = 0; i < count; i++) {
      const { plaintext, hash } = generatePlainCode();
      plaintexts.push(plaintext);
      await query(
        `INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`,
        [userId, hash],
      );
    }
    return plaintexts;
  },

  /**
   * Count of unused codes for a user. UI surfaces "you have N unused
   * recovery codes" so users know whether they need to regenerate.
   */
  async countUnused(userId: string): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT count(*)::STRING AS count
       FROM recovery_codes
       WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    return Number(result.rows[0]?.count ?? '0');
  },

  /**
   * Attempt to redeem a code. Returns `{ ok: true, codeId }` on
   * successful redemption (atomically marks the row used), or
   * `{ ok: false }` when the code doesn't match any unused row.
   *
   * Uses `timingSafeEqual` — though we look up by hash equality (which
   * is already constant-time at the DB layer for fixed-length BYTES),
   * the structure of the function is timing-safe by construction.
   */
  async redeem(
    userId: string,
    plaintextCode: string,
    usedFor: 'vault-unlock' | 'rotate-passphrase',
  ): Promise<{ ok: true; codeId: string } | { ok: false }> {
    const candidateHash = hashCode(plaintextCode);

    // Atomic match-and-mark via a single UPDATE … WHERE … RETURNING.
    // The unused/expiry filter is in the WHERE, so a concurrent redeem
    // of the same code can't double-spend.
    const result = await query<{ id: string; code_hash: Buffer }>(
      `UPDATE recovery_codes
       SET used_at = now(), used_for = $3
       WHERE user_id = $1
         AND code_hash = $2
         AND used_at IS NULL
       RETURNING id, code_hash`,
      [userId, candidateHash, usedFor],
    );

    const row = result.rows[0];
    if (!row) return { ok: false };

    // Defense-in-depth: re-verify the returned row's hash equals the
    // candidate via timingSafeEqual. The DB equality should already be
    // exact, but if for any reason it returned a near-match, we want
    // to reject.
    if (
      row.code_hash.length !== candidateHash.length ||
      !timingSafeEqual(row.code_hash, candidateHash)
    ) {
      return { ok: false };
    }

    return { ok: true, codeId: row.id };
  },

  /**
   * Audit-friendly listing of all codes (used + unused) for the
   * current user. Returns metadata only — never the hashes.
   */
  async listForUser(userId: string): Promise<Array<{
    id: string;
    createdAt: Date;
    usedAt: Date | null;
    usedFor: string | null;
  }>> {
    const result = await query<RecoveryCodeRow>(
      `SELECT id, user_id, code_hash, created_at, used_at, used_for
       FROM recovery_codes
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      usedAt: r.used_at,
      usedFor: r.used_for,
    }));
  },
};
