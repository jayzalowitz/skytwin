import type {
  GmailArchiveRecoveryLeaseFence,
  GmailInboxMutationBinding,
  GmailInboxMutationCommand,
  GmailInboxMutationPort,
  GmailInboxMutationResult,
} from '@skytwin/shared-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTHORITY_KEYS = ['approvalId', 'userId'] as const;
const COMMAND_KEYS = ['admissionId', 'messageRefId', 'operation', 'userId'] as const;
const BINDING_KEYS = ['admissionId', 'messageRefId', 'userId'] as const;
const FENCE_KEYS = [
  'admissionId', 'approvalId', 'attemptPhase', 'barrierStatus', 'generation',
  'leaseToken', 'messageRefId', 'phaseChangedAt', 'userId', 'workKind',
] as const;

export interface GmailArchiveCallerAuthority {
  userId: string;
  approvalId: string;
}

export type GmailArchiveClaimResult =
  | { ok: true; claimed: true; command: Readonly<GmailInboxMutationCommand> }
  | {
      ok: true;
      claimed: false;
      state: 'not_ready' | 'in_progress' | 'terminal';
      command: null;
    }
  | {
      ok: false;
      error: 'invalid_input' | 'not_found' | 'policy_stale' | 'idempotency_conflict';
    };

export interface GmailArchiveClaimPort {
  claim(input: GmailArchiveCallerAuthority): Promise<GmailArchiveClaimResult>;
}

export type GmailArchiveTerminalizationResult =
  | { ok: true; created: boolean; terminalization: unknown }
  | {
      ok: false;
      error: 'invalid_input' | 'not_found' | 'not_ready' | 'idempotency_conflict' |
        'integrity_conflict' | 'commit_unverified';
    };

export interface GmailArchiveTerminalizationPort {
  terminalize(input: {
    command: GmailInboxMutationCommand;
    result: GmailInboxMutationResult;
  }): Promise<GmailArchiveTerminalizationResult>;
}

export type GmailArchiveRecordedObservationReconciliationResult =
  | { ok: true; reconciled: true }
  | {
      ok: true;
      reconciled: false;
      state: 'reconciliation_replay' | 'already_terminal' | 'terminal';
    }
  | {
      ok: false;
      error: 'invalid_input' | 'not_found' | 'not_ready' | 'stale_lease' |
        'integrity_conflict' | 'idempotency_conflict' | 'commit_unverified';
    };

export interface GmailArchiveRecordedObservationReconcilerPort {
  reconcileRecordedObservation(
    fence: GmailArchiveRecoveryLeaseFence,
  ): Promise<GmailArchiveRecordedObservationReconciliationResult>;
}

export interface GmailArchiveRecoveryObservationPort {
  observe(fence: GmailArchiveRecoveryLeaseFence): Promise<unknown>;
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
  read(input: GmailArchiveCallerAuthority): Promise<ReadGmailArchiveTerminalStatusResult>;
}

export interface GmailArchiveCallerKernelOptions {
  claimRepository: GmailArchiveClaimPort;
  mutation: GmailInboxMutationPort;
  terminalizationRepository: GmailArchiveTerminalizationPort;
  observation: GmailArchiveRecoveryObservationPort;
  recordedObservationReconciler: GmailArchiveRecordedObservationReconcilerPort;
  terminalStatusReader: GmailArchiveTerminalStatusReaderPort;
}

export type GmailArchiveCallerStage =
  | 'claim'
  | 'mutation'
  | 'terminalization'
  | 'observation'
  | 'reconciliation'
  | 'terminal_status';

export type GmailArchiveCallerResult =
  | {
      ok: true;
      status: 'terminal';
      terminal: Readonly<GmailArchiveVisibleTerminalStatus>;
    }
  | {
      ok: true;
      status: 'not_started';
      reason: 'not_ready' | 'in_progress';
    }
  | { ok: false; error: 'invalid_input'; stage: 'claim' | 'observation' }
  | {
      ok: false;
      error: 'claim_rejected';
      code: 'invalid_input' | 'not_found' | 'policy_stale' | 'idempotency_conflict';
    }
  | {
      ok: false;
      error: 'terminalization_rejected';
      code: 'invalid_input' | 'not_found' | 'not_ready' | 'idempotency_conflict' |
        'integrity_conflict';
    }
  | {
      ok: false;
      error: 'reconciliation_rejected';
      code: 'invalid_input' | 'not_found' | 'not_ready' | 'stale_lease' |
        'integrity_conflict' | 'idempotency_conflict';
    }
  | { ok: false; error: 'unverified'; stage: GmailArchiveCallerStage };

