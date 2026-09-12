import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptContentDigest,
  verifyJoinedDecisionReceiptChain,
  type JoinedDecisionReceiptContent,
  type JoinedDecisionReceiptContentV3,
} from '@skytwin/shared-types';
import { withTransaction } from '../connection.js';
import type { DecisionReceiptRevisionRow } from '../types.js';
import {
  canonicalGmailArchiveApprovalContent,
  loadCanonicalGmailArchiveApprovalState,
  type GmailArchiveApprovalCanonicalState,
} from './gmail-archive-approval-response-repository.js';
import {
  loadVerifiedGmailArchiveFeedbackApplication,
  type GmailArchiveFeedbackApplication,
  type VerifiedGmailArchiveFeedbackApplication,
} from './gmail-archive-feedback-application-repository.js';
import {
  decisionReceiptFeedbackApplicationRefV1,
  decisionReceiptRowArtifactRefV1,
} from './decision-receipt-artifacts.js';
import { decisionReceiptLifecycleRepository } from './decision-receipt-lifecycle.js';
import {
  loadGmailArchivePreparationReplay,
} from './gmail-archive-preparation-repository.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';
import {
  exactGmailArchiveApprovedPrefix,
  validateStoredGmailArchiveTerminal,
  type GmailArchiveTerminalStableState,
} from './gmail-archive-terminalization-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['blocked', 'succeeded', 'failed', 'unknown']);

export interface FinalizeGmailArchiveFeedbackReceiptInput {
  readonly userId: string;
  readonly approvalId: string;
  readonly feedbackEventId: string;
}

export interface GmailArchiveFeedbackReceiptFinalization {
  readonly application: GmailArchiveFeedbackApplication;
  readonly revision: DecisionReceiptRevisionRow;
}

export type FinalizeGmailArchiveFeedbackReceiptResult =
  | {
    readonly ok: true;
    readonly created: boolean;
    readonly finalization: GmailArchiveFeedbackReceiptFinalization;
  }
  | {
    readonly ok: false;
    readonly error: 'invalid_input' | 'not_found' | 'not_ready' | 'integrity_conflict';
  };

type FinalizeError = 'invalid_input' | 'not_found' | 'not_ready' | 'integrity_conflict';

interface StableValues {
  readonly revisionId: string;
}

interface FinalizerHooks {
  readonly afterAppend?: () => void | Promise<void>;
}

type TransactionRunner = <T>(callback: (client: PoolClient) => Promise<T>) => Promise<T>;

class RollbackResult extends Error {
  constructor(readonly result: FinalizeGmailArchiveFeedbackReceiptResult) {
    super('Gmail archive feedback receipt finalization rolled back');
  }
}

function ownInput(value: unknown): Readonly<FinalizeGmailArchiveFeedbackReceiptInput> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors).sort();
    if (names.join('\0') !== ['approvalId', 'feedbackEventId', 'userId'].join('\0')) return null;
    const snapshot: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true || typeof descriptor.value !== 'string' ||
          !UUID.test(descriptor.value)) return null;
      snapshot[name] = descriptor.value;
    }
    return Object.freeze({
      approvalId: snapshot['approvalId'] as string,
      feedbackEventId: snapshot['feedbackEventId'] as string,
      userId: snapshot['userId'] as string,
    });
  } catch {
    return null;
  }
}

function fail(error: FinalizeError): never {
  throw new RollbackResult(Object.freeze({ ok: false, error }));
}

async function databaseTime(client: PoolClient): Promise<string | null> {
  const row = (await client.query<{ finalized_at: Date }>(
    'SELECT statement_timestamp() AS finalized_at',
  )).rows[0];
  return row?.finalized_at instanceof Date ? row.finalized_at.toISOString() : null;
}

function terminalState(source: GmailArchiveApprovalCanonicalState): GmailArchiveTerminalStableState {
  return {
    approval: source.approval,
    decision: source.decision,
    candidate: source.candidate,
    outcome: source.outcome,
    proposalBarrier: source.proposalBarrier,
    proposalExplanation: source.explanation,
    receipt: source.receipt,
    revisions: source.revisions,
  };
}

