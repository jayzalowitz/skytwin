import { randomUUID } from 'node:crypto';
import {
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  verifyJoinedDecisionReceiptChain,
  type GmailArchiveAttemptPhase,
  type GmailInboxMutationBinding,
  type GmailInboxMutationCommand,
  type GmailInboxMutationResult,
  type JoinedDecisionReceiptContentV1,
  type JoinedDecisionReceiptContentV2,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../connection.js';
import type {
  DecisionReceiptRevisionRow,
  DecisionReceiptRow,
  DecisionOutcomeRow,
  DecisionRow,
  CandidateActionRow,
  ApprovalRequestRow,
  ExecutionPlanRow,
  ExecutionResultRow,
  ExplanationRecordRow,
} from '../types.js';
import {
  decisionReceiptBarrierRefV1,
  decisionReceiptApprovalRefV1,
  decisionReceiptExecutionPlanRefV1,
  decisionReceiptExecutionResultRefV1,
  decisionReceiptRowArtifactRefV1,
} from './decision-receipt-artifacts.js';
import { decisionReceiptLifecycleRepository } from './decision-receipt-lifecycle.js';
import { normalizeDecisionReceiptRevisionRow } from './decision-receipt-repository.js';
import {
  canonicalGmailArchiveCandidateMessageRef,
} from './gmail-archive-approval-response-repository.js';
import {
  exactClaimedGmailArchiveReceipt,
  type GmailArchiveClaimAuthority,
} from './gmail-archive-claim-integrity.js';
import { snapshotGmailArchiveAttemptState } from './gmail-archive-attempt-state.js';
import { canonicalGmailArchiveCandidate } from './gmail-archive-preparation-repository.js';
import { GMAIL_ARCHIVE_PROPOSAL_REASON } from './gmail-archive-proposal-repository.js';
import type { PreEffectBarrierRow } from './pre-effect-barrier-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KNOWN_FAILURE_CODES = [
  'invalid_command',
  'not_admitted',
  'admission_unavailable',
  'credentials_unavailable',
  'preflight_unavailable',
  'remote_rejected',
] as const;

type KnownFailureCode = (typeof KNOWN_FAILURE_CODES)[number];
type TerminalDisposition = 'succeeded' | 'failed' | 'unknown';
const TERMINAL_RESULT_SCHEMA_V1 = 'gmail_archive_terminal_result_v1';
const TERMINAL_RESULT_SCHEMA_V2 = 'gmail_archive_terminal_result_v2';
const TERMINAL_RESULT_SCHEMA_V3 = 'gmail_archive_terminal_result_v3';

export type LegacyGmailArchiveTerminalResultPayload =
  | {
      outcome: 'confirmed';
      operation: 'archive';
      inbox: false;
      effect: 'changed' | 'already_in_state' | 'reconciled';
      compensationAvailable: false;
      observedAt: string;
    }
  | {
      outcome: 'known_failure';
      code: KnownFailureCode;
      compensationAvailable: false;
    }
  | {
      outcome: 'unknown';
      code: 'remote_outcome_unknown';
      compensationAvailable: false;
    };

export type StoredGmailArchiveMutationResult =
  | Readonly<GmailInboxMutationResult>
  | Readonly<LegacyGmailArchiveTerminalResultPayload>;

export type GmailArchiveTerminalResultEnvelope =
  | ({ schema: typeof TERMINAL_RESULT_SCHEMA_V1 } & LegacyGmailArchiveTerminalResultPayload)
  | ({
      schema: typeof TERMINAL_RESULT_SCHEMA_V2;
      attemptPhase: GmailArchiveAttemptPhase;
    } & LegacyGmailArchiveTerminalResultPayload)
  | ({
      schema: typeof TERMINAL_RESULT_SCHEMA_V3;
      attemptPhase: GmailArchiveAttemptPhase;
    } & Exclude<GmailInboxMutationResult, { code: 'invalid_command' }>);

export interface TerminalizeGmailArchiveInput {
  command: GmailInboxMutationCommand;
  result: GmailInboxMutationResult;
}

export interface GmailArchiveTerminalEvidence {
  result: StoredGmailArchiveMutationResult;
  attemptPhase: GmailArchiveAttemptPhase | null;
}

type TerminalAuthority = GmailArchiveClaimAuthority;

export interface GmailArchiveTerminalStableState {
  approval: ApprovalRequestRow;
  decision: DecisionRow;
  candidate: CandidateActionRow;
  outcome: DecisionOutcomeRow;
  proposalBarrier: PreEffectBarrierRow;
  proposalExplanation: ExplanationRecordRow;
  receipt: DecisionReceiptRow;
  revisions: DecisionReceiptRevisionRow[];
}

export interface GmailArchiveTerminalizationBundle {
  status: TerminalDisposition;
  barrier: PreEffectBarrierRow;
  plan: ExecutionPlanRow;
  executionResult: ExecutionResultRow | null;
  executionExplanation: ExplanationRecordRow;
  revision: DecisionReceiptRevisionRow;
}

export type TerminalizeGmailArchiveResult =
  | { ok: true; created: boolean; terminalization: GmailArchiveTerminalizationBundle }
  | { ok: false; error: 'invalid_input' | 'not_found' | 'not_ready' | 'idempotency_conflict' };

export interface GmailArchiveTerminalizationStableValues {
  explanationId: string;
  resultId: string;
  revisionId: string;
  persistedAt: string;
}

export type GmailArchiveTerminalizationTransition = (
  client: PoolClient,
  input: Readonly<TerminalizeGmailArchiveInput>,
  stable: Readonly<GmailArchiveTerminalizationStableValues>,
) => Promise<TerminalizeGmailArchiveResult>;

class RollbackResult extends Error {
  constructor(readonly result: TerminalizeGmailArchiveResult) {
    super('Gmail archive terminalization rolled back');
  }
}

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors).sort();
    const expected = [...keys].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return null;
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

function canonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function snapshotBinding(value: unknown): Readonly<GmailInboxMutationBinding> | null {
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

function snapshotMutationResult(value: unknown): Readonly<GmailInboxMutationResult> | null {
  const invalid = ownData(value, ['code', 'compensationAvailable', 'outcome']);
  if (invalid?.['outcome'] === 'known_failure' && invalid['code'] === 'invalid_command' &&
      invalid['compensationAvailable'] === false) {
    return Object.freeze({
      outcome: 'known_failure', code: 'invalid_command', compensationAvailable: false,
    });
  }
  const outcome = ownData(value, [
    'binding', 'compensationAvailable', 'effect', 'inbox', 'observedAt', 'operation', 'outcome',
  ]);
  const outcomeBinding = snapshotBinding(outcome?.['binding']);
  if (outcome?.['outcome'] === 'confirmed' && outcome['operation'] === 'archive' &&
      outcome['inbox'] === false && outcome['compensationAvailable'] === false &&
      (['changed', 'already_in_state', 'reconciled'] as unknown[]).includes(outcome['effect']) &&
      canonicalIsoInstant(outcome['observedAt']) && outcomeBinding) {
    return Object.freeze({
      outcome: 'confirmed',
      operation: 'archive',
      inbox: false,
      effect: outcome['effect'] as 'changed' | 'already_in_state' | 'reconciled',
      compensationAvailable: false,
      observedAt: outcome['observedAt'],
      binding: outcomeBinding,
    });
  }
  const failure = ownData(value, ['binding', 'code', 'compensationAvailable', 'outcome']);
  const failureBinding = snapshotBinding(failure?.['binding']);
  if (failure?.['outcome'] === 'known_failure' && failure['compensationAvailable'] === false &&
      failure['code'] !== 'invalid_command' &&
      KNOWN_FAILURE_CODES.includes(failure['code'] as KnownFailureCode) && failureBinding) {
    return Object.freeze({
      outcome: 'known_failure',
      code: failure['code'] as Exclude<KnownFailureCode, 'invalid_command'>,
      compensationAvailable: false,
      binding: failureBinding,
    });
  }
  if (failure?.['outcome'] === 'unknown' && failure['code'] === 'remote_outcome_unknown' &&
      failure['compensationAvailable'] === false && failureBinding) {
    return Object.freeze({
      outcome: 'unknown',
      code: 'remote_outcome_unknown',
      compensationAvailable: false,
      binding: failureBinding,
    });
  }
  return null;
}

function snapshotLegacyMutationResult(
  value: unknown,
): Readonly<LegacyGmailArchiveTerminalResultPayload> | null {
  const confirmed = ownData(value, [
    'compensationAvailable', 'effect', 'inbox', 'observedAt', 'operation', 'outcome',
  ]);
  if (confirmed?.['outcome'] === 'confirmed' && confirmed['operation'] === 'archive' &&
      confirmed['inbox'] === false && confirmed['compensationAvailable'] === false &&
      (['changed', 'already_in_state', 'reconciled'] as unknown[]).includes(confirmed['effect']) &&
      canonicalIsoInstant(confirmed['observedAt'])) {
    return Object.freeze({
      outcome: 'confirmed', operation: 'archive', inbox: false,
      effect: confirmed['effect'] as 'changed' | 'already_in_state' | 'reconciled',
      compensationAvailable: false, observedAt: confirmed['observedAt'],
    });
  }
  const failure = ownData(value, ['code', 'compensationAvailable', 'outcome']);
  if (failure?.['outcome'] === 'known_failure' && failure['compensationAvailable'] === false &&
      KNOWN_FAILURE_CODES.includes(failure['code'] as KnownFailureCode)) {
    return Object.freeze({
      outcome: 'known_failure', code: failure['code'] as KnownFailureCode,
      compensationAvailable: false,
    });
  }
  if (failure?.['outcome'] === 'unknown' && failure['code'] === 'remote_outcome_unknown' &&
      failure['compensationAvailable'] === false) {
    return Object.freeze({
      outcome: 'unknown', code: 'remote_outcome_unknown', compensationAvailable: false,
    });
  }
  return null;
}

function resultBinding(
  value: StoredGmailArchiveMutationResult,
): Readonly<GmailInboxMutationBinding> | null {
  return 'binding' in value ? value.binding : null;
}

function legacyResultPayload(
  value: StoredGmailArchiveMutationResult,
): Readonly<LegacyGmailArchiveTerminalResultPayload> {
  if (value.outcome === 'confirmed') return Object.freeze({
    outcome: value.outcome,
    operation: value.operation,
    inbox: value.inbox,
    effect: value.effect,
    compensationAvailable: value.compensationAvailable,
    observedAt: value.observedAt,
  });
  if (value.outcome === 'known_failure') return Object.freeze({
    outcome: value.outcome,
    code: value.code,
    compensationAvailable: value.compensationAvailable,
  });
  return Object.freeze({
    outcome: value.outcome,
    code: value.code,
    compensationAvailable: value.compensationAvailable,
  });
}

function sameTerminalResultForReplay(
  retained: StoredGmailArchiveMutationResult,
  requested: GmailInboxMutationResult,
): boolean {
  return sameCanonical(legacyResultPayload(retained), legacyResultPayload(requested));
}

function snapshotCommand(value: unknown): Readonly<GmailInboxMutationCommand> | null {
  const command = ownData(value, ['admissionId', 'messageRefId', 'operation', 'userId']);
  if (!command || typeof command['userId'] !== 'string' || !UUID.test(command['userId']) ||
      typeof command['admissionId'] !== 'string' || !UUID.test(command['admissionId']) ||
      typeof command['messageRefId'] !== 'string' || !UUID.test(command['messageRefId']) ||
      command['operation'] !== 'archive') return null;
  return Object.freeze({
    userId: command['userId'],
    admissionId: command['admissionId'],
    messageRefId: command['messageRefId'],
    operation: 'archive',
  });
}

/** Secret-free canonical envelope committed by terminal explanations. */
function buildTerminalResultEnvelope(
  value: StoredGmailArchiveMutationResult,
  attemptPhase: GmailArchiveAttemptPhase | null,
): GmailArchiveTerminalResultEnvelope {
  const result = snapshotMutationResult(value) ?? snapshotLegacyMutationResult(value);
  if (!result) throw new TypeError('cannot build a terminal envelope from an invalid result');
  const binding = resultBinding(result);
  if (binding && (attemptPhase === null || result.outcome === 'known_failure' &&
      result.code === 'invalid_command')) {
    throw new TypeError('bound terminal evidence requires an attempt phase and canonical command');
  }
  if (binding) {
    const header = { schema: TERMINAL_RESULT_SCHEMA_V3, attemptPhase: attemptPhase! } as const;
    if (result.outcome === 'confirmed') return {
      ...header,
      outcome: result.outcome,
      operation: result.operation,
      inbox: result.inbox,
      effect: result.effect,
      compensationAvailable: result.compensationAvailable,
      observedAt: result.observedAt,
      binding,
    };
    if (result.outcome === 'known_failure') return {
      ...header,
      outcome: result.outcome,
      code: result.code as Exclude<KnownFailureCode, 'invalid_command'>,
      compensationAvailable: result.compensationAvailable,
      binding,
    };
    return {
      ...header,
      outcome: result.outcome,
      code: result.code,
      compensationAvailable: result.compensationAvailable,
      binding,
    };
  }
  const header = attemptPhase === null
    ? { schema: TERMINAL_RESULT_SCHEMA_V1 } as const
    : { schema: TERMINAL_RESULT_SCHEMA_V2, attemptPhase } as const;
  return result.outcome === 'confirmed' ? {
    ...header,
    outcome: result.outcome,
    operation: result.operation,
    inbox: result.inbox,
    effect: result.effect,
    compensationAvailable: result.compensationAvailable,
    observedAt: result.observedAt,
  } : result.outcome === 'known_failure' ? {
    ...header,
    outcome: result.outcome,
    code: result.code,
    compensationAvailable: result.compensationAvailable,
  } : {
    ...header,
    outcome: result.outcome,
    code: result.code,
    compensationAvailable: result.compensationAvailable,
  };
}

/** Build the phase-bound envelope used by every newly terminalized attempt. */
export function buildGmailArchiveTerminalResultEnvelope(
  value: GmailInboxMutationResult,
  attemptPhase: GmailArchiveAttemptPhase,
): GmailArchiveTerminalResultEnvelope {
  return buildTerminalResultEnvelope(value, attemptPhase);
}

/** Strict parser for the result evidence retained in terminal explanations. */
export function parseGmailArchiveTerminalResultEnvelope(
  value: unknown,
): StoredGmailArchiveMutationResult | null {
  return parseGmailArchiveTerminalEvidence(value)?.result ?? null;
}

/** Strict parser retaining the durable attempt boundary carried by v2/v3. */
export function parseGmailArchiveTerminalEvidence(
  value: unknown,
): Readonly<GmailArchiveTerminalEvidence> | null {
  const confirmedV3 = ownData(value, [
    'attemptPhase', 'binding', 'compensationAvailable', 'effect', 'inbox', 'observedAt',
    'operation', 'outcome', 'schema',
  ]);
  if (confirmedV3?.['schema'] === TERMINAL_RESULT_SCHEMA_V3) {
    const attemptPhase = confirmedV3['attemptPhase'];
    const { schema: _schema, attemptPhase: _attemptPhase, ...result } = confirmedV3;
    const parsed = snapshotMutationResult(result);
    if (!parsed || parsed.outcome === 'known_failure' && parsed.code === 'invalid_command' ||
        (attemptPhase !== 'pre_dispatch' && attemptPhase !== 'dispatch_may_have_started') ||
        !gmailArchiveResultAllowedForAttemptPhase(parsed, attemptPhase)) return null;
    return Object.freeze({ result: parsed, attemptPhase });
  }
  const failureV3 = ownData(value, [
    'attemptPhase', 'binding', 'code', 'compensationAvailable', 'outcome', 'schema',
  ]);
  if (failureV3?.['schema'] === TERMINAL_RESULT_SCHEMA_V3) {
    const attemptPhase = failureV3['attemptPhase'];
    const { schema: _schema, attemptPhase: _attemptPhase, ...result } = failureV3;
    const parsed = snapshotMutationResult(result);
    if (!parsed || parsed.outcome === 'known_failure' && parsed.code === 'invalid_command' ||
        (attemptPhase !== 'pre_dispatch' && attemptPhase !== 'dispatch_may_have_started') ||
        !gmailArchiveResultAllowedForAttemptPhase(parsed, attemptPhase)) return null;
    return Object.freeze({ result: parsed, attemptPhase });
  }
  const confirmedV2 = ownData(value, [
    'attemptPhase', 'compensationAvailable', 'effect', 'inbox', 'observedAt',
    'operation', 'outcome', 'schema',
  ]);
  if (confirmedV2?.['schema'] === TERMINAL_RESULT_SCHEMA_V2) {
    const attemptPhase = confirmedV2['attemptPhase'];
    const { schema: _schema, attemptPhase: _attemptPhase, ...result } = confirmedV2;
    const parsed = snapshotLegacyMutationResult(result);
    if (!parsed || (attemptPhase !== 'pre_dispatch' && attemptPhase !== 'dispatch_may_have_started') ||
        !gmailArchiveResultAllowedForAttemptPhase(parsed, attemptPhase)) return null;
    return Object.freeze({ result: parsed, attemptPhase });
  }
  const failureV2 = ownData(value, [
    'attemptPhase', 'code', 'compensationAvailable', 'outcome', 'schema',
  ]);
  if (failureV2?.['schema'] === TERMINAL_RESULT_SCHEMA_V2) {
    const attemptPhase = failureV2['attemptPhase'];
    const { schema: _schema, attemptPhase: _attemptPhase, ...result } = failureV2;
    const parsed = snapshotLegacyMutationResult(result);
    if (!parsed || (attemptPhase !== 'pre_dispatch' && attemptPhase !== 'dispatch_may_have_started') ||
        !gmailArchiveResultAllowedForAttemptPhase(parsed, attemptPhase)) return null;
    return Object.freeze({ result: parsed, attemptPhase });
  }
  const confirmed = ownData(value, [
    'compensationAvailable', 'effect', 'inbox', 'observedAt', 'operation', 'outcome', 'schema',
  ]);
  if (confirmed?.['schema'] === TERMINAL_RESULT_SCHEMA_V1) {
    const { schema: _schema, ...result } = confirmed;
    const parsed = snapshotLegacyMutationResult(result);
    return parsed ? Object.freeze({ result: parsed, attemptPhase: null }) : null;
  }
  const failure = ownData(value, ['code', 'compensationAvailable', 'outcome', 'schema']);
  if (failure?.['schema'] !== TERMINAL_RESULT_SCHEMA_V1) return null;
  const { schema: _schema, ...result } = failure;
  const parsed = snapshotLegacyMutationResult(result);
  return parsed ? Object.freeze({ result: parsed, attemptPhase: null }) : null;
}

/** Exact one-envelope explanation evidence retained by terminal receipt v2. */
export function parseGmailArchiveTerminalExplanationEvidence(
  value: unknown,
): StoredGmailArchiveMutationResult | null {
  return parseGmailArchiveTerminalExplanationBinding(value)?.result ?? null;
}

/** Exact one-envelope explanation evidence including the attempt boundary. */
export function parseGmailArchiveTerminalExplanationBinding(
  value: unknown,
): Readonly<GmailArchiveTerminalEvidence> | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length !== 1 || Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.keys(value).length !== 1 || Object.keys(value)[0] !== '0') return null;
    const item = Object.getOwnPropertyDescriptor(value, '0');
    if (!item || !Object.prototype.hasOwnProperty.call(item, 'value') || !item.enumerable) return null;
    return parseGmailArchiveTerminalEvidence(item.value);
  } catch {
    return null;
  }
}

