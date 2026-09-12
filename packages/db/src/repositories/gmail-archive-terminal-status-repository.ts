import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';
import type { DecisionReceiptRevisionRow } from '../types.js';
import {
  canonicalGmailArchiveApprovalContent,
  loadCanonicalGmailArchiveApprovalStateReadOnly,
} from './gmail-archive-approval-response-repository.js';
import {
  exactReservedGmailArchiveBarrier,
  loadGmailArchivePreparationReplay,
} from './gmail-archive-preparation-repository.js';
import { queryAbandonedGmailArchiveInTransaction } from './gmail-archive-recovery-repository.js';
import {
  validateStoredGmailArchiveTerminalGraphReadOnly,
} from './gmail-archive-reconciliation-repository.js';
import {
  exactGmailArchiveApprovedPrefix,
  loadGmailArchiveStableState,
} from './gmail-archive-terminalization-repository.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ReadGmailArchiveTerminalStatusInput {
  userId: string;
  approvalId: string;
}

export interface GmailArchiveVisibleTerminalStatus {
  disposition: 'blocked' | 'succeeded' | 'failed' | 'unknown';
  receiptRevisionId: string;
  recordedAt: string;
}

export type ReadGmailArchiveTerminalStatusResult =
  | {
      ok: true;
      status: 'terminal';
      terminal: Readonly<GmailArchiveVisibleTerminalStatus>;
    }
  | { ok: true; status: 'not_terminal'; terminal: null }
  | { ok: false; error: 'invalid_input' | 'not_found' | 'integrity_conflict' };

export interface GmailArchiveTerminalStatusReaderPort {
  read(
    input: ReadGmailArchiveTerminalStatusInput,
  ): Promise<ReadGmailArchiveTerminalStatusResult>;
}

type Transaction = <T>(callback: (client: PoolClient) => Promise<T>) => Promise<T>;

interface ReaderDependencies {
  loadApprovalState: typeof loadCanonicalGmailArchiveApprovalStateReadOnly;
  canonicalApprovalContent: typeof canonicalGmailArchiveApprovalContent;
  exactReservedBarrier: typeof exactReservedGmailArchiveBarrier;
  loadPreparationReplay: typeof loadGmailArchivePreparationReplay;
  queryRecovery: typeof queryAbandonedGmailArchiveInTransaction;
  loadTerminalState: typeof loadGmailArchiveStableState;
  exactApprovedPrefix: typeof exactGmailArchiveApprovedPrefix;
  validateTerminalGraph: typeof validateStoredGmailArchiveTerminalGraphReadOnly;
  correlatedBlockedTimestamps: typeof correlatedBlockedTimestamps;
  canonicalTerminalTimestamps: typeof canonicalTerminalTimestamps;
}

const dependencies: Readonly<ReaderDependencies> = Object.freeze({
  loadApprovalState: loadCanonicalGmailArchiveApprovalStateReadOnly,
  canonicalApprovalContent: canonicalGmailArchiveApprovalContent,
  exactReservedBarrier: exactReservedGmailArchiveBarrier,
  loadPreparationReplay: loadGmailArchivePreparationReplay,
  queryRecovery: queryAbandonedGmailArchiveInTransaction,
  loadTerminalState: loadGmailArchiveStableState,
  exactApprovedPrefix: exactGmailArchiveApprovedPrefix,
  validateTerminalGraph: validateStoredGmailArchiveTerminalGraphReadOnly,
  correlatedBlockedTimestamps,
  canonicalTerminalTimestamps,
});

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

function snapshotInput(value: unknown): Readonly<ReadGmailArchiveTerminalStatusInput> | null {
  const input = ownData(value, ['approvalId', 'userId']);
  if (!input || typeof input['approvalId'] !== 'string' || !UUID.test(input['approvalId']) ||
      typeof input['userId'] !== 'string' || !UUID.test(input['userId'])) return null;
  return Object.freeze({
    approvalId: input['approvalId'],
    userId: input['userId'],
  });
}

