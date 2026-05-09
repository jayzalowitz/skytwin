import { query } from '../connection.js';

export type ModelDownloadStatus =
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'installing'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface ModelDownloadRow {
  id: string;
  user_id: string;
  model_id: string;
  target_path: string;
  total_bytes: number;
  bytes_downloaded: number;
  sha256_expected: string;
  status: ModelDownloadStatus;
  error: string | null;
  started_at: Date;
  paused_at: Date | null;
  completed_at: Date | null;
}

export interface CreateModelDownloadInput {
  userId: string;
  modelId: string;
  targetPath: string;
  totalBytes: number;
  sha256Expected: string;
}

/**
 * Repository for `model_downloads` (#187 AC#2).
 *
 * One row per download attempt. Resumable: a row in 'paused' state with
 * `bytes_downloaded > 0` keeps its `<target_path>.partial` file on disk
 * and can be restarted via Range request from `bytes_downloaded`.
 */
export const modelDownloadRepository = {
  async create(input: CreateModelDownloadInput): Promise<ModelDownloadRow> {
    const result = await query<ModelDownloadRow>(
      `INSERT INTO model_downloads
         (user_id, model_id, target_path, total_bytes, sha256_expected, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [
        input.userId,
        input.modelId,
        input.targetPath,
        input.totalBytes,
        input.sha256Expected,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('model download create returned no row');
    return row;
  },

  async findById(id: string): Promise<ModelDownloadRow | null> {
    const result = await query<ModelDownloadRow>(
      `SELECT * FROM model_downloads WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  async listForUser(userId: string): Promise<ModelDownloadRow[]> {
    const result = await query<ModelDownloadRow>(
      `SELECT * FROM model_downloads
       WHERE user_id = $1
       ORDER BY started_at DESC
       LIMIT 50`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Find the active (non-terminal) download for a given (user, model)
   * pair. Used to prevent double-starting the same download.
   */
  async findActive(userId: string, modelId: string): Promise<ModelDownloadRow | null> {
    const result = await query<ModelDownloadRow>(
      `SELECT * FROM model_downloads
       WHERE user_id = $1 AND model_id = $2
         AND status NOT IN ('complete', 'failed', 'cancelled')
       ORDER BY started_at DESC
       LIMIT 1`,
      [userId, modelId],
    );
    return result.rows[0] ?? null;
  },

  async updateProgress(id: string, bytesDownloaded: number): Promise<void> {
    await query(
      `UPDATE model_downloads
       SET bytes_downloaded = $2
       WHERE id = $1`,
      [id, bytesDownloaded],
    );
  },

  async updateTotalBytes(id: string, totalBytes: number): Promise<void> {
    await query(
      `UPDATE model_downloads
       SET total_bytes = $2
       WHERE id = $1`,
      [id, totalBytes],
    );
  },

  async setStatus(
    id: string,
    status: ModelDownloadStatus,
    extra: { error?: string; bytesDownloaded?: number } = {},
  ): Promise<void> {
    const sets: string[] = ['status = $2'];
    const params: unknown[] = [id, status];
    let i = 3;

    if (extra.error !== undefined) {
      sets.push(`error = $${i++}`);
      params.push(extra.error);
    }
    if (extra.bytesDownloaded !== undefined) {
      sets.push(`bytes_downloaded = $${i++}`);
      params.push(extra.bytesDownloaded);
    }
    if (status === 'paused') {
      sets.push(`paused_at = now()`);
    }
    if (status === 'downloading') {
      sets.push(`paused_at = NULL`);
    }
    if (status === 'complete') {
      sets.push(`completed_at = now()`);
    }

    await query(
      `UPDATE model_downloads SET ${sets.join(', ')} WHERE id = $1`,
      params,
    );
  },

  /**
   * Boot-time recovery: any download that was 'downloading' when the
   * API process died gets transitioned to 'paused' so the user can
   * choose to resume. The on-disk `<target_path>.partial` file is
   * preserved.
   */
  async recoverOrphanedDownloads(): Promise<number> {
    const result = await query(
      `UPDATE model_downloads
       SET status = 'paused', paused_at = now()
       WHERE status = 'downloading'`,
    );
    return result.rowCount ?? 0;
  },
};
