import {
  GMAIL_ARCHIVE_ATTEMPT_SCHEMA,
  GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
  type GmailArchiveRecoveryObservationPermit,
  type GmailInboxObservationCommand,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';
import { GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS } from './gmail-archive-recovery-policy.js';
import { queryAbandonedGmailArchiveInTransaction } from './gmail-archive-recovery-repository.js';

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface GmailInboxObservationTarget {
  connectorAccountId: string;
  credentialRevision: string;
  providerMessageId: string;
}

export interface GmailArchiveRecoveryObservationSelection {
  connectorAccountId: string;
  /** Selection-time metadata only; final bearer authority is supplied separately. */
  credentialRevision: string;
  providerMessageId: string;
}

export interface GmailArchiveRecoveryObservationFinalTargetInput {
  permit: GmailArchiveRecoveryObservationPermit;
  selection: GmailArchiveRecoveryObservationSelection;
  credentialRevision: string;
}

interface GmailInboxObservationTargetRow {
  connector_account_id: string;
  credential_revision: string;
  provider_message_id: string;
}

interface FinalTargetSnapshot {
  permit: Readonly<GmailArchiveRecoveryObservationPermit>;
  selection: Readonly<GmailArchiveRecoveryObservationSelection>;
  credentialRevision: string;
}

type ObservationTargetTransaction = <T>(
  callback: (client: PoolClient) => Promise<T>,
) => Promise<T>;

const FENCE_KEYS = [
  'admissionId', 'approvalId', 'attemptPhase', 'barrierStatus', 'generation',
  'leaseToken', 'messageRefId', 'phaseChangedAt', 'userId', 'workKind',
] as const;

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
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validPhaseTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})(?:\d{3})?Z$/.exec(value);
  if (!match) return false;
  try {
    return new Date(`${match[1]}Z`).toISOString() === `${match[1]}Z`;
  } catch {
    return false;
  }
}

function snapshotPermit(value: unknown): Readonly<GmailArchiveRecoveryObservationPermit> | null {
  const permit = ownData(value, [
    ...FENCE_KEYS, 'authorizedAt', 'deadlineAt', 'leaseExpiresAt', 'observationAttemptId',
  ]);
  if (!permit || typeof permit['userId'] !== 'string' || !UUID.test(permit['userId']) ||
      typeof permit['approvalId'] !== 'string' || !UUID.test(permit['approvalId']) ||
      typeof permit['admissionId'] !== 'string' || !UUID.test(permit['admissionId']) ||
      typeof permit['messageRefId'] !== 'string' || !UUID.test(permit['messageRefId']) ||
      permit['workKind'] !== 'observe_dispatch' || permit['barrierStatus'] !== 'in_progress' ||
      permit['attemptPhase'] !== 'dispatch_may_have_started' ||
      !validPhaseTimestamp(permit['phaseChangedAt']) ||
      typeof permit['leaseToken'] !== 'string' || !UUID.test(permit['leaseToken']) ||
      !Number.isSafeInteger(permit['generation']) || (permit['generation'] as number) < 1 ||
      typeof permit['observationAttemptId'] !== 'string' ||
      !UUID.test(permit['observationAttemptId']) || !validTimestamp(permit['authorizedAt']) ||
      !validTimestamp(permit['deadlineAt']) || !validTimestamp(permit['leaseExpiresAt']) ||
      Date.parse(permit['authorizedAt']) >= Date.parse(permit['leaseExpiresAt']) ||
      Date.parse(permit['deadlineAt']) - Date.parse(permit['authorizedAt']) !==
        GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS * 1_000) return null;
  return Object.freeze({
    userId: permit['userId'], approvalId: permit['approvalId'],
    admissionId: permit['admissionId'], messageRefId: permit['messageRefId'],
    workKind: 'observe_dispatch', barrierStatus: 'in_progress',
    attemptPhase: 'dispatch_may_have_started', phaseChangedAt: permit['phaseChangedAt'],
    leaseToken: permit['leaseToken'], generation: permit['generation'] as number,
    observationAttemptId: permit['observationAttemptId'], authorizedAt: permit['authorizedAt'],
    leaseExpiresAt: permit['leaseExpiresAt'], deadlineAt: permit['deadlineAt'],
  });
}

