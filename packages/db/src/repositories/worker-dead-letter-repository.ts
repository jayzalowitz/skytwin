import { query } from '../connection.js';

export const WORKER_DEAD_LETTER_JOB_CODES = [
  'metrics-rollup',
  'changelog-poll',
  'domain-extraction',
  'capability-inference',
  'watch-scheduler',
  'federation-sync',
  'embedding-backfill',
  'tier-backfill',
  'relationship-tier-backfill',
  'memory-action-loop',
  'briefing-generator-daily',
  'briefing-generator-weekly',
  'promotion-eligibility-check',
  'legacy-redacted',
] as const;

export const WORKER_DEAD_LETTER_ERROR_CODES = [
  'job-failed',
  'legacy-redacted',
] as const;

export type WorkerDeadLetterJobCode =
  (typeof WORKER_DEAD_LETTER_JOB_CODES)[number];
export type WorkerDeadLetterErrorCode =
  (typeof WORKER_DEAD_LETTER_ERROR_CODES)[number];
export type WorkerDeadLetterStatus = 'pending' | 'replayed' | 'discarded';

const JOB_CODES: ReadonlySet<string> = new Set(WORKER_DEAD_LETTER_JOB_CODES);
const ACTIVE_JOB_CODES: ReadonlySet<string> = new Set(
  WORKER_DEAD_LETTER_JOB_CODES.filter((code) => code !== 'legacy-redacted'),
);
const ACTIVE_ERROR_CODES: ReadonlySet<string> = new Set(
  WORKER_DEAD_LETTER_ERROR_CODES.filter((code) => code !== 'legacy-redacted'),
);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_KEYS = new Set([
  'jobCode',
  'errorCode',
  'attempts',
  'correlationId',
]);

export interface WorkerDeadLetterRow {
  id: string;
  correlation_id: string;
  job_code: WorkerDeadLetterJobCode;
  error_code: WorkerDeadLetterErrorCode;
  attempts: number;
  status: WorkerDeadLetterStatus;
  dead_lettered_at: Date;
  resolved_at: Date | null;
}

/** Content-free input only. Source-bearing diagnostics have no repository type. */
export interface RecordDeadLetterInput {
  jobCode: Exclude<WorkerDeadLetterJobCode, 'legacy-redacted'>;
  errorCode: Exclude<WorkerDeadLetterErrorCode, 'legacy-redacted'>;
  attempts: number;
  correlationId: string;
  errorMessage?: never;
  context?: never;
  jobName?: never;
}

export function isWorkerDeadLetterJobCode(
  value: unknown,
): value is WorkerDeadLetterJobCode {
  return typeof value === 'string' && JOB_CODES.has(value);
}

function assertRecordInput(input: RecordDeadLetterInput): void {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some((key) => !RECORD_KEYS.has(key)) ||
    !ACTIVE_JOB_CODES.has(input.jobCode) ||
    !ACTIVE_ERROR_CODES.has(input.errorCode) ||
    !Number.isSafeInteger(input.attempts) ||
    input.attempts < 1 ||
    input.attempts > 1_000_000 ||
    !UUID_PATTERN.test(input.correlationId)
  ) {
    throw new Error('Invalid content-free worker dead-letter record');
  }
}

const RETURNING_COLUMNS = `id, correlation_id, job_code, error_code, attempts,
                            status, dead_lettered_at, resolved_at`;

export const workerDeadLetterRepository = {
  async record(input: RecordDeadLetterInput): Promise<WorkerDeadLetterRow> {
    assertRecordInput(input);
    const result = await query<WorkerDeadLetterRow>(
      `INSERT INTO worker_dead_letter (job_code, error_code, attempts, correlation_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${RETURNING_COLUMNS}`,
      [input.jobCode, input.errorCode, input.attempts, input.correlationId],
    );
    return result.rows[0]!;
  },

  async list(
    opts: {
      status?: WorkerDeadLetterStatus | null;
      jobCode?: WorkerDeadLetterJobCode;
      limit?: number;
    } = {},
  ): Promise<WorkerDeadLetterRow[]> {
    const status = opts.status === undefined ? 'pending' : opts.status;
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);

    const where: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (status !== null) {
      where.push(`status = $${i++}`);
      params.push(status);
    }
    if (opts.jobCode) {
      if (!isWorkerDeadLetterJobCode(opts.jobCode)) {
        throw new Error('Invalid worker dead-letter job code');
      }
      where.push(`job_code = $${i++}`);
      params.push(opts.jobCode);
    }
    params.push(limit);

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await query<WorkerDeadLetterRow>(
      `SELECT ${RETURNING_COLUMNS}
         FROM worker_dead_letter
         ${whereClause}
        ORDER BY dead_lettered_at DESC
        LIMIT $${i}`,
      params,
    );
    return result.rows;
  },

  async findById(id: string): Promise<WorkerDeadLetterRow | null> {
    const result = await query<WorkerDeadLetterRow>(
      `SELECT ${RETURNING_COLUMNS}
         FROM worker_dead_letter
        WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  async markResolved(
    id: string,
    status: Extract<WorkerDeadLetterStatus, 'replayed' | 'discarded'>,
  ): Promise<WorkerDeadLetterRow | null> {
    const result = await query<WorkerDeadLetterRow>(
      `UPDATE worker_dead_letter
          SET status = $2, resolved_at = now()
        WHERE id = $1 AND status = 'pending'
      RETURNING ${RETURNING_COLUMNS}`,
      [id, status],
    );
    return result.rows[0] ?? null;
  },

  async countPending(): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT count(*)::INT AS count FROM worker_dead_letter WHERE status = 'pending'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  },

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