function snapshotInput(value: unknown): Readonly<TerminalizeGmailArchiveInput> | null {
  const input = ownData(value, ['command', 'result']);
  if (!input) return null;
  const command = snapshotCommand(input['command']);
  const result = snapshotMutationResult(input['result']);
  const binding = result ? resultBinding(result) : null;
  if (!command || !result || !binding || binding.userId !== command.userId ||
      binding.admissionId !== command.admissionId ||
      binding.messageRefId !== command.messageRefId) return null;
  return Object.freeze({ command, result });
}

function exactApprovalResponse(value: unknown): boolean {
  const response = ownData(value, ['action', 'reason']);
  return response?.['action'] === 'approve' &&
    (response['reason'] === null || typeof response['reason'] === 'string');
}

function disposition(result: StoredGmailArchiveMutationResult): TerminalDisposition {
  return result.outcome === 'confirmed' ? 'succeeded' :
    result.outcome === 'known_failure' ? 'failed' : 'unknown';
}

function effectResult(
  result: GmailInboxMutationResult,
  attemptPhase: GmailArchiveAttemptPhase,
): Record<string, unknown> {
  return buildGmailArchiveTerminalResultEnvelope(result, attemptPhase);
}

function failureReason(result: StoredGmailArchiveMutationResult): string | null {
  return result.outcome === 'confirmed' ? null : result.code;
}

