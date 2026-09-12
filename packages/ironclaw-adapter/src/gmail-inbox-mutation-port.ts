import {
  DbTokenStore,
  type AuditLogPort,
  type GoogleOAuthConfig,
} from '@skytwin/connectors';
import type {
  GmailInboxMutationBinding,
  GmailInboxMutationCommand,
  GmailInboxMutationDispatchGate,
  GmailInboxMutationPort,
  GmailInboxMutationResult,
  GmailInboxMutationTarget,
} from '@skytwin/shared-types';
import {
  gmailMessageRefRepository,
  oauthRepository,
} from '@skytwin/db';
import {
  cancelGmailResponseBody,
  gmailMessageStateResponseLimits,
  parseExactGmailMessageState,
} from './gmail-message-state-response.js';

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL_API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const COMMAND_KEYS = ['admissionId', 'messageRefId', 'operation', 'userId'] as const;
const TARGET_KEYS = ['connectorAccountId', 'credentialRevision', 'providerMessageId'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface KeyCacheLike {
  get(userId: string): Buffer | null;
  has(userId: string): boolean;
  set(userId: string, key: Buffer): void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GmailInboxMutationServiceOptions {
  googleOAuthConfig: GoogleOAuthConfig;
  dispatchGate: GmailInboxMutationDispatchGate;
  keyCache?: KeyCacheLike;
  auditLog?: AuditLogPort;
  auditActor?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

interface HttpResult {
  status?: number;
  accepted: boolean;
  inbox: boolean | null;
  observedAt?: Date;
  failed: boolean;
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

function parseCanonicalCommand(value: GmailInboxMutationCommand): Readonly<GmailInboxMutationCommand> | null {
  if (!value || typeof value !== 'object') return null;
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  let symbols: symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype || symbols.length !== 0) return null;
  const keys = Object.keys(descriptors).sort();
  if (keys.length !== COMMAND_KEYS.length || keys.some((key, index) => key !== COMMAND_KEYS[index])) {
    return null;
  }
  if (keys.some((key) => {
    const descriptor = descriptors[key];
    return !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.enumerable !== true;
  })) return null;
  const userId = descriptors['userId']!.value as unknown;
  const admissionId = descriptors['admissionId']!.value as unknown;
  const messageRefId = descriptors['messageRefId']!.value as unknown;
  const operation = descriptors['operation']!.value as unknown;
  if (
    typeof userId !== 'string' || !UUID.test(userId) ||
    typeof admissionId !== 'string' || !UUID.test(admissionId) ||
    typeof messageRefId !== 'string' || !UUID.test(messageRefId) ||
    operation !== 'archive'
  ) return null;
  return Object.freeze({ userId, admissionId, messageRefId, operation });
}

function deterministicClientFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function bindingFor(
  command: Readonly<GmailInboxMutationCommand>,
): Readonly<GmailInboxMutationBinding> {
  return Object.freeze({
    userId: command.userId,
    admissionId: command.admissionId,
    messageRefId: command.messageRefId,
  });
}

type BoundFailureCode = Exclude<
  Extract<GmailInboxMutationResult, { outcome: 'known_failure' }>['code'],
  'invalid_command'
>;

function knownFailure(
  binding: Readonly<GmailInboxMutationBinding>,
  code: BoundFailureCode,
): GmailInboxMutationResult {
  return Object.freeze({ outcome: 'known_failure', code, compensationAvailable: false, binding });
}

function unknownOutcome(
  binding: Readonly<GmailInboxMutationBinding>,
): GmailInboxMutationResult {
  return Object.freeze({
    outcome: 'unknown',
    code: 'remote_outcome_unknown',
    compensationAvailable: false,
    binding,
  });
}

function snapshotTarget(value: unknown): Readonly<GmailInboxMutationTarget> | null {
  const target = ownData(value, TARGET_KEYS);
  if (!target || typeof target['connectorAccountId'] !== 'string' ||
      !UUID.test(target['connectorAccountId']) ||
      typeof target['credentialRevision'] !== 'string' || !UUID.test(target['credentialRevision']) ||
      typeof target['providerMessageId'] !== 'string' || target['providerMessageId'].length === 0 ||
      target['providerMessageId'].length > 2_048) return null;
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

function sameTarget(
  left: Readonly<GmailInboxMutationTarget>,
  right: Readonly<GmailInboxMutationTarget>,
): boolean {
  return left.connectorAccountId === right.connectorAccountId &&
    left.credentialRevision === right.credentialRevision &&
    left.providerMessageId === right.providerMessageId;
}

function sameResource(
  left: Readonly<GmailInboxMutationTarget>,
  right: Readonly<GmailInboxMutationTarget>,
): boolean {
  return left.connectorAccountId === right.connectorAccountId &&
    left.providerMessageId === right.providerMessageId;
}

/**
 * An intentionally unregistered Gmail Inbox mutation boundary. Constructing
 * this service does not make it reachable from any API, worker, router, or
 * existing action handler.
 */
export class GmailInboxMutationService implements GmailInboxMutationPort {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly googleOAuthConfig: Readonly<GoogleOAuthConfig>;
  private readonly dispatchGateEnter: GmailInboxMutationDispatchGate['enter'];
  private readonly keyCache: KeyCacheLike | undefined;
  private readonly auditLog: AuditLogPort | undefined;
  private readonly auditActor: string;

  constructor(options: GmailInboxMutationServiceOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new TypeError('timeoutMs must be a finite value between 1 and 60000');
    }
    this.timeoutMs = timeoutMs;
    this.googleOAuthConfig = Object.freeze({
      clientId: options.googleOAuthConfig.clientId,
      clientSecret: options.googleOAuthConfig.clientSecret,
      redirectUri: options.googleOAuthConfig.redirectUri,
    });
    const gate = options.dispatchGate;
    this.dispatchGateEnter = gate.enter.bind(gate);
    if (options.keyCache) {
      const cache = options.keyCache;
      this.keyCache = Object.freeze({
        get: cache.get.bind(cache),
        has: cache.has.bind(cache),
        set: cache.set.bind(cache),
      });
    }
    if (options.auditLog) {
      const auditLog = options.auditLog;
      this.auditLog = Object.freeze({
        recordAccess: auditLog.recordAccess.bind(auditLog),
      });
    }
    this.auditActor = options.auditActor ?? 'gmail_inbox_mutation';
  }

  async mutate(submittedCommand: GmailInboxMutationCommand): Promise<GmailInboxMutationResult> {
    const command = parseCanonicalCommand(submittedCommand);
    if (!command) {
      return Object.freeze({
        outcome: 'known_failure', code: 'invalid_command', compensationAvailable: false,
      });
    }
    const binding = bindingFor(command);

    let initialTarget: Awaited<ReturnType<
      typeof gmailMessageRefRepository.resolveInboxMutationTarget
    >>;
    try {
      initialTarget = snapshotTarget(
        await gmailMessageRefRepository.resolveInboxMutationTarget(command),
      );
    } catch {
      return knownFailure(binding, 'admission_unavailable');
    }
    if (!initialTarget) {
      return knownFailure(binding, 'not_admitted');
    }

    let accessToken: string;
    let materializedCredentialRevision: string;
    try {
      const store = new DbTokenStore(
        oauthRepository,
        this.googleOAuthConfig,
        undefined,
        initialTarget.connectorAccountId,
      );
      if (this.keyCache) store.setKeyCache(this.keyCache);
      if (this.auditLog) {
        store.setAuditLog(this.auditLog, this.auditActor);
      }
      const token = await store.refreshIfExpiredWithRevision(command.userId, 'google');
      if (!token.scopes.includes(GMAIL_MODIFY_SCOPE)) {
        return knownFailure(binding, 'credentials_unavailable');
      }
      accessToken = token.accessToken;
      materializedCredentialRevision = token.credentialRevision;
    } catch {
      return knownFailure(binding, 'credentials_unavailable');
    }

    // OAuth refresh, lazy migration, disconnect, or reconnect can rotate the
    // target authority. Fail closed before the first provider request when the
    // current database revision no longer matches the materialized snapshot.
    let credentialTarget: Readonly<GmailInboxMutationTarget> | null;
    try {
      credentialTarget = snapshotTarget(
        await gmailMessageRefRepository.resolveInboxMutationTarget(command),
      );
    } catch {
      return knownFailure(binding, 'admission_unavailable');
    }
    if (!credentialTarget || !sameResource(initialTarget, credentialTarget) ||
        credentialTarget.credentialRevision !== materializedCredentialRevision) {
      return knownFailure(binding, 'not_admitted');
    }

    const preflight = await this.request(
      this.messageUrl(initialTarget.providerMessageId, true),
      initialTarget.providerMessageId,
      accessToken,
      'GET',
    );
    if (preflight.failed) {
      return knownFailure(binding, 'preflight_unavailable');
    }
    if (preflight.status !== undefined && deterministicClientFailure(preflight.status)) {
      return knownFailure(binding, 'remote_rejected');
    }
    if (!preflight.accepted) {
      return knownFailure(binding, 'preflight_unavailable');
    }

    const desiredInbox = false;
    const preflightInbox = preflight.inbox;
    if (preflightInbox === null) {
      return knownFailure(binding, 'preflight_unavailable');
    }
    if (preflightInbox === desiredInbox) {
      return this.confirm(
        command,
        'already_in_state',
        preflight.observedAt!,
      );
    }

    // Re-resolve after credential materialization and the preflight read. A
    // disconnect, scope change, admission transition, or ownership change in
    // that interval prevents the sole POST. Credential refresh may rotate its
    // revision; the resolver intentionally checks the current bound row.
    let currentTarget: Awaited<ReturnType<
      typeof gmailMessageRefRepository.resolveInboxMutationTarget
    >>;
    try {
      currentTarget = snapshotTarget(
        await gmailMessageRefRepository.resolveInboxMutationTarget(command),
      );
    } catch {
      return knownFailure(binding, 'admission_unavailable');
    }
    if (!currentTarget || !sameTarget(credentialTarget, currentTarget)) {
      return knownFailure(binding, 'not_admitted');
    }

    // This durable transition is the uncertainty boundary. If it does not
    // commit successfully, no provider mutation request is permitted. A thrown
    // commit ambiguity is classified conservatively but still precedes POST.
    let gateResult: Awaited<ReturnType<GmailInboxMutationDispatchGate['enter']>>;
    try {
      gateResult = await this.dispatchGateEnter(command, currentTarget);
    } catch {
      return knownFailure(binding, 'admission_unavailable');
    }
    if (gateResult.status !== 'entered') {
      return knownFailure(
        binding,
        gateResult.status === 'not_admitted' ? 'not_admitted' : 'admission_unavailable',
      );
    }

    // Do not move the uncertainty boundary by re-reading after the committed
    // gate. A disconnect or revision change in the unavoidable commit-to-POST
    // interval is handled as a dispatch-uncertain recovery case; no POST is
    // retried and no third authority snapshot is treated as a new admission.
    const mutation = await this.request(
      `${this.messageUrl(currentTarget.providerMessageId)}/modify?fields=id%2ClabelIds`,
      currentTarget.providerMessageId,
      accessToken,
      'POST',
      { addLabelIds: [], removeLabelIds: ['INBOX'] },
    );

    if (mutation.status !== undefined && deterministicClientFailure(mutation.status)) {
      return knownFailure(binding, 'remote_rejected');
    }
    if (mutation.accepted) {
      const mutatedInbox = mutation.inbox;
      if (mutatedInbox === desiredInbox) {
        return this.confirm(command, 'changed', mutation.observedAt!);
      }
    }

    // A POST is never retried. One read-only reconciliation is the only safe
    // follow-up for a timeout, network error, retryable status, or response
    // whose state cannot be verified.
    const reconciliation = await this.request(
      this.messageUrl(currentTarget.providerMessageId, true),
      currentTarget.providerMessageId,
      accessToken,
      'GET',
    );
    if (reconciliation.accepted) {
      const reconciledInbox = reconciliation.inbox;
      if (reconciledInbox === desiredInbox) {
        return this.confirm(
          command,
          'reconciled',
          reconciliation.observedAt!,
        );
      }
    }
    return unknownOutcome(binding);
  }

  private messageUrl(providerMessageId: string, withFields = false): string {
    const url = `${GMAIL_API_ROOT}/${encodeURIComponent(providerMessageId)}`;
    return withFields ? `${url}?format=minimal&fields=id%2ClabelIds` : url;
  }

  private async confirm(
    command: GmailInboxMutationCommand,
    effect: 'changed' | 'already_in_state' | 'reconciled',
    observedAt: Date,
  ): Promise<GmailInboxMutationResult> {
    return Object.freeze({
      outcome: 'confirmed',
      operation: command.operation,
      inbox: false,
      effect,
      // Restore is not part of this boundary. Do not advertise theoretical
      // provider reversibility as an available durable compensation path.
      compensationAvailable: false,
      observedAt: observedAt.toISOString(),
      binding: bindingFor(command),
    });
  }

  private async request(
    url: string,
    expectedProviderMessageId: string,
    accessToken: string,
    method: 'GET' | 'POST',
    body?: Record<string, string[]>,
  ): Promise<HttpResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status !== 200) {
        await cancelGmailResponseBody(response);
        return { status: response.status, accepted: false, inbox: null, failed: false };
      }
      const inbox = await parseExactGmailMessageState(response, expectedProviderMessageId);
      if (inbox === null) {
        return { status: response.status, accepted: false, inbox: null, failed: false };
      }
      // Only a completely received, bounded, exact provider representation is
      // accepted as evidence. The timeout remains active through this parse.
      const observedAt = new Date();
      return {
        status: response.status,
        accepted: true,
        inbox,
        observedAt,
        failed: false,
      };
    } catch {
      return { accepted: false, inbox: null, failed: true };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const gmailInboxMutationLimits = Object.freeze({
  ...gmailMessageStateResponseLimits,
});
