import { query } from '../connection.js';
import type { ServiceCredentialRow } from '../types.js';

export interface UpsertServiceCredentialInput {
  service: string;
  credentialKey: string;
  credentialValue: string;
  label?: string;
}

/**
 * Repository for managing service-level credentials (API keys, secrets, etc.)
 * stored in the database so non-technical users can configure them via the UI.
 */
export const serviceCredentialRepository = {
  async getByService(service: string): Promise<ServiceCredentialRow[]> {
    const result = await query<ServiceCredentialRow>(
      `SELECT credential.*
         FROM service_credentials AS credential
         JOIN installation_identity AS owner
           ON owner.singleton = true
          AND owner.installation_id = credential.installation_id
        WHERE credential.service = $1
        ORDER BY credential.credential_key`,
      [service],
    );
    return result.rows;
  },

  async get(service: string, credentialKey: string): Promise<ServiceCredentialRow | null> {
    const result = await query<ServiceCredentialRow>(
      `SELECT credential.*
         FROM service_credentials AS credential
         JOIN installation_identity AS owner
           ON owner.singleton = true
          AND owner.installation_id = credential.installation_id
        WHERE credential.service = $1 AND credential.credential_key = $2`,
      [service, credentialKey],
    );
    return result.rows[0] ?? null;
  },

  async upsert(input: UpsertServiceCredentialInput): Promise<ServiceCredentialRow> {
    const result = await query<ServiceCredentialRow>(
      `INSERT INTO service_credentials
         (installation_id, service, credential_key, credential_value, label)
       SELECT installation_id, $1, $2, $3, $4
         FROM installation_identity
        WHERE singleton = true
       ON CONFLICT (installation_id, service, credential_key) DO UPDATE SET
         credential_value = EXCLUDED.credential_value,
         label = COALESCE(EXCLUDED.label, service_credentials.label),
         ironclaw_synced_at = NULL,
         updated_at = now()
       RETURNING *`,
      [input.service, input.credentialKey, input.credentialValue, input.label ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('installation_identity_unavailable');
    return row;
  },

  async delete(service: string, credentialKey: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM service_credentials AS credential
        USING installation_identity AS owner
        WHERE owner.singleton = true
          AND owner.installation_id = credential.installation_id
          AND credential.service = $1
          AND credential.credential_key = $2`,
      [service, credentialKey],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async listServices(): Promise<string[]> {
    const result = await query<{ service: string }>(
      `SELECT DISTINCT credential.service
         FROM service_credentials AS credential
         JOIN installation_identity AS owner
           ON owner.singleton = true
          AND owner.installation_id = credential.installation_id
        ORDER BY credential.service`,
    );
    return result.rows.map((r) => r.service);
  },

  async getAll(): Promise<ServiceCredentialRow[]> {
    const result = await query<ServiceCredentialRow>(
      `SELECT credential.*
         FROM service_credentials AS credential
         JOIN installation_identity AS owner
           ON owner.singleton = true
          AND owner.installation_id = credential.installation_id
        ORDER BY credential.service, credential.credential_key`,
    );
    return result.rows;
  },

  async getUnsyncedCredentials(): Promise<ServiceCredentialRow[]> {
    const result = await query<ServiceCredentialRow>(
      `SELECT credential.*
         FROM service_credentials AS credential
         JOIN installation_identity AS owner
           ON owner.singleton = true
          AND owner.installation_id = credential.installation_id
        WHERE credential.ironclaw_synced_at IS NULL
        ORDER BY credential.service, credential.credential_key`,
    );
    return result.rows;
  },

  async markSynced(service: string, credentialKey: string, syncedAt: Date = new Date()): Promise<ServiceCredentialRow | null> {
    const result = await query<ServiceCredentialRow>(
      `UPDATE service_credentials AS credential
          SET ironclaw_synced_at = $1, updated_at = now()
         FROM installation_identity AS owner
        WHERE owner.singleton = true
          AND owner.installation_id = credential.installation_id
          AND credential.service = $2
          AND credential.credential_key = $3
       RETURNING credential.*`,
      [syncedAt, service, credentialKey],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Get credentials for a service as a key-value map.
   * Useful for building config objects.
   */
  async getAsMap(service: string): Promise<Record<string, string>> {
    const rows = await this.getByService(service);
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.credential_key] = row.credential_value;
    }
    return map;
  },
};
