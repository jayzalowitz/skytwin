import { query } from '../connection.js';

export interface CredentialVaultMetaRow {
  user_id: string;
  passphrase_salt: Buffer;
  passphrase_hash: Buffer;
  current_key_version: number;
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
         (user_id, passphrase_salt, passphrase_hash, current_key_version)
       VALUES ($1, $2, $3, 1)
       RETURNING user_id, passphrase_salt, passphrase_hash, current_key_version,
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
                 created_at, rotated_at`,
      [userId],
    );
    return result.rows[0] ?? null;
  },
};
