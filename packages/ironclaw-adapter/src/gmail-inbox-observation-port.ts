import {
  DbTokenStore,
  type AuditLogPort,
  type GoogleOAuthConfig,
} from '@skytwin/connectors';
import {
  GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS,
  gmailInboxObservationTargetRepository,
  oauthRepository,
  type GmailInboxObservationTarget,
} from '@skytwin/db';
import type {
  GmailArchiveRecoveryLeaseFence,
  GmailArchiveRecoveryLeaseRepository,
  GmailArchiveRecoveryObservationEvidence,
  GmailArchiveRecoveryObservationPermit,
  GmailInboxObservationCommand,
  GmailInboxObservationBinding,
  GmailInboxObservationPort,
  GmailInboxObservationResult,
  GmailInboxObservationUnavailableCode,
} from '@skytwin/shared-types';
import {
  cancelGmailResponseBody,
  gmailMessageStateResponseLimits,
  parseExactGmailMessageState,
} from './gmail-message-state-response.js';

interface GmailArchiveRecoveryObservationSelection {
  connectorAccountId: string;
  credentialRevision: string;
  providerMessageId: string;
}

interface GmailArchiveRecoveryObservationFinalTargetInput {
  permit: GmailArchiveRecoveryObservationPermit;
  selection: GmailArchiveRecoveryObservationSelection;
  credentialRevision: string;
}

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL_API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const COMMAND_KEYS = ['admissionId', 'messageRefId', 'operation', 'userId'] as const;
const TARGET_KEYS = ['connectorAccountId', 'credentialRevision', 'providerMessageId'] as const;
const CREDENTIAL_KEYS = ['accessToken', 'credentialRevision', 'scopes'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ACCESS_TOKEN_LENGTH = 16 * 1024;

interface KeyCacheLike {
  get(userId: string): Buffer | null;
  has(userId: string): boolean;
  set(userId: string, key: Buffer): void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GmailInboxObservationCredentialRequest {
  userId: string;
  connectorAccountId: string;
  requiredScope: typeof GMAIL_MODIFY_SCOPE;
}

export interface GmailInboxObservationCredential {
  accessToken: string;
  credentialRevision: string;
  scopes: readonly string[];
}

/**
 * Narrow secret-materialization seam. Implementations may refresh OAuth and
 * persist token CAS/lazy-migration/audit maintenance; callers must not describe
 * this boundary as globally read-only or zero-write.
 */
export interface GmailInboxObservationCredentialsPort {
  materialize(
    request: GmailInboxObservationCredentialRequest,
  ): Promise<GmailInboxObservationCredential | null>;
}

export interface GmailInboxObservationTargetResolver {
  resolve(
    command: GmailInboxObservationCommand,
  ): Promise<Readonly<GmailInboxObservationTarget> | null>;
}

export interface GmailInboxObservationServiceOptions {
  credentials: GmailInboxObservationCredentialsPort;
  targetResolver?: GmailInboxObservationTargetResolver;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface DbGmailInboxObservationCredentialsOptions {
  googleOAuthConfig: GoogleOAuthConfig;
  keyCache?: KeyCacheLike;
  auditLog?: AuditLogPort;
  auditActor?: string;
}

/** Account-bound DbTokenStore adapter; not constructed by any runtime yet. */
export class DbGmailInboxObservationCredentials implements GmailInboxObservationCredentialsPort {
  private readonly googleOAuthConfig: Readonly<GoogleOAuthConfig>;
  private readonly keyCache: KeyCacheLike | null;
  private readonly auditLog: AuditLogPort | null;
  private readonly auditActor: string;

  constructor(options: DbGmailInboxObservationCredentialsOptions) {
    this.googleOAuthConfig = Object.freeze({
      clientId: options.googleOAuthConfig.clientId,
      clientSecret: options.googleOAuthConfig.clientSecret,
      redirectUri: options.googleOAuthConfig.redirectUri,
    });
    this.keyCache = options.keyCache ? Object.freeze({
      get: options.keyCache.get.bind(options.keyCache),
      has: options.keyCache.has.bind(options.keyCache),
      set: options.keyCache.set.bind(options.keyCache),
    }) : null;
    this.auditLog = options.auditLog ? Object.freeze({
      recordAccess: options.auditLog.recordAccess.bind(options.auditLog),
    }) : null;
    this.auditActor = options.auditActor ?? 'gmail_inbox_observation';
  }

  async materialize(
    request: GmailInboxObservationCredentialRequest,
  ): Promise<GmailInboxObservationCredential | null> {
    const input = snapshotCredentialRequest(request);
    if (!input) throw new TypeError('invalid Gmail Inbox observation credential request');
    const store = new DbTokenStore(
      oauthRepository,
      this.googleOAuthConfig,
      undefined,
      input.connectorAccountId,
    );
    if (this.keyCache) store.setKeyCache(this.keyCache);
    if (this.auditLog) {
      store.setAuditLog(this.auditLog, this.auditActor);
    }
    const token = await store.refreshIfExpiredWithRevision(input.userId, 'google');
    return Object.freeze({
      accessToken: token.accessToken,
      credentialRevision: token.credentialRevision,
      scopes: Object.freeze([...token.scopes]),
    });
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

function snapshotStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
): readonly string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0 || value.length > maxItems) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors);
    if (names.length !== value.length + 1 || !names.includes('length')) return null;
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true || typeof descriptor.value !== 'string' ||
          descriptor.value.length > maxItemLength) return null;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function snapshotCommand(value: unknown): Readonly<GmailInboxObservationCommand> | null {
  const command = ownData(value, COMMAND_KEYS);
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

function snapshotCredentialRequest(
  value: unknown,
): Readonly<GmailInboxObservationCredentialRequest> | null {
  const request = ownData(value, ['connectorAccountId', 'requiredScope', 'userId']);
  if (!request || typeof request['userId'] !== 'string' || !UUID.test(request['userId']) ||
      typeof request['connectorAccountId'] !== 'string' || !UUID.test(request['connectorAccountId']) ||
      request['requiredScope'] !== GMAIL_MODIFY_SCOPE) return null;
  return Object.freeze({
    userId: request['userId'],
    connectorAccountId: request['connectorAccountId'],
    requiredScope: GMAIL_MODIFY_SCOPE,
  });
}

function snapshotTarget(value: unknown): Readonly<GmailInboxObservationTarget> | null {
  const target = ownData(value, TARGET_KEYS);
  if (!target || typeof target['connectorAccountId'] !== 'string' ||
      !UUID.test(target['connectorAccountId']) ||
      typeof target['credentialRevision'] !== 'string' || !UUID.test(target['credentialRevision']) ||
      typeof target['providerMessageId'] !== 'string' ||
      target['providerMessageId'].length === 0 || target['providerMessageId'].length > 2_048) return null;
  try {
    encodeURIComponent(target['providerMessageId']);
  } catch {
    return null;
  }
  return Object.freeze({
    connectorAccountId: target['connectorAccountId'],
    credentialRevision: target['credentialRevision'],
    providerMessageId: target['providerMessageId'],
  });
}

function snapshotCredential(value: unknown): Readonly<GmailInboxObservationCredential> | null {
  const credential = ownData(value, CREDENTIAL_KEYS);
  if (!credential || typeof credential['accessToken'] !== 'string' ||
      credential['accessToken'].length === 0 ||
      credential['accessToken'].length > MAX_ACCESS_TOKEN_LENGTH ||
      typeof credential['credentialRevision'] !== 'string' ||
      !UUID.test(credential['credentialRevision'])) return null;
  const scopes = snapshotStringArray(credential['scopes'], 128, 512);
  if (!scopes) return null;
  return Object.freeze({
    accessToken: credential['accessToken'],
    credentialRevision: credential['credentialRevision'],
    scopes,
  });
}

function observationBinding(
  command: Readonly<GmailInboxObservationCommand>,
): Readonly<GmailInboxObservationBinding> {
  return Object.freeze({
    userId: command.userId,
    admissionId: command.admissionId,
    messageRefId: command.messageRefId,
  });
}

function unavailable(
  code: GmailInboxObservationUnavailableCode,
  binding: Readonly<GmailInboxObservationBinding>,
): GmailInboxObservationResult {
  return Object.freeze({ outcome: 'unavailable', code, binding });
}

/**
 * Unregistered Gmail-mailbox observation boundary. It performs no Gmail
 * mutation and issues at most one Gmail resource GET. Credential
 * materialization may perform OAuth maintenance before that GET.
 */
export class GmailInboxObservationService implements GmailInboxObservationPort {
  private readonly fetchFn: FetchLike;
  private readonly targetResolver: GmailInboxObservationTargetResolver;
  private readonly materializeCredential: GmailInboxObservationCredentialsPort['materialize'];
  private readonly timeoutMs: number;

  constructor(options: GmailInboxObservationServiceOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.materializeCredential = options.credentials.materialize.bind(options.credentials);
    this.targetResolver = options.targetResolver ?? Object.freeze({
      resolve: async () => null,
    });
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new TypeError('timeoutMs must be a finite value between 1 and 60000');
    }
    this.timeoutMs = timeoutMs;
  }

  async observe(
    submittedCommand: GmailInboxObservationCommand,
  ): Promise<GmailInboxObservationResult> {
    const command = snapshotCommand(submittedCommand);
    if (!command) return Object.freeze({ outcome: 'unavailable', code: 'invalid_command' });
    const binding = observationBinding(command);

    let initialTarget: Readonly<GmailInboxObservationTarget> | null;
    try {
      initialTarget = snapshotTarget(await this.targetResolver.resolve(command));
    } catch {
      return unavailable('authority_unavailable', binding);
    }
    if (!initialTarget) return unavailable('not_observable', binding);

    let credential: Readonly<GmailInboxObservationCredential> | null;
    try {
      credential = snapshotCredential(await this.materializeCredential(Object.freeze({
        userId: command.userId,
        connectorAccountId: initialTarget.connectorAccountId,
        requiredScope: GMAIL_MODIFY_SCOPE,
      })));
    } catch {
      return unavailable('credentials_unavailable', binding);
    }
    if (!credential || !credential.scopes.includes(GMAIL_MODIFY_SCOPE)) {
      return unavailable('credentials_unavailable', binding);
    }

    // Credential refresh can race with disconnect, scope changes, graph
    // terminalization, or target replacement. A fresh exact authority read is
    // required immediately before the only Gmail request.
    let currentTarget: Readonly<GmailInboxObservationTarget> | null;
    try {
      currentTarget = snapshotTarget(await this.targetResolver.resolve(command));
    } catch {
      return unavailable('authority_unavailable', binding);
    }
    if (!currentTarget ||
        currentTarget.connectorAccountId !== initialTarget.connectorAccountId ||
        currentTarget.credentialRevision !== credential.credentialRevision ||
        currentTarget.providerMessageId !== initialTarget.providerMessageId) {
      return unavailable('not_observable', binding);
    }

    return requestGmailInbox(
      currentTarget.providerMessageId,
      credential.accessToken,
      binding,
      this.fetchFn,
      this.timeoutMs,
    );
  }
}

function requestGmailInbox(
  providerMessageId: string,
  accessToken: string,
  binding: Readonly<GmailInboxObservationBinding>,
  fetchFn: FetchLike,
  timeoutMs: number,
): Promise<GmailInboxObservationResult> {
  return (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${GMAIL_API_ROOT}/${encodeURIComponent(providerMessageId)}` +
        '?format=minimal&fields=id%2ClabelIds';
      const response = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Cache-Control': 'no-store',
        },
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 401) {
        await cancelGmailResponseBody(response);
        return unavailable('credentials_unavailable', binding);
      }
      if ([400, 403, 404, 409].includes(response.status)) {
        await cancelGmailResponseBody(response);
        return unavailable('observation_rejected', binding);
      }
      if (response.status !== 200) {
        await cancelGmailResponseBody(response);
        return unavailable('observation_unavailable', binding);
      }
      const inbox = await parseExactGmailMessageState(response, providerMessageId);
      if (inbox === null) return unavailable('observation_unavailable', binding);
      // This is local evidence-acceptance time: only a completely received,
      // bounded, exact provider representation qualifies as an observation.
      const observedAt = new Date().toISOString();
      return Object.freeze({
        outcome: 'observed',
        operation: 'observe_inbox',
        inbox,
        observedAt,
        binding,
      });
    } catch {
      return unavailable('observation_unavailable', binding);
    } finally {
      clearTimeout(timeout);
    }
  })();
}

export interface GmailArchiveRecoveryObservationTargetResolver {
  resolveInitial(
    permit: GmailArchiveRecoveryObservationPermit,
  ): Promise<Readonly<GmailArchiveRecoveryObservationSelection> | null>;
  resolveFinal(
    input: GmailArchiveRecoveryObservationFinalTargetInput,
  ): Promise<Readonly<GmailArchiveRecoveryObservationSelection> | null>;
}

export interface GmailArchiveRecoveryObservationCoordinatorOptions {
  leaseRepository: GmailArchiveRecoveryLeaseRepository;
  credentials: GmailInboxObservationCredentialsPort;
  targetResolver?: GmailArchiveRecoveryObservationTargetResolver;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export type GmailArchiveRecoveryObservationCoordinatorResult =
  | { status: 'not_permitted' }
  | {
      status: 'evidence_recorded' | 'evidence_unverified';
      evidence: Readonly<GmailArchiveRecoveryObservationEvidence>;
    };

const RECOVERY_FENCE_KEYS = [
  'admissionId', 'approvalId', 'attemptPhase', 'barrierStatus', 'generation',
  'leaseToken', 'messageRefId', 'phaseChangedAt', 'userId', 'workKind',
] as const;
const RECOVERY_PERMIT_KEYS = [
  ...RECOVERY_FENCE_KEYS, 'authorizedAt', 'deadlineAt', 'leaseExpiresAt',
  'observationAttemptId',
] as const;

function canonicalTimestamp(value: unknown): value is string {
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

function exactTimestampEpochMicroseconds(value: string): bigint | null {
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) return null;
  const subMilliseconds = /\.\d{3}(\d{3})?Z$/.exec(value)?.[1] ?? '0';
  return BigInt(epochMilliseconds) * 1_000n + BigInt(subMilliseconds);
}

function snapshotRecoveryFence(
  value: unknown,
): Readonly<GmailArchiveRecoveryLeaseFence> | null {
  const fence = ownData(value, RECOVERY_FENCE_KEYS);
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
    userId: fence['userId'], approvalId: fence['approvalId'],
    admissionId: fence['admissionId'], messageRefId: fence['messageRefId'],
    workKind: 'observe_dispatch', barrierStatus: 'in_progress',
    attemptPhase: 'dispatch_may_have_started', phaseChangedAt: fence['phaseChangedAt'],
    leaseToken: fence['leaseToken'], generation: fence['generation'] as number,
  });
}

function sameRecoveryFence(
  permit: Readonly<GmailArchiveRecoveryObservationPermit>,
  fence: Readonly<GmailArchiveRecoveryLeaseFence>,
): boolean {
  return permit.userId === fence.userId && permit.approvalId === fence.approvalId &&
    permit.admissionId === fence.admissionId && permit.messageRefId === fence.messageRefId &&
    permit.workKind === fence.workKind && permit.barrierStatus === fence.barrierStatus &&
    permit.attemptPhase === fence.attemptPhase && permit.phaseChangedAt === fence.phaseChangedAt &&
    permit.leaseToken === fence.leaseToken && permit.generation === fence.generation;
}

function snapshotRecoveryPermit(
  value: unknown,
): Readonly<GmailArchiveRecoveryObservationPermit> | null {
  const permit = ownData(value, RECOVERY_PERMIT_KEYS);
  if (!permit || typeof permit['userId'] !== 'string' || !UUID.test(permit['userId']) ||
      typeof permit['approvalId'] !== 'string' || !UUID.test(permit['approvalId']) ||
      typeof permit['admissionId'] !== 'string' || !UUID.test(permit['admissionId']) ||
      typeof permit['messageRefId'] !== 'string' || !UUID.test(permit['messageRefId']) ||
      permit['workKind'] !== 'observe_dispatch' || permit['barrierStatus'] !== 'in_progress' ||
      permit['attemptPhase'] !== 'dispatch_may_have_started' ||
      !canonicalPhaseTimestamp(permit['phaseChangedAt']) ||
      typeof permit['leaseToken'] !== 'string' || !UUID.test(permit['leaseToken']) ||
      !Number.isSafeInteger(permit['generation']) || (permit['generation'] as number) < 1 ||
      typeof permit['observationAttemptId'] !== 'string' ||
      !UUID.test(permit['observationAttemptId']) || !canonicalTimestamp(permit['authorizedAt']) ||
      !canonicalTimestamp(permit['deadlineAt']) ||
      !canonicalTimestamp(permit['leaseExpiresAt'])) return null;
  const authorizedAt = exactTimestampEpochMicroseconds(permit['authorizedAt']);
  const deadlineAt = exactTimestampEpochMicroseconds(permit['deadlineAt']);
  const leaseExpiresAt = exactTimestampEpochMicroseconds(permit['leaseExpiresAt']);
  const phaseChangedAt = exactTimestampEpochMicroseconds(permit['phaseChangedAt']);
  if (authorizedAt === null || deadlineAt === null || leaseExpiresAt === null ||
      phaseChangedAt === null || authorizedAt < phaseChangedAt ||
      authorizedAt >= leaseExpiresAt || deadlineAt - authorizedAt !==
        BigInt(GMAIL_ARCHIVE_RECOVERY_OBSERVATION_DEADLINE_SECONDS) * 1_000_000n) return null;
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

/**
 * Unregistered one-shot recovery coordinator. The permit is consumed before
 * any connector authority or credential work and is never returned as data.
 */
export class GmailArchiveRecoveryObservationCoordinator {
  private readonly beginObservation: GmailArchiveRecoveryLeaseRepository['beginObservation'];
  private readonly recordObservation: GmailArchiveRecoveryLeaseRepository['recordObservation'];
  private readonly materializeCredential: GmailInboxObservationCredentialsPort['materialize'];
  private readonly resolveInitial: GmailArchiveRecoveryObservationTargetResolver['resolveInitial'];
  private readonly resolveFinal: GmailArchiveRecoveryObservationTargetResolver['resolveFinal'];
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: GmailArchiveRecoveryObservationCoordinatorOptions) {
    this.beginObservation = options.leaseRepository.beginObservation.bind(options.leaseRepository);
    this.recordObservation = options.leaseRepository.recordObservation.bind(options.leaseRepository);
    this.materializeCredential = options.credentials.materialize.bind(options.credentials);
    const resolver = options.targetResolver ?? gmailInboxObservationTargetRepository;
    this.resolveInitial = resolver.resolveInitial.bind(resolver);
    this.resolveFinal = resolver.resolveFinal.bind(resolver);
    this.fetchFn = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new TypeError('timeoutMs must be a finite value between 1 and 60000');
    }
    this.timeoutMs = timeoutMs;
  }

  async observe(
    submittedFence: GmailArchiveRecoveryLeaseFence,
  ): Promise<GmailArchiveRecoveryObservationCoordinatorResult> {
    const fence = snapshotRecoveryFence(submittedFence);
    if (!fence) return Object.freeze({ status: 'not_permitted' });
    let begun: Awaited<ReturnType<GmailArchiveRecoveryLeaseRepository['beginObservation']>>;
    try {
      begun = await this.beginObservation(fence);
    } catch {
      return Object.freeze({ status: 'not_permitted' });
    }
    if (!begun.ok || begun.status !== 'permitted') {
      return Object.freeze({ status: 'not_permitted' });
    }
    const permit = snapshotRecoveryPermit(begun.permit);
    if (!permit || !sameRecoveryFence(permit, fence)) {
      return Object.freeze({ status: 'not_permitted' });
    }
    const binding = Object.freeze({
      userId: permit.userId,
      admissionId: permit.admissionId,
      messageRefId: permit.messageRefId,
    });

    let selection: Readonly<GmailArchiveRecoveryObservationSelection> | null;
    try {
      selection = snapshotSelection(await this.resolveInitial(permit));
    } catch {
      return this.recordUnavailable(permit, binding, 'authority_unavailable');
    }
    if (!selection) return this.recordUnavailable(permit, binding, 'not_observable');

    let credential: Readonly<GmailInboxObservationCredential> | null;
    try {
      credential = snapshotCredential(await this.materializeCredential(Object.freeze({
        userId: permit.userId,
        connectorAccountId: selection.connectorAccountId,
        requiredScope: GMAIL_MODIFY_SCOPE,
      })));
    } catch {
      return this.recordUnavailable(permit, binding, 'credentials_unavailable');
    }
    if (!credential || !credential.scopes.includes(GMAIL_MODIFY_SCOPE)) {
      return this.recordUnavailable(permit, binding, 'credentials_unavailable');
    }

    let finalSelection: Readonly<GmailArchiveRecoveryObservationSelection> | null;
    try {
      finalSelection = snapshotSelection(await this.resolveFinal(Object.freeze({
        permit,
        selection,
        credentialRevision: credential.credentialRevision,
      })));
    } catch {
      return this.recordUnavailable(permit, binding, 'authority_unavailable');
    }
    if (!finalSelection || finalSelection.connectorAccountId !== selection.connectorAccountId ||
        finalSelection.credentialRevision !== credential.credentialRevision ||
        finalSelection.providerMessageId !== selection.providerMessageId) {
      return this.recordUnavailable(permit, binding, 'not_observable');
    }

    // Do not insert an await, callback, audit, cache, or dependency lookup
    // between this final exact authority result and invoking the only GET.
    const providerRequest = requestGmailInbox(
      finalSelection.providerMessageId,
      credential.accessToken,
      binding,
      this.fetchFn,
      this.timeoutMs,
    );
    const result = await providerRequest;
    const evidence: Readonly<GmailArchiveRecoveryObservationEvidence> = result.outcome === 'observed'
      ? Object.freeze({
          kind: 'mailbox_observed', binding, inbox: result.inbox, observedAt: result.observedAt,
        })
      : Object.freeze({
          kind: 'mailbox_observation_unavailable', binding,
          code: result.code === 'invalid_command' ? 'observation_unavailable' : result.code,
        });
    return this.recordEvidence(permit, evidence);
  }

  private recordUnavailable(
    permit: Readonly<GmailArchiveRecoveryObservationPermit>,
    binding: Readonly<GmailInboxObservationBinding>,
    code: GmailInboxObservationUnavailableCode,
  ): Promise<GmailArchiveRecoveryObservationCoordinatorResult> {
    return this.recordEvidence(permit, Object.freeze({
      kind: 'mailbox_observation_unavailable', binding, code,
    }));
  }

  private async recordEvidence(
    permit: Readonly<GmailArchiveRecoveryObservationPermit>,
    evidence: Readonly<GmailArchiveRecoveryObservationEvidence>,
  ): Promise<GmailArchiveRecoveryObservationCoordinatorResult> {
    try {
      const recorded = await this.recordObservation({ permit, evidence });
      return Object.freeze({
        status: recorded.ok ? 'evidence_recorded' : 'evidence_unverified',
        evidence,
      });
    } catch {
      return Object.freeze({ status: 'evidence_unverified', evidence });
    }
  }
}

export const gmailArchiveRecoveryObservationTestHooks = Object.freeze({
  snapshotRecoveryFence,
  snapshotRecoveryPermit,
  snapshotSelection,
});

export const gmailInboxObservationLimits = Object.freeze({
  ...gmailMessageStateResponseLimits,
});
