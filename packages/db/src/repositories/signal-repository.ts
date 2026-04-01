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

  async cleanup(_olderThanDays: number = 30): Promise<number> {
    const result = await query(
      'DELETE FROM signals WHERE retention_until < now() RETURNING id',
    );
    return result.rowCount ?? 0;
  },
};
