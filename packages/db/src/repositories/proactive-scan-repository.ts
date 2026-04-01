import { query } from '../connection.js';
import type { ProactiveScanRow, BriefingRow } from '../types.js';

export interface CreateScanInput {
  userId: string;
  scanType: 'daily' | 'hourly' | 'manual';
}

export interface CreateBriefingInput {
  userId: string;
  scanId?: string;
  items: unknown[];
}

export const proactiveScanRepository = {
  async createScan(input: CreateScanInput): Promise<ProactiveScanRow> {
    const result = await query<ProactiveScanRow>(
      `INSERT INTO proactive_scans (user_id, scan_type)
       VALUES ($1, $2)
       RETURNING *`,
      [input.userId, input.scanType],
    );
    return result.rows[0]!;
  },

  async completeScan(
    scanId: string,
    itemsFound: number,
    itemsAutoExecuted: number,
    itemsQueuedApproval: number,
  ): Promise<ProactiveScanRow> {
    const result = await query<ProactiveScanRow>(
      `UPDATE proactive_scans
       SET items_found = $1, items_auto_executed = $2, items_queued_approval = $3, completed_at = now()
       WHERE id = $4
       RETURNING *`,
      [itemsFound, itemsAutoExecuted, itemsQueuedApproval, scanId],
    );
    return result.rows[0]!;
  },

  async getLatestScan(userId: string): Promise<ProactiveScanRow | null> {
    const result = await query<ProactiveScanRow>(
      'SELECT * FROM proactive_scans WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1',
      [userId],
    );
    return result.rows[0] ?? null;
  },

  async createBriefing(input: CreateBriefingInput): Promise<BriefingRow> {
    const result = await query<BriefingRow>(
      `INSERT INTO briefings (user_id, scan_id, items)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.userId, input.scanId ?? null, JSON.stringify(input.items)],
    );
    return result.rows[0]!;
  },

  async getLatestBriefing(userId: string): Promise<BriefingRow | null> {
    const result = await query<BriefingRow>(
      'SELECT * FROM briefings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId],
    );
    return result.rows[0] ?? null;
  },

  async markEmailSent(briefingId: string): Promise<void> {
    await query(
      'UPDATE briefings SET email_sent = true WHERE id = $1',
      [briefingId],
    );
  },
};