function feedbackContent(
  previous: JoinedDecisionReceiptContent,
  verified: VerifiedGmailArchiveFeedbackApplication,
): JoinedDecisionReceiptContentV3 {
  return {
    ...previous,
    version: 3,
    stage: 'feedback_recorded',
    disposition: previous.disposition,
    feedbackEvents: [decisionReceiptRowArtifactRefV1('feedback', { ...verified.feedback })],
    feedbackApplication: decisionReceiptFeedbackApplicationRefV1(verified.application),
  };
}

async function lockTerminalAdmissionIfPresent(
  client: PoolClient,
  input: Readonly<FinalizeGmailArchiveFeedbackReceiptInput>,
): Promise<{ barrier: PreEffectBarrierRow | null; premature: boolean; duplicate: boolean }> {
  const hints = (await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE user_id = $1 AND effect_type = 'event_execution' AND idempotency_key = $2
      ORDER BY id LIMIT 2`,
    [input.userId, input.approvalId],
  )).rows;
  if (hints.length > 1) return { barrier: null, premature: false, duplicate: true };
  const hint = hints[0];
  if (!hint || !TERMINAL.has(hint.status)) {
    return { barrier: hint ?? null, premature: hint !== undefined, duplicate: false };
  }
  const locked = (await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE id = $1 AND user_id = $2 AND effect_type = 'event_execution'
        AND idempotency_key = $3 FOR UPDATE`,
    [hint.id, input.userId, input.approvalId],
  )).rows;
  return locked.length === 1
    ? { barrier: locked[0]!, premature: false, duplicate: false }
    : { barrier: null, premature: false, duplicate: true };
}

async function priorRevision(
  client: PoolClient,
  input: Readonly<FinalizeGmailArchiveFeedbackReceiptInput>,
  source: GmailArchiveApprovalCanonicalState,
  admission: Awaited<ReturnType<typeof lockTerminalAdmissionIfPresent>>,
): Promise<DecisionReceiptRevisionRow | 'not_ready' | null> {
  const revisions = source.revisions;
  if (source.approval.status === 'rejected') {
    if (admission.barrier || admission.premature || admission.duplicate) return null;
    const rejected = canonicalGmailArchiveApprovalContent(
      { ...source, revisions: revisions.slice(0, 4) },
      'rejected',
    );
    if (!rejected || (revisions.length !== 4 && revisions.length !== 5)) return null;
    return revisions[3] ?? null;
  }
  if (source.approval.status !== 'approved' || admission.duplicate) return null;
  if (!admission.barrier) return admission.premature ? 'not_ready' : null;
  if (admission.premature || !TERMINAL.has(admission.barrier.status)) return 'not_ready';
  const stable = terminalState(source);
  const approved = exactGmailArchiveApprovedPrefix(stable);
  if (!approved) return null;
  if (admission.barrier.status === 'blocked') {
    const replay = await loadGmailArchivePreparationReplay(
      client,
      { userId: input.userId, approvalId: input.approvalId },
      source,
      admission.barrier,
      approved,
      { allowSingleFeedbackContinuation: true },
    );
    if (!replay.ok || replay.preparation.status !== 'blocked' ||
        (revisions.length !== 5 && revisions.length !== 6)) return null;
    return revisions[4] ?? null;
  }
  const terminal = await validateStoredGmailArchiveTerminal(
    client,
    { userId: input.userId, approvalId: input.approvalId },
    stable,
    admission.barrier,
    approved,
  );
  if (!terminal || terminal.status !== admission.barrier.status ||
      (revisions.length !== 7 && revisions.length !== 8)) return null;
  return revisions[6] ?? null;
}

