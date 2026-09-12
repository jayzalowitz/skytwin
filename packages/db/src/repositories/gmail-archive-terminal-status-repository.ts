import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';
import type { DecisionReceiptRevisionRow } from '../types.js';
import {
  canonicalGmailArchiveApprovalContent,
  loadCanonicalGmailArchiveApprovalState,
} from './gmail-archive-approval-response-repository.js';
import {
  exactReservedGmailArchiveBarrier,
  loadGmailArchivePreparationReplay,
} from './gmail-archive-preparation-repository.js';
import { queryAbandonedGmailArchiveInTransaction } from './gmail-archive-recovery-repository.js';
import { validateStoredGmailArchiveTerminalGraph } from './gmail-archive-reconciliation-repository.js';
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
  loadApprovalState: typeof loadCanonicalGmailArchiveApprovalState;
  canonicalApprovalContent: typeof canonicalGmailArchiveApprovalContent;
  exactReservedBarrier: typeof exactReservedGmailArchiveBarrier;
  loadPreparationReplay: typeof loadGmailArchivePreparationReplay;
  queryRecovery: typeof queryAbandonedGmailArchiveInTransaction;
  loadTerminalState: typeof loadGmailArchiveStableState;
  exactApprovedPrefix: typeof exactGmailArchiveApprovedPrefix;
  validateTerminalGraph: typeof validateStoredGmailArchiveTerminalGraph;
}

const dependencies: Readonly<ReaderDependencies> = Object.freeze({
  loadApprovalState: loadCanonicalGmailArchiveApprovalState,
  canonicalApprovalContent: canonicalGmailArchiveApprovalContent,
  exactReservedBarrier: exactReservedGmailArchiveBarrier,
  loadPreparationReplay: loadGmailArchivePreparationReplay,
  queryRecovery: queryAbandonedGmailArchiveInTransaction,
  loadTerminalState: loadGmailArchiveStableState,
  exactApprovedPrefix: exactGmailArchiveApprovedPrefix,
  validateTerminalGraph: validateStoredGmailArchiveTerminalGraph,
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
      lockRows: false,
    });
    if (!state) return integrityConflict();
    const approved = readerDependencies.canonicalApprovalContent({
      ...state,
      revisions: state.revisions.slice(0, 4),
    }, 'approved');
    if (!approved) return integrityConflict();
    if (barrier.status === 'reserved') {
      return readerDependencies.exactReservedBarrier(barrier, input)
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
      { lockRows: false },
    );
    const terminalData = exactDataObject(terminal);
    if (terminalData?.['status'] !== barrier.status) return integrityConflict();
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
