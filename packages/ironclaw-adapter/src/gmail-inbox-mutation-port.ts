import { DbTokenStore, type GoogleOAuthConfig } from '@skytwin/connectors';
import type {
  GmailInboxMutationCommand,
  GmailInboxMutationPort,
  GmailInboxMutationResult,
} from '@skytwin/shared-types';
import {
  gmailMessageRefRepository,
  oauthRepository,
} from '@skytwin/db';

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL_API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const COMMAND_KEYS = ['admissionId', 'messageRefId', 'operation', 'userId'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface KeyCacheLike {
  get(userId: string): Buffer | null;
  has(userId: string): boolean;
  set(userId: string, key: Buffer): void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GmailInboxMutationServiceOptions {
  googleOAuthConfig: GoogleOAuthConfig;
  keyCache?: KeyCacheLike;
  fetch?: FetchLike;
  timeoutMs?: number;
}

interface HttpResult {
  status?: number;
  ok: boolean;
  inbox: boolean | null;
  observedAt?: Date;
  failed: boolean;
}

function parseCanonicalCommand(value: GmailInboxMutationCommand): Readonly<GmailInboxMutationCommand> | null {
  if (!value || typeof value !== 'object') return null;
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
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
    (operation !== 'archive' && operation !== 'restore')
  ) return null;
  return Object.freeze({ userId, admissionId, messageRefId, operation });
}

function desiredInboxState(operation: GmailInboxMutationCommand['operation']): boolean {
  return operation === 'restore';
}

function deterministicClientFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function inboxStateFromResponse(response: Response): Promise<boolean | null> {
  try {
    const value = await response.json() as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const labels = (value as Record<string, unknown>)['labelIds'];
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) return null;
    return labels.includes('INBOX');
  } catch {
    return null;
  }
}

/**
 * An intentionally unregistered Gmail Inbox mutation boundary. Constructing
 * this service does not make it reachable from any API, worker, router, or
 * existing action handler.
 */
