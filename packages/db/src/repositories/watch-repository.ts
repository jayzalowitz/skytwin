import { query } from '../connection.js';
import type { Watch, RoutineSpec, RoutineStatus } from '@skytwin/shared-types';
import { randomUUID } from 'node:crypto';

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
  hour_of_day: number | null;
  day_of_week: number | null;
  filter: Record<string, unknown> | null;
  action: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
  next_run_at: Date | null;
  schedule_revision: string;
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
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    sourceText: r.source_text,
    cadence: r.cadence as Watch['cadence'],
    ...(r.hour_of_day !== null ? { hourOfDay: r.hour_of_day } : {}),
    ...(r.day_of_week !== null ? { dayOfWeek: r.day_of_week } : {}),
    filter: (r.filter ?? {}) as Watch['filter'],
    action: r.action as Watch['action'],
    status: r.status as RoutineStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
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
         (user_id, name, source_text, cadence, hour_of_day, day_of_week, filter, action, status, next_run_at)
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
            OR jsonb_path_exists(filter, '$.sources[*] ? (@.type() == "string" && @ like_regex ".*\\S.*")')
            OR jsonb_path_exists(filter, '$.fromContains[*] ? (@.type() == "string" && @ like_regex ".*\\S.*")')
            OR jsonb_path_exists(filter, '$.keywords[*] ? (@.type() == "string" && @ like_regex ".*\\S.*")')
            OR jsonb_path_exists(filter, '$.domains[*] ? (@.type() == "string" && @ like_regex ".*\\S.*")')
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
    const result = await query<{ id: string }>(
      `DELETE FROM watches WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
    return result.rows.length > 0;
  },

};
