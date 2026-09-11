import type { PoolClient } from 'pg';
import {
  GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
  type GmailInboxMutationCommand,
} from '@skytwin/shared-types';
import { query, withTransaction } from '../connection.js';
import type { GmailMessageRefRow, SignalRow } from '../types.js';
import { signalRepository } from './signal-repository.js';

export interface PersistGmailEvidenceInput {
  userId: string;
  connectorAccountId: string;
  sourceSignalId: string;
  providerMessageId: string;
  providerThreadId?: string | null;
  authoringTier: string;
  observedInInbox: boolean;
  observedAt: Date;
  signalTimestamp: Date;
  signalType: string;
  signalData: Record<string, unknown>;
  retentionDays?: number;
}

export type PersistGmailEvidenceResult =
  | { ok: true; messageRef: GmailMessageRefRow; signal: SignalRow; created: boolean }
  | { ok: false; error: 'account_not_active' | 'source_binding_conflict' | 'immutable_binding_conflict' };

interface GmailInboxMutationTarget {
  connectorAccountId: string;
  providerMessageId: string;
}

interface GmailInboxMutationTargetRow {
  connector_account_id: string;
  provider_message_id: string;
}

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

function canonicalMutationParameters(input: GmailInboxMutationCommand): string {
  return JSON.stringify({
    schema: GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
    messageRefId: input.messageRefId,
    operation: input.operation,
    domain: 'email',
    costZeroIntent: 'verified_zero',
    provenance: 'untrusted_external',
  });
}

class EvidenceBindingError extends Error {
  constructor(readonly code: 'account_not_active' | 'source_binding_conflict' | 'immutable_binding_conflict') {
    super(code);
  }
}

async function persistInTransaction(
  client: PoolClient,
  input: PersistGmailEvidenceInput,
): Promise<Extract<PersistGmailEvidenceResult, { ok: true }>> {
  const messageRefResult = await client.query<GmailMessageRefRow>(
    `INSERT INTO gmail_message_refs (
       user_id, connector_account_id, provider, provider_message_id,
       provider_thread_id, source_signal_id, authoring_tier,
       last_observed_inbox, first_observed_at, last_observed_at
     )
     SELECT $1, ca.id, 'google', $3, $4, $5, $6, $7, $8, $8
       FROM connected_accounts AS ca
      WHERE ca.id = $2 AND ca.user_id = $1 AND ca.provider = 'google'
        AND ca.is_active = true AND ca.identity_verified = true
     ON CONFLICT (connector_account_id, provider_message_id) DO UPDATE SET
       last_observed_inbox = CASE
         WHEN EXCLUDED.last_observed_at > gmail_message_refs.last_observed_at
           THEN EXCLUDED.last_observed_inbox
         ELSE gmail_message_refs.last_observed_inbox
       END,
       last_observed_at = GREATEST(gmail_message_refs.last_observed_at, EXCLUDED.last_observed_at),
       updated_at = now()
     RETURNING *`,
    [
      input.userId,
      input.connectorAccountId,
      input.providerMessageId,
      input.providerThreadId ?? null,
      input.sourceSignalId,
      input.authoringTier,
      input.observedInInbox,
      input.observedAt,
    ],
  );
  const messageRef = messageRefResult.rows[0];
  if (!messageRef) throw new EvidenceBindingError('account_not_active');
  if (messageRef.source_signal_id !== input.sourceSignalId) {
    throw new EvidenceBindingError('source_binding_conflict');
  }
  if (
    messageRef.authoring_tier !== input.authoringTier ||
    messageRef.provider_thread_id !== (input.providerThreadId ?? null)
  ) {
    throw new EvidenceBindingError('immutable_binding_conflict');
  }

  const persisted = await signalRepository.persistConnectorSignal(client, {
    userId: input.userId,
    signalType: input.signalType,
    signalData: input.signalData,
    timestamp: input.signalTimestamp,
    retentionDays: input.retentionDays,
    connectorAccountId: input.connectorAccountId,
    sourceSignalId: input.sourceSignalId,
    resourceRefId: messageRef.id,
  });
  if (!persisted) {
    throw new EvidenceBindingError('source_binding_conflict');
  }
  return {
    ok: true,
    messageRef,
    signal: persisted.signal,
    created: persisted.created,
  };
}

export const gmailMessageRefRepository = {
  /** Persist the durable target and Watch-visible signal before interpretation. */
  async persistEvidence(input: PersistGmailEvidenceInput): Promise<PersistGmailEvidenceResult> {
    try {
      return await withTransaction((client) => persistInTransaction(client, input));
    } catch (error) {
      if (error instanceof EvidenceBindingError) {
        return { ok: false, error: error.code };
      }
      // The reverse collision (same account/source_signal_id, different
      // provider message) is enforced by a second unique key and can race
      // between concurrent transactions. Map it to the same deterministic
      // binding conflict instead of leaking a raw 23505 as a 500.
      if ((error as { code?: unknown }).code === '23505') {
        return { ok: false, error: 'source_binding_conflict' };
      }
      throw error;
    }
  },

  async findOwned(
    userId: string,
    messageRefId: string,
    connectorAccountId?: string,
  ): Promise<GmailMessageRefRow | null> {
    // This read intentionally lives behind a transaction-free repository
    // method; it returns no credential and requires the authenticated owner.
    const params: unknown[] = [messageRefId, userId];
    let sql = 'SELECT * FROM gmail_message_refs WHERE id = $1 AND user_id = $2';
    if (connectorAccountId) {
      params.push(connectorAccountId);
      sql += ' AND connector_account_id = $3';
    }
    const result = await query<GmailMessageRefRow>(sql, params);
    return result.rows[0] ?? null;
  },

  /** Resolve the private native target only through an active admission. */
  async resolveInboxMutationTarget(
    input: GmailInboxMutationCommand,
  ): Promise<GmailInboxMutationTarget | null> {
    const result = await query<GmailInboxMutationTargetRow>(
      `SELECT ref.connector_account_id, ref.provider_message_id
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
          AND signal.source_signal_id = decision.signal_id
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
          AND barrier.status = 'in_progress'
          AND barrier.effect_type = 'event_execution'
          AND candidate.action_type = 'archive_email'
          AND candidate.parameters = $4::JSONB
          AND candidate.reversible = true
          AND candidate.estimated_cost IS NULL
          AND decision.raw_event->>'messageRefId' = ref.id::STRING
          AND ref.provider = 'google'
          AND account.is_active = true
          AND account.identity_verified = true
          AND $5 = ANY(account.scopes)
          AND $5 = ANY(token.scopes)
        LIMIT 2`,
      [
        input.admissionId,
        input.userId,
        input.messageRefId,
        canonicalMutationParameters(input),
        GMAIL_MODIFY_SCOPE,
      ],
    );
    if (result.rows.length !== 1) return null;
    const row = result.rows[0]!;
    return {
      connectorAccountId: row.connector_account_id,
      providerMessageId: row.provider_message_id,
    };
  },

};