function snapshotSelection(
  value: unknown,
): Readonly<GmailArchiveRecoveryObservationSelection> | null {
  const selection = ownData(value, [
    'connectorAccountId', 'credentialRevision', 'providerMessageId',
  ]);
  if (!selection || typeof selection['connectorAccountId'] !== 'string' ||
      !UUID.test(selection['connectorAccountId']) ||
      typeof selection['credentialRevision'] !== 'string' ||
      !UUID.test(selection['credentialRevision']) ||
      typeof selection['providerMessageId'] !== 'string' ||
      selection['providerMessageId'].length === 0 ||
      selection['providerMessageId'].length > 2_048) return null;
  try {
    encodeURIComponent(selection['providerMessageId']);
  } catch {
    return null;
  }
  return Object.freeze({
    connectorAccountId: selection['connectorAccountId'],
    credentialRevision: selection['credentialRevision'],
    providerMessageId: selection['providerMessageId'],
  });
}

function snapshotFinalInput(value: unknown): Readonly<FinalTargetSnapshot> | null {
  const input = ownData(value, ['credentialRevision', 'permit', 'selection']);
  if (!input || typeof input['credentialRevision'] !== 'string' ||
      !UUID.test(input['credentialRevision'])) return null;
  const permit = snapshotPermit(input['permit']);
  const selection = snapshotSelection(input['selection']);
  return permit && selection ? Object.freeze({
    permit, selection, credentialRevision: input['credentialRevision'],
  }) : null;
}

function canonicalArchiveParameters(messageRefId: string): string {
  return JSON.stringify({
    schema: GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
    messageRefId,
    operation: 'archive',
    domain: 'email',
    costZeroIntent: 'verified_zero',
    provenance: 'untrusted_external',
  });
}

async function resolvePermitInTransaction(
  client: PoolClient,
  permit: Readonly<GmailArchiveRecoveryObservationPermit>,
  expected: Readonly<{
    selection: Readonly<GmailArchiveRecoveryObservationSelection>;
    credentialRevision: string;
  }> | null,
): Promise<Readonly<GmailArchiveRecoveryObservationSelection> | null> {
  const rows = (await client.query<GmailInboxObservationTargetRow>(
    `SELECT ref.connector_account_id, token.credential_revision, ref.provider_message_id
       FROM gmail_archive_recovery_leases AS lease
       JOIN pre_effect_barriers AS barrier
         ON barrier.id = lease.admission_id AND barrier.user_id = lease.user_id
        AND barrier.idempotency_key = lease.approval_id
       JOIN candidate_actions AS candidate ON candidate.id = barrier.action_id
       JOIN decisions AS decision
         ON decision.id = barrier.decision_id AND decision.id = candidate.decision_id
        AND decision.user_id = barrier.user_id
       JOIN signals AS signal
         ON signal.user_id = decision.user_id AND signal.source = 'gmail'
        AND (signal.id::STRING = decision.signal_id OR signal.source_signal_id = decision.signal_id)
       JOIN gmail_message_refs AS ref
         ON ref.id = signal.resource_ref_id AND ref.id = lease.message_ref_id
        AND ref.user_id = signal.user_id AND ref.connector_account_id = signal.connector_account_id
        AND ref.source_signal_id = signal.source_signal_id
       JOIN connected_accounts AS account
         ON account.id = ref.connector_account_id AND account.user_id = ref.user_id
        AND account.provider = ref.provider
       JOIN oauth_tokens AS token
         ON token.connector_account_id = account.id AND token.user_id = account.user_id
        AND token.provider = account.provider
      WHERE lease.admission_id = $1 AND lease.user_id = $2 AND lease.approval_id = $3
        AND lease.message_ref_id = $4 AND lease.work_kind = $5
        AND lease.barrier_status = $6 AND lease.attempt_phase IS NOT DISTINCT FROM $7
        AND lease.phase_changed_at = $8::TIMESTAMPTZ
        AND lease.lease_token = $9 AND lease.generation = $10::INT8
        AND lease.observation_attempt_id = $11
        AND lease.observation_authorized_at = $12::TIMESTAMPTZ
        AND lease.observation_deadline_at = $13::TIMESTAMPTZ
        AND lease.expires_at = $14::TIMESTAMPTZ AND lease.observation_state = 'started'
        AND lease.expires_at > statement_timestamp()
        AND lease.observation_deadline_at > statement_timestamp()
        AND barrier.status = 'in_progress' AND barrier.effect_type = 'event_execution'
        AND barrier.updated_at = lease.phase_changed_at
        AND barrier.failure_reason IS NULL AND barrier.effect_result = $15::JSONB
        AND candidate.action_type = 'archive_email' AND candidate.parameters = $16::JSONB
        AND candidate.reversible = true AND candidate.estimated_cost IS NULL
        AND decision.raw_event->>'messageRefId' = ref.id::STRING
        AND ref.provider = 'google' AND account.is_active = true
        AND account.identity_verified = true AND account.disconnected_at IS NULL
        AND $17::STRING = ANY(account.scopes) AND $17::STRING = ANY(token.scopes)
        AND ($18::UUID IS NULL OR ref.connector_account_id = $18::UUID)
        AND ($19::STRING IS NULL OR ref.provider_message_id = $19::STRING)
        AND ($20::UUID IS NULL OR token.credential_revision = $20::UUID)
      LIMIT 2`,
    [
      permit.admissionId, permit.userId, permit.approvalId, permit.messageRefId,
      permit.workKind, permit.barrierStatus, permit.attemptPhase, permit.phaseChangedAt,
      permit.leaseToken, permit.generation, permit.observationAttemptId, permit.authorizedAt,
      permit.deadlineAt, permit.leaseExpiresAt,
      JSON.stringify({ schema: GMAIL_ARCHIVE_ATTEMPT_SCHEMA, phase: 'dispatch_may_have_started' }),
      canonicalArchiveParameters(permit.messageRefId), GMAIL_MODIFY_SCOPE,
      expected?.selection.connectorAccountId ?? null,
      expected?.selection.providerMessageId ?? null,
      expected?.credentialRevision ?? null,
    ],
  )).rows;
  if (rows.length !== 1 || typeof rows[0]!.connector_account_id !== 'string' ||
      !UUID.test(rows[0]!.connector_account_id) ||
      typeof rows[0]!.credential_revision !== 'string' ||
      !UUID.test(rows[0]!.credential_revision) ||
      typeof rows[0]!.provider_message_id !== 'string' ||
      rows[0]!.provider_message_id.length === 0 ||
      rows[0]!.provider_message_id.length > 2_048) return null;
  try {
    encodeURIComponent(rows[0]!.provider_message_id);
  } catch {
    return null;
  }
  return Object.freeze({
    connectorAccountId: rows[0]!.connector_account_id,
    credentialRevision: rows[0]!.credential_revision,
    providerMessageId: rows[0]!.provider_message_id,
  });
}

