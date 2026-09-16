import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { RoutineActionKind, RoutineSpec } from "@skytwin/shared-types";
import { query, withTransaction } from "../connection.js";
import type { WatchRow } from "./watch-repository.js";

/** Durable scheduled slots for read-only Watches (the historical table name is retained). */
export type WatchSlotStatus = "pending" | "processing" | "completed" | "failed";

export interface WatchRunRow {
  id: string;
  watch_id: string;
  user_id: string;
  ran_at: Date;
  action: RoutineActionKind;
  matched_count: number;
  summary: string;
  matched_refs: string[];
  schedule_revision: string;
  scheduled_for: Date;
  window_start: Date;
  window_end: Date;
  watch_spec: Record<string, unknown>;
  slot_status: WatchSlotStatus;
  lease_token: string | null;
  lease_expires_at: Date | null;
  attempt_count: number;
  completed_at: Date | null;
  failed_at: Date | null;
  last_error: string | null;
}

interface DueWatchRow extends WatchRow {
  timezone: string | null;
}

export interface ClaimedWatchSlot {
  id: string;
  watchId: string;
  userId: string;
  spec: RoutineSpec;
  scheduledFor: Date;
  windowStart: Date;
  windowEnd: Date;
  leaseToken: string;
  attemptCount: number;
}

export interface ClaimNextWatchSlotInput {
  /** Pure scheduling callback. It is invoked inside the DB transaction. */
  calculateNextRun: (spec: RoutineSpec, from: Date, timezone: string) => Date;
  leaseMs?: number;
}

export interface CompleteWatchSlotInput {
  id: string;
  leaseToken: string;
  matchedCount: number;
  summary: string;
  matchedRefs: string[];
}

export interface FailWatchSlotInput {
  id: string;
  leaseToken: string;
  retryDelayMs: number;
  error: string;
}

export type FailWatchSlotResult = "retry_scheduled" | "failed" | "lost_lease";

const HOUR_MS = 60 * 60 * 1000;
const MAX_WINDOW_MS = 7 * 24 * HOUR_MS;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_LEASE_MS = 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_STORED_REFS = 200;
const MAX_SUMMARY_LENGTH = 4_000;
const DEFAULT_ZERO_MATCH_RETENTION_DAYS = 30;
const MAX_QUARANTINES_PER_CLAIM = 100;

function defaultLookbackMs(cadence: RoutineSpec["cadence"]): number {
  if (cadence === "hourly") return HOUR_MS;
  if (cadence === "weekly") return 7 * 24 * HOUR_MS;
  return 24 * HOUR_MS;
}

function specFromWatch(row: WatchRow): RoutineSpec {
  return specFromSnapshot({
    name: row.name,
    cadence: row.cadence,
    hourOfDay: row.hour_of_day,
    dayOfWeek: row.day_of_week,
    filter: row.filter ?? {},
    action: row.action,
  });
}

function specFromSnapshot(value: Record<string, unknown>): RoutineSpec {
  const cadence = value["cadence"];
  const action = value["action"];
  const filter = value["filter"];
  if (
    typeof value["name"] !== "string" ||
    (cadence !== "hourly" && cadence !== "daily" && cadence !== "weekly") ||
    (action !== "digest" && action !== "notify") ||
    typeof filter !== "object" ||
    filter === null ||
    Array.isArray(filter)
  ) {
    throw new Error("Stored Watch slot has an invalid spec snapshot");
  }
  const fields = ["sources", "fromContains", "keywords", "domains"] as const;
  const filterRecord = filter as Record<string, unknown>;
  if (
    Object.keys(filterRecord).some(
      (key) => !fields.includes(key as (typeof fields)[number]),
    ) ||
    fields.some((field) => {
      const entries = filterRecord[field];
      return (
        !Array.isArray(entries) ||
        !entries.every(
          (entry) => typeof entry === "string" && entry.trim().length > 0,
        )
      );
    })
  ) {
    throw new Error("Stored Watch slot has an invalid filter snapshot");
  }
  return {
    name: value["name"],
    cadence,
    action,
    filter: filterRecord as RoutineSpec["filter"],
    ...(typeof value["hourOfDay"] === "number"
      ? { hourOfDay: value["hourOfDay"] }
      : {}),
    ...(typeof value["dayOfWeek"] === "number"
      ? { dayOfWeek: value["dayOfWeek"] }
      : {}),
  };
}

function toClaimed(row: WatchRunRow): ClaimedWatchSlot {
  if (!row.lease_token)
    throw new Error("Claimed Watch slot is missing its lease token");
  return {
    id: row.id,
    watchId: row.watch_id,
    userId: row.user_id,
    spec: specFromSnapshot(row.watch_spec),
    scheduledFor: row.scheduled_for,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    leaseToken: row.lease_token,
    attemptCount: row.attempt_count,
  };
}

