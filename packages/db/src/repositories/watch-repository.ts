import { query, withTransaction } from '../connection.js';
import type {
  Watch,
  RoutineSpec,
  RoutineStatus,
} from '@skytwin/shared-types';
import { randomUUID } from 'node:crypto';
import { databaseNullableSafeInteger } from './database-values.js';

const LEGACY_WATCH_QUARANTINE_PROVIDER_KEY = 'legacy_watch.quarantine.v1';

/**
 * Repository for **watches** — the persisted form of no-code routines (#519).
 * A Watch is a READ-ONLY signal watcher (digest / notify on a schedule); it
 * takes no action, so there is no policy gate here. See migration 069-watches.
 * Distinct from the IronClaw cron `/api/routines` execution primitive.
 */

export interface WatchRow {
  id: string;
  user_id: string;
  name: string;
  source_text: string;
  cadence: string;
  hour_of_day: number | string | null;
  day_of_week: number | string | null;
  filter: Record<string, unknown> | null;
  action: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
  next_run_at: Date | null;
  schedule_revision: string;
  workflow_id: string | null;
  workflow_version_id: string | null;
  workflow_provider_key: string | null;
  workflow_provider_schema_version: string | null;
  content_hash: string | null;
  projection_version: number | string | null;
}

function isFilterNarrowed(spec: RoutineSpec): boolean {
  const f = spec.filter;
  return Boolean(f.sources?.length || f.fromContains?.length || f.keywords?.length || f.domains?.length);
}

function storedFilter(spec: RoutineSpec): Required<RoutineSpec['filter']> {
  return {
    sources: spec.filter.sources ?? [],
    fromContains: spec.filter.fromContains ?? [],
    keywords: spec.filter.keywords ?? [],
    domains: spec.filter.domains ?? [],
  };
}

function rowToWatch(r: WatchRow): Watch {
  const hourOfDay = databaseNullableSafeInteger(r.hour_of_day, 'watches.hour_of_day');
  const dayOfWeek = databaseNullableSafeInteger(r.day_of_week, 'watches.day_of_week');
  const projectionVersion = databaseNullableSafeInteger(
    r.projection_version,
    'watches.projection_version',
  );
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    sourceText: r.source_text,
    cadence: r.cadence as Watch['cadence'],
    ...(hourOfDay !== null ? { hourOfDay } : {}),
    ...(dayOfWeek !== null ? { dayOfWeek } : {}),
    filter: (r.filter ?? {}) as Watch['filter'],
    action: r.action as Watch['action'],
    status: r.status as RoutineStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    workflowId: r.workflow_id ?? null,
    workflowVersionId: r.workflow_version_id ?? null,
    workflowProviderKey: r.workflow_provider_key ?? null,
    workflowProviderSchemaVersion: r.workflow_provider_schema_version ?? null,
    contentHash: r.content_hash ?? null,
    projectionVersion,
  };
}

export interface CreateWatchInput {
  userId: string;
  sourceText: string;
  spec: RoutineSpec;
  status?: RoutineStatus;
  /** When the watch first becomes due. Null for draft/paused. */
  nextRunAt?: Date | null;
}

