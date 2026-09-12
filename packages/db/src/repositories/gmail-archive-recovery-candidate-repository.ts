import { GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA } from '@skytwin/shared-types';
import { createHash } from 'node:crypto';
import { query } from '../connection.js';
import { GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS } from './gmail-archive-recovery-policy.js';

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 25;
const MAX_SWEEP_CANDIDATES = 100;
const CURSOR_PREFIX = 'gmail_archive_recovery_v3';
const MAX_CURSOR_LENGTH = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURSOR_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})(?:([0-9]{3}))?Z$/;

declare const gmailArchiveRecoveryCursorBrand: unique symbol;
export type GmailArchiveRecoveryCursor = string & {
  readonly [gmailArchiveRecoveryCursorBrand]: 'GmailArchiveRecoveryCursor';
};

export interface GmailArchiveRecoveryCandidate {
  readonly userId: string;
  readonly approvalId: string;
}

export interface ListGmailArchiveRecoveryCandidatesInput {
  readonly limit: number;
  /**
   * Opaque continuation returned by this trusted in-process scheduler port.
   * Never accept it from an HTTP/client boundary or treat it as recovery authority.
   */
  readonly cursor?: GmailArchiveRecoveryCursor;
}

export type ListGmailArchiveRecoveryCandidatesResult =
  | {
    ok: true;
    candidates: readonly Readonly<GmailArchiveRecoveryCandidate>[];
    /** Continue the current sweep, which is capped at 100 candidates. */
    nextCursor: GmailArchiveRecoveryCursor | null;
    /**
     * Persist this high-water mark for the next scheduled sweep when
     * `nextCursor` is null. Scheduling only; opacity is not confidentiality.
     */
    resumeCursor: GmailArchiveRecoveryCursor | null;
  }
  | { ok: false; error: 'invalid_input' | 'integrity_conflict' };

interface CandidateRow {
  user_id: string;
  approval_id: string;
  updated_at_text: string;
  rotation_upper_text: string;
}

interface CursorState {
  readonly updatedAt: string;
  readonly approvalId: string;
  readonly remaining: number;
  readonly rotationUpper: string;
}

interface CandidatePage {
  readonly candidates: readonly Readonly<GmailArchiveRecoveryCandidate>[];
  readonly lastKey: Readonly<Pick<CursorState, 'updatedAt' | 'approvalId'>> | null;
  readonly rotationUpper: string | null;
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
  const input = ownData(value, ['limit']) ?? ownData(value, ['cursor', 'limit']);
  if (!input || !Number.isSafeInteger(input['limit']) ||
      (input['limit'] as number) < 1 ||
      (input['limit'] as number) > MAX_PAGE_LIMIT) return null;
  if (Object.prototype.hasOwnProperty.call(input, 'cursor') &&
      typeof input['cursor'] !== 'string') return null;
  return Object.freeze({
    limit: input['limit'] as number,
    ...(typeof input['cursor'] === 'string'
      ? { cursor: input['cursor'] as GmailArchiveRecoveryCursor }
      : {}),
  });
}

function validCursorTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = CURSOR_TIMESTAMP.exec(value);
  if (!match || match[2] === '000') return false;
  const millisecondForm = `${match[1]}Z`;
  try {
    return new Date(millisecondForm).toISOString() === millisecondForm;
  } catch {
    return false;
  }
}

function canonicalDbTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  const microseconds = (match[3] ?? '').padEnd(6, '0');
  const fraction = microseconds.slice(3) === '000'
    ? microseconds.slice(0, 3)
    : microseconds;
  const canonical = `${match[1]}T${match[2]}.${fraction}Z`;
  return validCursorTimestamp(canonical) ? canonical : null;
}

function cursorChecksum(encodedPayload: string): string {
  return createHash('sha256')
    .update(`${CURSOR_PREFIX}.${encodedPayload}`, 'utf8')
    .digest('base64url');
}