type TerminalizationFallback =
  | Extract<GmailArchiveCallerResult, { error: 'terminalization_rejected' }>
  | Extract<GmailArchiveCallerResult, { error: 'unverified' }>;

type ReconciliationFallback =
  | Extract<GmailArchiveCallerResult, { error: 'reconciliation_rejected' }>
  | Extract<GmailArchiveCallerResult, { error: 'unverified' }>;

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

function plainData(value: unknown): Record<string, unknown> | null {
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

function canonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function canonicalPhaseTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})(?:\d{3})?Z$/.exec(value);
  if (!match) return false;
  try {
    return new Date(`${match[1]}Z`).toISOString() === `${match[1]}Z`;
  } catch {
    return false;
  }
}

function snapshotAuthority(value: unknown): Readonly<GmailArchiveCallerAuthority> | null {
  const authority = ownData(value, AUTHORITY_KEYS);
  if (!authority || typeof authority['userId'] !== 'string' || !UUID.test(authority['userId']) ||
      typeof authority['approvalId'] !== 'string' || !UUID.test(authority['approvalId'])) return null;
  return Object.freeze({ userId: authority['userId'], approvalId: authority['approvalId'] });
}

function snapshotCommand(value: unknown): Readonly<GmailInboxMutationCommand> | null {
  const command = ownData(value, COMMAND_KEYS);
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

function snapshotBinding(value: unknown): Readonly<GmailInboxMutationBinding> | null {
  const binding = ownData(value, BINDING_KEYS);
  if (!binding || typeof binding['userId'] !== 'string' || !UUID.test(binding['userId']) ||
      typeof binding['admissionId'] !== 'string' || !UUID.test(binding['admissionId']) ||
      typeof binding['messageRefId'] !== 'string' || !UUID.test(binding['messageRefId'])) return null;
  return Object.freeze({
    userId: binding['userId'],
    admissionId: binding['admissionId'],
    messageRefId: binding['messageRefId'],
  });
}

function sameBinding(
  binding: Readonly<GmailInboxMutationBinding>,
  command: Readonly<GmailInboxMutationCommand>,
): boolean {
  return binding.userId === command.userId && binding.admissionId === command.admissionId &&
    binding.messageRefId === command.messageRefId;
}

function snapshotFence(value: unknown): Readonly<GmailArchiveRecoveryLeaseFence> | null {
  const fence = ownData(value, FENCE_KEYS);
  if (!fence || typeof fence['userId'] !== 'string' || !UUID.test(fence['userId']) ||
      typeof fence['approvalId'] !== 'string' || !UUID.test(fence['approvalId']) ||
      typeof fence['admissionId'] !== 'string' || !UUID.test(fence['admissionId']) ||
      typeof fence['messageRefId'] !== 'string' || !UUID.test(fence['messageRefId']) ||
      fence['workKind'] !== 'observe_dispatch' || fence['barrierStatus'] !== 'in_progress' ||
      fence['attemptPhase'] !== 'dispatch_may_have_started' ||
      !canonicalPhaseTimestamp(fence['phaseChangedAt']) ||
      typeof fence['leaseToken'] !== 'string' || !UUID.test(fence['leaseToken']) ||
      !Number.isSafeInteger(fence['generation']) || (fence['generation'] as number) < 1) return null;
  return Object.freeze({
    userId: fence['userId'],
    approvalId: fence['approvalId'],
    admissionId: fence['admissionId'],
    messageRefId: fence['messageRefId'],
    workKind: 'observe_dispatch',
    barrierStatus: 'in_progress',
    attemptPhase: 'dispatch_may_have_started',
    phaseChangedAt: fence['phaseChangedAt'],
    leaseToken: fence['leaseToken'],
    generation: fence['generation'] as number,
  });
}

function snapshotClaim(
  value: unknown,
  authority: Readonly<GmailArchiveCallerAuthority>,
): GmailArchiveClaimResult | null {
  const data = plainData(value);
  if (!data || data['ok'] === false) {
    const failure = ownData(value, ['error', 'ok']);
    return failure?.['ok'] === false && typeof failure['error'] === 'string' && [
      'invalid_input', 'not_found', 'policy_stale', 'idempotency_conflict',
    ].includes(failure['error'])
      ? Object.freeze({ ok: false, error: failure['error'] }) as GmailArchiveClaimResult
      : null;
  }
  if (data['ok'] !== true || typeof data['claimed'] !== 'boolean') return null;
  if (data['claimed'] === false) {
    const notClaimed = ownData(value, ['claimed', 'command', 'ok', 'state']);
    if (!notClaimed || notClaimed['ok'] !== true || notClaimed['claimed'] !== false ||
        notClaimed['command'] !== null || !['not_ready', 'in_progress', 'terminal']
          .includes(notClaimed['state'] as string)) return null;
    return Object.freeze({
      ok: true,
      claimed: false,
      state: notClaimed['state'],
      command: null,
    }) as GmailArchiveClaimResult;
  }
  const claimed = ownData(value, ['claimed', 'command', 'ok']);
  const command = snapshotCommand(claimed?.['command']);
  if (!claimed || claimed['ok'] !== true || claimed['claimed'] !== true || !command ||
      command.userId !== authority.userId) return null;
  return Object.freeze({ ok: true, claimed: true, command });
}

type ParsedMutation =
  | { kind: 'bound'; result: Readonly<GmailInboxMutationResult> }
  | { kind: 'unbound_invalid_command' };

function snapshotMutation(
  value: unknown,
  command: Readonly<GmailInboxMutationCommand>,
): ParsedMutation | null {
  const data = plainData(value);
  if (!data || (data['outcome'] !== 'confirmed' && data['outcome'] !== 'known_failure' &&
      data['outcome'] !== 'unknown')) return null;
  if (data['outcome'] === 'confirmed') {
    const confirmed = ownData(value, [
      'binding', 'compensationAvailable', 'effect', 'inbox', 'observedAt', 'operation', 'outcome',
    ]);
    const binding = snapshotBinding(confirmed?.['binding']);
    if (!confirmed || confirmed['outcome'] !== 'confirmed' || confirmed['operation'] !== 'archive' ||
        confirmed['inbox'] !== false || !['changed', 'already_in_state', 'reconciled']
          .includes(confirmed['effect'] as string) || confirmed['compensationAvailable'] !== false ||
        !canonicalIsoInstant(confirmed['observedAt']) || !binding || !sameBinding(binding, command)) {
      return null;
    }
    return {
      kind: 'bound',
      result: Object.freeze({
        outcome: 'confirmed',
        operation: 'archive',
        inbox: false,
        effect: confirmed['effect'],
        compensationAvailable: false,
        observedAt: confirmed['observedAt'],
        binding,
      }) as Readonly<GmailInboxMutationResult>,
    };
  }
  if (data['outcome'] === 'known_failure' && data['code'] === 'invalid_command') {
    const invalid = ownData(value, ['code', 'compensationAvailable', 'outcome']);
    return invalid?.['outcome'] === 'known_failure' && invalid['code'] === 'invalid_command' &&
      invalid['compensationAvailable'] === false
      ? { kind: 'unbound_invalid_command' }
      : null;
  }
  const result = ownData(value, ['binding', 'code', 'compensationAvailable', 'outcome']);
  const binding = snapshotBinding(result?.['binding']);
  if (!result || result['compensationAvailable'] !== false || !binding ||
      !sameBinding(binding, command)) return null;
  if (result['outcome'] === 'known_failure' && typeof result['code'] === 'string' && [
    'not_admitted', 'admission_unavailable', 'credentials_unavailable',
    'preflight_unavailable', 'remote_rejected',
  ].includes(result['code'])) {
    return {
      kind: 'bound',
      result: Object.freeze({
        outcome: 'known_failure',
        code: result['code'],
        compensationAvailable: false,
        binding,
      }) as Readonly<GmailInboxMutationResult>,
    };
  }
  if (result['outcome'] === 'unknown' && result['code'] === 'remote_outcome_unknown') {
    return {
      kind: 'bound',
      result: Object.freeze({
        outcome: 'unknown',
        code: 'remote_outcome_unknown',
        compensationAvailable: false,
        binding,
      }),
    };
  }
  return null;
}

function terminalizationFallback(value: unknown): TerminalizationFallback {
  const success = ownData(value, ['created', 'ok', 'terminalization']);
  if (success?.['ok'] === true && typeof success['created'] === 'boolean' &&
      plainData(success['terminalization'])) {
    return Object.freeze({ ok: false, error: 'unverified', stage: 'terminalization' });
  }
  const failure = ownData(value, ['error', 'ok']);
  if (failure?.['ok'] !== false || typeof failure['error'] !== 'string') {
    return Object.freeze({ ok: false, error: 'unverified', stage: 'terminalization' });
  }
  if (failure['error'] === 'commit_unverified') {
    return Object.freeze({ ok: false, error: 'unverified', stage: 'terminalization' });
  }
  if (['invalid_input', 'not_found', 'not_ready', 'idempotency_conflict', 'integrity_conflict']
    .includes(failure['error'])) {
    return Object.freeze({
      ok: false,
      error: 'terminalization_rejected',
      code: failure['error'],
    }) as TerminalizationFallback;
  }
  return Object.freeze({ ok: false, error: 'unverified', stage: 'terminalization' });
}

function reconciliationFallback(value: unknown): ReconciliationFallback {
  const reconciled = ownData(value, ['ok', 'reconciled']);
  if (reconciled?.['ok'] === true && reconciled['reconciled'] === true) {
    return Object.freeze({ ok: false, error: 'unverified', stage: 'reconciliation' });
  }
  const control = ownData(value, ['ok', 'reconciled', 'state']);
  if (control?.['ok'] === true && control['reconciled'] === false &&
      typeof control['state'] === 'string' && [
        'reconciliation_replay', 'already_terminal', 'terminal',
      ].includes(control['state'])) {
    return Object.freeze({ ok: false, error: 'unverified', stage: 'reconciliation' });
  }
  const failure = ownData(value, ['error', 'ok']);
  if (failure?.['ok'] !== false || typeof failure['error'] !== 'string') {
    return Object.freeze({ ok: false, error: 'unverified', stage: 'reconciliation' });
  }
  if (failure['error'] === 'commit_unverified') {
    return Object.freeze({ ok: false, error: 'unverified', stage: 'reconciliation' });
  }
  if (['invalid_input', 'not_found', 'not_ready', 'stale_lease', 'integrity_conflict',
    'idempotency_conflict'].includes(failure['error'])) {
    return Object.freeze({
      ok: false,
      error: 'reconciliation_rejected',
      code: failure['error'],
    }) as ReconciliationFallback;
  }
  return Object.freeze({ ok: false, error: 'unverified', stage: 'reconciliation' });
}

function snapshotTerminalStatus(value: unknown): ReadGmailArchiveTerminalStatusResult | null {
  const terminalResult = ownData(value, ['ok', 'status', 'terminal']);
  if (terminalResult?.['ok'] === true && terminalResult['status'] === 'not_terminal' &&
      terminalResult['terminal'] === null) {
    return Object.freeze({ ok: true, status: 'not_terminal', terminal: null });
  }
  if (terminalResult?.['ok'] === true && terminalResult['status'] === 'terminal') {
    const terminal = ownData(terminalResult['terminal'], [
      'disposition', 'receiptRevisionId', 'recordedAt',
    ]);
    if (!terminal || typeof terminal['disposition'] !== 'string' ||
        !['blocked', 'succeeded', 'failed', 'unknown'].includes(terminal['disposition']) ||
        typeof terminal['receiptRevisionId'] !== 'string' ||
        !UUID.test(terminal['receiptRevisionId']) || !canonicalIsoInstant(terminal['recordedAt'])) {
      return null;
    }
    return Object.freeze({
      ok: true,
      status: 'terminal',
      terminal: Object.freeze({
        disposition: terminal['disposition'],
        receiptRevisionId: terminal['receiptRevisionId'],
        recordedAt: terminal['recordedAt'],
      }),
    }) as ReadGmailArchiveTerminalStatusResult;
  }
  const failure = ownData(value, ['error', 'ok']);
  return failure?.['ok'] === false && typeof failure['error'] === 'string' &&
    ['invalid_input', 'not_found', 'integrity_conflict'].includes(failure['error'])
    ? Object.freeze({ ok: false, error: failure['error'] }) as ReadGmailArchiveTerminalStatusResult
    : null;
}

export class GmailArchiveCallerKernel {
  private readonly claim: GmailArchiveClaimPort['claim'];
  private readonly mutate: GmailInboxMutationPort['mutate'];
  private readonly terminalize: GmailArchiveTerminalizationPort['terminalize'];
  private readonly observe: GmailArchiveRecoveryObservationPort['observe'];
  private readonly reconcileRecordedObservation:
    GmailArchiveRecordedObservationReconcilerPort['reconcileRecordedObservation'];
  private readonly readTerminalStatus: GmailArchiveTerminalStatusReaderPort['read'];

  constructor(options: GmailArchiveCallerKernelOptions) {
    const claimRepository = options.claimRepository;
    const mutation = options.mutation;
    const terminalizationRepository = options.terminalizationRepository;
    const observation = options.observation;
    const recordedObservationReconciler = options.recordedObservationReconciler;
    const terminalStatusReader = options.terminalStatusReader;
    const claim = claimRepository.claim;
    const mutate = mutation.mutate;
    const terminalize = terminalizationRepository.terminalize;
    const observe = observation.observe;
    const reconcileRecordedObservation = recordedObservationReconciler.reconcileRecordedObservation;
    const readTerminalStatus = terminalStatusReader.read;
    this.claim = claim.bind(claimRepository);
    this.mutate = mutate.bind(mutation);
    this.terminalize = terminalize.bind(terminalizationRepository);
    this.observe = observe.bind(observation);
    this.reconcileRecordedObservation = reconcileRecordedObservation
      .bind(recordedObservationReconciler);
    this.readTerminalStatus = readTerminalStatus.bind(terminalStatusReader);
  }

  async executeApproved(submitted: GmailArchiveCallerAuthority): Promise<GmailArchiveCallerResult> {
    const authority = snapshotAuthority(submitted);
    if (!authority) return Object.freeze({ ok: false, error: 'invalid_input', stage: 'claim' });
    let claimValue: unknown;
    try {
      claimValue = await this.claim(authority);
    } catch {
      return Object.freeze({ ok: false, error: 'unverified', stage: 'claim' });
    }
    const claim = snapshotClaim(claimValue, authority);
    if (!claim) return Object.freeze({ ok: false, error: 'unverified', stage: 'claim' });
    if (!claim.ok) {
      return Object.freeze({ ok: false, error: 'claim_rejected', code: claim.error });
    }
    if (!claim.claimed) {
      if (claim.state !== 'terminal') {
        return Object.freeze({ ok: true, status: 'not_started', reason: claim.state });
      }
      return this.readStatus(authority,
        Object.freeze({ ok: false, error: 'unverified', stage: 'terminal_status' }));
    }

    let mutationValue: unknown;
    try {
      mutationValue = await this.mutate(claim.command);
    } catch {
      return Object.freeze({ ok: false, error: 'unverified', stage: 'mutation' });
    }
    const mutation = snapshotMutation(mutationValue, claim.command);
    if (!mutation || mutation.kind === 'unbound_invalid_command') {
      return Object.freeze({ ok: false, error: 'unverified', stage: 'mutation' });
    }

    let fallback: TerminalizationFallback;
    try {
      const terminalization = await this.terminalize(Object.freeze({
        command: claim.command,
        result: mutation.result,
      }));
      fallback = terminalizationFallback(terminalization);
    } catch {
      fallback = Object.freeze({ ok: false, error: 'unverified', stage: 'terminalization' });
    }
    return this.readStatus(authority, fallback);
  }

  async reconcileObserved(
    submitted: GmailArchiveRecoveryLeaseFence,
  ): Promise<GmailArchiveCallerResult> {
    const fence = snapshotFence(submitted);
    if (!fence) return Object.freeze({ ok: false, error: 'invalid_input', stage: 'observation' });
    try {
      await this.observe(fence);
    } catch {
      // Durable DB evidence, not the coordinator reply, is the only handoff.
    }
    let fallback: ReconciliationFallback;
    try {
      fallback = reconciliationFallback(await this.reconcileRecordedObservation(fence));
    } catch {
      fallback = Object.freeze({ ok: false, error: 'unverified', stage: 'reconciliation' });
    }
    return this.readStatus(Object.freeze({
      userId: fence.userId,
      approvalId: fence.approvalId,
    }), fallback);
  }

  private async readStatus(
    authority: Readonly<GmailArchiveCallerAuthority>,
    fallback: TerminalizationFallback | ReconciliationFallback |
      Extract<GmailArchiveCallerResult, { error: 'unverified' }>,
  ): Promise<GmailArchiveCallerResult> {
    let statusValue: unknown;
    try {
      statusValue = await this.readTerminalStatus(authority);
    } catch {
      return Object.freeze({ ok: false, error: 'unverified', stage: 'terminal_status' });
    }
    const status = snapshotTerminalStatus(statusValue);
    if (!status || !status.ok) {
      return Object.freeze({ ok: false, error: 'unverified', stage: 'terminal_status' });
    }
    if (status.status === 'terminal') {
      return Object.freeze({ ok: true, status: 'terminal', terminal: status.terminal });
    }
    return fallback;
  }
}

export const gmailArchiveCallerKernelTestHooks = Object.freeze({
  snapshotAuthority,
  snapshotClaim,
  snapshotCommand,
  snapshotFence,
  snapshotMutation,
  snapshotTerminalStatus,
});