async function retrySerializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

async function resolveInitialWithTransaction(
  submitted: GmailArchiveRecoveryObservationPermit,
  transaction: ObservationTargetTransaction = withTransaction,
): Promise<Readonly<GmailArchiveRecoveryObservationSelection> | null> {
  const permit = snapshotPermit(submitted);
  if (!permit) return null;
  return retrySerializable(() => transaction((client) => resolvePermitInTransaction(
    client, permit, null,
  )));
}

async function resolveFinalWithTransaction(
  submitted: GmailArchiveRecoveryObservationFinalTargetInput,
  transaction: ObservationTargetTransaction = withTransaction,
): Promise<Readonly<GmailArchiveRecoveryObservationSelection> | null> {
  const input = snapshotFinalInput(submitted);
  if (!input) return null;
  return retrySerializable(() => transaction((client) => resolvePermitInTransaction(
    client,
    input.permit,
    Object.freeze({ selection: input.selection, credentialRevision: input.credentialRevision }),
  )));
}

function snapshotCommand(value: unknown): Readonly<GmailInboxObservationCommand> | null {
  const command = ownData(value, ['admissionId', 'messageRefId', 'operation', 'userId']);
  if (!command || typeof command['userId'] !== 'string' || !UUID.test(command['userId']) ||
      typeof command['admissionId'] !== 'string' || !UUID.test(command['admissionId']) ||
      typeof command['messageRefId'] !== 'string' || !UUID.test(command['messageRefId']) ||
      command['operation'] !== 'observe_inbox') return null;
  return Object.freeze({
    userId: command['userId'], admissionId: command['admissionId'],
    messageRefId: command['messageRefId'], operation: 'observe_inbox',
  });
}

