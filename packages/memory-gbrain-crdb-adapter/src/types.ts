/**
 * Internal row shapes for the CRDB-backed gbrain backend.
 *
 * These mirror the brain_* tables defined in
 * `packages/db/src/migrations/040-gbrain-memory.sql`. They are intentionally
 * separate from `@skytwin/memory-port` types — the port carries the public
 * shape, these carry the database shape, and the repository maps between them.
 */

export interface BrainPageRow {
  id: string;
  user_id: string;
  title: string;
  content: string;
  source: string;
  source_ref: string | null;
  metadata: Record<string, unknown>;
  embedding: number[] | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface BrainEntityRow {
  id: string;
  user_id: string;
  name: string;
  entity_type: string;
  attributes: Record<string, unknown>;
  first_seen_at: Date;
  last_seen_at: Date;
}

export interface BrainTripleRow {
  id: string;
  user_id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: Date;
  valid_to: Date | null;
  evidence: Record<string, unknown>;
  created_at: Date;
}

export interface BrainEpisodeRow {
  id: string;
  user_id: string;
  wing: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  started_at: Date;
  ended_at: Date;
}

export interface BrainSignalRow {
  id: string;
  user_id: string;
  source: string;
  type: string;
  data: Record<string, unknown>;
  recorded_at: Date;
  signal_timestamp: Date;
}

export type TierCalibration = 'sparse' | 'normal' | 'dense';

export interface BrainSettingsRow {
  user_id: string;
  backend: 'hybrid' | 'gbrain' | 'mempalace';
  hybrid_notification_dismissed: boolean;
  routing: Record<string, unknown>;
  /**
   * When true, retrieval applies the authoring-tier multiplier in the RRF
   * fold so user-authored pages outrank received noise on equal-text queries.
   * Default false — Layer 2 is eval-gated and opt-in (#251).
   */
  tier_weighting: boolean;
  /**
   * Calibration band tuned to the user's writing volume. Computed from
   * `user_sent_*` page count in last 90 days. Sparse caps the multiplier so
   * a thin sent corpus doesn't get over-amplified; dense uses the wide spread.
   */
  tier_calibration: TierCalibration;
  updated_at: Date;
}

export interface RrfHit {
  id: string;
  rrfScore: number;
  vectorRank: number | null;
  textRank: number | null;
  page: BrainPageRow;
}

/**
 * Inputs for inserting a brain page. `embedding` is optional; if absent the
 * page is inserted with `embedding IS NULL` and an embedding job is enqueued
 * for later async backfill.
 */
export interface InsertBrainPageInput {
  id?: string;
  userId: string;
  title?: string;
  content: string;
  source: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
  embeddingModel?: string;
}