export function gmailArchiveResultAllowedForAttemptPhase(
  result: StoredGmailArchiveMutationResult,
  attemptPhase: GmailArchiveAttemptPhase,
): boolean {
  if (result.outcome === 'unknown') return attemptPhase === 'dispatch_may_have_started';
  if (result.outcome === 'confirmed') {
    return result.effect === 'already_in_state'
      ? attemptPhase === 'pre_dispatch'
      : attemptPhase === 'dispatch_may_have_started';
  }
  if (result.code === 'remote_rejected' || result.code === 'admission_unavailable') return true;
  return attemptPhase === 'pre_dispatch';
}

export interface GmailArchiveTerminalExplanationSemantics {
  whatHappened: string;
  confidenceReasoning: string;
  escalationRationale: string | null;
  correctionGuidance: string;
}

/** Result-bound prose fields used by both persistence and portable validation. */
export function gmailArchiveTerminalExplanationSemantics(
  result: StoredGmailArchiveMutationResult,
): GmailArchiveTerminalExplanationSemantics {
  const outcome = disposition(result);
  const effect = result.outcome === 'confirmed' ? result.effect : null;
  const code = result.outcome === 'confirmed' ? null : result.code;
  const whatHappened = effect === 'already_in_state'
    ? 'A confirming read found the message already outside the Inbox; no mutation POST was sent.'
    : effect === 'reconciled'
      ? 'The mutation POST returned an ambiguous outcome; a confirming read verified the message was outside the Inbox.'
      : effect === 'changed'
        ? 'The approved Gmail Inbox archive was confirmed after one mutation POST.'
        : outcome === 'failed' && code !== 'remote_rejected'
          ? 'The approved Gmail Inbox archive stopped before any mutation request with a known failure classification.'
          : outcome === 'failed'
            ? 'The approved Gmail Inbox archive stopped with the remote_rejected classification.'
            : 'The mutation POST outcome remains unknown after the confirming read.';
  const confidenceReasoning = effect === 'already_in_state'
    ? 'The execution port returned already_in_state after a read and reported no POST.'
    : effect === 'reconciled'
      ? 'The execution port returned reconciled after an ambiguous POST and a confirming read.'
      : effect === 'changed'
        ? 'The execution port returned changed after the archive POST response confirmed Inbox removal.'
        : code === 'remote_outcome_unknown'
          ? 'The execution port returned remote_outcome_unknown after one POST and one inconclusive confirming read.'
          : `The execution port returned the known failure classification ${code}.`;
  return {
    whatHappened,
    confidenceReasoning,
    escalationRationale: outcome === 'succeeded' ? null : `Terminal classification: ${code}.`,
    correctionGuidance: outcome === 'unknown'
      ? 'Reconcile the mailbox state before considering any new archive request; automated restore and compensation are unavailable.'
      : 'Review the recorded terminal classification before creating any follow-up request; automated restore and compensation are unavailable.',
  };
}

function terminalExplanation(input: {
  id: string;
  createdAt: string;
  state: GmailArchiveTerminalStableState;
  barrier: PreEffectBarrierRow;
  plan: ExecutionPlanRow;
  result: StoredGmailArchiveMutationResult;
  attemptPhase: GmailArchiveAttemptPhase | null;
}): ExplanationRecordRow {
  const semantics = gmailArchiveTerminalExplanationSemantics(input.result);
  const policyIds = Array.isArray(input.barrier.policy_snapshot['policyIds'])
    ? input.barrier.policy_snapshot['policyIds'].filter((id): id is string => typeof id === 'string')
    : [];
  return {
    id: input.id,
    decision_id: input.state.decision.id,
    what_happened: semantics.whatHappened,
    evidence_used: [buildTerminalResultEnvelope(input.result, input.attemptPhase)],
    preferences_invoked: [...policyIds].sort(),
    confidence_reasoning: semantics.confidenceReasoning,
    action_rationale: `Record the terminal state of the explicitly approved Gmail Inbox archive. Preserved policy rationale: ${input.state.approval.candidate_action['reasoning'] as string}. Policy snapshot: ${joinedDecisionReceiptArtifactDigest('policy', input.barrier.policy_snapshot)}.`,
    escalation_rationale: semantics.escalationRationale,
    correction_guidance: semantics.correctionGuidance,
    capability_provenance_node_id: null,
    created_at: new Date(input.createdAt),
  };
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return joinedDecisionReceiptArtifactDigest('policy', left) ===
    joinedDecisionReceiptArtifactDigest('policy', right);
}

export function buildGmailArchiveTerminalContent(input: {
  admitted: JoinedDecisionReceiptContentV1;
  barrier: PreEffectBarrierRow;
  plan: ExecutionPlanRow;
  executionResult: ExecutionResultRow | null;
  executionExplanation: ExplanationRecordRow;
  disposition: TerminalDisposition;
}): JoinedDecisionReceiptContentV2 {
  return {
    ...input.admitted,
    version: 2,
    stage: 'execution_recorded',
    disposition: input.disposition,
    barrier: decisionReceiptBarrierRefV1(input.barrier),
    executionPlan: decisionReceiptExecutionPlanRefV1(input.plan),
    ...(input.executionResult ? {
      executionResult: decisionReceiptExecutionResultRefV1(input.executionResult, input.disposition),
    } : {}),
    executionDisposition: input.disposition,
    executionExplanation: decisionReceiptRowArtifactRefV1('explanation', { ...input.executionExplanation }),
  };
}

function exactProposalBarrier(
  barrier: PreEffectBarrierRow,
  state: Pick<GmailArchiveTerminalStableState, 'candidate' | 'decision' | 'proposalExplanation'>,
  userId: string,
): boolean {
  const result = ownData(barrier.effect_result, ['dispatched', 'proposalOnly']);
  return barrier.user_id === userId && barrier.effect_type === 'event_execution' &&
    barrier.idempotency_key === state.decision.id && barrier.status === 'blocked' &&
    barrier.decision_id === state.decision.id && barrier.action_id === state.candidate.id &&
    barrier.explanation_id === state.proposalExplanation.id &&
    barrier.failure_reason === 'proposal_only_boundary' &&
    result?.['proposalOnly'] === true && result['dispatched'] === false;
}

/**
 * Load the portable archive lifecycle graph without consulting connector
 * evidence. Terminalization takes row locks; read-only recovery uses the same
 * canonical loader against a serializable snapshot without locks.
 */
