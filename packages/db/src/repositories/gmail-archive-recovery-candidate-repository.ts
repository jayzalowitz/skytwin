import { GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA } from '@skytwin/shared-types';
import { query } from '../connection.js';
import { GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS } from './gmail-archive-recovery-policy.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface GmailArchiveRecoveryCandidate {
  readonly userId: string;
  readonly approvalId: string;
}

export interface ListGmailArchiveRecoveryCandidatesInput {
  readonly limit: number;
}

export type ListGmailArchiveRecoveryCandidatesResult =
  | { ok: true; candidates: readonly Readonly<GmailArchiveRecoveryCandidate>[] }
  | { ok: false; error: 'invalid_input' | 'integrity_conflict' };

interface CandidateRow {
  user_id: string;
  approval_id: string;
}

type QueryCandidates = (
  text: string,
  params: unknown[],
) => Promise<{ rows: CandidateRow[] }>;

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors).sort();
    const expected = [...keys].sort();
    if (names.length !== expected.length ||
        names.some((name, index) => name !== expected[index])) return null;
    const snapshot: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      snapshot[name] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotInput(value: unknown): Readonly<ListGmailArchiveRecoveryCandidatesInput> | null {
  const input = ownData(value, ['limit']);
  if (!input || !Number.isSafeInteger(input['limit']) ||
      (input['limit'] as number) < 1 || (input['limit'] as number) > MAX_LIMIT) return null;
  return Object.freeze({ limit: input['limit'] as number });
}

function snapshotRows(
  rows: unknown,
  limit: number = MAX_LIMIT,
): readonly Readonly<GmailArchiveRecoveryCandidate>[] | null {
  if (!Array.isArray(rows) || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > MAX_LIMIT || rows.length > limit) return null;
  const candidates: Readonly<GmailArchiveRecoveryCandidate>[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    const row = ownData(value, ['approval_id', 'user_id']);
    const userId = row?.['user_id'];
    const approvalId = row?.['approval_id'];
    if (typeof userId !== 'string' || !UUID.test(userId) ||
        typeof approvalId !== 'string' || !UUID.test(approvalId)) return null;
    const identity = `${userId}:${approvalId}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    candidates.push(Object.freeze({ userId, approvalId }));
  }
  return Object.freeze(candidates);
}

/**
 * Discovery returns scheduling hints only. The query deliberately filters out
 * a currently-live lease so an old busy row cannot occupy every bounded scan;
 * lease acquisition still revalidates the complete graph, DB clock, and stage
 * before returning any recovery capability.
 */
async function listWithQuery(
  submitted: ListGmailArchiveRecoveryCandidatesInput,
  queryFn: QueryCandidates = query,
): Promise<ListGmailArchiveRecoveryCandidatesResult> {
  const input = snapshotInput(submitted);
  if (!input) return Object.freeze({ ok: false, error: 'invalid_input' });
  const result = await queryFn(
    `SELECT barrier.user_id::STRING AS user_id,
            approval.id::STRING AS approval_id
       FROM pre_effect_barriers AS barrier
       JOIN approval_requests AS approval
         ON approval.id::STRING = barrier.idempotency_key
        AND approval.user_id = barrier.user_id
        AND approval.status = 'approved'
        AND approval.responded_at IS NOT NULL
        AND approval.response->>'action' = 'approve'
       JOIN decisions AS decision
         ON decision.id = approval.decision_id
        AND decision.user_id = approval.user_id
       JOIN decision_outcomes AS outcome
         ON outcome.decision_id = decision.id
        AND outcome.selected_action_id IS NOT NULL
        AND outcome.auto_executed = false
        AND outcome.requires_approval = true
       JOIN candidate_actions AS candidate
         ON candidate.id = outcome.selected_action_id
        AND candidate.decision_id = decision.id
        AND candidate.action_type = 'archive_email'
        AND candidate.parameters->>'schema' = $1
       LEFT JOIN gmail_archive_recovery_leases AS lease
         ON lease.admission_id = barrier.id
        AND lease.user_id = barrier.user_id
      WHERE barrier.effect_type = 'event_execution'
        AND barrier.status IN ('reserved', 'prepared', 'in_progress')
        AND approval.candidate_action->>'actionType' = 'archive_email'
        AND approval.candidate_action->'parameters'->>'schema' = $1
        AND (CASE WHEN barrier.status = 'reserved'
                  THEN barrier.created_at ELSE barrier.updated_at END)
              + ($2::INT * INTERVAL '1 second') <= statement_timestamp()
        AND (lease.admission_id IS NULL OR
             CASE WHEN lease.observation_state = 'started'
                  THEN lease.observation_deadline_at <= statement_timestamp()
                  ELSE lease.expires_at <= statement_timestamp() END)
      ORDER BY barrier.updated_at ASC, barrier.id ASC
      LIMIT $3`,
    [
      GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
      GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS,
      input.limit,
    ],
  );
  const candidates = snapshotRows(result.rows, input.limit);
  return candidates
    ? Object.freeze({ ok: true, candidates })
    : Object.freeze({ ok: false, error: 'integrity_conflict' });
}

export const gmailArchiveRecoveryCandidateTestHooks = Object.freeze({
  defaultLimit: DEFAULT_LIMIT,
  listWithQuery,
  maxLimit: MAX_LIMIT,
  snapshotInput,
  snapshotRows,
});

export const gmailArchiveRecoveryCandidateRepository = Object.freeze({
  list(input: ListGmailArchiveRecoveryCandidatesInput) {
    return listWithQuery(input);
  },
});
