import type { PoolClient } from 'pg';
import { query } from '../connection.js';
import type { SignalRow } from '../types.js';

export interface CreateSignalInput {
  userId: string;
  source: string;
  type: string;
  domain: string;
  data: Record<string, unknown>;
  timestamp: Date;
  retentionDays?: number;
}

export interface PersistConnectorSignalInput {
  userId: string;
  signalType: string;
  signalData: Record<string, unknown>;
  timestamp: Date;
  retentionDays?: number;
  connectorAccountId: string;
  sourceSignalId: string;
  resourceRefId: string;
}

export const signalRepository = {
  async persist(input: CreateSignalInput): Promise<SignalRow> {
    const retentionInterval = `${input.retentionDays ?? 30} days`;
    const result = await query<SignalRow>(
      `INSERT INTO signals (user_id, source, type, domain, data, timestamp, retention_until)
       VALUES ($1, $2, $3, $4, $5, $6, now() + $7::INTERVAL)
       RETURNING *`,
      [input.userId, input.source, input.type, input.domain, JSON.stringify(input.data), input.timestamp, retentionInterval],
    );
    return result.rows[0]!;
  },

  /**
   * Account-bound, idempotent persistence for connector evidence. The
   * INSERT...SELECT ownership join prevents a caller from attaching another
   * user's resource reference even if they know its UUID.
   */
  async persistConnectorSignal(
    client: PoolClient,
    input: PersistConnectorSignalInput,
  ): Promise<{ signal: SignalRow; created: boolean } | null> {
    const retentionInterval = `${input.retentionDays ?? 30} days`;
    const inserted = await client.query<SignalRow>(
      `INSERT INTO signals (
         user_id, source, type, domain, data, timestamp, retention_until,
         source_signal_id, connector_account_id, resource_ref_id
       )
       SELECT $1, 'gmail', $3, 'email', $4, $5, now() + $6::INTERVAL,
              $7, r.connector_account_id, r.id
         FROM gmail_message_refs AS r
        WHERE r.id = $2 AND r.user_id = $1 AND r.connector_account_id = $8
       ON CONFLICT (user_id, source, connector_account_id, source_signal_id)
         WHERE source_signal_id IS NOT NULL AND connector_account_id IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [
        input.userId,
        input.resourceRefId,
        input.signalType,
        JSON.stringify(input.signalData),
        input.timestamp,
        retentionInterval,
        input.sourceSignalId,
        input.connectorAccountId,
      ],
    );
    if (inserted.rows[0]) return { signal: inserted.rows[0], created: true };

    const existing = await client.query<SignalRow>(
      `SELECT * FROM signals
        WHERE user_id = $1 AND source = 'gmail' AND connector_account_id = $2
          AND source_signal_id = $3`,
      [input.userId, input.connectorAccountId, input.sourceSignalId],
    );
    const signal = existing.rows[0];
    if (!signal || signal.resource_ref_id !== input.resourceRefId) return null;
    return { signal, created: false };
  },

  async getRecent(userId: string, domain?: string, hours: number = 48): Promise<SignalRow[]> {
    if (domain) {
      const result = await query<SignalRow>(
        `SELECT * FROM signals
         WHERE user_id = $1 AND domain = $2 AND timestamp > now() - $3::INTERVAL
         ORDER BY timestamp DESC`,
        [userId, domain, `${hours} hours`],
      );
      return result.rows;
    }
    const result = await query<SignalRow>(
      `SELECT * FROM signals
       WHERE user_id = $1 AND timestamp > now() - $2::INTERVAL
       ORDER BY timestamp DESC`,
      [userId, `${hours} hours`],
    );
    return result.rows;
  },

  async getById(id: string): Promise<SignalRow | null> {
    const result = await query<SignalRow>(
      'SELECT * FROM signals WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  },

  async getByIdForUser(userId: string, id: string): Promise<SignalRow | null> {
    const result = await query<SignalRow>(
      'SELECT * FROM signals WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return result.rows[0] ?? null;
  },

  async cleanup(_olderThanDays: number = 30): Promise<number> {
    const result = await query(
      'DELETE FROM signals WHERE retention_until < now() RETURNING id',
    );
    return result.rowCount ?? 0;
  },
};
