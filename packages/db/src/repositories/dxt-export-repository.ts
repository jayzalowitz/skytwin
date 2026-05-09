import { query } from '../connection.js';

export interface DxtExportRow {
  id: string;
  user_id: string;
  server_id: string;
  exported_at: Date;
  artifact_blob: Buffer;
  artifact_sha256: Buffer;
}

export interface CreateDxtExportInput {
  userId: string;
  serverId: string;
  blob: Buffer;
  sha256: Buffer;
}

/**
 * Repository for dxt_exports.
 *
 * Each row stores one packed DXT binary artifact keyed by (user_id, server_id,
 * exported_at). Blobs are stored as raw bytes and never mutated after insert.
 */
export const dxtExportRepository = {
  /**
   * Persist a new DXT artifact to the database.
   * Returns the inserted row including its generated id and exported_at.
   */
  async create(input: CreateDxtExportInput): Promise<DxtExportRow> {
    const result = await query<DxtExportRow>(
      `INSERT INTO dxt_exports (user_id, server_id, artifact_blob, artifact_sha256)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, server_id, exported_at, artifact_blob, artifact_sha256`,
      [input.userId, input.serverId, input.blob, input.sha256],
    );
    const row = result.rows[0];
    if (!row) throw new Error('dxt_exports insert returned no row');
    return row;
  },

  /**
   * Find a single export row by its id.
   * Returns null if not found.
   */
  async findById(id: string): Promise<DxtExportRow | null> {
    const result = await query<DxtExportRow>(
      `SELECT id, user_id, server_id, exported_at, artifact_blob, artifact_sha256
       FROM dxt_exports
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * List all exports for a user, newest first.
   * Blob bytes are included — for metadata-only listings (e.g. the
   * `/api/dxt/exports` endpoint), prefer `listMetadataForUser` so we
   * don't ship the full artifact bytes through Postgres → API → response.
   */
  async listForUser(userId: string): Promise<DxtExportRow[]> {
    const result = await query<DxtExportRow>(
      `SELECT id, user_id, server_id, exported_at, artifact_blob, artifact_sha256
       FROM dxt_exports
       WHERE user_id = $1
       ORDER BY exported_at DESC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Metadata-only variant of listForUser — excludes artifact_blob and uses
   * octet_length() for the byte count so blobs don't leave Postgres.
   */
  async listMetadataForUser(userId: string): Promise<DxtExportMetadataRow[]> {
    const result = await query<DxtExportMetadataRow>(
      `SELECT id, user_id, server_id, exported_at, artifact_sha256,
              octet_length(artifact_blob)::INT AS blob_bytes
       FROM dxt_exports
       WHERE user_id = $1
       ORDER BY exported_at DESC`,
      [userId],
    );
    return result.rows;
  },
};

export interface DxtExportMetadataRow {
  id: string;
  user_id: string;
  server_id: string;
  exported_at: Date;
  artifact_sha256: Buffer;
  blob_bytes: number;
}