export class GmailInboxMutationService implements GmailInboxMutationPort {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: GmailInboxMutationServiceOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new TypeError('timeoutMs must be a finite value between 1 and 60000');
    }
    this.timeoutMs = timeoutMs;
  }

  async mutate(submittedCommand: GmailInboxMutationCommand): Promise<GmailInboxMutationResult> {
    const command = parseCanonicalCommand(submittedCommand);
    if (!command) {
      return { outcome: 'known_failure', code: 'invalid_command', compensationAvailable: false };
    }

    let initialTarget: Awaited<ReturnType<
      typeof gmailMessageRefRepository.resolveInboxMutationTarget
    >>;
    try {
      initialTarget = await gmailMessageRefRepository.resolveInboxMutationTarget(command);
    } catch {
      return { outcome: 'unknown', code: 'admission_unavailable', compensationAvailable: false };
    }
    if (!initialTarget) {
      return { outcome: 'known_failure', code: 'not_admitted', compensationAvailable: false };
    }

    let accessToken: string;
    try {
      const store = new DbTokenStore(
        oauthRepository,
        this.options.googleOAuthConfig,
        undefined,
        initialTarget.connectorAccountId,
      );
      if (this.options.keyCache) store.setKeyCache(this.options.keyCache);
      const token = await store.refreshIfExpired(command.userId, 'google');
      if (!token.scopes.includes(GMAIL_MODIFY_SCOPE)) {
        return { outcome: 'known_failure', code: 'credentials_unavailable', compensationAvailable: false };
      }
      accessToken = token.accessToken;
    } catch {
      return { outcome: 'known_failure', code: 'credentials_unavailable', compensationAvailable: false };
    }

    const preflight = await this.request(
      this.messageUrl(initialTarget.providerMessageId, true),
      accessToken,
      'GET',
    );
    if (preflight.failed) {
      return { outcome: 'unknown', code: 'preflight_unavailable', compensationAvailable: false };
    }
    if (preflight.status !== undefined && deterministicClientFailure(preflight.status)) {
      return { outcome: 'known_failure', code: 'remote_rejected', compensationAvailable: false };
    }
    if (!preflight.ok) {
      return { outcome: 'unknown', code: 'preflight_unavailable', compensationAvailable: false };
    }

    const desiredInbox = desiredInboxState(command.operation);
    const preflightInbox = preflight.inbox;
    if (preflightInbox === null) {
      return { outcome: 'unknown', code: 'preflight_unavailable', compensationAvailable: false };
    }
    if (preflightInbox === desiredInbox) {
      return this.confirm(
        command,
        initialTarget,
        desiredInbox,
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
      currentTarget = await gmailMessageRefRepository.resolveInboxMutationTarget(command);
    } catch {
      return { outcome: 'unknown', code: 'admission_unavailable', compensationAvailable: false };
    }
    if (
      !currentTarget ||
      currentTarget.connectorAccountId !== initialTarget.connectorAccountId ||
      currentTarget.providerMessageId !== initialTarget.providerMessageId
    ) {
      return { outcome: 'known_failure', code: 'not_admitted', compensationAvailable: false };
    }

    const mutation = await this.request(
      `${this.messageUrl(currentTarget.providerMessageId)}/modify?fields=id%2ClabelIds`,
      accessToken,
      'POST',
      command.operation === 'archive'
        ? { addLabelIds: [], removeLabelIds: ['INBOX'] }
        : { addLabelIds: ['INBOX'], removeLabelIds: [] },
    );

    if (mutation.status !== undefined && deterministicClientFailure(mutation.status)) {
      return { outcome: 'known_failure', code: 'remote_rejected', compensationAvailable: false };
    }
    if (mutation.ok) {
      const mutatedInbox = mutation.inbox;
      if (mutatedInbox === desiredInbox) {
        return this.confirm(command, currentTarget, desiredInbox, 'changed', mutation.observedAt!);
      }
    }

    // A POST is never retried. One read-only reconciliation is the only safe
    // follow-up for a timeout, network error, retryable status, or response
    // whose state cannot be verified.
    const reconciliation = await this.request(
      this.messageUrl(currentTarget.providerMessageId, true),
      accessToken,
      'GET',
    );
    if (reconciliation.ok) {
      const reconciledInbox = reconciliation.inbox;
      if (reconciledInbox === desiredInbox) {
        return this.confirm(
          command,
          currentTarget,
          desiredInbox,
          'reconciled',
          reconciliation.observedAt!,
        );
      }
    }
    return { outcome: 'unknown', code: 'remote_outcome_unknown', compensationAvailable: false };
  }

  private messageUrl(providerMessageId: string, withFields = false): string {
    const url = `${GMAIL_API_ROOT}/${encodeURIComponent(providerMessageId)}`;
    return withFields ? `${url}?format=minimal&fields=id%2ClabelIds` : url;
  }

  private async confirm(
    command: GmailInboxMutationCommand,
    target: { connectorAccountId: string; providerMessageId: string },
    inbox: boolean,
    effect: 'changed' | 'already_in_state' | 'reconciled',
    observedAt: Date,
  ): Promise<GmailInboxMutationResult> {
    let observationRecorded = false;
    try {
      observationRecorded = await gmailMessageRefRepository.recordConfirmedInboxState({
        userId: command.userId,
        messageRefId: command.messageRefId,
        connectorAccountId: target.connectorAccountId,
        providerMessageId: target.providerMessageId,
        inbox,
        observedAt,
      });
    } catch {
      observationRecorded = false;
    }
    return {
      outcome: 'confirmed',
      operation: command.operation,
      inbox,
      effect,
      compensationAvailable: command.operation === 'archive' && effect === 'changed',
      observationRecorded,
    };
  }

  private async request(
    url: string,
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
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      // This timestamp represents when provider state reached us, not when a
      // potentially slow response body finished parsing.
      const observedAt = new Date();
      return {
        status: response.status,
        ok: response.ok,
        inbox: response.ok ? await inboxStateFromResponse(response) : null,
        observedAt,
        failed: false,
      };
    } catch {
      return { ok: false, inbox: null, failed: true };
    } finally {
      clearTimeout(timeout);
    }
  }
}
