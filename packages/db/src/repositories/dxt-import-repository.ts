import { query } from '../connection.js';

export interface DxtImportRow {
  id: string;
  user_id: string;
  imported_at: Date;
  artifact_blob: Buffer;
  artifact_sha256: Buffer;
  registry_id: string;
  source_instance_id: string | null;
  status: 'pending' | 'installed' | 'rejected' | 'failed';
  installed_server_id: string | null;
  rejected_at: Date | null;
  installed_at: Date | null;
  error_message: string | null;
}

export interface CreateDxtImportInput {
  userId: string;
  blob: Buffer;
  sha256: Buffer;
  registryId: string;
  sourceInstanceId: string | null;
}

/**
 * Repository for dxt_imports.
 *
 * Each row represents one imported DXT artifact waiting for user confirmation.
 * Blobs are stored as raw bytes and never mutated after insert. Status
 * transitions are one-way: pending -> installed | rejected | failed.
 */
export const dxtImportRepository = {
  /**
   * Persist a new import row with status='pending'.
   * Returns the inserted row including its generated id and imported_at.
   */
  async create(input: CreateDxtImportInput): Promise<DxtImportRow> {
    const result = await query<DxtImportRow>(
      `INSERT INTO dxt_imports
         (user_id, artifact_blob, artifact_sha256, registry_id, source_instance_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id, user_id, imported_at, artifact_blob, artifact_sha256,
                 registry_id, source_instance_id, status, installed_server_id,
                 rejected_at, installed_at, error_message`,
      [
        input.userId,
        input.blob,
        input.sha256,
        input.registryId,
        input.sourceInstanceId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('dxt_imports insert returned no row');
    return row;
  },

  /**
   * Find a single import row by its id.
   * Returns null if not found.
   */
  async findById(id: string): Promise<DxtImportRow | null> {
    const result = await query<DxtImportRow>(
      `SELECT id, user_id, imported_at, artifact_blob, artifact_sha256,
              registry_id, source_instance_id, status, installed_server_id,
              rejected_at, installed_at, error_message
       FROM dxt_imports
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * List all imports for a user, newest first.
   * Blob bytes are included — callers that need metadata-only must omit
   * artifact_blob from the response themselves.
   * Optionally filter by status.
   */
  async listForUser(userId: string, opts?: { status?: string }): Promise<DxtImportRow[]> {
    if (opts?.status != null) {
      const result = await query<DxtImportRow>(
        `SELECT id, user_id, imported_at, artifact_blob, artifact_sha256,
                registry_id, source_instance_id, status, installed_server_id,
                rejected_at, installed_at, error_message
         FROM dxt_imports
         WHERE user_id = $1 AND status = $2
         ORDER BY imported_at DESC`,
        [userId, opts.status],
      );
      return result.rows;
    }
    const result = await query<DxtImportRow>(
      `SELECT id, user_id, imported_at, artifact_blob, artifact_sha256,
              registry_id, source_instance_id, status, installed_server_id,
              rejected_at, installed_at, error_message
       FROM dxt_imports
       WHERE user_id = $1
       ORDER BY imported_at DESC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Transition a row to status='rejected'. Idempotent on already-rejected rows.
   */
  async markRejected(id: string): Promise<void> {
    await query(
      `UPDATE dxt_imports
       SET status = 'rejected', rejected_at = now()
       WHERE id = $1`,
      [id],
    );
  },

  /**
   * Transition a row to status='installed'. Records the mcp_servers FK.
   */
  async markInstalled(id: string, serverId: string): Promise<void> {
    await query(
      `UPDATE dxt_imports
       SET status = 'installed', installed_server_id = $2, installed_at = now()
       WHERE id = $1`,
      [id, serverId],
    );
  },

  /**
   * Transition a row to status='failed'. Records the error message.
   * No PII should be passed in the error string.
   */
  async markFailed(id: string, error: string): Promise<void> {
    await query(
      `UPDATE dxt_imports
       SET status = 'failed', error_message = $2
       WHERE id = $1`,
      [id, error],
    );
  },
};
