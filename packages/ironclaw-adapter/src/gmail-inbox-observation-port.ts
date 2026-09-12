import {
  DbTokenStore,
  type AuditLogPort,
  type GoogleOAuthConfig,
} from '@skytwin/connectors';
import {
  gmailInboxObservationTargetRepository,
  oauthRepository,
  type GmailInboxObservationTarget,
} from '@skytwin/db';
import type {
  GmailInboxObservationCommand,
  GmailInboxObservationBinding,
  GmailInboxObservationPort,
  GmailInboxObservationResult,
  GmailInboxObservationUnavailableCode,
} from '@skytwin/shared-types';

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL_API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const COMMAND_KEYS = ['admissionId', 'messageRefId', 'operation', 'userId'] as const;
const TARGET_KEYS = ['connectorAccountId', 'credentialRevision', 'providerMessageId'] as const;
const CREDENTIAL_KEYS = ['accessToken', 'scopes'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_LABEL_IDS = 128;
const MAX_LABEL_ID_LENGTH = 256;
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
  constructor(private readonly options: DbGmailInboxObservationCredentialsOptions) {}

  async materialize(
    request: GmailInboxObservationCredentialRequest,
  ): Promise<GmailInboxObservationCredential | null> {
    const input = snapshotCredentialRequest(request);
    if (!input) throw new TypeError('invalid Gmail Inbox observation credential request');
    const store = new DbTokenStore(
      oauthRepository,
      this.options.googleOAuthConfig,
      undefined,
      input.connectorAccountId,
    );
    if (this.options.keyCache) store.setKeyCache(this.options.keyCache);
    if (this.options.auditLog) {
      store.setAuditLog(this.options.auditLog, this.options.auditActor ?? 'gmail_inbox_observation');
    }
    const token = await store.refreshIfExpired(input.userId, 'google');
    // Do not claim a database revision produced this bearer: refresh or lazy
    // migration may rotate it. The service's mandatory second target resolve
    // compares the database's current revision with the initial authority
    // snapshot and fails closed on any change.
    return Object.freeze({
      accessToken: token.accessToken,
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
      credential['accessToken'].length > MAX_ACCESS_TOKEN_LENGTH) return null;
  const scopes = snapshotStringArray(credential['scopes'], 128, 512);
  if (!scopes) return null;
  return Object.freeze({
    accessToken: credential['accessToken'],
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

async function readBoundedBody(response: Response): Promise<string | null> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
      'application/json') {
    await cancelBody(response);
    return null;
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 ||
        parsedLength > MAX_RESPONSE_BYTES) {
      await cancelBody(response);
      return null;
    }
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort and never changes the secret-free result.
  }
}

async function parseObservation(
  response: Response,
  expectedProviderMessageId: string,
): Promise<boolean | null> {
  const body = await readBoundedBody(response);
  if (body === null) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    const object = ownData(parsed, ['id', 'labelIds']);
    if (!object || object['id'] !== expectedProviderMessageId) return null;
    const labels = snapshotStringArray(object['labelIds'], MAX_LABEL_IDS, MAX_LABEL_ID_LENGTH);
    return labels ? labels.includes('INBOX') : null;
  } catch {
    return null;
  }
}

/**
 * Unregistered Gmail-mailbox observation boundary. It performs no Gmail
 * mutation and issues at most one Gmail resource GET. Credential
 * materialization may perform OAuth maintenance before that GET.
 */
export class GmailInboxObservationService implements GmailInboxObservationPort {
  private readonly fetchFn: FetchLike;
  private readonly targetResolver: GmailInboxObservationTargetResolver;
  private readonly timeoutMs: number;

  constructor(private readonly options: GmailInboxObservationServiceOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.targetResolver = options.targetResolver ?? gmailInboxObservationTargetRepository;
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
      credential = snapshotCredential(await this.options.credentials.materialize(Object.freeze({
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
        currentTarget.credentialRevision !== initialTarget.credentialRevision ||
        currentTarget.providerMessageId !== initialTarget.providerMessageId) {
      return unavailable('not_observable', binding);
    }

    return this.request(currentTarget.providerMessageId, credential.accessToken, binding);
  }

  private async request(
    providerMessageId: string,
    accessToken: string,
    binding: Readonly<GmailInboxObservationBinding>,
  ): Promise<GmailInboxObservationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${GMAIL_API_ROOT}/${encodeURIComponent(providerMessageId)}` +
        '?format=minimal&fields=id%2ClabelIds';
      const response = await this.fetchFn(url, {
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
        await cancelBody(response);
        return unavailable('credentials_unavailable', binding);
      }
      if ([400, 403, 404, 409].includes(response.status)) {
        await cancelBody(response);
        return unavailable('observation_rejected', binding);
      }
      if (response.status !== 200) {
        await cancelBody(response);
        return unavailable('observation_unavailable', binding);
      }
      const inbox = await parseObservation(response, providerMessageId);
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
  }
}

export const gmailInboxObservationLimits = Object.freeze({
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxLabelIds: MAX_LABEL_IDS,
  maxLabelIdLength: MAX_LABEL_ID_LENGTH,
});