async function resolveLegacyInTransaction(
  client: PoolClient,
  command: Readonly<GmailInboxObservationCommand>,
): Promise<Readonly<GmailInboxObservationTarget> | null> {
  const barriers = (await client.query<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM pre_effect_barriers
      WHERE id = $1 AND user_id = $2 AND effect_type = 'event_execution'
        AND status = 'in_progress' AND failure_reason IS NULL
        AND effect_result = $3::JSONB`,
    [command.admissionId, command.userId, JSON.stringify({
      schema: GMAIL_ARCHIVE_ATTEMPT_SCHEMA, phase: 'dispatch_may_have_started',
    })],
  )).rows;
  if (barriers.length !== 1 || !UUID.test(barriers[0]!.idempotency_key)) return null;
  const recovery = await queryAbandonedGmailArchiveInTransaction(client, {
    userId: command.userId, approvalId: barriers[0]!.idempotency_key,
  });
  if (!recovery.ok || recovery.status !== 'eligible' ||
      recovery.recovery.phase !== 'dispatch_may_have_started' ||
      recovery.recovery.command.userId !== command.userId ||
      recovery.recovery.command.admissionId !== command.admissionId ||
      recovery.recovery.command.messageRefId !== command.messageRefId ||
      recovery.recovery.command.operation !== 'archive') return null;
  const targets = (await client.query<GmailInboxObservationTargetRow>(
    `SELECT ref.connector_account_id, token.credential_revision, ref.provider_message_id
       FROM pre_effect_barriers AS barrier
       JOIN candidate_actions AS candidate ON candidate.id = barrier.action_id
       JOIN decisions AS decision ON decision.id = barrier.decision_id
        AND decision.id = candidate.decision_id AND decision.user_id = barrier.user_id
       JOIN signals AS signal ON signal.user_id = decision.user_id AND signal.source = 'gmail'
        AND (signal.id::STRING = decision.signal_id OR signal.source_signal_id = decision.signal_id)
       JOIN gmail_message_refs AS ref ON ref.id = signal.resource_ref_id AND ref.id = $3
        AND ref.user_id = signal.user_id AND ref.connector_account_id = signal.connector_account_id
        AND ref.source_signal_id = signal.source_signal_id
       JOIN connected_accounts AS account ON account.id = ref.connector_account_id
        AND account.user_id = ref.user_id AND account.provider = ref.provider
       JOIN oauth_tokens AS token ON token.connector_account_id = account.id
        AND token.user_id = account.user_id AND token.provider = account.provider
      WHERE barrier.id = $1 AND barrier.user_id = $2 AND barrier.idempotency_key = $4
        AND barrier.status = 'in_progress' AND barrier.effect_type = 'event_execution'
        AND barrier.failure_reason IS NULL AND barrier.effect_result = $5::JSONB
        AND candidate.action_type = 'archive_email' AND candidate.parameters = $6::JSONB
        AND candidate.reversible = true AND candidate.estimated_cost IS NULL
        AND decision.raw_event->>'messageRefId' = ref.id::STRING AND ref.provider = 'google'
        AND account.is_active = true AND account.identity_verified = true
        AND account.disconnected_at IS NULL AND $7::STRING = ANY(account.scopes)
        AND $7::STRING = ANY(token.scopes) LIMIT 2`,
    [
      command.admissionId, command.userId, command.messageRefId, barriers[0]!.idempotency_key,
      JSON.stringify({ schema: GMAIL_ARCHIVE_ATTEMPT_SCHEMA, phase: 'dispatch_may_have_started' }),
      canonicalArchiveParameters(command.messageRefId), GMAIL_MODIFY_SCOPE,
    ],
  )).rows;
  const target = targets.length === 1 ? targets[0]! : null;
  if (!target || typeof target.connector_account_id !== 'string' ||
      !UUID.test(target.connector_account_id) || typeof target.credential_revision !== 'string' ||
      !UUID.test(target.credential_revision) || typeof target.provider_message_id !== 'string' ||
      target.provider_message_id.length === 0 || target.provider_message_id.length > 2_048) return null;
  try { encodeURIComponent(target.provider_message_id); } catch { return null; }
  return Object.freeze({
    connectorAccountId: target.connector_account_id,
    credentialRevision: target.credential_revision,
    providerMessageId: target.provider_message_id,
  });
}

async function resolveLegacyWithTransaction(
  submitted: GmailInboxObservationCommand,
  transaction: ObservationTargetTransaction = withTransaction,
): Promise<Readonly<GmailInboxObservationTarget> | null> {
  const command = snapshotCommand(submitted);
  if (!command) return null;
  return retrySerializable(() => transaction((client) => resolveLegacyInTransaction(client, command)));
}

export const gmailInboxObservationTargetTestHooks = {
  resolvePermitInTransaction,
  resolveInitialWithTransaction,
  resolveFinalWithTransaction,
  snapshotFinalInput,
  resolveLegacyInTransaction,
  resolveLegacyWithTransaction,
  snapshotPermit,
  snapshotSelection,
};

export const gmailInboxObservationTargetRepository = Object.freeze({
  resolve(command: GmailInboxObservationCommand) {
    return resolveLegacyWithTransaction(command);
  },
  resolveInitial(permit: GmailArchiveRecoveryObservationPermit) {
    return resolveInitialWithTransaction(permit);
  },
  resolveFinal(input: GmailArchiveRecoveryObservationFinalTargetInput) {
    return resolveFinalWithTransaction(input);
  },
});