export async function loadGmailArchiveStableState(
  client: PoolClient,
  authority: TerminalAuthority,
  lockRows = true,
): Promise<GmailArchiveTerminalStableState | null> {
  const lock = lockRows ? ' FOR UPDATE' : '';
  const approval = (await client.query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests
      WHERE id = $1 AND user_id = $2${lock}`,
    [authority.approvalId, authority.userId],
  )).rows[0];
  if (!approval || approval.status !== 'approved' || approval.responded_at === null ||
      approval.responded_at.getTime() > approval.expires_at.getTime() ||
      approval.reason !== GMAIL_ARCHIVE_PROPOSAL_REASON || approval.urgency !== 'medium' ||
      approval.confirmation_level !== 'single' || approval.batch_id !== null ||
      approval.first_confirmed_at !== null || approval.confirmation_token !== null ||
      !exactApprovalResponse(approval.response)) return null;
  const decision = (await client.query<DecisionRow>(
    `SELECT * FROM decisions
      WHERE id = $1 AND user_id = $2 AND situation_type = 'email_triage'
        AND domain = 'email' AND metadata = '{"proposalOnly":true}'::JSONB`,
    [approval.decision_id, authority.userId],
  )).rows[0];
  if (!decision) return null;
  const candidateId = approval.candidate_action['id'];
  if (typeof candidateId !== 'string' || !UUID.test(candidateId)) return null;
  const candidate = (await client.query<CandidateActionRow>(
    'SELECT * FROM candidate_actions WHERE id = $1 AND decision_id = $2',
    [candidateId, decision.id],
  )).rows[0];
  const messageRefId = candidate
    ? canonicalGmailArchiveCandidateMessageRef(approval, candidate)
    : null;
  const rawEvent = decision.raw_event;
  if (!candidate || !messageRefId ||
      ownData(rawEvent, ['authoringTier', 'messageRefId', 'signalId', 'source', 'type']) === null ||
      rawEvent['source'] !== 'gmail' || rawEvent['signalId'] !== decision.signal_id ||
      rawEvent['messageRefId'] !== messageRefId || !canonicalGmailArchiveCandidate({
        approval,
        candidate,
        decision,
      })) return null;
  const outcomes = (await client.query<DecisionOutcomeRow>(
    `SELECT * FROM decision_outcomes
      WHERE decision_id = $1 AND selected_action_id = $2
        AND auto_executed = false AND requires_approval = true`,
    [decision.id, candidate.id],
  )).rows;
  if (outcomes.length !== 1 || outcomes[0]!.execution_plan_id === null ||
      outcomes[0]!.escalation_reason !== GMAIL_ARCHIVE_PROPOSAL_REASON ||
      outcomes[0]!.explanation !== GMAIL_ARCHIVE_PROPOSAL_REASON) return null;
  const proposalBarriers = (await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE user_id = $1 AND decision_id = $2 AND action_id = $3
        AND effect_type = 'event_execution' AND idempotency_key = $2::STRING${lock}`,
    [authority.userId, decision.id, candidate.id],
  )).rows;
  if (proposalBarriers.length !== 1 || proposalBarriers[0]!.explanation_id === null) return null;
  const proposalExplanation = (await client.query<ExplanationRecordRow>(
    'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
    [proposalBarriers[0]!.explanation_id, decision.id],
  )).rows[0];
  if (!proposalExplanation) return null;
  const receipt = (await client.query<DecisionReceiptRow>(
    `SELECT * FROM decision_receipts WHERE user_id = $1 AND decision_id = $2${lock}`,
    [authority.userId, decision.id],
  )).rows[0];
  if (!receipt) return null;
  const rawRevisions = (await client.query<DecisionReceiptRevisionRow>(
    'SELECT * FROM decision_receipt_revisions WHERE receipt_id = $1 ORDER BY sequence ASC',
    [receipt.id],
  )).rows;
  const normalizedRevisions = rawRevisions.map(normalizeDecisionReceiptRevisionRow);
  if (normalizedRevisions.some((revision) => revision === null)) return null;
  const revisions = normalizedRevisions as DecisionReceiptRevisionRow[];
  const state = {
    approval,
    decision,
    candidate,
    outcome: outcomes[0]!,
    proposalBarrier: proposalBarriers[0]!,
    proposalExplanation,
    receipt,
    revisions,
  };
  return exactProposalBarrier(proposalBarriers[0]!, state, authority.userId) ? state : null;
}

export function exactGmailArchiveApprovedPrefix(
  state: GmailArchiveTerminalStableState,
): JoinedDecisionReceiptContentV1 | null {
  const revisions = state.revisions;
  const r1 = revisions[0];
  const r2 = revisions[1];
  const r3 = revisions[2];
  const r4 = revisions[3];
  if (!r1 || !r2 || !r3 || !r4 || r4.content.version !== 1 ||
      r1.event_key !== buildDecisionReceiptEventKey('decision_created', state.decision.id) ||
      r1.stage !== 'decision_recorded' || r1.disposition !== 'pending' ||
      r2.event_key !== buildDecisionReceiptEventKey('policy_evaluated', state.proposalBarrier.id) ||
      r2.stage !== 'policy_evaluated' || r2.disposition !== 'requires_approval' ||
      r3.event_key !== buildDecisionReceiptEventKey('approval_created', state.approval.id) ||
      r3.stage !== 'approval_recorded' || r3.disposition !== 'requires_approval' ||
      r4.stage !== 'approval_recorded' ||
      r4.disposition !== 'approved' ||
      r4.event_key !== buildDecisionReceiptEventKey('approval_responded', state.approval.id)) return null;
  const content = r4.content;
  const decisionRef = decisionReceiptRowArtifactRefV1('decision', { ...state.decision });
  const candidateRef = decisionReceiptRowArtifactRefV1('candidate_action', { ...state.candidate });
  const approvalRef = decisionReceiptApprovalRefV1(state.approval);
  const pendingApprovalRef = decisionReceiptApprovalRefV1({
    ...state.approval,
    status: 'pending',
    responded_at: null,
  });
  const proposalBarrierRef = decisionReceiptBarrierRefV1(state.proposalBarrier);
  const proposalExplanationRef = decisionReceiptRowArtifactRefV1(
    'explanation',
    { ...state.proposalExplanation },
  );
  if (r1.content.decision.id !== decisionRef.id ||
      r1.content.decision.canonicalHash !== decisionRef.canonicalHash ||
      r2.content.barrier?.id !== proposalBarrierRef.id ||
      r2.content.barrier.canonicalHash !== proposalBarrierRef.canonicalHash ||
      r2.content.explanation?.id !== proposalExplanationRef.id ||
      r2.content.explanation.canonicalHash !== proposalExplanationRef.canonicalHash ||
      r3.content.approvalRequest?.id !== pendingApprovalRef.id ||
      r3.content.approvalRequest.canonicalHash !== pendingApprovalRef.canonicalHash ||
      content.decision.id !== decisionRef.id || content.decision.canonicalHash !== decisionRef.canonicalHash ||
      content.candidateAction?.id !== candidateRef.id ||
      content.candidateAction.canonicalHash !== candidateRef.canonicalHash ||
      content.risk?.candidateActionId !== state.candidate.id ||
      content.risk.canonicalHash !==
        joinedDecisionReceiptArtifactDigest('risk', state.candidate.risk_assessment) ||
      content.approvalRequest?.id !== approvalRef.id ||
      content.approvalRequest.canonicalHash !== approvalRef.canonicalHash ||
      content.barrier?.id !== proposalBarrierRef.id ||
      content.barrier.canonicalHash !== proposalBarrierRef.canonicalHash ||
      content.explanation?.id !== proposalExplanationRef.id ||
      content.explanation.canonicalHash !== proposalExplanationRef.canonicalHash ||
      content.evidence.length !== 1 || content.evidence[0]?.kind !== 'signal' ||
      content.evidence[0].id !== state.decision.signal_id ||
      r4.candidate_action_id !== state.candidate.id || r4.barrier_id !== state.proposalBarrier.id ||
      r4.explanation_id !== state.proposalExplanation.id || r4.approval_request_id !== state.approval.id ||
      r4.execution_plan_id !== null || r4.execution_result_id !== null ||
      r4.execution_disposition !== null || r4.correction_of_revision_id !== null) return null;
  return content;
}