function exactDataObject(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function uuidField(value: unknown, field: string): string | null {
  const data = exactDataObject(value);
  const candidate = data?.[field];
  return typeof candidate === 'string' && UUID.test(candidate) ? candidate : null;
}

async function correlatedBlockedTimestamps(client: PoolClient, value: unknown): Promise<boolean> {
  const preparation = exactDataObject(value);
  const barrierId = uuidField(preparation?.['barrier'], 'id');
  const explanationId = uuidField(preparation?.['explanation'], 'id');
  const revisions = preparation?.['revisions'];
  const revisionId = Array.isArray(revisions) ? uuidField(revisions[4], 'id') : null;
  if (!barrierId || !explanationId || !revisionId) return false;
  const row = (await client.query<{ correlated: boolean }>(`SELECT COALESCE((SELECT
      barrier.updated_at = explanation.created_at
        AND explanation.created_at = revision.created_at
      FROM pre_effect_barriers AS barrier
      JOIN explanation_records AS explanation ON explanation.id = $2
      JOIN decision_receipt_revisions AS revision ON revision.id = $3
      WHERE barrier.id = $1), false) AS correlated`, [
    barrierId,
    explanationId,
    revisionId,
  ])).rows[0];
  return row?.correlated === true;
}

async function canonicalTerminalTimestamps(client: PoolClient, value: unknown): Promise<boolean> {
  const terminal = exactDataObject(value);
  const barrierId = uuidField(terminal?.['barrier'], 'id');
  const planId = uuidField(terminal?.['plan'], 'id');
  const explanationId = uuidField(terminal?.['executionExplanation'], 'id');
  const revisionId = uuidField(terminal?.['revision'], 'id');
  const rawResult = terminal?.['executionResult'];
  const resultId = rawResult === null ? null : uuidField(rawResult, 'id');
  if (!barrierId || !planId || !explanationId || !revisionId ||
      (rawResult !== null && !resultId)) return false;
  const row = (await client.query<{
    barrier: boolean;
    explanation: boolean;
    plan: boolean;
    result: boolean;
    revision: boolean;
  }>(`SELECT
      COALESCE((SELECT updated_at = date_trunc('milliseconds', updated_at)
        FROM pre_effect_barriers WHERE id = $1), false) AS barrier,
      COALESCE((SELECT updated_at = date_trunc('milliseconds', updated_at)
        FROM execution_plans WHERE id = $2), false) AS plan,
      COALESCE((SELECT created_at = date_trunc('milliseconds', created_at)
        FROM explanation_records WHERE id = $3), false) AS explanation,
      COALESCE((SELECT created_at = date_trunc('milliseconds', created_at)
        FROM decision_receipt_revisions WHERE id = $4), false) AS revision,
      CASE WHEN $5::UUID IS NULL THEN true ELSE COALESCE((SELECT
        completed_at = date_trunc('milliseconds', completed_at)
        FROM execution_results WHERE id = $5), false) END AS result`, [
    barrierId,
    planId,
    explanationId,
    revisionId,
    resultId,
  ])).rows[0];
  return row?.barrier === true && row.plan === true && row.explanation === true &&
    row.revision === true && row.result === true;
}

function visibleTerminal(
  disposition: GmailArchiveVisibleTerminalStatus['disposition'],
  revisionValue: unknown,
): ReadGmailArchiveTerminalStatusResult | null {
  const revision = exactDataObject(revisionValue);
  const createdAt = revision?.['created_at'];
  if (!revision || revision['stage'] !== (disposition === 'blocked'
    ? 'policy_evaluated'
    : 'execution_recorded') || revision['disposition'] !== disposition ||
      revision['trusted'] !== true || typeof revision['id'] !== 'string' ||
      !UUID.test(revision['id']) || !(createdAt instanceof Date) ||
      !Number.isFinite(createdAt.getTime())) return null;
  const terminal = Object.freeze({
    disposition,
    receiptRevisionId: revision['id'],
    recordedAt: createdAt.toISOString(),
  });
  return Object.freeze({ ok: true, status: 'terminal', terminal });
}

function notTerminal(): ReadGmailArchiveTerminalStatusResult {
  return Object.freeze({ ok: true, status: 'not_terminal', terminal: null });
}

function integrityConflict(): ReadGmailArchiveTerminalStatusResult {
  return Object.freeze({ ok: false, error: 'integrity_conflict' });
}

async function readTransition(
  client: PoolClient,
  input: Readonly<ReadGmailArchiveTerminalStatusInput>,
  readerDependencies: Readonly<ReaderDependencies> = dependencies,
): Promise<ReadGmailArchiveTerminalStatusResult> {
  const barriers = (await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE user_id = $1 AND idempotency_key = $2
        AND effect_type = 'event_execution'
      ORDER BY id ASC
      LIMIT 2`,
    [input.userId, input.approvalId],
  )).rows;
  if (barriers.length === 0) return Object.freeze({ ok: false, error: 'not_found' });
  if (barriers.length !== 1) return integrityConflict();
  const barrier = barriers[0]!;

  if (barrier.status === 'reserved' || barrier.status === 'prepared' ||
      barrier.status === 'blocked') {
    const state = await readerDependencies.loadApprovalState(client, {
      userId: input.userId,
      approvalId: input.approvalId,
      action: 'approve',
    }, {
      allowExecutionPlan: barrier.status !== 'reserved',
    });
    if (!state) return integrityConflict();
    if (barrier.status === 'reserved' && state.revisions.length !== 4) {
      return integrityConflict();
    }
    const approved = readerDependencies.canonicalApprovalContent({
      ...state,
      revisions: state.revisions.slice(0, 4),
    }, 'approved');
    if (!approved) return integrityConflict();
    if (barrier.status === 'reserved') {
      if (!readerDependencies.exactReservedBarrier(barrier, input)) {
        return integrityConflict();
      }
      const counts = (await client.query<{
        approvals: string;
        barriers: string;
        explanations: string;
        plans: string;
      }>(`SELECT
          (SELECT count(*) FROM approval_requests WHERE decision_id = $1) AS approvals,
          (SELECT count(*) FROM pre_effect_barriers
            WHERE decision_id = $1 OR id = $2) AS barriers,
          (SELECT count(*) FROM explanation_records WHERE decision_id = $1) AS explanations,
          (SELECT count(*) FROM execution_plans WHERE decision_id = $1) AS plans`, [
        state.decision.id,
        barrier.id,
      ])).rows[0];
      return counts?.approvals === '1' && counts.barriers === '2' &&
        counts.explanations === '1' && counts.plans === '0'
        ? notTerminal()
        : integrityConflict();
    }
    const replay = await readerDependencies.loadPreparationReplay(
      client,
      input,
      state,
      barrier,
      approved,
    );
    const replayData = exactDataObject(replay);
    const preparation = exactDataObject(replayData?.['preparation']);
    if (replayData?.['ok'] !== true || preparation?.['status'] !== barrier.status) {
      return integrityConflict();
    }
    if (barrier.status === 'prepared') return notTerminal();
    const revisions = preparation['revisions'];
    const r5: DecisionReceiptRevisionRow | undefined = Array.isArray(revisions)
      ? revisions[4] as DecisionReceiptRevisionRow | undefined
      : undefined;
    if (!await readerDependencies.correlatedBlockedTimestamps(client, replayData?.['preparation'])) {
      return integrityConflict();
    }
    return visibleTerminal('blocked', r5) ?? integrityConflict();
  }

  if (barrier.status === 'in_progress') {
    const recovery = await readerDependencies.queryRecovery(client, input);
    const recoveryData = exactDataObject(recovery);
    return recoveryData?.['ok'] === true &&
      (recoveryData['status'] === 'not_due' || recoveryData['status'] === 'eligible')
      ? notTerminal()
      : integrityConflict();
  }

  if (barrier.status === 'succeeded' || barrier.status === 'failed' ||
      barrier.status === 'unknown') {
    const authority = Object.freeze({
      userId: input.userId,
      approvalId: input.approvalId,
    });
    const state = await readerDependencies.loadTerminalState(client, authority, false);
    if (!state) return integrityConflict();
    const approved = readerDependencies.exactApprovedPrefix(state);
    if (!approved) return integrityConflict();
    const terminal = await readerDependencies.validateTerminalGraph(
      client,
      authority,
      state,
      barrier,
      approved,
    );
    const terminalData = exactDataObject(terminal);
    if (terminalData?.['status'] !== barrier.status) return integrityConflict();
    if (!await readerDependencies.canonicalTerminalTimestamps(client, terminal)) {
      return integrityConflict();
    }
    return visibleTerminal(barrier.status, terminalData['revision']) ?? integrityConflict();
  }

  return integrityConflict();
}

async function readWithTransition(
  submitted: ReadGmailArchiveTerminalStatusInput,
  transition: (
    client: PoolClient,
    input: Readonly<ReadGmailArchiveTerminalStatusInput>,
  ) => Promise<ReadGmailArchiveTerminalStatusResult> = readTransition,
  transaction: Transaction = withTransaction,
): Promise<ReadGmailArchiveTerminalStatusResult> {
  const input = snapshotInput(submitted);
  if (!input) return Object.freeze({ ok: false, error: 'invalid_input' });
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transaction((client) => transition(client, input));
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

export const gmailArchiveTerminalStatusTestHooks = Object.freeze({
  readTransition,
  readWithTransition,
  snapshotInput,
  visibleTerminal,
});

export const gmailArchiveTerminalStatusRepository: GmailArchiveTerminalStatusReaderPort =
  Object.freeze({
    read(input: ReadGmailArchiveTerminalStatusInput) {
      return readWithTransition(input);
    },
  });
