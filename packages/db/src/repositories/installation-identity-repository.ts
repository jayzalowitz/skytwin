import { query, withTransaction } from '../connection.js';

export interface InstallationIdentityRow {
  singleton: true;
  installation_id: string;
  created_at: Date;
}

/**
 * Stable database-side ownership identity for installation-local records.
 *
 * This is not key material. It stays readable while every user vault is
 * locked so an eventual device-reset flow can delete unusable installation
 * records by opaque owner identifier. Rotating it cascades deletion of every
 * installation-owned credential/tool row before a fresh owner is created.
 */
export const installationIdentityRepository = {
  async getCurrent(): Promise<InstallationIdentityRow> {
    const result = await query<InstallationIdentityRow>(
      `SELECT singleton, installation_id, created_at
         FROM installation_identity
        WHERE singleton = true`,
    );
    if (result.rows.length !== 1) {
      throw new Error('installation_identity_unavailable');
    }
    return result.rows[0]!;
  },

  /**
   * Delete all data owned by the expected installation and mint a new owner.
   * The compare-and-swap prevents a stale reset request from deleting records
   * created after another reset. The transaction rolls back the cascade if
   * minting the replacement identity fails.
   */
  async reset(expectedInstallationId: string): Promise<InstallationIdentityRow | null> {
    return withTransaction(async (client) => {
      const removed = await client.query<{ installation_id: string }>(
        `DELETE FROM installation_identity
          WHERE singleton = true AND installation_id = $1
        RETURNING installation_id`,
        [expectedInstallationId],
      );
      if (removed.rowCount !== 1) return null;

      const replacement = await client.query<InstallationIdentityRow>(
        `INSERT INTO installation_identity (singleton)
         VALUES (true)
         RETURNING singleton, installation_id, created_at`,
      );
      if (replacement.rows.length !== 1) {
        throw new Error('installation_identity_reset_incomplete');
      }
      return replacement.rows[0]!;
    });
  },
};