// The checksum rejects accidental corruption and noncanonical encodings. It is
// forgeable by design, not a secret/authentication tag. This cursor is confined
// to a trusted in-process scheduler port and grants no recovery authority.
function encodeCursor(state: CursorState): GmailArchiveRecoveryCursor {
  const payload = JSON.stringify([
    state.updatedAt,
    state.approvalId,
    state.remaining,
    state.rotationUpper,
  ]);
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url');
  return `${CURSOR_PREFIX}.${encodedPayload}.${cursorChecksum(encodedPayload)}` as
    GmailArchiveRecoveryCursor;
}

function comparableCursorTimestamp(value: string): string {
  return value.length === 24 ? `${value.slice(0, -1)}000Z` : value;
}

function parseCursor(value: unknown): Readonly<CursorState> | null {
  if (typeof value !== 'string' || value.length > MAX_CURSOR_LENGTH) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX ||
      !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? '')) return null;
  const encodedPayload = parts[1]!;
  if (parts[2] !== cursorChecksum(encodedPayload)) return null;
  try {
    const decoded = Buffer.from(encodedPayload, 'base64url');
    if (decoded.toString('base64url') !== encodedPayload) return null;
    const payload = JSON.parse(decoded.toString('utf8')) as unknown;
    if (!Array.isArray(payload) || payload.length !== 4 ||
        Object.getPrototypeOf(payload) !== Array.prototype ||
        !validCursorTimestamp(payload[0]) ||
        typeof payload[1] !== 'string' || !UUID.test(payload[1]) ||
        !Number.isSafeInteger(payload[2]) || (payload[2] as number) < 1 ||
        (payload[2] as number) > MAX_SWEEP_CANDIDATES ||
        !validCursorTimestamp(payload[3]) ||
        comparableCursorTimestamp(payload[0]) > comparableCursorTimestamp(payload[3])) return null;
    const state = Object.freeze({
      updatedAt: payload[0],
      approvalId: payload[1],
      remaining: payload[2] as number,
      rotationUpper: payload[3],
    });
    return encodeCursor(state) === value ? state : null;
  } catch {
    return null;
  }
}

function compareKey(
  left: Readonly<Pick<CursorState, 'updatedAt' | 'approvalId'>>,
  right: Readonly<Pick<CursorState, 'updatedAt' | 'approvalId'>>,
): number {
  const leftInstant = comparableCursorTimestamp(left.updatedAt);
  const rightInstant = comparableCursorTimestamp(right.updatedAt);
  if (leftInstant !== rightInstant) return leftInstant < rightInstant ? -1 : 1;
  if (left.approvalId === right.approvalId) return 0;
  return left.approvalId < right.approvalId ? -1 : 1;
}

