import type {
  GmailArchiveAttemptPhase,
  GmailArchiveRecoveryLeaseFence,
  GmailArchiveRecoveryObservationEvidence,
  GmailArchiveRecoveryObservationPermit,
  GmailArchiveRecoveryWorkKind,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS } from './gmail-archive-recovery-policy.js';
import { exactTimestampEpochMicroseconds } from './gmail-archive-recovery-time.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBSERVATION_EVIDENCE_SCHEMA = 'gmail_archive_recovery_observation_v1';

interface RecoveryLeaseConsumptionRow {
  admission_id: string;
  user_id: string;
  approval_id: string;
  message_ref_id: string;
  work_kind: GmailArchiveRecoveryWorkKind;
  barrier_status: 'reserved' | 'prepared' | 'in_progress';
  attempt_phase: GmailArchiveAttemptPhase | null;
  phase_changed_at_text: string;
  lease_token: string;
  generation: string;
  observation_state: 'not_started' | 'started' | 'evidence_recorded';
  observation_attempt_id: string | null;
  observation_authorized_at: Date | null;
  observation_deadline_at: Date | null;
  observation_evidence: unknown;
}

interface GmailArchiveTerminalLeaseLineage {
  userId: string;
  approvalId: string;
  admissionId: string;
  messageRefId: string;
}

type RetireGmailArchiveRecoveryLeaseForTerminalResult =
  | { ok: true; retired: boolean }
  | { ok: false; error: 'integrity_conflict' };

export interface ConsumeGmailArchiveRecoveryLeaseInput {
  fence: GmailArchiveRecoveryLeaseFence;
  observationAttemptId: string | null;
  evidence: GmailArchiveRecoveryObservationEvidence | null;
}

export type ConsumeGmailArchiveRecoveryLeaseResult =
  | { ok: true; evidence: Readonly<GmailArchiveRecoveryObservationEvidence> | null }
  | {
      ok: false;
      error: 'invalid_input' | 'stale_lease' | 'not_ready' | 'evidence_conflict' |
        'integrity_conflict';
    };

export type ConsumeRecordedGmailArchiveObservationResult =
  | { ok: true; evidence: Readonly<GmailArchiveRecoveryObservationEvidence> }
  | {
      ok: false;
      error: 'invalid_input' | 'stale_lease' | 'not_ready' | 'integrity_conflict';
    };

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

function validPhaseTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})(?:\d{3})?Z$/.exec(value);
  if (!match) return false;
  const millisecondForm = `${match[1]}Z`;
  try {
    return new Date(millisecondForm).toISOString() === millisecondForm;
  } catch {
    return false;
  }
}

function canonicalDbPhaseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  const microseconds = (match[3] ?? '').padEnd(6, '0');
  const fraction = microseconds.slice(3) === '000' ? microseconds.slice(0, 3) : microseconds;
  const canonical = `${match[1]}T${match[2]}.${fraction}Z`;
  return validPhaseTimestamp(canonical) ? canonical : null;
}

function validExternalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

const FENCE_KEYS = [
  'admissionId', 'approvalId', 'attemptPhase', 'barrierStatus', 'generation',
  'leaseToken', 'messageRefId', 'phaseChangedAt', 'userId', 'workKind',
] as const;

export function snapshotGmailArchiveRecoveryLeaseFence(
  value: unknown,
): Readonly<GmailArchiveRecoveryLeaseFence> | null {
  const fence = ownData(value, FENCE_KEYS);
  if (!fence || typeof fence['userId'] !== 'string' || !UUID.test(fence['userId']) ||
      typeof fence['approvalId'] !== 'string' || !UUID.test(fence['approvalId']) ||
      typeof fence['admissionId'] !== 'string' || !UUID.test(fence['admissionId']) ||
      typeof fence['messageRefId'] !== 'string' || !UUID.test(fence['messageRefId']) ||
      typeof fence['leaseToken'] !== 'string' || !UUID.test(fence['leaseToken']) ||
      !Number.isSafeInteger(fence['generation']) || (fence['generation'] as number) < 1 ||
      !validPhaseTimestamp(fence['phaseChangedAt'])) return null;
  const workKind = fence['workKind'];
  const barrierStatus = fence['barrierStatus'];
  const attemptPhase = fence['attemptPhase'];
  const validStage =
    (workKind === 'resume_preparation' && barrierStatus === 'reserved' && attemptPhase === null) ||
    (workKind === 'resume_claim' && barrierStatus === 'prepared' && attemptPhase === null) ||
    (workKind === 'reconcile_pre_dispatch' && barrierStatus === 'in_progress' &&
      attemptPhase === 'pre_dispatch') ||
    (workKind === 'observe_dispatch' && barrierStatus === 'in_progress' &&
      attemptPhase === 'dispatch_may_have_started');
  if (!validStage) return null;
  return Object.freeze({
    userId: fence['userId'],
    approvalId: fence['approvalId'],
    admissionId: fence['admissionId'],
    messageRefId: fence['messageRefId'],
    workKind,
    barrierStatus,
    attemptPhase,
    phaseChangedAt: fence['phaseChangedAt'],
    leaseToken: fence['leaseToken'],
    generation: fence['generation'] as number,
  });
}

