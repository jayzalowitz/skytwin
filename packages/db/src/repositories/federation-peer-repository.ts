import { query } from '../connection.js';

export interface FederationPeerRow {
  id: string;
  user_id: string;
  label: string;
  peer_public_key: string;
  local_secret_key: string;
  local_public_key: string;
  endpoint_url: string | null;
  paired_at: Date;
  last_sync_at: Date | null;
  last_sync_status: 'ok' | 'failed' | 'never' | 'paused' | null;
  last_sync_error: string | null;
  unpaired_at: Date | null;
}

export interface CreatePeerInput {
  userId: string;
  label: string;
  peerPublicKey: string;
  localSecretKey: string;
  localPublicKey: string;
  endpointUrl?: string;
}

export interface UpdateSyncStatusInput {
  peerId: string;
  status: 'ok' | 'failed' | 'paused';
  error?: string;
}

export interface PairingCodeRow {
  id: string;
  user_id: string;
  pairing_code: string;
  local_secret_key: string;
  local_public_key: string;
  expires_at: Date;
  created_at: Date;
}

export const federationPeerRepository = {
  /**
   * Persist a paired peer. Public on (user_id, peer_public_key) so a
   * second pair attempt with the same peer key updates instead of
   * creating a duplicate row — useful when the user re-pairs after a
   * peer key rotation client-side.
   */
  async create(input: CreatePeerInput): Promise<FederationPeerRow> {
    const result = await query<FederationPeerRow>(
      `INSERT INTO federation_peers
         (user_id, label, peer_public_key, local_secret_key, local_public_key, endpoint_url, last_sync_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'never')
       ON CONFLICT (user_id, peer_public_key) DO UPDATE SET
         label = EXCLUDED.label,
         local_secret_key = EXCLUDED.local_secret_key,
         local_public_key = EXCLUDED.local_public_key,
         endpoint_url = EXCLUDED.endpoint_url,
         unpaired_at = NULL,
         paired_at = now()
       RETURNING *`,
      [
        input.userId,
        input.label,
        input.peerPublicKey,
        input.localSecretKey,
        input.localPublicKey,
        input.endpointUrl ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('peer create returned no row');
    return row;
  },

  async listActive(userId: string): Promise<FederationPeerRow[]> {
    const result = await query<FederationPeerRow>(
      `SELECT * FROM federation_peers
       WHERE user_id = $1 AND unpaired_at IS NULL
       ORDER BY paired_at DESC`,
      [userId],
    );
    return result.rows;
  },

  async findById(userId: string, peerId: string): Promise<FederationPeerRow | null> {
    const result = await query<FederationPeerRow>(
      `SELECT * FROM federation_peers
       WHERE user_id = $1 AND id = $2
       LIMIT 1`,
      [userId, peerId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Soft-unpair: keeps the row for audit. The sync worker filters on
   * `unpaired_at IS NULL` so unpaired peers stop receiving deltas
   * immediately.
   */
  async unpair(userId: string, peerId: string): Promise<boolean> {
    const result = await query(
      `UPDATE federation_peers
       SET unpaired_at = now()
       WHERE user_id = $1 AND id = $2 AND unpaired_at IS NULL`,
      [userId, peerId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async markSyncResult(input: UpdateSyncStatusInput): Promise<void> {
    await query(
      `UPDATE federation_peers
       SET last_sync_at = now(),
           last_sync_status = $2,
           last_sync_error = $3
       WHERE id = $1`,
      [input.peerId, input.status, input.error ?? null],
    );
  },
};

export const federationPairingCodeRepository = {
  async create(input: {
    userId: string;
    code: string;
    localSecretKey: string;
    localPublicKey: string;
    ttlSeconds: number;
  }): Promise<PairingCodeRow> {
    const result = await query<PairingCodeRow>(
      `INSERT INTO federation_pairing_codes
         (user_id, pairing_code, local_secret_key, local_public_key, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
       RETURNING *`,
      [
        input.userId,
        input.code,
        input.localSecretKey,
        input.localPublicKey,
        String(input.ttlSeconds),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('pairing code create returned no row');
    return row;
  },

  async findActiveByCode(code: string): Promise<PairingCodeRow | null> {
    const result = await query<PairingCodeRow>(
      `SELECT * FROM federation_pairing_codes
       WHERE pairing_code = $1 AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1`,
      [code],
    );
    return result.rows[0] ?? null;
  },

  async consume(id: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM federation_pairing_codes WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async deleteExpired(): Promise<number> {
    const result = await query(
      `DELETE FROM federation_pairing_codes WHERE expires_at < now()`,
    );
    return result.rowCount ?? 0;
  },
};
