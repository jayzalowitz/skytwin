import { query } from '../connection.js';

export interface SourceKeyRegistryRow {
  user_id: string;
  key_version: number;
  wrapper_version: number;
  algorithm: 'aes-256-gcm';
  kdf_record: unknown;
  recovery_wrapper: unknown;
  created_at: Date;
  retired_at: Date | null;
}

export const sourceKeyRegistryRepository = {
  async getCurrent(userId: string): Promise<SourceKeyRegistryRow | null> {
    const result = await query<SourceKeyRegistryRow>(
      `SELECT user_id, key_version, wrapper_version, algorithm, kdf_record,
              recovery_wrapper, created_at, retired_at
         FROM user_source_key_registry
        WHERE user_id = $1 AND retired_at IS NULL
        ORDER BY key_version DESC LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  },

  async createInitial(input: Omit<SourceKeyRegistryRow, 'created_at' | 'retired_at'>): Promise<boolean> {
    const result = await query(
      `INSERT INTO user_source_key_registry
        (user_id, key_version, wrapper_version, algorithm, kdf_record, recovery_wrapper)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, key_version) DO NOTHING
       RETURNING user_id`,
      [input.user_id, input.key_version, input.wrapper_version, input.algorithm, input.kdf_record, input.recovery_wrapper],
    );
    return result.rowCount === 1;
  },

  async requestDeletion(userId: string): Promise<void> {
    await query(
      `UPSERT INTO source_key_deletion_intents (user_id, requested_at, device_wrapper_deleted_at)
       VALUES ($1, now(), NULL)`,
      [userId],
    );
  },
};