function snapshotObservationPermit(
  value: unknown,
): Readonly<GmailArchiveRecoveryObservationPermit> | null {
  const permit = ownData(value, [
    ...FENCE_KEYS, 'authorizedAt', 'deadlineAt', 'leaseExpiresAt', 'observationAttemptId',
  ]);
  if (!permit) return null;
  const fenceInput: Record<string, unknown> = {};
  for (const key of FENCE_KEYS) fenceInput[key] = permit[key];
  const fence = snapshotGmailArchiveRecoveryLeaseFence(fenceInput);
  if (!fence || fence.workKind !== 'observe_dispatch' ||
      typeof permit['observationAttemptId'] !== 'string' ||
      !UUID.test(permit['observationAttemptId']) ||
      !validExternalTimestamp(permit['authorizedAt']) ||
      !validExternalTimestamp(permit['deadlineAt']) ||
      !validExternalTimestamp(permit['leaseExpiresAt'])) return null;
  const authorizedAt = exactTimestampEpochMicroseconds(permit['authorizedAt']);
  const deadlineAt = exactTimestampEpochMicroseconds(permit['deadlineAt']);
  const leaseExpiresAt = exactTimestampEpochMicroseconds(permit['leaseExpiresAt']);
  const phaseChangedAt = exactTimestampEpochMicroseconds(fence.phaseChangedAt);
  if (authorizedAt === null || deadlineAt === null || leaseExpiresAt === null ||
      phaseChangedAt === null || authorizedAt < phaseChangedAt ||
      authorizedAt >= leaseExpiresAt || deadlineAt - authorizedAt !==
        BigInt(GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS) * 1_000_000n) return null;
  return Object.freeze({
    ...fence,
    observationAttemptId: permit['observationAttemptId'],
    authorizedAt: permit['authorizedAt'],
    leaseExpiresAt: permit['leaseExpiresAt'],
    deadlineAt: permit['deadlineAt'],
  });
}

function snapshotBinding(value: unknown): Readonly<{
  userId: string;
  admissionId: string;
  messageRefId: string;
}> | null {
  const binding = ownData(value, ['admissionId', 'messageRefId', 'userId']);
  if (!binding || typeof binding['userId'] !== 'string' || !UUID.test(binding['userId']) ||
      typeof binding['admissionId'] !== 'string' || !UUID.test(binding['admissionId']) ||
      typeof binding['messageRefId'] !== 'string' || !UUID.test(binding['messageRefId'])) return null;
  return Object.freeze({
    userId: binding['userId'],
    admissionId: binding['admissionId'],
    messageRefId: binding['messageRefId'],
  });
}

function snapshotEvidence(
  value: unknown,
): Readonly<GmailArchiveRecoveryObservationEvidence> | null {
  const observed = ownData(value, ['binding', 'inbox', 'kind', 'observedAt']);
  if (observed?.['kind'] === 'mailbox_observed') {
    const binding = snapshotBinding(observed['binding']);
    if (!binding || typeof observed['inbox'] !== 'boolean' ||
        !validExternalTimestamp(observed['observedAt'])) return null;
    return Object.freeze({
      kind: 'mailbox_observed',
      binding,
      inbox: observed['inbox'],
      observedAt: observed['observedAt'],
    });
  }
  const unavailable = ownData(value, ['binding', 'code', 'kind']);
  const codes = [
    'not_observable', 'authority_unavailable', 'credentials_unavailable',
    'observation_rejected', 'observation_unavailable',
  ];
  const binding = unavailable ? snapshotBinding(unavailable['binding']) : null;
  if (unavailable?.['kind'] !== 'mailbox_observation_unavailable' || !binding ||
      typeof unavailable['code'] !== 'string' || !codes.includes(unavailable['code'])) return null;
  return Object.freeze({
    kind: 'mailbox_observation_unavailable',
    binding,
    code: unavailable['code'] as Extract<GmailArchiveRecoveryObservationEvidence, {
      kind: 'mailbox_observation_unavailable';
    }>['code'],
  });
}

