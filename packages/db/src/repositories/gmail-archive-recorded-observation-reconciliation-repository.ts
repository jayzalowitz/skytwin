import { randomUUID } from 'node:crypto';
import type { GmailArchiveRecoveryLeaseFence } from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../connection.js';
import {
  gmailArchiveReconciliationRollbackResult,
  reconcileRecordedGmailArchiveObservationInTransaction,
  type GmailArchiveReconciliationStableValues,
  type RecordedGmailArchiveObservationReconciliationTransitionResult,
} from './gmail-archive-reconciliation-repository.js';
import { snapshotGmailArchiveRecoveryLeaseFence } from './gmail-archive-recovery-lease-consumer.js';
import { GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS } from './gmail-archive-recovery-policy.js';
import { exactTimestampEpochMicroseconds } from './gmail-archive-recovery-time.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ReconcileRecordedGmailArchiveObservationResult =
  RecordedGmailArchiveObservationReconciliationTransitionResult;

export interface ReconcileRecordedGmailArchiveObservationPort {
  reconcileRecordedObservation(
    fence: GmailArchiveRecoveryLeaseFence,
  ): Promise<ReconcileRecordedGmailArchiveObservationResult>;
}

type RecordedObservationTransition = (
  client: PoolClient,
  fence: Readonly<GmailArchiveRecoveryLeaseFence>,
  stable: Readonly<GmailArchiveReconciliationStableValues>,
) => Promise<ReconcileRecordedGmailArchiveObservationResult>;

type Transaction = <T>(callback: (client: PoolClient) => Promise<T>) => Promise<T>;

function canonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function snapshotStableValues(
  value: unknown,
): Readonly<GmailArchiveReconciliationStableValues> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors).sort();
    const expected = ['explanationId', 'persistedAt', 'resultId', 'revisionId'];
    if (names.length !== expected.length ||
        names.some((name, index) => name !== expected[index])) return null;
    const values: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      values[name] = descriptor.value;
    }
    if (typeof values['explanationId'] !== 'string' || !UUID.test(values['explanationId']) ||
        typeof values['resultId'] !== 'string' || !UUID.test(values['resultId']) ||
        typeof values['revisionId'] !== 'string' || !UUID.test(values['revisionId']) ||
        new Set([
          values['explanationId'], values['resultId'], values['revisionId'],
        ]).size !== 3 || !canonicalIsoInstant(values['persistedAt'])) return null;
    return Object.freeze({
      explanationId: values['explanationId'],
      resultId: values['resultId'],
      revisionId: values['revisionId'],
      persistedAt: values['persistedAt'],
    });
  } catch {
    return null;
  }
}

function allocateStableValues(persistedAt: string): GmailArchiveReconciliationStableValues {
  return Object.freeze({
    explanationId: randomUUID(),
    resultId: randomUUID(),
    revisionId: randomUUID(),
    persistedAt,
  });
}

async function loadDatabasePersistedAt(): Promise<string> {
  const value = (await query<{ persisted_at: Date | string }>(
    'SELECT now() AS persisted_at',
  )).rows[0]?.persisted_at;
  const persistedAt = value instanceof Date ? value.toISOString() : value;
  if (!canonicalIsoInstant(persistedAt)) {
    throw new Error('Database did not return a canonical reconciliation timestamp');
  }
  return persistedAt;
}

function commitMayBeUnverified(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' && [
    '08000', '08001', '08003', '08004', '08006', '08007', '40003', '57P01',
  ].includes(code);
}

async function reconcileRecordedObservationWithTransition(
  submitted: GmailArchiveRecoveryLeaseFence,
  transition: RecordedObservationTransition = reconcileRecordedGmailArchiveObservationInTransaction,
  stableFactory: (
    persistedAt: string,
  ) => GmailArchiveReconciliationStableValues = allocateStableValues,
  persistedAtFactory: () => Promise<string> = loadDatabasePersistedAt,
  transaction: Transaction = withTransaction,
): Promise<ReconcileRecordedGmailArchiveObservationResult> {
  const fence = snapshotGmailArchiveRecoveryLeaseFence(submitted);
  if (!fence || fence.workKind !== 'observe_dispatch' ||
      fence.barrierStatus !== 'in_progress' ||
      fence.attemptPhase !== 'dispatch_may_have_started') {
    return { ok: false, error: 'invalid_input' };
  }
  const persistedAt = await persistedAtFactory();
  const stable = snapshotStableValues(stableFactory(persistedAt));
  const phaseChangedAtMicros = exactTimestampEpochMicroseconds(fence.phaseChangedAt);
  const persistedAtMicros = stable
    ? exactTimestampEpochMicroseconds(stable.persistedAt) : null;
  if (!stable || stable.persistedAt !== persistedAt || phaseChangedAtMicros === null ||
      persistedAtMicros === null) {
    return { ok: false, error: 'invalid_input' };
  }
  if (phaseChangedAtMicros +
      BigInt(GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS) * 1_000_000n > persistedAtMicros) {
    return { ok: false, error: 'not_ready' };
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transaction((client) => transition(client, fence, stable));
    } catch (error) {
      const rollback = gmailArchiveReconciliationRollbackResult(error);
      if (rollback) return rollback;
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === '40001' && attempt < 2) continue;
      if (commitMayBeUnverified(error)) return { ok: false, error: 'commit_unverified' };
      throw error;
    }
  }
}

export const gmailArchiveRecordedObservationReconciliationTestHooks = Object.freeze({
  reconcileRecordedObservationWithTransition,
  snapshotStableValues,
});

/**
 * Unwired DB-only handoff from an exact recovery fence to retained observation
 * evidence. No permit, attempt, or evidence is accepted from or returned to the
 * caller.
 */
export const gmailArchiveRecordedObservationReconciliationRepository:
ReconcileRecordedGmailArchiveObservationPort = Object.freeze({
  reconcileRecordedObservation(fence: GmailArchiveRecoveryLeaseFence) {
    return reconcileRecordedObservationWithTransition(fence);
  },
});
