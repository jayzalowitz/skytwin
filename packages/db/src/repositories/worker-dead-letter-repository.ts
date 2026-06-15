import { query } from '../connection.js';

/**
 * Status of a dead-letter row.
 *   'pending'   — awaiting operator action (default; surfaces in the admin list)
 *   'replayed'  — operator re-queued the job
 *   'discarded' — operator dismissed it as not worth replaying
 */
export type WorkerDeadLetterStatus = 'pending' | 'replayed' | 'discarded';

/** A single dead-lettered worker job. See migration 065 for rationale. */
export interface WorkerDeadLetterRow {
  id: string;
  job_name: string;
  error_message: string;
  attempts: number;
  /**
   * Arbitrary job input snapshot (e.g. `{ cadence: 'daily' }`,
   * `{ userId: '…' }`). `null` for jobs that take no input. Typed as
   * `unknown` rather than a concrete shape because the worker writes
   * heterogeneous job contexts here; consumers narrow at read time.
   */
  context: unknown;
  status: WorkerDeadLetterStatus;
  dead_lettered_at: Date;
  resolved_at: Date | null;
}

export interface RecordDeadLetterInput {
  jobName: string;
  errorMessage: string;
  /** Number of attempts that were made before dead-lettering. Defaults to 1. */
  attempts?: number;
  /** Optional JSON-serializable snapshot of the job's input. */
  context?: unknown;
}

/**
 * Dead-letter queue for worker background jobs (#407).
 *
 * The worker wraps each global background job in a retry counter
 * (`runWithDeadLetter` in apps/worker). After the job exceeds its
 * retry budget, the worker calls `record()` once with the final error
 * and the accumulated attempt count. An operator inspects the queue
 * via the admin API (`/api/admin/dead-letter`) and resolves each row
 * (`replayed` or `discarded`).
 *
 * NOT user-scoped — these are process-global jobs with no single owner
 * user. `context` may name a user when one applies, but the row's
 * identity is `(job_name, dead_lettered_at)`.
 */
export const workerDeadLetterRepository = {
  /**
   * Record a dead-lettered job. Returns the inserted row so the worker
   * can log its id. `context` is serialized to JSONB via the driver's
   * parameter binding (pass a plain object, not a pre-stringified blob)
   * — stringifying ourselves would double-encode it.
   */
  async record(input: RecordDeadLetterInput): Promise<WorkerDeadLetterRow> {
    const result = await query<WorkerDeadLetterRow>(
      `INSERT INTO worker_dead_letter (job_name, error_message, attempts, context)
       VALUES ($1, $2, $3, $4)
       RETURNING id, job_name, error_message, attempts, context,
                 status, dead_lettered_at, resolved_at`,
      [
        input.jobName,
        input.errorMessage,
        input.attempts ?? 1,
        input.context === undefined ? null : JSON.stringify(input.context),
      ],
    );
    // RETURNING always yields exactly one row for a single-row INSERT.
    return result.rows[0]!;
  },

  /**
   * List dead-letter rows, newest first. Defaults to only `pending`
   * rows (the operator's actionable queue). Pass `status: null` to
   * include resolved history, or a specific status to filter.
   * `jobName` narrows to a single job; `limit` caps the page (default
   * 100, hard-capped at 500 so a malformed query can't scan the world).
   */
  async list(opts: {
    status?: WorkerDeadLetterStatus | null;
    jobName?: string;
    limit?: number;
  } = {}): Promise<WorkerDeadLetterRow[]> {
    const status = opts.status === undefined ? 'pending' : opts.status;
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);

    const where: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (status !== null) {
      where.push(`status = $${i++}`);
      params.push(status);
    }
    if (opts.jobName) {
      where.push(`job_name = $${i++}`);
      params.push(opts.jobName);
    }
    params.push(limit);

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await query<WorkerDeadLetterRow>(
      `SELECT id, job_name, error_message, attempts, context,
              status, dead_lettered_at, resolved_at
         FROM worker_dead_letter
         ${whereClause}
        ORDER BY dead_lettered_at DESC
        LIMIT $${i}`,
      params,
    );
    return result.rows;
  },

  /** Fetch a single row by id, or null if it doesn't exist. */
  async findById(id: string): Promise<WorkerDeadLetterRow | null> {
    const result = await query<WorkerDeadLetterRow>(
      `SELECT id, job_name, error_message, attempts, context,
              status, dead_lettered_at, resolved_at
         FROM worker_dead_letter
        WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Mark a row resolved (`replayed` or `discarded`). Race-safe: only
   * transitions a row that is still `pending`, so two operators
   * clicking at once can't both "win". Returns the updated row, or
   * null if the row didn't exist or was already resolved.
   */
  async markResolved(
    id: string,
    status: Extract<WorkerDeadLetterStatus, 'replayed' | 'discarded'>,
  ): Promise<WorkerDeadLetterRow | null> {
    const result = await query<WorkerDeadLetterRow>(
      `UPDATE worker_dead_letter
          SET status = $2, resolved_at = now()
        WHERE id = $1 AND status = 'pending'
      RETURNING id, job_name, error_message, attempts, context,
                status, dead_lettered_at, resolved_at`,
      [id, status],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Count of pending rows — backs the admin badge. Cheap thanks to the
   * partial index `worker_dead_letter_pending_idx`.
   */
  async countPending(): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT count(*)::INT AS count FROM worker_dead_letter WHERE status = 'pending'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  },

  /**
   * Drop resolved rows older than the TTL window so the table doesn't
   * grow unbounded. Only `replayed` / `discarded` rows are purged —
   * `pending` rows are never deleted (they're the actionable queue).
   * Returns the number of rows removed.
   */
  async purgeResolvedOlderThan(ttlMs: number): Promise<number> {
    const result = await query(
      `DELETE FROM worker_dead_letter
        WHERE status IN ('replayed', 'discarded')
          AND resolved_at IS NOT NULL
          AND resolved_at <= now() - ($1::INTERVAL)`,
      [`${Math.max(1, Math.floor(ttlMs / 1000))} seconds`],
    );
    return result.rowCount ?? 0;
  },
};