/** Narrow deep-import seams for parser parity regression tests. */
export const gmailArchiveRecoveryLeaseConsumerTestHooks = {
  snapshotEvidence,
  snapshotFence: snapshotGmailArchiveRecoveryLeaseFence,
  snapshotPermit: snapshotObservationPermit,
};

function evidenceEnvelope(evidence: Readonly<GmailArchiveRecoveryObservationEvidence>) {
  return Object.freeze({ schema: OBSERVATION_EVIDENCE_SCHEMA, evidence });
}

function parseEvidenceEnvelope(value: unknown): Readonly<GmailArchiveRecoveryObservationEvidence> | null {
  const envelope = ownData(value, ['evidence', 'schema']);
  return envelope?.['schema'] === OBSERVATION_EVIDENCE_SCHEMA
    ? snapshotEvidence(envelope['evidence'])
    : null;
}

function sameEvidence(
  left: Readonly<GmailArchiveRecoveryObservationEvidence>,
  right: Readonly<GmailArchiveRecoveryObservationEvidence>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordedObservationEvidenceFromRow(
  row: RecoveryLeaseConsumptionRow,
  fence: GmailArchiveRecoveryLeaseFence,
): Readonly<GmailArchiveRecoveryObservationEvidence> | null {
  if (row.observation_state !== 'evidence_recorded' ||
      typeof row.observation_attempt_id !== 'string' ||
      !UUID.test(row.observation_attempt_id) || !row.observation_authorized_at ||
      !row.observation_deadline_at) return null;
  const retained = parseEvidenceEnvelope(row.observation_evidence);
  const phaseChangedAtMicros = exactTimestampEpochMicroseconds(fence.phaseChangedAt);
  const authorizedAtMicros = exactTimestampEpochMicroseconds(row.observation_authorized_at);
  const deadlineAtMicros = exactTimestampEpochMicroseconds(row.observation_deadline_at);
  if (phaseChangedAtMicros === null || authorizedAtMicros === null || deadlineAtMicros === null ||
      authorizedAtMicros < phaseChangedAtMicros || deadlineAtMicros - authorizedAtMicros !==
        BigInt(GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS) * 1_000_000n ||
      !retained || retained.binding.userId !== fence.userId ||
      retained.binding.admissionId !== fence.admissionId ||
      retained.binding.messageRefId !== fence.messageRefId) return null;
  if (retained.kind === 'mailbox_observed') {
    const observedAtMicros = exactTimestampEpochMicroseconds(retained.observedAt);
    if (observedAtMicros === null || observedAtMicros < authorizedAtMicros ||
        observedAtMicros < phaseChangedAtMicros || observedAtMicros > deadlineAtMicros) return null;
  }
  return retained;
}

function exactRowFence(
  row: RecoveryLeaseConsumptionRow,
  fence: GmailArchiveRecoveryLeaseFence,
): boolean {
  return row.user_id === fence.userId && row.approval_id === fence.approvalId &&
    row.admission_id === fence.admissionId && row.message_ref_id === fence.messageRefId &&
    row.work_kind === fence.workKind && row.barrier_status === fence.barrierStatus &&
    row.attempt_phase === fence.attemptPhase &&
    canonicalDbPhaseTimestamp(row.phase_changed_at_text) === fence.phaseChangedAt &&
    row.lease_token === fence.leaseToken && Number(row.generation) === fence.generation;
}

function snapshotConsumeInput(
  value: unknown,
): Readonly<ConsumeGmailArchiveRecoveryLeaseInput> | null {
  const input = ownData(value, ['evidence', 'fence', 'observationAttemptId']);
  if (!input) return null;
  const fence = snapshotGmailArchiveRecoveryLeaseFence(input['fence']);
  const attemptId = input['observationAttemptId'];
  const evidence = input['evidence'] === null ? null : snapshotEvidence(input['evidence']);
  const preDispatch = fence?.workKind === 'reconcile_pre_dispatch' &&
    fence.barrierStatus === 'in_progress' && fence.attemptPhase === 'pre_dispatch';
  const observeDispatch = fence?.workKind === 'observe_dispatch' &&
    fence.barrierStatus === 'in_progress' &&
    fence.attemptPhase === 'dispatch_may_have_started';
  if (!fence || (preDispatch
    ? attemptId !== null || evidence !== null
    : !observeDispatch || typeof attemptId !== 'string' || !UUID.test(attemptId) || !evidence)) {
    return null;
  }
  return Object.freeze({
    fence,
    observationAttemptId: attemptId as string | null,
    evidence,
  });
}

/** Consume one exact recovery generation after its matching barrier is locked. */
export async function consumeGmailArchiveRecoveryLeaseInTransaction(
  client: PoolClient,
  submitted: ConsumeGmailArchiveRecoveryLeaseInput,
): Promise<ConsumeGmailArchiveRecoveryLeaseResult> {
  const input = snapshotConsumeInput(submitted);
  if (!input) return { ok: false, error: 'invalid_input' };
  const { fence, evidence } = input;
  const attemptId = input.observationAttemptId;
  const preDispatch = fence?.workKind === 'reconcile_pre_dispatch' &&
    fence.barrierStatus === 'in_progress' && fence.attemptPhase === 'pre_dispatch';

  const rows = (await client.query<RecoveryLeaseConsumptionRow>(
    `SELECT lease.*,
            (lease.phase_changed_at AT TIME ZONE 'UTC')::STRING AS phase_changed_at_text
       FROM gmail_archive_recovery_leases AS lease
      WHERE admission_id = $1 AND user_id = $2
      FOR UPDATE`,
    [fence.admissionId, fence.userId],
  )).rows;
  if (rows.length === 0) return { ok: false, error: 'stale_lease' };
  if (rows.length !== 1) return { ok: false, error: 'integrity_conflict' };
  const row = rows[0]!;
  if (!exactRowFence(row, fence)) return { ok: false, error: 'stale_lease' };
  if (!Number.isSafeInteger(Number(row.generation)) || Number(row.generation) < 1) {
    return { ok: false, error: 'integrity_conflict' };
  }

  let expectedEvidence: ReturnType<typeof evidenceEnvelope> | null = null;
  if (preDispatch) {
    if (row.observation_state !== 'not_started' || row.observation_attempt_id !== null ||
        row.observation_authorized_at !== null || row.observation_deadline_at !== null ||
        row.observation_evidence !== null) return { ok: false, error: 'integrity_conflict' };
  } else {
    if (row.observation_state !== 'evidence_recorded') return { ok: false, error: 'not_ready' };
    if (row.observation_attempt_id !== attemptId) return { ok: false, error: 'stale_lease' };
    const retained = recordedObservationEvidenceFromRow(row, fence);
    if (!retained) return { ok: false, error: 'integrity_conflict' };
    if (!evidence || !sameEvidence(retained, evidence)) {
      return { ok: false, error: 'evidence_conflict' };
    }
    expectedEvidence = evidenceEnvelope(evidence);
  }

  const deleted = await client.query(
    `DELETE FROM gmail_archive_recovery_leases
      WHERE admission_id = $1 AND user_id = $2 AND approval_id = $3
        AND message_ref_id = $4 AND work_kind = $5 AND barrier_status = $6
        AND attempt_phase IS NOT DISTINCT FROM $7::STRING
        AND phase_changed_at = $8::TIMESTAMPTZ
        AND lease_token = $9 AND generation = $10::INT8
        AND observation_state = $11
        AND observation_attempt_id IS NOT DISTINCT FROM $12::UUID
        AND observation_evidence IS NOT DISTINCT FROM $13::JSONB
      RETURNING admission_id`,
    [
      fence.admissionId, fence.userId, fence.approvalId, fence.messageRefId,
      fence.workKind, fence.barrierStatus, fence.attemptPhase, fence.phaseChangedAt,
      fence.leaseToken, fence.generation, preDispatch ? 'not_started' : 'evidence_recorded',
      attemptId, expectedEvidence === null ? null : JSON.stringify(expectedEvidence),
    ],
  );
  if (deleted.rows.length !== 1) return { ok: false, error: 'integrity_conflict' };
  return { ok: true, evidence };
}

/**
 * Derive and consume recorded observation evidence after the matching barrier
 * graph has been locked and validated by the caller. The attempt and evidence
 * never cross the repository boundary.
 */
export async function consumeRecordedGmailArchiveObservationInTransaction(
  client: PoolClient,
  submitted: GmailArchiveRecoveryLeaseFence,
): Promise<ConsumeRecordedGmailArchiveObservationResult> {
  const fence = snapshotGmailArchiveRecoveryLeaseFence(submitted);
  if (!fence || fence.workKind !== 'observe_dispatch' ||
      fence.barrierStatus !== 'in_progress' ||
      fence.attemptPhase !== 'dispatch_may_have_started') {
    return { ok: false, error: 'invalid_input' };
  }
  const rows = (await client.query<RecoveryLeaseConsumptionRow>(
    `SELECT lease.*,
            (lease.phase_changed_at AT TIME ZONE 'UTC')::STRING AS phase_changed_at_text
       FROM gmail_archive_recovery_leases AS lease
      WHERE admission_id = $1 AND user_id = $2
      FOR UPDATE`,
    [fence.admissionId, fence.userId],
  )).rows;
  if (rows.length === 0) return { ok: false, error: 'stale_lease' };
  if (rows.length !== 1) return { ok: false, error: 'integrity_conflict' };
  const row = rows[0]!;
  if (!exactRowFence(row, fence)) return { ok: false, error: 'stale_lease' };
  if (!Number.isSafeInteger(Number(row.generation)) || Number(row.generation) < 1) {
    return { ok: false, error: 'integrity_conflict' };
  }
  if (row.observation_state !== 'evidence_recorded') {
    return { ok: false, error: 'not_ready' };
  }
  const retained = recordedObservationEvidenceFromRow(row, fence);
  if (!retained || !row.observation_attempt_id || !row.observation_authorized_at ||
      !row.observation_deadline_at) return { ok: false, error: 'integrity_conflict' };
  const expectedEvidence = evidenceEnvelope(retained);
  const deleted = await client.query(
    `DELETE FROM gmail_archive_recovery_leases
      WHERE admission_id = $1 AND user_id = $2 AND approval_id = $3
        AND message_ref_id = $4 AND work_kind = $5 AND barrier_status = $6
        AND attempt_phase IS NOT DISTINCT FROM $7::STRING
        AND phase_changed_at = $8::TIMESTAMPTZ
        AND lease_token = $9 AND generation = $10::INT8
        AND observation_state = 'evidence_recorded'
        AND observation_attempt_id = $11::UUID
        AND observation_authorized_at = $12::TIMESTAMPTZ
        AND observation_deadline_at = $13::TIMESTAMPTZ
        AND observation_evidence = $14::JSONB
      RETURNING admission_id`,
    [
      fence.admissionId, fence.userId, fence.approvalId, fence.messageRefId,
      fence.workKind, fence.barrierStatus, fence.attemptPhase, fence.phaseChangedAt,
      fence.leaseToken, fence.generation, row.observation_attempt_id,
      row.observation_authorized_at.toISOString(), row.observation_deadline_at.toISOString(),
      JSON.stringify(expectedEvidence),
    ],
  );
  if (deleted.rows.length !== 1) return { ok: false, error: 'integrity_conflict' };
  return { ok: true, evidence: retained };
}

/**
 * Revoke installation-local recovery capability after canonical terminal truth
 * has been established. The caller supplies only lineage from its locked graph;
 * no recovery fence, token, generation, permit, or observation evidence is
 * accepted as authority here.
 */
export async function retireGmailArchiveRecoveryLeaseForTerminalInTransaction(
  client: PoolClient,
  lineage: Readonly<GmailArchiveTerminalLeaseLineage>,
): Promise<RetireGmailArchiveRecoveryLeaseForTerminalResult> {
  const rows = (await client.query<Pick<RecoveryLeaseConsumptionRow,
    'admission_id' | 'user_id' | 'approval_id' | 'message_ref_id'>>(
    `SELECT admission_id, user_id, approval_id, message_ref_id
       FROM gmail_archive_recovery_leases
      WHERE admission_id = $1
      FOR UPDATE`,
    [lineage.admissionId],
  )).rows;
  if (rows.length === 0) return { ok: true, retired: false };
  if (rows.length !== 1) return { ok: false, error: 'integrity_conflict' };
  const row = rows[0]!;
  if (row.admission_id !== lineage.admissionId || row.user_id !== lineage.userId ||
      row.approval_id !== lineage.approvalId || row.message_ref_id !== lineage.messageRefId) {
    return { ok: false, error: 'integrity_conflict' };
  }
  const deleted = await client.query(
    `DELETE FROM gmail_archive_recovery_leases
      WHERE admission_id = $1 AND user_id = $2 AND approval_id = $3 AND message_ref_id = $4
      RETURNING admission_id`,
    [lineage.admissionId, lineage.userId, lineage.approvalId, lineage.messageRefId],
  );
  return deleted.rows.length === 1
    ? { ok: true, retired: true }
    : { ok: false, error: 'integrity_conflict' };
}