export const watchRepository = {
  async create(input: CreateWatchInput): Promise<Watch> {
    const s = input.spec;
    const status = input.status ?? 'active';
    // Invariant: an ACTIVE watch must have a next_run_at, or listDue() never
    // returns it and it would never fire. Default to "due now" when the caller
    // didn't set one; a draft/paused watch is unscheduled (null).
    const nextRunAt = status === 'active' ? (input.nextRunAt ?? new Date()) : null;
    const result = await query<WatchRow>(
      `INSERT INTO watches
       (user_id, name, source_text, cadence, hour_of_day, day_of_week, filter,
          action, status, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.userId,
        s.name,
        input.sourceText,
        s.cadence,
        s.hourOfDay ?? null,
        s.dayOfWeek ?? null,
        JSON.stringify(storedFilter(s)),
        s.action,
        status,
        nextRunAt,
      ],
    );
    return rowToWatch(result.rows[0]!);
  },

  async listForUser(userId: string): Promise<Watch[]> {
    const result = await query<WatchRow>(
      `SELECT * FROM watches WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map(rowToWatch);
  },

  async getForUser(id: string, userId: string): Promise<Watch | null> {
    const result = await query<WatchRow>(
      `SELECT * FROM watches WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return result.rows[0] ? rowToWatch(result.rows[0]) : null;
  },

  /** Pause / resume (or draft → active). Same invariant as create(). */
  async setStatus(
    id: string,
    userId: string,
    status: RoutineStatus,
    nextRunAt: Date | null = null,
  ): Promise<Watch | null> {
    // Active ⇒ must have a next_run_at (else it never fires); paused/draft ⇒ null.
    const effectiveNext = status === 'active' ? (nextRunAt ?? new Date()) : null;
    const result = await query<WatchRow>(
      `UPDATE watches
          SET status = $3, next_run_at = $4, schedule_revision = $5, updated_at = now()
        WHERE id = $1 AND user_id = $2
          AND (
            $3 <> 'active'
            OR jsonb_array_length(filter->'sources') > 0
            OR jsonb_array_length(filter->'fromContains') > 0
            OR jsonb_array_length(filter->'keywords') > 0
            OR jsonb_array_length(filter->'domains') > 0
          )
          AND (
            $3 <> 'active'
            OR workflow_id IS NULL
            OR EXISTS (
              SELECT 1 FROM workflows
               WHERE workflows.id = watches.workflow_id
                 AND workflows.user_id = watches.user_id
                 AND workflows.active_version_id = watches.workflow_version_id
            )
          )
      RETURNING *`,
      [id, userId, status, effectiveNext, randomUUID()],
    );
    return result.rows[0] ? rowToWatch(result.rows[0]) : null;
  },

  /** Replace the watch's spec (an edit from the UI). Ownership-scoped. */
  async updateSpec(
    id: string,
    userId: string,
    spec: RoutineSpec,
    sourceText?: string,
  ): Promise<Watch | null> {
    const result = await query<WatchRow>(
      `UPDATE watches
          SET name = $3, cadence = $4, hour_of_day = $5, day_of_week = $6,
              filter = $7, action = $8, source_text = COALESCE($9, source_text),
              schedule_revision = $11, updated_at = now()
        WHERE id = $1 AND user_id = $2
          AND workflow_id IS NULL
          AND (status <> 'active' OR $10 = true)
      RETURNING *`,
      [
        id,
        userId,
        spec.name,
        spec.cadence,
        spec.hourOfDay ?? null,
        spec.dayOfWeek ?? null,
        JSON.stringify(storedFilter(spec)),
        spec.action,
        sourceText === undefined ? null : sourceText,
        isFilterNarrowed(spec),
        randomUUID(),
      ],
    );
    return result.rows[0] ? rowToWatch(result.rows[0]) : null;
  },

  async delete(id: string, userId: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const target = await client.query<{
        id: string;
        workflow_id: string | null;
        workflow_provider_key: string | null;
      }>(
        `SELECT id, workflow_id, workflow_provider_key
           FROM watches
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [id, userId],
      );
      const watch = target.rows[0];
      if (!watch) return false;

      if (watch.workflow_id === null) {
        const deleted = await client.query<{ id: string }>(
          `DELETE FROM watches
            WHERE id = $1 AND user_id = $2 AND workflow_id IS NULL
          RETURNING id`,
          [id, userId],
        );
        return deleted.rows.length > 0;
      }

      // Versioned workflows are immutable and must not be removed through the
      // legacy Watch endpoint. The sole exception is an inactive quarantine
      // workflow created when a legacy Watch cannot be compiled safely. Delete
      // the owning workflow so its version and Watch projection cascade as one
      // operation, while re-checking the quarantine/no-active-version boundary
      // atomically in the DELETE itself.
      if (watch.workflow_provider_key !== LEGACY_WATCH_QUARANTINE_PROVIDER_KEY) {
        return false;
      }
      const deleted = await client.query<{ id: string }>(
        `DELETE FROM workflows
          WHERE id = $1
            AND user_id = $2
            AND provider_key = $3
            AND active_version_id IS NULL
        RETURNING id`,
        [watch.workflow_id, userId, LEGACY_WATCH_QUARANTINE_PROVIDER_KEY],
      );
      return deleted.rows.length > 0;
    });
  },

};
