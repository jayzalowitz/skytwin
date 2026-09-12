import {
  GMAIL_ARCHIVE_ATTEMPT_SCHEMA,
  GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
  type GmailInboxObservationCommand,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';
import { queryAbandonedGmailArchiveInTransaction } from './gmail-archive-recovery-repository.js';

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface GmailInboxObservationTarget {
  connectorAccountId: string;
  credentialRevision: string;
  providerMessageId: string;
}

interface GmailInboxObservationTargetRow {
  connector_account_id: string;
  credential_revision: string;
  provider_message_id: string;
}

type ObservationTargetTransaction = <T>(
  callback: (client: PoolClient) => Promise<T>,
) => Promise<T>;

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

function snapshotCommand(value: unknown): Readonly<GmailInboxObservationCommand> | null {
  const command = ownData(value, ['admissionId', 'messageRefId', 'operation', 'userId']);
  if (!command || typeof command['userId'] !== 'string' || !UUID.test(command['userId']) ||
      typeof command['admissionId'] !== 'string' || !UUID.test(command['admissionId']) ||
      typeof command['messageRefId'] !== 'string' || !UUID.test(command['messageRefId']) ||
      command['operation'] !== 'observe_inbox') return null;
  return Object.freeze({
    userId: command['userId'],
    admissionId: command['admissionId'],
    messageRefId: command['messageRefId'],
    operation: 'observe_inbox',
  });
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

async function resolveInTransaction(
  client: PoolClient,
  command: Readonly<GmailInboxObservationCommand>,
): Promise<Readonly<GmailInboxObservationTarget> | null> {
  const barriers = (await client.query<{ idempotency_key: string }>(
    `SELECT idempotency_key
       FROM pre_effect_barriers
      WHERE id = $1 AND user_id = $2 AND effect_type = 'event_execution'
        AND status = 'in_progress' AND failure_reason IS NULL
        AND effect_result = $3::JSONB`,
    [
      command.admissionId,
      command.userId,
      JSON.stringify({
        schema: GMAIL_ARCHIVE_ATTEMPT_SCHEMA,
        phase: 'dispatch_may_have_started',
      }),
    ],
  )).rows;
  if (barriers.length !== 1 || !UUID.test(barriers[0]!.idempotency_key)) return null;

  // The recovery query is the source of truth for the entire durable graph,
  // its receipt chain, the DB-clock grace period, and the absence of a
  // terminal result. Observation adds live connector authority; it does not
  // weaken or duplicate those checks.
  const recovery = await queryAbandonedGmailArchiveInTransaction(client, {
    userId: command.userId,
    approvalId: barriers[0]!.idempotency_key,
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
       JOIN candidate_actions AS candidate
         ON candidate.id = barrier.action_id
       JOIN decisions AS decision
         ON decision.id = barrier.decision_id
        AND decision.id = candidate.decision_id
        AND decision.user_id = barrier.user_id
       JOIN signals AS signal
         ON signal.user_id = decision.user_id
        AND signal.source = 'gmail'
        AND (signal.id::STRING = decision.signal_id OR signal.source_signal_id = decision.signal_id)
       JOIN gmail_message_refs AS ref
         ON ref.id = signal.resource_ref_id
        AND ref.id = $3
        AND ref.user_id = signal.user_id
        AND ref.connector_account_id = signal.connector_account_id
        AND ref.source_signal_id = signal.source_signal_id
       JOIN connected_accounts AS account
         ON account.id = ref.connector_account_id
        AND account.user_id = ref.user_id
        AND account.provider = ref.provider
       JOIN oauth_tokens AS token
         ON token.connector_account_id = account.id
        AND token.user_id = account.user_id
        AND token.provider = account.provider
      WHERE barrier.id = $1
        AND barrier.user_id = $2
        AND barrier.idempotency_key = $4
        AND barrier.status = 'in_progress'
        AND barrier.effect_type = 'event_execution'
        AND barrier.failure_reason IS NULL
        AND barrier.effect_result = $5::JSONB
        AND candidate.action_type = 'archive_email'
        AND candidate.parameters = $6::JSONB
        AND candidate.reversible = true
        AND candidate.estimated_cost IS NULL
        AND decision.raw_event->>'messageRefId' = ref.id::STRING
        AND ref.provider = 'google'
        AND account.is_active = true
        AND account.identity_verified = true
        AND account.disconnected_at IS NULL
        AND $7::STRING = ANY(account.scopes)
        AND $7::STRING = ANY(token.scopes)
      LIMIT 2`,
    [
      command.admissionId,
      command.userId,
      command.messageRefId,
      barriers[0]!.idempotency_key,
      JSON.stringify({
        schema: GMAIL_ARCHIVE_ATTEMPT_SCHEMA,
        phase: 'dispatch_may_have_started',
      }),
      canonicalArchiveParameters(command.messageRefId),
      GMAIL_MODIFY_SCOPE,
    ],
  )).rows;
  if (targets.length !== 1 || !UUID.test(targets[0]!.connector_account_id) ||
      !UUID.test(targets[0]!.credential_revision) ||
      targets[0]!.provider_message_id.length === 0 ||
      targets[0]!.provider_message_id.length > 2_048) return null;
  try {
    encodeURIComponent(targets[0]!.provider_message_id);
  } catch {
    return null;
  }
  return Object.freeze({
    connectorAccountId: targets[0]!.connector_account_id,
    credentialRevision: targets[0]!.credential_revision,
    providerMessageId: targets[0]!.provider_message_id,
  });
}

async function resolveWithTransaction(
  submitted: GmailInboxObservationCommand,
  transactionFn: ObservationTargetTransaction = withTransaction,
): Promise<Readonly<GmailInboxObservationTarget> | null> {
  const command = snapshotCommand(submitted);
  if (!command) return null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transactionFn((client) => resolveInTransaction(client, command));
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

export const gmailInboxObservationTargetTestHooks = {
  resolveInTransaction,
  resolveWithTransaction,
};

export const gmailInboxObservationTargetRepository = {
  async resolve(
    command: GmailInboxObservationCommand,
  ): Promise<Readonly<GmailInboxObservationTarget> | null> {
    return resolveWithTransaction(command);
  },
};