async function transition(
  client: PoolClient,
  input: Readonly<FinalizeGmailArchiveFeedbackReceiptInput>,
  stable: Readonly<StableValues>,
  hooks: FinalizerHooks = {},
): Promise<FinalizeGmailArchiveFeedbackReceiptResult> {
  // Terminal admission rows are immutable. Lock them before approval to match
  // terminalization; nonterminal hints remain unlocked and can only yield
  // not_ready after the canonical graph/application are checked.
  const admission = await lockTerminalAdmissionIfPresent(client, input);
  const source = await loadCanonicalGmailArchiveApprovalState(client, {
    userId: input.userId,
    approvalId: input.approvalId,
    action: 'approve',
  }, { allowExecutionPlan: true });
  if (!source) return Object.freeze({ ok: false, error: 'not_found' });
  const verified = await loadVerifiedGmailArchiveFeedbackApplication(client, {
    userId: input.userId,
    feedbackEventId: input.feedbackEventId,
  }, source);
  if (!verified) return Object.freeze({ ok: false, error: 'integrity_conflict' });
  const previous = await priorRevision(client, input, source, admission);
  if (previous === 'not_ready') return Object.freeze({ ok: false, error: 'not_ready' });
  if (!previous) return Object.freeze({ ok: false, error: 'integrity_conflict' });
  const content = feedbackContent(previous.content, verified);
  const eventKey = buildDecisionReceiptEventKey('feedback_recorded', verified.feedback.id);
  const finalizedAt = await databaseTime(client);
  if (!finalizedAt) fail('integrity_conflict');
  const appended = await decisionReceiptLifecycleRepository.appendForUser(client, input.userId, {
    eventId: verified.feedback.id,
    eventKind: 'feedback_recorded',
    expectedPreviousDigest: previous.revision_digest,
    content,
    receiptId: source.receipt.id,
    revisionId: stable.revisionId,
    createdAt: finalizedAt,
  });
  if (!appended.success) fail('integrity_conflict');
  await hooks.afterAppend?.();
  const expectedLength = previous.sequence as number;
  const chain = appended.created
    ? [...source.revisions, appended.revision]
    : source.revisions;
  const final = chain[chain.length - 1];
  if (chain.length !== expectedLength + 1 || !final || final.id !== appended.revision.id ||
      final.event_key !== eventKey || final.previous_digest !== previous.revision_digest ||
      final.content_digest !== joinedDecisionReceiptContentDigest(content) ||
      final.stage !== 'feedback_recorded' || final.disposition !== previous.disposition ||
      final.candidate_action_id !== (content.candidateAction?.id ?? null) ||
      final.barrier_id !== (content.barrier?.id ?? null) ||
      final.explanation_id !== (content.explanation?.id ?? null) ||
      final.approval_request_id !== source.approval.id ||
      final.execution_plan_id !== (content.executionPlan?.id ?? null) ||
      final.execution_result_id !== (content.executionResult?.id ?? null) ||
      final.execution_disposition !== (content.executionDisposition ?? null) ||
      final.correction_of_revision_id !== null || final.trusted !== true ||
      !verifyJoinedDecisionReceiptChain({
        receiptId: source.receipt.id,
        decisionId: source.decision.id,
        userId: input.userId,
        revisions: chain,
      })) fail('integrity_conflict');
  return Object.freeze({
    ok: true,
    created: appended.created,
    finalization: Object.freeze({ application: verified.application, revision: final }),
  });
}

async function finalizeWithTransition(
  submitted: FinalizeGmailArchiveFeedbackReceiptInput,
  runTransition = transition,
  runTransaction: TransactionRunner = withTransaction,
  hooks: FinalizerHooks = {},
): Promise<FinalizeGmailArchiveFeedbackReceiptResult> {
  const input = ownInput(submitted);
  if (!input) return Object.freeze({ ok: false, error: 'invalid_input' });
  const stable = Object.freeze({ revisionId: randomUUID() });
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runTransaction((client) => runTransition(client, input, stable, hooks));
    } catch (error) {
      if (error instanceof RollbackResult) return error.result;
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

export async function finalizeGmailArchiveFeedbackReceipt(
  input: FinalizeGmailArchiveFeedbackReceiptInput,
): Promise<FinalizeGmailArchiveFeedbackReceiptResult> {
  return finalizeWithTransition(input);
}

export const gmailArchiveFeedbackReceiptRepository = Object.freeze({
  finalize: finalizeGmailArchiveFeedbackReceipt,
});

export const gmailArchiveFeedbackReceiptTestHooks = Object.freeze({
  feedbackContent,
  finalizeWithTransition,
  ownInput,
  transition,
});