export async function loadGmailArchivePolicyExplanation(
  client: PoolClient,
  barrier: PreEffectBarrierRow,
  decisionId: string,
): Promise<ExplanationRecordRow | null> {
  if (barrier.explanation_id === null) return null;
  return (await client.query<ExplanationRecordRow>(
    'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
    [barrier.explanation_id, decisionId],
  )).rows[0] ?? null;
}

function baselineState(state: GmailArchiveTerminalStableState) {
  return { ...state, revisions: state.revisions.slice(0, 6) };
}

export async function exactGmailArchiveInProgressBaseline(
  client: PoolClient,
  authority: TerminalAuthority,
  state: GmailArchiveTerminalStableState,
  barrier: PreEffectBarrierRow,
  plan: ExecutionPlanRow,
  policyExplanation: ExplanationRecordRow,
  approved: JoinedDecisionReceiptContentV1,
  terminalExists: boolean,
): Promise<boolean> {
  const counts = await client.query<{ approvals: string; barriers: string; explanations: string; plans: string }>(
    `SELECT
       (SELECT count(*) FROM approval_requests WHERE decision_id = $1) AS approvals,
       (SELECT count(*) FROM pre_effect_barriers WHERE decision_id = $1) AS barriers,
       (SELECT count(*) FROM explanation_records WHERE decision_id = $1) AS explanations,
       (SELECT count(*) FROM execution_plans WHERE decision_id = $1) AS plans`,
    [state.decision.id],
  );
  if (counts.rows[0]?.approvals !== '1' || counts.rows[0]?.barriers !== '2' ||
      counts.rows[0]?.plans !== '1' ||
      (terminalExists
        ? Number(counts.rows[0]?.explanations ?? 0) < 3
        : counts.rows[0]?.explanations !== '2')) return false;
  return exactClaimedGmailArchiveReceipt(
    authority,
    baselineState(state),
    { ...barrier, effect_result: {}, failure_reason: null },
    { ...plan, status: 'in_progress' },
    policyExplanation,
    approved,
  );
}

function exactExecutionResult(
  row: ExecutionResultRow,
  result: StoredGmailArchiveMutationResult,
  attemptPhase: GmailArchiveAttemptPhase | null,
  plan: ExecutionPlanRow,
  terminalAt: Date,
): boolean {
  if (row.plan_id !== plan.id || row.rollback_available !== false ||
      row.completed_at.getTime() !== terminalAt.getTime()) return false;
  if (result.outcome === 'confirmed') {
    return row.success === true && row.error === null &&
      sameCanonical(row.outputs, buildTerminalResultEnvelope(result, attemptPhase));
  }
  return result.outcome === 'known_failure' && row.success === false &&
    row.error === result.code &&
    sameCanonical(row.outputs, buildTerminalResultEnvelope(result, attemptPhase));
}

async function exactTerminalReplay(
  client: PoolClient,
  authority: TerminalAuthority,
  result: StoredGmailArchiveMutationResult,
  state: GmailArchiveTerminalStableState,
  barrier: PreEffectBarrierRow,
  approved: JoinedDecisionReceiptContentV1,
): Promise<GmailArchiveTerminalizationBundle | null> {
  const expectedDisposition = disposition(result);
  const binding = resultBinding(result);
  const messageRefId = canonicalGmailArchiveCandidateMessageRef(state.approval, state.candidate);
  if (binding && (binding.userId !== authority.userId || binding.admissionId !== barrier.id ||
      binding.messageRefId !== messageRefId)) return null;
  const retainedBarrier = parseGmailArchiveTerminalEvidence(barrier.effect_result);
  if (!retainedBarrier || !sameCanonical(retainedBarrier.result, result) ||
      barrier.status !== expectedDisposition ||
      barrier.failure_reason !== failureReason(result)) return null;
  const attemptPhase = retainedBarrier.attemptPhase;
  const plans = (await client.query<ExecutionPlanRow>(
    'SELECT * FROM execution_plans WHERE decision_id = $1 ORDER BY id ASC FOR UPDATE',
    [state.decision.id],
  )).rows;
  const expectedPlanStatus = expectedDisposition === 'succeeded' ? 'completed' : 'failed';
  if (plans.length !== 1 || plans[0]!.status !== expectedPlanStatus ||
      plans[0]!.id !== state.outcome.execution_plan_id || plans[0]!.action_id !== state.candidate.id) {
    return null;
  }
  const plan = plans[0]!;
  const results = (await client.query<ExecutionResultRow>(
    'SELECT * FROM execution_results WHERE plan_id = $1 ORDER BY id ASC FOR UPDATE',
    [plan.id],
  )).rows;
  const events = await client.query<{ count: string }>(
    'SELECT count(*)::STRING AS count FROM execution_events WHERE plan_id = $1',
    [plan.id],
  );
  if (events.rows[0]?.count !== '0' ||
      (expectedDisposition === 'unknown' ? results.length !== 0 : results.length !== 1)) {
    return null;
  }
  const policyExplanation = await loadGmailArchivePolicyExplanation(client, barrier, state.decision.id);
  if (!policyExplanation || !await exactGmailArchiveInProgressBaseline(
    client,
    authority,
    state,
    barrier,
    plan,
    policyExplanation,
    approved,
    true,
  )) {
    return null;
  }
  const r7 = state.revisions[6];
  const executionExplanationId = r7?.content.version === 2
    ? r7.content.executionExplanation.id
    : null;
  if (!r7 || !executionExplanationId || executionExplanationId === barrier.explanation_id) {
    return null;
  }
  const executionExplanation = (await client.query<ExplanationRecordRow>(
    'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
    [executionExplanationId, state.decision.id],
  )).rows[0];
  const terminalAt = r7.created_at;
  const executionResult = results[0] ?? null;
  const retainedEvidence = parseGmailArchiveTerminalExplanationBinding(
    executionExplanation?.evidence_used,
  );
  if (!executionExplanation || barrier.updated_at.getTime() !== terminalAt.getTime() ||
      plan.updated_at.getTime() !== terminalAt.getTime() ||
      executionExplanation.created_at.getTime() !== terminalAt.getTime() ||
      (result.outcome === 'confirmed' &&
        Date.parse(result.observedAt) > terminalAt.getTime()) ||
      !retainedEvidence || retainedEvidence.attemptPhase !== attemptPhase ||
      !sameCanonical(retainedEvidence.result, result) ||
      (attemptPhase !== null && !gmailArchiveResultAllowedForAttemptPhase(result, attemptPhase)) ||
      (executionResult && !exactExecutionResult(executionResult, result, attemptPhase, plan, terminalAt))) {
    return null;
  }
  const expectedExplanation = terminalExplanation({
    id: executionExplanation.id,
    createdAt: terminalAt.toISOString(),
    state,
    barrier,
    plan,
    result,
    attemptPhase,
  });
  if (decisionReceiptRowArtifactRefV1('explanation', { ...executionExplanation }).canonicalHash !==
      decisionReceiptRowArtifactRefV1('explanation', { ...expectedExplanation }).canonicalHash) {
    return null;
  }
  const expectedContent = buildGmailArchiveTerminalContent({
    admitted: state.revisions[5]!.content as JoinedDecisionReceiptContentV1,
    barrier,
    plan,
    executionResult,
    executionExplanation,
    disposition: expectedDisposition,
  });
  const eventKey = buildDecisionReceiptEventKey('execution_recorded', plan.id);
  if (state.revisions.length < 7 ||
      state.revisions.filter((revision) => revision.stage === 'execution_recorded').length !== 1 ||
      state.revisions.some((revision) => revision.trusted !== true) ||
      !verifyJoinedDecisionReceiptChain({
        receiptId: state.receipt.id,
        decisionId: state.decision.id,
        userId: authority.userId,
        revisions: state.revisions,
      }) || r7.event_key !== eventKey || r7.stage !== 'execution_recorded' ||
      r7.disposition !== expectedDisposition ||
      r7.content_digest !== joinedDecisionReceiptContentDigest(expectedContent) ||
      r7.candidate_action_id !== state.candidate.id || r7.barrier_id !== barrier.id ||
      r7.explanation_id !== barrier.explanation_id || r7.approval_request_id !== state.approval.id ||
      r7.execution_plan_id !== plan.id ||
      r7.execution_result_id !== (executionResult?.id ?? null) ||
      r7.execution_disposition !== expectedDisposition || r7.correction_of_revision_id !== null) {
    return null;
  }
  return {
    status: expectedDisposition,
    barrier,
    plan,
    executionResult,
    executionExplanation,
    revision: r7,
  };
}