async function withSerializableRetry<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTransaction(fn);
    } catch (error) {
      lastError = error;
      if (
        (error as { code?: unknown } | null)?.code !== "40001" ||
        attempt === 2
      )
        throw error;
    }
  }
  throw lastError;
}

export const watchRunRepository = {
  /**
   * Claim one unit of work. Expired leases are reclaimed first. Otherwise the
   * transaction locks one due Watch, inserts its immutable slot, and advances
   * the Watch schedule together. No connector/network work occurs in the
   * transaction. Cockroach serialization failures retry the whole operation.
   */
  async claimNextDueSlot(
    input: ClaimNextWatchSlotInput,
  ): Promise<ClaimedWatchSlot | null> {
    if (input.leaseMs !== undefined && !Number.isFinite(input.leaseMs)) {
      throw new TypeError("Watch slot lease must be finite");
    }
    const leaseMs = Math.min(
      MAX_LEASE_MS,
      Math.max(1_000, input.leaseMs ?? DEFAULT_LEASE_MS),
    );

    for (
      let quarantineCount = 0;
      quarantineCount < MAX_QUARANTINES_PER_CLAIM;
      quarantineCount += 1
    ) {
      const result = await withSerializableRetry(async (client) => {
        const clock = await client.query<{ db_now: Date }>(
          "SELECT now() AS db_now",
        );
        const dbNow = clock.rows[0]!.db_now;
        const leaseToken = randomUUID();
        const leaseExpiresAt = new Date(dbNow.getTime() + leaseMs);
        await client.query(
          `UPDATE watch_runs AS wr
            SET slot_status = 'failed', failed_at = now(),
                lease_token = NULL, lease_expires_at = NULL,
                last_error = 'Watch became inactive before its slot could be retried'
           FROM watches AS w
          WHERE w.id = wr.watch_id AND w.user_id = wr.user_id
            AND w.status <> 'active'
            AND wr.slot_status IN ('pending', 'processing')
            AND wr.lease_expires_at <= now()`,
        );
        await client.query(
          `UPDATE watch_runs
            SET slot_status = 'failed',
                failed_at = now(),
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error = COALESCE(last_error, 'Watch slot lease expired repeatedly')
          WHERE slot_status = 'processing'
            AND lease_expires_at <= now()
            AND attempt_count >= $1`,
          [MAX_ATTEMPTS],
        );
        const retryable = await client.query<WatchRunRow>(
          `SELECT wr.*
           FROM watch_runs AS wr
           JOIN watches AS w ON w.id = wr.watch_id AND w.user_id = wr.user_id
          WHERE (
              (wr.slot_status = 'processing' AND wr.lease_expires_at <= now())
              OR (wr.slot_status = 'pending' AND wr.lease_expires_at <= now())
            )
            AND wr.attempt_count < $1
            AND w.status = 'active'
          ORDER BY wr.scheduled_for ASC, wr.id ASC
          LIMIT 1
          FOR UPDATE OF wr SKIP LOCKED`,
          [MAX_ATTEMPTS],
        );
        if (retryable.rows[0]) {
          try {
            specFromSnapshot(retryable.rows[0].watch_spec);
          } catch (error) {
            await client.query(
              `UPDATE watch_runs
                SET slot_status = 'failed', failed_at = now(),
                    lease_token = NULL, lease_expires_at = NULL, last_error = $2
              WHERE id = $1 AND slot_status IN ('pending', 'processing')`,
              [
                retryable.rows[0].id,
                `Invalid persisted Watch slot: ${error instanceof Error ? error.message : String(error)}`.slice(
                  0,
                  1000,
                ),
              ],
            );
            return "quarantined" as const;
          }
          const reclaimed = await client.query<WatchRunRow>(
            `UPDATE watch_runs
              SET slot_status = 'processing',
                  lease_token = $2,
                  lease_expires_at = $3,
                  attempt_count = attempt_count + 1,
                  last_error = NULL
            WHERE id = $1 AND slot_status IN ('pending', 'processing')
          RETURNING *`,
            [retryable.rows[0].id, leaseToken, leaseExpiresAt],
          );
          return toClaimed(reclaimed.rows[0]!);
        }

        const due = await client.query<DueWatchRow>(
          `SELECT w.*, u.timezone
           FROM watches AS w
           JOIN users AS u ON u.id = w.user_id
          WHERE w.status = 'active'
            AND w.next_run_at IS NOT NULL
            AND w.next_run_at <= $1
            AND NOT EXISTS (
              SELECT 1 FROM watch_runs AS outstanding
               WHERE outstanding.watch_id = w.id
                 AND outstanding.slot_status IN ('pending', 'processing')
            )
          ORDER BY w.next_run_at ASC, w.id ASC
          LIMIT 1
          FOR UPDATE OF w SKIP LOCKED`,
          [dbNow],
        );
        const watch = due.rows[0];
        if (!watch || !watch.next_run_at) return null;

        let spec: RoutineSpec;
        try {
          spec = specFromWatch(watch);
        } catch {
          await client.query(
            `UPDATE watches
              SET status = 'paused', next_run_at = NULL,
                  schedule_revision = $2, updated_at = now()
            WHERE id = $1 AND schedule_revision = $3`,
            [watch.id, randomUUID(), watch.schedule_revision],
          );
          return "quarantined" as const;
        }
        const cadenceFloor = new Date(
          dbNow.getTime() - defaultLookbackMs(spec.cadence),
        );
        const createdAt =
          watch.created_at instanceof Date ? watch.created_at : cadenceFloor;
        const firstRunStart = new Date(
          Math.max(cadenceFloor.getTime(), createdAt.getTime()),
        );
        const priorBoundary = watch.last_run_at ?? firstRunStart;
        const hardFloor = new Date(dbNow.getTime() - MAX_WINDOW_MS);
        const windowStart =
          priorBoundary < hardFloor ? hardFloor : priorBoundary;
        const windowEnd = dbNow;
        let nextRunAt: Date;
        try {
          nextRunAt = input.calculateNextRun(
            spec,
            dbNow,
            watch.timezone ?? "UTC",
          );
          if (Number.isNaN(nextRunAt.getTime()) || nextRunAt <= dbNow) {
            throw new Error(
              "next-run calculator did not return a valid future time",
            );
          }
        } catch (error) {
          await client.query(
            `INSERT INTO watch_runs
             (watch_id, user_id, ran_at, action, matched_count, summary, matched_refs,
              schedule_revision, scheduled_for, window_start, window_end, watch_spec,
              slot_status, attempt_count, failed_at, last_error)
           VALUES ($1, $2, $3, $4, 0, '', '[]'::JSONB,
                   $5, $6, $7, $8, $9, 'failed', 1, now(), $10)`,
            [
              watch.id,
              watch.user_id,
              dbNow,
              spec.action,
              watch.schedule_revision,
              watch.next_run_at,
              windowStart,
              windowEnd,
              JSON.stringify(spec),
              `Watch schedule quarantined: ${error instanceof Error ? error.message : String(error)}`.slice(
                0,
                1000,
              ),
            ],
          );
          await client.query(
            `UPDATE watches
              SET status = 'paused', next_run_at = NULL,
                  schedule_revision = $2, updated_at = now()
            WHERE id = $1 AND schedule_revision = $3`,
            [watch.id, randomUUID(), watch.schedule_revision],
          );
          return "quarantined" as const;
        }

        const inserted = await client.query<WatchRunRow>(
          `INSERT INTO watch_runs
           (watch_id, user_id, ran_at, action, matched_count, summary, matched_refs,
            schedule_revision, scheduled_for, window_start, window_end, watch_spec,
            slot_status, lease_token, lease_expires_at, attempt_count)
         VALUES ($1, $2, $3, $4, 0, '', '[]'::JSONB,
                 $5, $6, $7, $8, $9, 'processing', $10, $11, 1)
         RETURNING *`,
          [
            watch.id,
            watch.user_id,
            dbNow,
            spec.action,
            watch.schedule_revision,
            watch.next_run_at,
            windowStart,
            windowEnd,
            JSON.stringify(spec),
            leaseToken,
            leaseExpiresAt,
          ],
        );
        const advanced = await client.query<{ id: string }>(
          `UPDATE watches
            SET last_run_at = $3,
                next_run_at = $4,
                schedule_revision = $5,
                updated_at = now()
          WHERE id = $1 AND status = 'active' AND schedule_revision = $2
        RETURNING id`,
          [
            watch.id,
            watch.schedule_revision,
            windowEnd,
            nextRunAt,
            randomUUID(),
          ],
        );
        if (advanced.rows.length !== 1) {
          throw new Error(
            "Watch schedule changed while claiming its durable slot",
          );
        }
        return toClaimed(inserted.rows[0]!);
      });
      if (result === "quarantined") continue;
      return result;
    }
    return null;
  },

  /** Complete only the lease currently owned by this worker (fencing stale retries). */
  async completeSlot(input: CompleteWatchSlotInput): Promise<boolean> {
    const matchedCount = Number.isFinite(input.matchedCount)
      ? Math.max(0, Math.trunc(input.matchedCount))
      : 0;
    const matchedRefs = input.matchedRefs
      .filter((ref): ref is string => typeof ref === "string")
      .slice(0, MAX_STORED_REFS);
    const result = await query<{ id: string }>(
      `UPDATE watch_runs
          SET slot_status = 'completed', ran_at = now(), matched_count = $3,
              summary = $4, matched_refs = $5, completed_at = now(),
              lease_token = NULL, lease_expires_at = NULL, last_error = NULL
        WHERE id = $1 AND slot_status = 'processing' AND lease_token = $2
          AND lease_expires_at > now()
      RETURNING id`,
      [
        input.id,
        input.leaseToken,
        matchedCount,
        input.summary.slice(0, MAX_SUMMARY_LENGTH),
        JSON.stringify(matchedRefs),
      ],
    );
    return result.rows.length === 1;
  },

  /** Release a failed attempt for retry, or terminally fail it at the ceiling. */
  async failSlot(input: FailWatchSlotInput): Promise<FailWatchSlotResult> {
    if (
      !Number.isFinite(input.retryDelayMs) ||
      input.retryDelayMs < 1_000 ||
      input.retryDelayMs > MAX_RETRY_DELAY_MS
    ) {
      throw new TypeError(
        "Watch slot retry delay must be between one second and one day",
      );
    }
    const result = await query<{ slot_status: WatchSlotStatus }>(
      `UPDATE watch_runs
          SET slot_status = CASE WHEN attempt_count >= $4 THEN 'failed' ELSE 'pending' END,
              failed_at = CASE WHEN attempt_count >= $4 THEN now() ELSE NULL END,
              lease_token = NULL,
              lease_expires_at = CASE WHEN attempt_count >= $4 THEN NULL ELSE now() + ($3::INT * INTERVAL '1 millisecond') END,
              last_error = $5
        WHERE id = $1 AND slot_status = 'processing' AND lease_token = $2
          AND lease_expires_at > now()
      RETURNING slot_status`,
      [
        input.id,
        input.leaseToken,
        Math.trunc(input.retryDelayMs),
        MAX_ATTEMPTS,
        input.error.slice(0, 1000),
      ],
    );
    const status = result.rows[0]?.slot_status;
    if (!status) return "lost_lease";
    return status === "failed" ? "failed" : "retry_scheduled";
  },

  /** Bounded retention for internal zero-match audit slots; positive history is preserved. */
  async pruneZeroMatchSlots(
    retentionDays = DEFAULT_ZERO_MATCH_RETENTION_DAYS,
    limit = 100,
  ): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays < 1) {
      throw new TypeError("Watch slot retention must be at least one day");
    }
    const cappedLimit = Math.min(1_000, Math.max(1, Math.trunc(limit)));
    const result = await query<{ id: string }>(
      `DELETE FROM watch_runs
        WHERE id IN (
          SELECT id FROM watch_runs
           WHERE slot_status = 'completed'
             AND matched_count = 0
             AND completed_at < now() - ($1::INT * INTERVAL '1 day')
           ORDER BY completed_at ASC, id ASC
           LIMIT $2
        )
      RETURNING id`,
      [Math.trunc(retentionDays), cappedLimit],
    );
    return result.rows.length;
  },

  /** Positive completed results only; zero-match slots remain internal audit data. */
  async listForWatch(
    watchId: string,
    userId: string,
    limit = 20,
  ): Promise<WatchRunRow[]> {
    const result = await query<WatchRunRow>(
      `SELECT wr.* FROM watch_runs AS wr
         JOIN watches AS w ON w.id = wr.watch_id AND w.user_id = wr.user_id
        WHERE wr.watch_id = $1 AND w.user_id = $2
          AND wr.slot_status = 'completed' AND wr.matched_count > 0
        ORDER BY wr.ran_at DESC LIMIT $3`,
      [watchId, userId, limit],
    );
    return result.rows;
  },

  /** Positive completed results only; used by the user-facing briefing. */
  async listRecentForUser(
    userId: string,
    since: Date,
    limit = 50,
  ): Promise<WatchRunRow[]> {
    const result = await query<WatchRunRow>(
      `SELECT wr.* FROM watch_runs AS wr
         JOIN watches AS w ON w.id = wr.watch_id AND w.user_id = wr.user_id
        WHERE w.user_id = $1 AND wr.ran_at >= $2
          AND wr.slot_status = 'completed' AND wr.matched_count > 0
        ORDER BY wr.ran_at DESC LIMIT $3`,
      [userId, since, limit],
    );
    return result.rows;
  },
};