function snapshotPage(
  rows: unknown,
  limit: number = MAX_PAGE_LIMIT,
  after: Readonly<Pick<CursorState, 'updatedAt' | 'approvalId'>> | null = null,
  expectedRotationUpper: string | null = null,
): Readonly<CandidatePage> | null {
  if (!Array.isArray(rows) || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > MAX_PAGE_LIMIT || rows.length > limit) return null;
  const candidates: Readonly<GmailArchiveRecoveryCandidate>[] = [];
  const seen = new Set<string>();
  let previous = after;
  let rotationUpper = expectedRotationUpper;
  for (const value of rows) {
    const row = ownData(value, [
      'approval_id', 'rotation_upper_text', 'updated_at_text', 'user_id',
    ]);
    const userId = row?.['user_id'];
    const approvalId = row?.['approval_id'];
    const updatedAt = canonicalDbTimestamp(row?.['updated_at_text']);
    const rowRotationUpper = canonicalDbTimestamp(row?.['rotation_upper_text']);
    if (typeof userId !== 'string' || !UUID.test(userId) ||
        typeof approvalId !== 'string' || !UUID.test(approvalId) ||
        !updatedAt || !rowRotationUpper ||
        comparableCursorTimestamp(updatedAt) > comparableCursorTimestamp(rowRotationUpper) ||
        (rotationUpper !== null && rowRotationUpper !== rotationUpper)) return null;
    rotationUpper = rowRotationUpper;
    const key = Object.freeze({ updatedAt, approvalId });
    if (previous && compareKey(previous, key) >= 0) return null;
    const identity = `${userId}:${approvalId}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    candidates.push(Object.freeze({ userId, approvalId }));
    previous = key;
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    lastKey: previous === after ? null : previous,
    rotationUpper,
  });
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
  const cursor = input.cursor === undefined ? null : parseCursor(input.cursor);
  if (input.cursor !== undefined && !cursor) {
    return Object.freeze({ ok: false, error: 'invalid_input' });
  }
  const remaining = cursor?.remaining ?? MAX_SWEEP_CANDIDATES;
  const pageLimit = Math.min(input.limit, remaining);
  const result = await queryFn(
    `SELECT barrier.user_id::STRING AS user_id,
            approval.id::STRING AS approval_id,
            (barrier.updated_at AT TIME ZONE 'UTC')::STRING AS updated_at_text,
            (COALESCE($6::TIMESTAMPTZ, statement_timestamp())
              AT TIME ZONE 'UTC')::STRING AS rotation_upper_text
       FROM pre_effect_barriers@{
              FORCE_INDEX=pre_effect_barriers_gmail_archive_recovery_scan_idx
            } AS barrier
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
        AND ($3::BOOL = false OR
             (barrier.updated_at, barrier.idempotency_key) > ($4::TIMESTAMPTZ, $5::STRING))
        AND barrier.updated_at <= COALESCE($6::TIMESTAMPTZ, statement_timestamp())
      ORDER BY barrier.updated_at ASC, barrier.idempotency_key ASC
      LIMIT $7`,
    [
      GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
      GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS,
      cursor !== null,
      cursor?.updatedAt ?? null,
      cursor?.approvalId ?? null,
      cursor?.rotationUpper ?? null,
      pageLimit,
    ],
  );
  const page = snapshotPage(result.rows, pageLimit, cursor, cursor?.rotationUpper ?? null);
  if (!page) return Object.freeze({ ok: false, error: 'integrity_conflict' });
  const remainingAfterPage = remaining - page.candidates.length;
  const nextCursor = page.lastKey && page.rotationUpper &&
      page.candidates.length === pageLimit &&
      remainingAfterPage > 0
    ? encodeCursor({
      ...page.lastKey,
      remaining: remainingAfterPage,
      rotationUpper: page.rotationUpper,
    })
    : null;
  // Retain the latest key and the rotation's DB-clock upper bound for the next
  // scheduled sweep. Resetting only the embedded budget preserves the per-call
  // cap while the finite upper bound guarantees eventual wrap to older hints
  // that were temporarily hidden by a live lease.
  const resumeCursor = page.lastKey && page.rotationUpper &&
      page.candidates.length === pageLimit
    ? encodeCursor({
      ...page.lastKey,
      remaining: MAX_SWEEP_CANDIDATES,
      rotationUpper: page.rotationUpper,
    })
    : null;
  return Object.freeze({
    ok: true,
    candidates: page.candidates,
    nextCursor,
    resumeCursor,
  });
}

export const gmailArchiveRecoveryCandidateTestHooks = Object.freeze({
  defaultPageLimit: DEFAULT_PAGE_LIMIT,
  encodeCursor,
  listWithQuery,
  maxPageLimit: MAX_PAGE_LIMIT,
  maxSweepCandidates: MAX_SWEEP_CANDIDATES,
  parseCursor,
  snapshotInput,
  snapshotPage,
});

export const gmailArchiveRecoveryCandidateRepository = Object.freeze({
  list(input: ListGmailArchiveRecoveryCandidatesInput) {
    return listWithQuery(input);
  },
});