/** Validate the exact r7 terminal graph plus any trusted, valid continuation. */
export async function validateStoredGmailArchiveTerminal(
  client: PoolClient,
  authority: TerminalAuthority,
  state: GmailArchiveTerminalStableState,
  barrier: PreEffectBarrierRow,
  approved: JoinedDecisionReceiptContentV1,
  expectedResult?: GmailInboxMutationResult,
): Promise<GmailArchiveTerminalizationBundle | null> {
  let result: StoredGmailArchiveMutationResult | undefined = expectedResult;
  if (!result) {
    const r7 = state.revisions[6];
    const explanationId = r7?.content.version === 2 ? r7.content.executionExplanation.id : null;
    if (!explanationId || explanationId === barrier.explanation_id) return null;
    const explanation = (await client.query<ExplanationRecordRow>(
      'SELECT * FROM explanation_records WHERE id = $1 AND decision_id = $2',
      [explanationId, state.decision.id],
    )).rows[0];
    result = parseGmailArchiveTerminalExplanationEvidence(explanation?.evidence_used) ?? undefined;
    if (!result) return null;
  }
  return exactTerminalReplay(client, authority, result, state, barrier, approved);
}

function fail(result: TerminalizeGmailArchiveResult): never {
  throw new RollbackResult(result);
}

