import { randomUUID } from 'node:crypto';
import {
  verifyJoinedDecisionReceiptChain,
  type AcquireGmailArchiveRecoveryLeaseInput,
  type AcquireGmailArchiveRecoveryLeaseResult,
  type BeginGmailArchiveRecoveryObservationResult,
  type GmailArchiveAttemptPhase,
  type GmailArchiveRecoveryLease,
  type GmailArchiveRecoveryLeaseFence,
  type GmailArchiveRecoveryLeaseRepository,
  type GmailArchiveRecoveryObservationEvidence,
  type GmailArchiveRecoveryObservationPermit,
  type GmailArchiveRecoveryWorkKind,
  type RecordGmailArchiveRecoveryObservationInput,
  type RecordGmailArchiveRecoveryObservationResult,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../connection.js';
import type { ExecutionPlanRow } from '../types.js';
import {
  canonicalGmailArchiveApprovalContent,
  canonicalGmailArchiveCandidateMessageRef,
  loadCanonicalGmailArchiveApprovalState,
} from './gmail-archive-approval-response-repository.js';
import { loadGmailArchivePreparationReplay } from './gmail-archive-preparation-repository.js';
import { queryAbandonedGmailArchiveInTransaction } from './gmail-archive-recovery-repository.js';
import {
  GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS,
  GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS,
} from './gmail-archive-recovery-policy.js';
export { GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS } from './gmail-archive-recovery-policy.js';
import { exactClaimedGmailArchiveReceipt } from './gmail-archive-claim-integrity.js';
import {
  exactGmailArchiveApprovedPrefix,
  loadGmailArchivePolicyExplanation,
  loadGmailArchiveStableState,
} from './gmail-archive-terminalization-repository.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

/**
 * Installation-local coordination only. This foundation intentionally has no
 * runtime composition point: a later integration must consume the returned
 * fence in the observation target resolver and reconciliation terminalizer
 * before approval-to-dispatch recovery can be enabled.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBSERVATION_EVIDENCE_SCHEMA = 'gmail_archive_recovery_observation_v1';
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 5 * 60 * 1_000;

interface LockedBarrierRow extends PreEffectBarrierRow {
  phase_changed_at_text: string;
}

interface RecoveryLeaseRow {
  admission_id: string;
  user_id: string;
  approval_id: string;
  message_ref_id: string;
  work_kind: GmailArchiveRecoveryWorkKind;
  barrier_status: 'reserved' | 'prepared' | 'in_progress';
  attempt_phase: GmailArchiveAttemptPhase | null;
  phase_changed_at: Date;
  phase_changed_at_text?: string;
  lease_token: string;
  generation: string;
  acquired_at: Date;
  renewed_at: Date;
  expires_at: Date;
  observation_state: 'not_started' | 'started' | 'evidence_recorded';
  observation_attempt_id: string | null;
  observation_authorized_at: Date | null;
  observation_deadline_at: Date | null;
  observation_evidence: unknown;
}

interface EligibleStage {
  admissionId: string;
  messageRefId: string;
  workKind: GmailArchiveRecoveryWorkKind;
  barrierStatus: 'reserved' | 'prepared' | 'in_progress';
  attemptPhase: GmailArchiveAttemptPhase | null;
  phaseChangedAt: string;
}

type StageResult =
  | { status: 'eligible'; stage: EligibleStage }
  | { status: 'not_due' | 'terminal' }
  | { status: 'error'; error: 'not_found' | 'legacy_untracked' | 'integrity_conflict' };

type Transaction = <T>(callback: (client: PoolClient) => Promise<T>) => Promise<T>;

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
  const fraction = microseconds.slice(3) === '000'
    ? microseconds.slice(0, 3)
    : microseconds;
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

function snapshotAcquireInput(value: unknown): Readonly<AcquireGmailArchiveRecoveryLeaseInput> | null {
  const input = ownData(value, ['approvalId', 'leaseMs', 'userId']);
  if (!input || typeof input['userId'] !== 'string' || !UUID.test(input['userId']) ||
      typeof input['approvalId'] !== 'string' || !UUID.test(input['approvalId']) ||
      !Number.isSafeInteger(input['leaseMs']) || (input['leaseMs'] as number) < MIN_LEASE_MS ||
      (input['leaseMs'] as number) > MAX_LEASE_MS) return null;
  return Object.freeze({
    userId: input['userId'],
    approvalId: input['approvalId'],
    leaseMs: input['leaseMs'] as number,
  });
}

const FENCE_KEYS = [
  'admissionId', 'approvalId', 'attemptPhase', 'barrierStatus', 'generation',
  'leaseToken', 'messageRefId', 'phaseChangedAt', 'userId', 'workKind',
] as const;

function snapshotFence(value: unknown): Readonly<GmailArchiveRecoveryLeaseFence> | null {
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

function snapshotEvidence(value: unknown): Readonly<GmailArchiveRecoveryObservationEvidence> | null {
  const kind = ownData(value, ['binding', 'inbox', 'kind', 'observedAt']);
  if (kind?.['kind'] === 'mailbox_observed') {
    const binding = snapshotBinding(kind['binding']);
    if (!binding || typeof kind['inbox'] !== 'boolean' ||
        !validExternalTimestamp(kind['observedAt'])) return null;
    return Object.freeze({
      kind: 'mailbox_observed', binding, inbox: kind['inbox'], observedAt: kind['observedAt'],
    });
  }
  const unavailable = ownData(value, ['binding', 'code', 'kind']);
  const codes = [
    'not_observable', 'authority_unavailable', 'credentials_unavailable',
    'observation_rejected', 'observation_unavailable',
  ];
  if (unavailable?.['kind'] !== 'mailbox_observation_unavailable' ||
      typeof unavailable['code'] !== 'string' || !codes.includes(unavailable['code'])) return null;
  const binding = snapshotBinding(unavailable['binding']);
  if (!binding) return null;
  return Object.freeze({
    kind: 'mailbox_observation_unavailable',
    binding,
    code: unavailable['code'] as Extract<GmailArchiveRecoveryObservationEvidence, {
      kind: 'mailbox_observation_unavailable';
    }>['code'],
  });
}

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

function snapshotPermit(value: unknown): Readonly<GmailArchiveRecoveryObservationPermit> | null {
  const permit = ownData(value, [...FENCE_KEYS, 'authorizedAt', 'deadlineAt', 'observationAttemptId']);
  if (!permit) return null;
  const fenceValues: Record<string, unknown> = {};
  for (const key of FENCE_KEYS) fenceValues[key] = permit[key];
  const fence = snapshotFence(fenceValues);
  if (!fence || fence.workKind !== 'observe_dispatch' ||
      typeof permit['observationAttemptId'] !== 'string' ||
      !UUID.test(permit['observationAttemptId']) ||
      !validExternalTimestamp(permit['authorizedAt']) ||
      !validExternalTimestamp(permit['deadlineAt']) ||
      Date.parse(permit['authorizedAt']) > Date.parse(permit['deadlineAt'])) return null;
  return Object.freeze({
    ...fence,
    observationAttemptId: permit['observationAttemptId'],
    authorizedAt: permit['authorizedAt'],
    deadlineAt: permit['deadlineAt'],
  });
}

function exactApprovalResponse(value: unknown): boolean {
  const response = ownData(value, ['action', 'reason']);
  return response?.['action'] === 'approve' &&
    (response['reason'] === null || typeof response['reason'] === 'string');
}

function stageMatchesFence(stage: EligibleStage, fence: GmailArchiveRecoveryLeaseFence): boolean {
  return stage.admissionId === fence.admissionId && stage.messageRefId === fence.messageRefId &&
    stage.workKind === fence.workKind && stage.barrierStatus === fence.barrierStatus &&
    stage.attemptPhase === fence.attemptPhase && stage.phaseChangedAt === fence.phaseChangedAt;
}

async function due(client: PoolClient, phaseChangedAt: string): Promise<boolean> {
  return (await client.query<{ due: boolean }>(
    `SELECT $1::TIMESTAMPTZ + ($2::INT * INTERVAL '1 second') <= clock_timestamp() AS due`,
    [phaseChangedAt, GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS],
  )).rows[0]?.due === true;
}

async function currentDbTime(client: PoolClient): Promise<Date> {
  const value = (await client.query<{ db_now: Date }>(
    'SELECT clock_timestamp() AS db_now',
  )).rows[0]?.db_now;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('database returned an invalid wall-clock timestamp');
  }
  return value;
}

async function currentWallClock(): Promise<Date> {
  const value = (await query<{ db_now: Date }>(
    'SELECT statement_timestamp() AS db_now',
  )).rows[0]?.db_now;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('database returned an invalid wall-clock timestamp');
  }
  return value;
}

async function liveCapability(
  capability: Readonly<GmailArchiveRecoveryLease | GmailArchiveRecoveryObservationPermit>,
): Promise<boolean> {
  const permit = 'deadlineAt' in capability ? capability : null;
  const row = (await query<{ live: boolean }>(
    `SELECT CASE
       WHEN $11::UUID IS NOT NULL THEN
         observation_state = 'started' AND observation_attempt_id = $11::UUID AND
         observation_authorized_at = $12::TIMESTAMPTZ AND
         observation_deadline_at = $13::TIMESTAMPTZ AND
         expires_at > statement_timestamp() AND
         observation_deadline_at > statement_timestamp()
       WHEN observation_state = 'started' THEN
         observation_deadline_at > statement_timestamp()
       ELSE expires_at > statement_timestamp()
     END AS live
       FROM gmail_archive_recovery_leases
      WHERE admission_id = $1 AND user_id = $2 AND approval_id = $3
        AND message_ref_id = $4 AND work_kind = $5 AND barrier_status = $6
        AND attempt_phase IS NOT DISTINCT FROM $7 AND phase_changed_at = $8::TIMESTAMPTZ
        AND lease_token = $9 AND generation = $10::INT8`,
    [
      capability.admissionId,
      capability.userId,
      capability.approvalId,
      capability.messageRefId,
      capability.workKind,
      capability.barrierStatus,
      capability.attemptPhase,
      capability.phaseChangedAt,
      capability.leaseToken,
      capability.generation,
      permit?.observationAttemptId ?? null,
      permit?.authorizedAt ?? null,
      permit?.deadlineAt ?? null,
    ],
  )).rows[0];
  return row?.live === true;
}

async function loadAdmissionBarriers(
  client: PoolClient,
  authority: Readonly<{ userId: string; approvalId: string }>,
  lock: boolean,
): Promise<LockedBarrierRow[]> {
  return (await client.query<LockedBarrierRow>(
    `SELECT barrier.*,
            (CASE WHEN barrier.status = 'reserved' THEN barrier.created_at
                  ELSE barrier.updated_at END AT TIME ZONE 'UTC')::STRING AS phase_changed_at_text
       FROM pre_effect_barriers AS barrier
      WHERE barrier.user_id = $1 AND barrier.effect_type = 'event_execution'
        AND barrier.idempotency_key = $2${lock ? ' FOR UPDATE' : ''}`,
    [authority.userId, authority.approvalId],
  )).rows;
}

async function classifyStage(
  client: PoolClient,
  authority: Readonly<{ userId: string; approvalId: string }>,
): Promise<StageResult> {
  // The first read routes lock order but grants no authority. Preparation and
  // claim lock the approval/proposal graph before the admission barrier, so
  // reserved/prepared recovery must do the same and revalidate after locking.
  // In-progress recovery has no competing forward writer and remains
  // barrier-first so its attempt phase is fenced before graph inspection.
  const observed = await loadAdmissionBarriers(client, authority, false);
  if (observed.length === 0) return { status: 'error', error: 'not_found' };
  if (observed.length !== 1) return { status: 'error', error: 'integrity_conflict' };
  const observedBarrier = observed[0]!;
  const portableStage = observedBarrier.status === 'reserved' ||
    observedBarrier.status === 'prepared';
  const authorityState = portableStage
    ? await loadGmailArchiveStableState(client, authority, true, true)
    : null;
  const barriers = await loadAdmissionBarriers(client, authority, true);
  if (barriers.length !== 1 || barriers[0]!.id !== observedBarrier.id) {
    return { status: 'error', error: 'integrity_conflict' };
  }
  const barrier = barriers[0]!;
  if (portableStage && barrier.status !== observedBarrier.status) {
    // A normal preparation/claim transition won the race while we acquired its
    // earlier approval/proposal locks. A later recovery pass classifies the new
    // stage without reversing lock order in this transaction.
    return { status: 'not_due' };
  }
  const phaseChangedAt = canonicalDbPhaseTimestamp(barrier.phase_changed_at_text);
  if (!UUID.test(barrier.id) || !phaseChangedAt) {
    return { status: 'error', error: 'integrity_conflict' };
  }

  if (barrier.status === 'in_progress' || barrier.status === 'succeeded' ||
      barrier.status === 'failed' || barrier.status === 'unknown') {
    const recovery = await queryAbandonedGmailArchiveInTransaction(client, authority);
    if (!recovery.ok) return {
      status: 'error',
      error: recovery.error === 'invalid_input' ? 'integrity_conflict' : recovery.error,
    };
    if (recovery.status === 'terminal') return { status: 'terminal' };
    if (recovery.status !== 'eligible') return { status: recovery.status };
    if (recovery.recovery.phaseChangedAt !== phaseChangedAt ||
        recovery.recovery.command.admissionId !== barrier.id) {
      return { status: 'error', error: 'integrity_conflict' };
    }
    return {
      status: 'eligible',
      stage: {
        admissionId: barrier.id,
        messageRefId: recovery.recovery.command.messageRefId,
        workKind: recovery.recovery.phase === 'pre_dispatch'
          ? 'reconcile_pre_dispatch'
          : 'observe_dispatch',
        barrierStatus: 'in_progress',
        attemptPhase: recovery.recovery.phase,
        phaseChangedAt,
      },
    };
  }

  const authorityApproved = authorityState
    ? exactGmailArchiveApprovedPrefix(authorityState)
    : null;
  const authorityMessageRefId = authorityState
    ? canonicalGmailArchiveCandidateMessageRef(authorityState.approval, authorityState.candidate)
    : null;
  if ((barrier.status === 'reserved' || barrier.status === 'prepared') &&
      (!authorityState || !authorityApproved || !authorityMessageRefId ||
       !UUID.test(authorityMessageRefId))) {
    return { status: 'error', error: 'integrity_conflict' };
  }

  if (barrier.status === 'reserved' && authorityState && authorityMessageRefId) {
    const plans = (await client.query<ExecutionPlanRow>(
      'SELECT * FROM execution_plans WHERE decision_id = $1 ORDER BY id ASC',
      [authorityState.decision.id],
    )).rows;
    if (barrier.decision_id !== null || barrier.action_id !== null ||
        barrier.explanation_id !== null || ownData(barrier.policy_snapshot, []) === null ||
        ownData(barrier.effect_result, []) === null || barrier.failure_reason !== null ||
        authorityState.outcome.execution_plan_id !== null || plans.length !== 0 ||
        authorityState.revisions.length !== 4 ||
        authorityState.revisions.some((revision) => revision.trusted !== true) ||
        !verifyJoinedDecisionReceiptChain({
          receiptId: authorityState.receipt.id,
          decisionId: authorityState.decision.id,
          userId: authority.userId,
          revisions: authorityState.revisions,
        })) {
      return { status: 'error', error: 'integrity_conflict' };
    }
    if (!await due(client, phaseChangedAt)) return { status: 'not_due' };
    return {
      status: 'eligible',
      stage: {
        admissionId: barrier.id,
        messageRefId: authorityMessageRefId,
        workKind: 'resume_preparation',
        barrierStatus: 'reserved',
        attemptPhase: null,
        phaseChangedAt,
      },
    };
  }

  if (barrier.status === 'prepared' && authorityState && authorityApproved &&
      authorityMessageRefId) {
    const plans = (await client.query<ExecutionPlanRow>(
      'SELECT * FROM execution_plans WHERE decision_id = $1 ORDER BY id ASC',
      [authorityState.decision.id],
    )).rows;
    const plan = plans[0];
    const explanation = await loadGmailArchivePolicyExplanation(
      client,
      barrier,
      authorityState.decision.id,
    );
    if (plans.length !== 1 || !plan || plan.status !== 'pending' ||
        authorityState.outcome.execution_plan_id !== plan.id || !explanation ||
        !exactClaimedGmailArchiveReceipt(
          authority,
          authorityState,
          barrier,
          plan,
          explanation,
          authorityApproved,
        )) {
      return { status: 'error', error: 'integrity_conflict' };
    }
    if (!await due(client, phaseChangedAt)) return { status: 'not_due' };
    return {
      status: 'eligible',
      stage: {
        admissionId: barrier.id,
        messageRefId: authorityMessageRefId,
        workKind: 'resume_claim',
        barrierStatus: 'prepared',
        attemptPhase: null,
        phaseChangedAt,
      },
    };
  }

  const state = await loadCanonicalGmailArchiveApprovalState(client, {
    ...authority,
    action: 'approve',
  }, { allowExecutionPlan: true });
  if (!state || state.approval.status !== 'approved' || state.approval.responded_at === null ||
      state.approval.responded_at.getTime() > state.approval.expires_at.getTime() ||
      !exactApprovalResponse(state.approval.response)) {
    return { status: 'error', error: 'integrity_conflict' };
  }
  const approved = canonicalGmailArchiveApprovalContent(
    { ...state, revisions: state.revisions.slice(0, 4) },
    'approved',
  );
  const messageRefId = canonicalGmailArchiveCandidateMessageRef(state.approval, state.candidate);
  if (!approved || !messageRefId || !UUID.test(messageRefId)) {
    return { status: 'error', error: 'integrity_conflict' };
  }

  if (barrier.status === 'blocked') {
    const replay = await loadGmailArchivePreparationReplay(client, authority, state, barrier, approved);
    return replay.ok && replay.preparation.status === 'blocked'
      ? { status: 'terminal' }
      : { status: 'error', error: 'integrity_conflict' };
  }
  return { status: 'error', error: 'integrity_conflict' };
}

function rowMatchesStage(row: RecoveryLeaseRow, stage: EligibleStage): boolean {
  return row.admission_id === stage.admissionId && row.message_ref_id === stage.messageRefId &&
    row.work_kind === stage.workKind && row.barrier_status === stage.barrierStatus &&
    row.attempt_phase === stage.attemptPhase &&
    canonicalDbPhaseTimestamp(row.phase_changed_at_text) === stage.phaseChangedAt;
}

function rowMatchesFence(row: RecoveryLeaseRow, fence: GmailArchiveRecoveryLeaseFence): boolean {
  return row.user_id === fence.userId && row.approval_id === fence.approvalId &&
    row.admission_id === fence.admissionId && row.message_ref_id === fence.messageRefId &&
    row.work_kind === fence.workKind && row.barrier_status === fence.barrierStatus &&
    row.attempt_phase === fence.attemptPhase &&
    canonicalDbPhaseTimestamp(row.phase_changed_at_text) === fence.phaseChangedAt &&
    row.lease_token === fence.leaseToken && Number(row.generation) === fence.generation;
}

function leaseFromRow(
  row: RecoveryLeaseRow,
  phaseChangedAt: string,
): Readonly<GmailArchiveRecoveryLease> | null {
  const generation = Number(row.generation);
  const evidence = row.observation_evidence === null
    ? null
    : parseEvidenceEnvelope(row.observation_evidence);
  if (!Number.isSafeInteger(generation) || generation < 1 ||
      !validLeaseObservationState(row, evidence, phaseChangedAt)) return null;
  return Object.freeze({
    userId: row.user_id,
    approvalId: row.approval_id,
    admissionId: row.admission_id,
    messageRefId: row.message_ref_id,
    workKind: row.work_kind,
    barrierStatus: row.barrier_status,
    attemptPhase: row.attempt_phase,
    phaseChangedAt,
    leaseToken: row.lease_token,
    generation,
    acquiredAt: row.acquired_at.toISOString(),
    renewedAt: row.renewed_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    observationState: row.observation_state,
    observationAttemptId: row.observation_attempt_id,
    observationAuthorizedAt: row.observation_authorized_at?.toISOString() ?? null,
    observationDeadlineAt: row.observation_deadline_at?.toISOString() ?? null,
    evidence,
  });
}

function validLeaseObservationState(
  row: RecoveryLeaseRow,
  evidence: Readonly<GmailArchiveRecoveryObservationEvidence> | null,
  phaseChangedAt: string,
): boolean {
  if (row.observation_state === 'not_started') {
    return row.observation_attempt_id === null && row.observation_authorized_at === null &&
      row.observation_deadline_at === null && evidence === null;
  }
  if (!row.observation_attempt_id || !UUID.test(row.observation_attempt_id) ||
      !row.observation_authorized_at || !row.observation_deadline_at ||
      row.observation_authorized_at.getTime() > row.observation_deadline_at.getTime() ||
      row.observation_deadline_at.getTime() - row.observation_authorized_at.getTime() !==
        GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS * 1_000 ||
      row.observation_authorized_at.getTime() < Date.parse(phaseChangedAt)) return false;
  if (row.observation_state === 'started') return evidence === null;
  if (row.observation_state !== 'evidence_recorded' || !evidence ||
      evidence.binding.userId !== row.user_id ||
      evidence.binding.admissionId !== row.admission_id ||
      evidence.binding.messageRefId !== row.message_ref_id) return false;
  if (evidence.kind === 'mailbox_observation_unavailable') return true;
  const observedAt = Date.parse(evidence.observedAt);
  return observedAt >= row.observation_authorized_at.getTime() &&
    observedAt >= Date.parse(phaseChangedAt) &&
    observedAt <= row.observation_deadline_at.getTime();
}

function expiredObservationEvidence(stage: EligibleStage, userId: string) {
  return evidenceEnvelope(Object.freeze({
    kind: 'mailbox_observation_unavailable' as const,
    binding: Object.freeze({
      userId,
      admissionId: stage.admissionId,
      messageRefId: stage.messageRefId,
    }),
    code: 'observation_unavailable' as const,
  }));
}

async function acquireTransition(
  client: PoolClient,
  input: Readonly<AcquireGmailArchiveRecoveryLeaseInput>,
  leaseToken: string,
): Promise<AcquireGmailArchiveRecoveryLeaseResult> {
  const classified = await classifyStage(client, input);
  if (classified.status === 'error') return { ok: false, error: classified.error };
  if (classified.status !== 'eligible') return { ok: true, status: classified.status, lease: null };
  const stage = classified.stage;
  const existing = (await client.query<RecoveryLeaseRow>(
    `SELECT lease.*,
            (lease.phase_changed_at AT TIME ZONE 'UTC')::STRING AS phase_changed_at_text
       FROM gmail_archive_recovery_leases AS lease
      WHERE admission_id = $1 AND user_id = $2
      FOR UPDATE`,
    [stage.admissionId, input.userId],
  )).rows;
  if (existing.length > 1) return { ok: false, error: 'integrity_conflict' };
  const prior = existing[0];
  const dbNow = await currentDbTime(client);
  if (!prior) {
    const inserted = (await client.query<RecoveryLeaseRow>(
      `WITH fresh_clock AS MATERIALIZED (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS db_now
       )
       INSERT INTO gmail_archive_recovery_leases (
         admission_id, user_id, approval_id, message_ref_id, work_kind,
         barrier_status, attempt_phase, phase_changed_at, lease_token, generation,
         acquired_at, renewed_at, expires_at
       ) SELECT $1, $2, $3, $4, $5, $6, $7, $8::TIMESTAMPTZ, $9, 1,
         fresh_clock.db_now, fresh_clock.db_now,
         fresh_clock.db_now + ($10::INT * INTERVAL '1 millisecond')
       FROM fresh_clock
       RETURNING *`,
      [
        stage.admissionId, input.userId, input.approvalId, stage.messageRefId,
        stage.workKind, stage.barrierStatus, stage.attemptPhase, stage.phaseChangedAt,
        leaseToken, input.leaseMs,
      ],
    )).rows[0];
    const lease = inserted ? leaseFromRow(inserted, stage.phaseChangedAt) : null;
    return lease
      ? { ok: true, status: 'acquired', created: true, lease }
      : { ok: false, error: 'integrity_conflict' };
  }
  const priorPhaseChangedAt = canonicalDbPhaseTimestamp(prior.phase_changed_at_text);
  if (prior.admission_id !== stage.admissionId || prior.user_id !== input.userId ||
      prior.approval_id !== input.approvalId || !Number.isSafeInteger(Number(prior.generation)) ||
      Number(prior.generation) >= Number.MAX_SAFE_INTEGER || !priorPhaseChangedAt ||
      !leaseFromRow(prior, priorPhaseChangedAt)) {
    return { ok: false, error: 'integrity_conflict' };
  }
  const sameStage = rowMatchesStage(prior, stage);
  const active = (await client.query<{ active: boolean; observation_active: boolean }>(
    `SELECT expires_at > $3::TIMESTAMPTZ AS active,
            observation_state = 'started' AND observation_deadline_at > $3::TIMESTAMPTZ AS observation_active
       FROM gmail_archive_recovery_leases
      WHERE admission_id = $1 AND user_id = $2`,
    [stage.admissionId, input.userId, dbNow],
  )).rows[0];
  const priorLive = prior.observation_state === 'started'
    ? active?.observation_active === true
    : active?.active === true;
  if (sameStage && prior.lease_token === leaseToken && priorLive) {
    return { ok: true, status: 'acquired', created: false, lease: leaseFromRow(prior, stage.phaseChangedAt)! };
  }
  if (sameStage && priorLive) {
    return { ok: true, status: 'busy', lease: null };
  }
  const timedOutObservation = sameStage && prior.work_kind === 'observe_dispatch' &&
    prior.observation_state === 'started';
  const updated = (await client.query<RecoveryLeaseRow>(
    `WITH fresh_clock AS MATERIALIZED (
       SELECT date_trunc('milliseconds', clock_timestamp()) AS db_now
     )
     UPDATE gmail_archive_recovery_leases
        SET message_ref_id = $4, work_kind = $5, barrier_status = $6,
            attempt_phase = $7, phase_changed_at = $8::TIMESTAMPTZ,
            lease_token = $9, generation = generation + 1,
            acquired_at = fresh_clock.db_now,
            renewed_at = fresh_clock.db_now,
            expires_at = fresh_clock.db_now + ($10::INT * INTERVAL '1 millisecond'),
            observation_state = $11,
            observation_attempt_id = CASE WHEN $11 = 'evidence_recorded'
              THEN observation_attempt_id ELSE NULL END,
            observation_authorized_at = CASE WHEN $11 = 'evidence_recorded'
              THEN observation_authorized_at ELSE NULL END,
            observation_deadline_at = CASE WHEN $11 = 'evidence_recorded'
              THEN observation_deadline_at ELSE NULL END,
            observation_evidence = $12::JSONB
       FROM fresh_clock
      WHERE admission_id = $1 AND user_id = $2 AND approval_id = $3
        AND lease_token = $13 AND generation = $14::INT8
      RETURNING *`,
    [
      stage.admissionId, input.userId, input.approvalId, stage.messageRefId,
      stage.workKind, stage.barrierStatus, stage.attemptPhase, stage.phaseChangedAt,
      leaseToken, input.leaseMs,
      timedOutObservation ? 'evidence_recorded' :
        (sameStage && stage.workKind === 'observe_dispatch' && prior.observation_state === 'evidence_recorded'
          ? 'evidence_recorded'
          : 'not_started'),
      timedOutObservation
        ? JSON.stringify(expiredObservationEvidence(stage, input.userId))
        : (sameStage && stage.workKind === 'observe_dispatch' && prior.observation_state === 'evidence_recorded'
          ? JSON.stringify(prior.observation_evidence)
          : null),
      prior.lease_token,
      prior.generation,
    ],
  )).rows[0];
  const lease = updated ? leaseFromRow(updated, stage.phaseChangedAt) : null;
  return lease
    ? { ok: true, status: 'acquired', created: false, lease }
    : { ok: false, error: 'integrity_conflict' };
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

async function acquireWithTransition(
  submitted: AcquireGmailArchiveRecoveryLeaseInput,
  transition = acquireTransition,
  transaction: Transaction = withTransaction,
): Promise<AcquireGmailArchiveRecoveryLeaseResult> {
  const input = snapshotAcquireInput(submitted);
  if (!input) return { ok: false, error: 'invalid_input' };
  const leaseToken = randomUUID();
  try {
    const result = await retry(() => transaction((client) => transition(client, input, leaseToken)));
    if (result.ok && result.status === 'acquired' &&
        !await liveCapability(result.lease)) {
      return { ok: true, status: 'busy', lease: null };
    }
    return result;
  } catch (error) {
    if (commitMayBeUnverified(error)) return { ok: false, error: 'commit_unverified' };
    throw error;
  }
}

async function loadExactLease(
  client: PoolClient,
  fence: GmailArchiveRecoveryLeaseFence,
): Promise<RecoveryLeaseRow | null> {
  const rows = (await client.query<RecoveryLeaseRow>(
    `SELECT lease.*,
            (lease.phase_changed_at AT TIME ZONE 'UTC')::STRING AS phase_changed_at_text
       FROM gmail_archive_recovery_leases AS lease
      WHERE admission_id = $1 AND user_id = $2
      FOR UPDATE`,
    [fence.admissionId, fence.userId],
  )).rows;
  const row = rows.length === 1 ? rows[0]! : null;
  return row && row.approval_id === fence.approvalId && rowMatchesFence(row, fence) &&
    leaseFromRow(row, fence.phaseChangedAt) ? row : null;
}

async function beginWithTransition(
  submitted: GmailArchiveRecoveryLeaseFence,
  transition: (
    client: PoolClient,
    fence: Readonly<GmailArchiveRecoveryLeaseFence>,
    observationAttemptId: string,
  ) => Promise<BeginGmailArchiveRecoveryObservationResult>,
  transaction: Transaction = withTransaction,
): Promise<BeginGmailArchiveRecoveryObservationResult> {
  const fence = snapshotFence(submitted);
  if (!fence || fence.workKind !== 'observe_dispatch') return { ok: false, error: 'invalid_input' };
  const observationAttemptId = randomUUID();
  try {
    const result = await retry(() => transaction((client) => transition(
      client,
      fence,
      observationAttemptId,
    )));
    if (!result.ok || result.status !== 'permitted' || await liveCapability(result.permit)) {
      return result;
    }
    // Cockroach time functions are transaction-scoped. A lock wait can make a
    // newly persisted deadline stale by commit, so re-enter with the same
    // attempt ID. The transition records unavailable evidence; it never mints
    // a second permit for a started observation.
    return await retry(() => transaction((client) => expireObservationAfterCommit(
      client,
      fence,
      observationAttemptId,
    )));
  } catch (error) {
    if (commitMayBeUnverified(error)) return { ok: false, error: 'commit_unverified' };
    throw error;
  }
}

async function expireObservationAfterCommit(
  client: PoolClient,
  fence: Readonly<GmailArchiveRecoveryLeaseFence>,
  observationAttemptId: string,
): Promise<BeginGmailArchiveRecoveryObservationResult> {
  const unavailable = evidenceEnvelope(Object.freeze({
    kind: 'mailbox_observation_unavailable' as const,
    binding: Object.freeze({
      userId: fence.userId,
      admissionId: fence.admissionId,
      messageRefId: fence.messageRefId,
    }),
    code: 'observation_unavailable' as const,
  }));
  const updated = await client.query(
    `UPDATE gmail_archive_recovery_leases
        SET observation_state = 'evidence_recorded', observation_evidence = $12::JSONB
      WHERE admission_id = $1 AND user_id = $2 AND approval_id = $3
        AND message_ref_id = $4 AND work_kind = $5 AND barrier_status = $6
        AND attempt_phase IS NOT DISTINCT FROM $7 AND phase_changed_at = $8::TIMESTAMPTZ
        AND lease_token = $9 AND generation = $10::INT8
        AND observation_state = 'started' AND observation_attempt_id = $11
        AND (expires_at <= statement_timestamp() OR
             observation_deadline_at <= statement_timestamp())
      RETURNING admission_id`,
    [
      fence.admissionId,
      fence.userId,
      fence.approvalId,
      fence.messageRefId,
      fence.workKind,
      fence.barrierStatus,
      fence.attemptPhase,
      fence.phaseChangedAt,
      fence.leaseToken,
      fence.generation,
      observationAttemptId,
      JSON.stringify(unavailable),
    ],
  );
  return updated.rows.length === 1
    ? { ok: true, status: 'evidence_recorded', permit: null }
    : { ok: false, error: 'stale_lease' };
}

async function beginTransition(
  client: PoolClient,
  fence: Readonly<GmailArchiveRecoveryLeaseFence>,
  observationAttemptId: string,
): Promise<BeginGmailArchiveRecoveryObservationResult> {
  const classified = await classifyStage(client, fence);
  if (classified.status !== 'eligible' || !stageMatchesFence(classified.stage, fence)) {
    return { ok: false, error: classified.status === 'error' && classified.error === 'integrity_conflict'
      ? 'integrity_conflict' : 'stale_lease' };
  }
  const row = await loadExactLease(client, fence);
  if (!row) return { ok: false, error: 'stale_lease' };
  const dbNow = await currentDbTime(client);
  if (row.observation_state === 'started') {
    if (row.observation_attempt_id === observationAttemptId &&
        row.observation_authorized_at && row.observation_deadline_at) {
      const live = (await client.query<{ live: boolean }>(
        `SELECT observation_deadline_at > $6::TIMESTAMPTZ AS live
           FROM gmail_archive_recovery_leases
          WHERE admission_id = $1 AND user_id = $2 AND lease_token = $3
            AND generation = $4::INT8 AND observation_attempt_id = $5`,
        [
          fence.admissionId,
          fence.userId,
          fence.leaseToken,
          fence.generation,
          observationAttemptId,
          dbNow,
        ],
      )).rows[0]?.live;
      if (live !== true) {
        const recorded = await client.query(
          `UPDATE gmail_archive_recovery_leases
              SET observation_state = 'evidence_recorded', observation_evidence = $6::JSONB
            WHERE admission_id = $1 AND user_id = $2 AND lease_token = $3
              AND generation = $4::INT8 AND observation_attempt_id = $5
              AND observation_state = 'started' AND
                  observation_deadline_at <= clock_timestamp()
            RETURNING admission_id`,
          [
            fence.admissionId,
            fence.userId,
            fence.leaseToken,
            fence.generation,
            observationAttemptId,
            JSON.stringify(expiredObservationEvidence(classified.stage, fence.userId)),
          ],
        );
        return recorded.rows.length === 1
          ? { ok: true, status: 'evidence_recorded', permit: null }
          : { ok: false, error: 'stale_lease' };
      }
      return {
        ok: true,
        status: 'permitted',
        permit: Object.freeze({
          ...fence,
          observationAttemptId,
          authorizedAt: row.observation_authorized_at.toISOString(),
          deadlineAt: row.observation_deadline_at.toISOString(),
        }),
      };
    }
    return { ok: true, status: 'already_started', permit: null };
  }
  if (row.observation_state === 'evidence_recorded') {
    return { ok: true, status: 'evidence_recorded', permit: null };
  }
  const updated = (await client.query<RecoveryLeaseRow>(
    `WITH fresh_clock AS MATERIALIZED (
       SELECT date_trunc('milliseconds', clock_timestamp()) AS db_now
     )
     UPDATE gmail_archive_recovery_leases
        SET observation_state = 'started', observation_attempt_id = $4,
            observation_authorized_at = fresh_clock.db_now,
            observation_deadline_at = fresh_clock.db_now + ($5::INT * INTERVAL '1 second')
       FROM fresh_clock
      WHERE admission_id = $1 AND user_id = $2 AND lease_token = $3
        AND generation = $6::INT8 AND expires_at > fresh_clock.db_now
        AND work_kind = 'observe_dispatch' AND observation_state = 'not_started'
      RETURNING *`,
    [
      fence.admissionId, fence.userId, fence.leaseToken, observationAttemptId,
      GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS, fence.generation,
    ],
  )).rows[0];
  if (!updated?.observation_authorized_at || !updated.observation_deadline_at) {
    return { ok: false, error: 'stale_lease' };
  }
  const permit: GmailArchiveRecoveryObservationPermit = Object.freeze({
    ...fence,
    observationAttemptId,
    authorizedAt: updated.observation_authorized_at.toISOString(),
    deadlineAt: updated.observation_deadline_at.toISOString(),
  });
  return { ok: true, status: 'permitted', permit };
}

function snapshotRecordInput(value: unknown): Readonly<RecordGmailArchiveRecoveryObservationInput> | null {
  const input = ownData(value, ['evidence', 'permit']);
  if (!input) return null;
  const permit = snapshotPermit(input['permit']);
  const evidence = snapshotEvidence(input['evidence']);
  if (!permit || !evidence || evidence.binding.userId !== permit.userId ||
      evidence.binding.admissionId !== permit.admissionId ||
      evidence.binding.messageRefId !== permit.messageRefId) return null;
  return Object.freeze({ permit, evidence });
}

async function recordTransition(
  client: PoolClient,
  input: Readonly<RecordGmailArchiveRecoveryObservationInput>,
  requestTime: Date,
): Promise<RecordGmailArchiveRecoveryObservationResult> {
  const classified = await classifyStage(client, input.permit);
  if (classified.status !== 'eligible' || !stageMatchesFence(classified.stage, input.permit)) {
    return { ok: false, error: classified.status === 'error' && classified.error === 'integrity_conflict'
      ? 'integrity_conflict' : 'stale_lease' };
  }
  const row = await loadExactLease(client, input.permit);
  if (!row || row.observation_attempt_id !== input.permit.observationAttemptId ||
      row.observation_authorized_at?.toISOString() !== input.permit.authorizedAt ||
      row.observation_deadline_at?.toISOString() !== input.permit.deadlineAt) {
    return { ok: false, error: 'stale_lease' };
  }
  if (row.observation_state === 'evidence_recorded') {
    const retained = parseEvidenceEnvelope(row.observation_evidence);
    if (!retained || !validLeaseObservationState(
      row,
      retained,
      input.permit.phaseChangedAt,
    )) return { ok: false, error: 'integrity_conflict' };
    return sameEvidence(retained, input.evidence)
      ? { ok: true, recorded: false, evidence: retained }
      : { ok: false, error: 'evidence_conflict' };
  }
  if (row.observation_state !== 'started') return { ok: false, error: 'stale_lease' };
  const timing = (await client.query<{
    permit_valid: boolean;
    observed_in_window: boolean;
  }>(
    `SELECT $1::TIMESTAMPTZ > $5::TIMESTAMPTZ AS permit_valid,
            ($2::TIMESTAMPTZ IS NULL OR (
              $2::TIMESTAMPTZ >= $3::TIMESTAMPTZ AND
              $2::TIMESTAMPTZ >= $4::TIMESTAMPTZ AND
              $2::TIMESTAMPTZ <= $5::TIMESTAMPTZ
            )) AS observed_in_window`,
    [
      input.permit.deadlineAt,
      input.evidence.kind === 'mailbox_observed' ? input.evidence.observedAt : null,
      input.permit.authorizedAt,
      input.permit.phaseChangedAt,
      requestTime,
    ],
  )).rows[0];
  if (timing?.permit_valid !== true) return { ok: false, error: 'permit_expired' };
  if (timing.observed_in_window !== true) return { ok: false, error: 'invalid_input' };
  const updated = await client.query(
    `UPDATE gmail_archive_recovery_leases
        SET observation_state = 'evidence_recorded', observation_evidence = $5::JSONB
      WHERE admission_id = $1 AND user_id = $2 AND lease_token = $3
        AND generation = $4::INT8 AND observation_state = 'started'
        AND observation_attempt_id = $6 AND
            observation_deadline_at > $7::TIMESTAMPTZ
      RETURNING admission_id`,
    [
      input.permit.admissionId, input.permit.userId, input.permit.leaseToken,
      input.permit.generation, JSON.stringify(evidenceEnvelope(input.evidence)),
      input.permit.observationAttemptId,
      requestTime,
    ],
  );
  return updated.rows.length === 1
    ? { ok: true, recorded: true, evidence: input.evidence }
    : { ok: false, error: 'permit_expired' };
}

async function recordWithTransition(
  submitted: RecordGmailArchiveRecoveryObservationInput,
  transition = recordTransition,
  transaction: Transaction = withTransaction,
  wallClock: () => Promise<Date> = currentWallClock,
): Promise<RecordGmailArchiveRecoveryObservationResult> {
  const input = snapshotRecordInput(submitted);
  if (!input) return { ok: false, error: 'invalid_input' };
  // The complete frozen evidence exists before this fresh DB-time sample.
  // Persistence may then wait on locks without invalidating timely evidence.
  const requestTime = await wallClock();
  try {
    return await retry(() => transaction((client) => transition(client, input, requestTime)));
  } catch (error) {
    if (commitMayBeUnverified(error)) return { ok: false, error: 'commit_unverified' };
    throw error;
  }
}

function commitMayBeUnverified(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' && [
    '08000', '08001', '08003', '08004', '08006', '08007', '40003', '57P01',
  ].includes(code);
}

async function renewTransition(
  client: PoolClient,
  fence: Readonly<GmailArchiveRecoveryLeaseFence>,
  leaseMs: number,
): Promise<AcquireGmailArchiveRecoveryLeaseResult> {
  const classified = await classifyStage(client, fence);
  if (classified.status === 'error') return { ok: false, error: classified.error };
  if (classified.status !== 'eligible' || !stageMatchesFence(classified.stage, fence)) {
    return { ok: true, status: classified.status === 'terminal' ? 'terminal' : 'not_due', lease: null };
  }
  const row = await loadExactLease(client, fence);
  if (!row || row.observation_state !== 'not_started') {
    return { ok: true, status: 'busy', lease: null };
  }
  const updated = (await client.query<RecoveryLeaseRow>(
      `WITH fresh_clock AS MATERIALIZED (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS db_now
       )
       UPDATE gmail_archive_recovery_leases
          SET renewed_at = fresh_clock.db_now,
              expires_at = fresh_clock.db_now + ($4::INT * INTERVAL '1 millisecond')
         FROM fresh_clock
        WHERE admission_id = $1 AND user_id = $2 AND lease_token = $3
          AND generation = $5::INT8 AND expires_at > fresh_clock.db_now
          AND observation_state = 'not_started'
        RETURNING *`,
      [fence.admissionId, fence.userId, fence.leaseToken, leaseMs, fence.generation],
  )).rows[0];
  const lease = updated ? leaseFromRow(updated, fence.phaseChangedAt) : null;
  return lease
    ? { ok: true, status: 'acquired', created: false, lease }
    : { ok: true, status: 'busy', lease: null };
}

async function renewWithTransition(
  submitted: GmailArchiveRecoveryLeaseFence,
  leaseMs: number,
  transition = renewTransition,
  transaction: Transaction = withTransaction,
): Promise<AcquireGmailArchiveRecoveryLeaseResult> {
  const fence = snapshotFence(submitted);
  if (!fence || !Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    return { ok: false, error: 'invalid_input' };
  }
  try {
    const result = await retry(() => transaction((client) => transition(client, fence, leaseMs)));
    if (result.ok && result.status === 'acquired' &&
        !await liveCapability(result.lease)) {
      return { ok: true, status: 'busy', lease: null };
    }
    return result;
  } catch (error) {
    if (commitMayBeUnverified(error)) return { ok: false, error: 'commit_unverified' };
    throw error;
  }
}

export const gmailArchiveRecoveryLeaseTestHooks = {
  acquireTransition,
  acquireWithTransition,
  beginTransition,
  beginWithTransition,
  canonicalDbPhaseTimestamp,
  classifyStage,
  leaseFromRow,
  recordTransition,
  recordWithTransition,
  renewTransition,
  renewWithTransition,
  snapshotAcquireInput,
  snapshotEvidence,
  snapshotFence,
  snapshotPermit,
};

export const gmailArchiveRecoveryLeaseRepository: GmailArchiveRecoveryLeaseRepository = {
  acquire(input) {
    return acquireWithTransition(input);
  },
  renew(fence, leaseMs) {
    return renewWithTransition(fence, leaseMs);
  },
  beginObservation(fence) {
    return beginWithTransition(fence, beginTransition);
  },
  recordObservation(input) {
    return recordWithTransition(input);
  },
};
