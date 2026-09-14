import type { PoolClient } from 'pg';
import { query } from '../connection.js';

export interface CredentialVaultMetaRow {
  user_id: string;
  passphrase_salt: Buffer;
  passphrase_hash: Buffer;
  current_key_version: number;
  vault_state: 'locked' | 'unlocked';
  vault_generation: string;
  created_at: Date;
  rotated_at: Date | null;
}

/**
 * Repository for user_credential_vault_meta.
 *
 * Stores the per-user passphrase salt and a SHA-256 hash of the derived
 * key (NOT the passphrase or the derived key itself). Used to:
 *   1. Derive the key on unlock: key = scrypt(passphrase, salt)
 *   2. Verify the passphrase without storing it.
 */
export const credentialVaultMetaRepository = {
  /**
   * Retrieve vault metadata for a user, or null if no vault has been
   * initialised for this user yet.
   */
  async getForUser(userId: string): Promise<CredentialVaultMetaRow | null> {
    const result = await query<CredentialVaultMetaRow>(
      `SELECT user_id, passphrase_salt, passphrase_hash, current_key_version,
              vault_state, vault_generation,
              created_at, rotated_at
       FROM user_credential_vault_meta
       WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Create a new vault metadata row for a user.
   * Throws if a row for this user already exists (enforce single vault per user
   * at the application layer before calling this).
   */
  async create(
    userId: string,
    passphraseSalt: Buffer,
    passphraseHash: Buffer,
  ): Promise<CredentialVaultMetaRow> {
    const result = await query<CredentialVaultMetaRow>(
      `INSERT INTO user_credential_vault_meta
         (user_id, passphrase_salt, passphrase_hash, current_key_version,
          vault_state, vault_generation)
       VALUES ($1, $2, $3, 1, 'unlocked', gen_random_uuid())
       RETURNING user_id, passphrase_salt, passphrase_hash, current_key_version,
                 vault_state, vault_generation,
                 created_at, rotated_at`,
      [userId, passphraseSalt, passphraseHash],
    );
    const row = result.rows[0];
    if (!row) throw new Error('user_credential_vault_meta insert returned no row');
    return row;
  },

  /**
   * Increment current_key_version by 1 for future key rotation support.
   * Sets rotated_at to now().
   */
  async incrementKeyVersion(userId: string): Promise<CredentialVaultMetaRow | null> {
    const result = await query<CredentialVaultMetaRow>(
      `UPDATE user_credential_vault_meta
       SET current_key_version = current_key_version + 1,
           rotated_at = now()
       WHERE user_id = $1
       RETURNING user_id, passphrase_salt, passphrase_hash, current_key_version,
                 vault_state, vault_generation,
                 created_at, rotated_at`,
      [userId],
    );
    return result.rows[0] ?? null;
  },

  /** Start a new cross-process unlock session only from the observed generation. */
  async unlockIfCurrent(userId: string, expectedGeneration: string): Promise<string | null> {
    const result = await query<{ vault_generation: string }>(
      `UPDATE user_credential_vault_meta
          SET vault_state = 'unlocked', vault_generation = gen_random_uuid()
        WHERE user_id = $1 AND vault_generation = $2
        RETURNING vault_generation`,
      [userId, expectedGeneration],
    );
    return result.rows[0]?.vault_generation ?? null;
  },

  /**
   * Rotate the passphrase: update salt, hash, bump key_version by 1, and set
   * rotated_at = now(). Accepts an optional PoolClient so the caller can include
   * this UPDATE in a serialisable transaction alongside oauth_tokens re-encryption.
   *
   * Returns the new current_key_version, or null if no row exists.
   */
  async rotatePassphrase(
    userId: string,
    input: { newSalt: Buffer; newPassphraseHash: Buffer },
    client?: PoolClient,
  ): Promise<{ keyVersion: number; vaultGeneration: string } | null> {
    const sql = `UPDATE user_credential_vault_meta
       SET passphrase_salt    = $1,
           passphrase_hash    = $2,
           current_key_version = current_key_version + 1,
           vault_state = 'unlocked',
           vault_generation = gen_random_uuid(),
           rotated_at         = now()
       WHERE user_id = $3
       RETURNING current_key_version, vault_generation`;
    const params = [input.newSalt, input.newPassphraseHash, userId];

    const result = client
      ? await client.query<{ current_key_version: number; vault_generation: string }>(sql, params)
      : await query<{ current_key_version: number; vault_generation: string }>(sql, params);

    const row = result.rows[0];
    return row ? { keyVersion: row.current_key_version, vaultGeneration: row.vault_generation } : null;
  },
};