async function transition(
  client: PoolClient,
  input: Readonly<TerminalizeGmailArchiveInput>,
  stable: Readonly<GmailArchiveTerminalizationStableValues>,
): Promise<TerminalizeGmailArchiveResult> {
  const barriers = (await client.query<PreEffectBarrierRow>(
    `SELECT * FROM pre_effect_barriers
      WHERE id = $1 AND user_id = $2 AND effect_type = 'event_execution'
      FOR UPDATE`,
    [input.command.admissionId, input.command.userId],
  )).rows;
  if (barriers.length !== 1 || !UUID.test(barriers[0]!.idempotency_key)) {
    return { ok: false, error: 'not_found' };
  }
  const barrier = barriers[0]!;
  const authority = Object.freeze({
    userId: input.command.userId,
    approvalId: barrier.idempotency_key,
  });
  const state = await loadGmailArchiveStableState(client, authority);
  if (!state) return { ok: false, error: 'not_found' };
  const messageRefId = canonicalGmailArchiveCandidateMessageRef(state.approval, state.candidate);
  if (!messageRefId || input.command.messageRefId !== messageRefId ||
      input.command.operation !== 'archive' || barrier.decision_id !== state.decision.id ||
      barrier.action_id !== state.candidate.id || barrier.explanation_id === null) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const approved = exactGmailArchiveApprovedPrefix(state);
  if (!approved) return { ok: false, error: 'idempotency_conflict' };
  if (['succeeded', 'failed', 'unknown'].includes(barrier.status)) {
    const retained = parseGmailArchiveTerminalEvidence(barrier.effect_result);
    if (!retained || !sameTerminalResultForReplay(retained.result, input.result)) {
      return { ok: false, error: 'idempotency_conflict' };
    }
    const terminalization = await validateStoredGmailArchiveTerminal(
      client, authority, state, barrier, approved,
    );
    return terminalization
      ? { ok: true, created: false, terminalization }
      : { ok: false, error: 'idempotency_conflict' };
  }
  if (barrier.status !== 'in_progress') return { ok: false, error: 'not_ready' };
  const attemptState = snapshotGmailArchiveAttemptState(barrier.effect_result);
  if (!attemptState || !gmailArchiveResultAllowedForAttemptPhase(input.result, attemptState.phase)) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const plans = (await client.query<ExecutionPlanRow>(
    'SELECT * FROM execution_plans WHERE decision_id = $1 ORDER BY id ASC FOR UPDATE',
    [state.decision.id],
  )).rows;
  if (plans.length !== 1 || plans[0]!.status !== 'in_progress' ||
      plans[0]!.id !== state.outcome.execution_plan_id || plans[0]!.action_id !== state.candidate.id) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const plan = plans[0]!;
  const attemptCounts = await client.query<{ results: string; events: string }>(
    `SELECT
       (SELECT count(*) FROM execution_results WHERE plan_id = $1) AS results,
       (SELECT count(*) FROM execution_events WHERE plan_id = $1) AS events`,
    [plan.id],
  );
  if (attemptCounts.rows[0]?.results !== '0' || attemptCounts.rows[0]?.events !== '0' ||
      state.revisions.length !== 6) return { ok: false, error: 'idempotency_conflict' };
  const policyExplanation = await loadGmailArchivePolicyExplanation(client, barrier, state.decision.id);
  if (!policyExplanation || !await exactGmailArchiveInProgressBaseline(
    client,
    authority,
    state,
    barrier,
    plan,
    policyExplanation,
    approved,
    false,
  )) {
    return { ok: false, error: 'idempotency_conflict' };
  }
  const terminalStatus = disposition(input.result);
  const terminalPlanStatus = terminalStatus === 'succeeded' ? 'completed' : 'failed';
  const expectedEffectResult = effectResult(input.result, attemptState.phase);
  const expectedFailureReason = failureReason(input.result);
  const explanation = terminalExplanation({
    id: stable.explanationId,
    createdAt: stable.persistedAt,
    state,
    barrier,
    plan,
    result: input.result,
    attemptPhase: attemptState.phase,
  });
  const insertedExplanation = (await client.query<ExplanationRecordRow>(
    `INSERT INTO explanation_records (
       id, decision_id, what_happened, evidence_used, preferences_invoked,
       confidence_reasoning, action_rationale, escalation_rationale,
       correction_guidance, capability_provenance_node_id, created_at
     ) VALUES ($1, $2, $3, $4::JSONB, $5::STRING[], $6, $7, $8, $9, NULL, $10::TIMESTAMPTZ)
     RETURNING *`,
    [
      explanation.id,
      explanation.decision_id,
      explanation.what_happened,
      JSON.stringify(explanation.evidence_used),
      explanation.preferences_invoked,
      explanation.confidence_reasoning,
      explanation.action_rationale,
      explanation.escalation_rationale,
      explanation.correction_guidance,
      stable.persistedAt,
    ],
  )).rows[0];
  if (!insertedExplanation) fail({ ok: false, error: 'idempotency_conflict' });
  const terminalBarrier = (await client.query<PreEffectBarrierRow>(
    `UPDATE pre_effect_barriers
        SET status = $4, effect_result = $5::JSONB, failure_reason = $6,
            updated_at = $7::TIMESTAMPTZ
      WHERE id = $1 AND user_id = $2 AND idempotency_key = $3
        AND effect_type = 'event_execution' AND status = 'in_progress'
        AND decision_id = $8 AND action_id = $9 AND explanation_id = $10
        AND policy_snapshot = $11::JSONB AND effect_result = $12::JSONB
        AND failure_reason IS NULL
      RETURNING *`,
    [
      barrier.id,
      authority.userId,
      authority.approvalId,
      terminalStatus,
      JSON.stringify(expectedEffectResult),
      expectedFailureReason,
      stable.persistedAt,
      state.decision.id,
      state.candidate.id,
      barrier.explanation_id,
      JSON.stringify(barrier.policy_snapshot),
      JSON.stringify(attemptState),
    ],
  )).rows[0];
  if (!terminalBarrier) fail({ ok: false, error: 'idempotency_conflict' });
  const terminalPlan = (await client.query<ExecutionPlanRow>(
    `UPDATE execution_plans
        SET status = $4, updated_at = $5::TIMESTAMPTZ
      WHERE id = $1 AND decision_id = $2 AND action_id = $3 AND status = 'in_progress'
        AND steps = $6::JSONB
        AND NOT EXISTS (SELECT 1 FROM execution_results WHERE plan_id = $1)
        AND NOT EXISTS (SELECT 1 FROM execution_events WHERE plan_id = $1)
      RETURNING *`,
    [plan.id, state.decision.id, state.candidate.id, terminalPlanStatus, stable.persistedAt,
      JSON.stringify(plan.steps)],
  )).rows[0];
  if (!terminalPlan) fail({ ok: false, error: 'idempotency_conflict' });
  let executionResult: ExecutionResultRow | null = null;
  if (terminalStatus !== 'unknown') {
    executionResult = (await client.query<ExecutionResultRow>(
      `INSERT INTO execution_results (
         id, plan_id, success, outputs, error, rollback_available, completed_at
       ) VALUES ($1, $2, $3, $4::JSONB, $5, false, $6::TIMESTAMPTZ)
       RETURNING *`,
      [
        stable.resultId,
        plan.id,
        terminalStatus === 'succeeded',
        JSON.stringify(expectedEffectResult),
        expectedFailureReason,
        stable.persistedAt,
      ],
    )).rows[0] ?? null;
    if (!executionResult || !exactExecutionResult(
      executionResult,
      input.result,
      attemptState.phase,
      terminalPlan,
      new Date(stable.persistedAt),
    )) fail({ ok: false, error: 'idempotency_conflict' });
  }
  const content = buildGmailArchiveTerminalContent({
    admitted: state.revisions[5]!.content as JoinedDecisionReceiptContentV1,
    barrier: terminalBarrier,
    plan: terminalPlan,
    executionResult,
    executionExplanation: insertedExplanation,
    disposition: terminalStatus,
  });
  const appended = await decisionReceiptLifecycleRepository.appendForUser(client, authority.userId, {
    eventId: plan.id,
    eventKind: 'execution_recorded',
    expectedPreviousDigest: state.revisions[5]!.revision_digest,
    content,
    receiptId: state.receipt.id,
    revisionId: stable.revisionId,
    createdAt: stable.persistedAt,
  });
  if (!appended.success || !appended.created) {
    fail({ ok: false, error: 'idempotency_conflict' });
  }
  return {
    ok: true,
    created: true,
    terminalization: {
      status: terminalStatus,
      barrier: terminalBarrier,
      plan: terminalPlan,
      executionResult,
      executionExplanation: insertedExplanation,
      revision: appended.revision,
    },
  };
}

function allocateStableValues(persistedAt: string): GmailArchiveTerminalizationStableValues {
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
    throw new Error('Database did not return a canonical terminal timestamp');
  }
  return persistedAt;
}

function snapshotStableValues(value: unknown): Readonly<GmailArchiveTerminalizationStableValues> | null {
  const stable = ownData(value, ['explanationId', 'persistedAt', 'resultId', 'revisionId']);
  if (!stable || typeof stable['explanationId'] !== 'string' || !UUID.test(stable['explanationId']) ||
      typeof stable['resultId'] !== 'string' || !UUID.test(stable['resultId']) ||
      typeof stable['revisionId'] !== 'string' || !UUID.test(stable['revisionId']) ||
      new Set([stable['explanationId'], stable['resultId'], stable['revisionId']]).size !== 3 ||
      !canonicalIsoInstant(stable['persistedAt'])) return null;
  return Object.freeze({
    explanationId: stable['explanationId'],
    resultId: stable['resultId'],
    revisionId: stable['revisionId'],
    persistedAt: stable['persistedAt'],
  });
}

async function terminalizeWithTransition(
  input: TerminalizeGmailArchiveInput,
  transitionFn: GmailArchiveTerminalizationTransition,
  stableFactory: (persistedAt: string) => GmailArchiveTerminalizationStableValues = allocateStableValues,
  persistedAtFactory: () => Promise<string> = loadDatabasePersistedAt,
): Promise<TerminalizeGmailArchiveResult> {
  const snapshot = snapshotInput(input);
  if (!snapshot) return { ok: false, error: 'invalid_input' };
  const persistedAt = await persistedAtFactory();
  const stable = snapshotStableValues(stableFactory(persistedAt));
  if (!stable || (snapshot.result.outcome === 'confirmed' &&
      Date.parse(snapshot.result.observedAt) > Date.parse(stable.persistedAt))) {
    return { ok: false, error: 'invalid_input' };
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTransaction((client) => transitionFn(client, snapshot, stable));
    } catch (error) {
      if (error instanceof RollbackResult) return error.result;
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

/** Narrow seam for transaction retry and rollback tests. */
export const gmailArchiveTerminalizationTestHooks = {
  terminalizeWithTransition,
  transition,
  sameTerminalResultForReplay,
};

export const gmailArchiveTerminalizationRepository = {
  async terminalize(input: TerminalizeGmailArchiveInput): Promise<TerminalizeGmailArchiveResult> {
    return terminalizeWithTransition(input, transition);
  },
};
