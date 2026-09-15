import { types as utilTypes } from 'node:util';

export const SOURCE_KEY_BROKER_PROTOCOL_VERSION = 1 as const;
export const SOURCE_KEY_ENVELOPE_VERSION = 2 as const;

export const SOURCE_KEY_BROKER_ROLES = Object.freeze([
  'api',
  'worker',
] as const);

/** Purpose roots accepted by ADR 0001 for user-owned source fields. */
export const SOURCE_KEY_PURPOSES = Object.freeze([
  'credentials',
  'twin',
  'activity',
  'memory',
  'portable_config',
] as const);

export const SOURCE_KEY_BROKER_OPERATIONS = Object.freeze([
  'encrypt',
  'decrypt',
  'rewrap',
  'state',
] as const);

export const SOURCE_KEY_BROKER_FAILURE_CODES = Object.freeze([
  'vault_uninitialized',
  'vault_locked',
  'vault_broker_unavailable',
  'key_version_unavailable',
  'ciphertext_invalid',
  'migration_pending',
  'rotation_in_progress',
] as const);

export const SOURCE_KEY_VAULT_STATES = Object.freeze([
  'uninitialized',
  'locked',
  'unlocked',
] as const);

export type SourceKeyBrokerRole = (typeof SOURCE_KEY_BROKER_ROLES)[number];
export type SourceKeyPurpose = (typeof SOURCE_KEY_PURPOSES)[number];
export type SourceKeyBrokerOperation =
  (typeof SOURCE_KEY_BROKER_OPERATIONS)[number];
export type SourceKeyBrokerFailureCode =
  (typeof SOURCE_KEY_BROKER_FAILURE_CODES)[number];
export type SourceKeyVaultState = (typeof SOURCE_KEY_VAULT_STATES)[number];

/**
 * User-child records are resolved to their parent user before this boundary.
 * Installation roots are a later ADR slice and are intentionally unsupported
 * by protocol version 1. System-global source data is forbidden by the ADR.
 */
export interface SourceKeyBrokerContext {
  readonly ownerKind: 'user';
  readonly ownerId: string;
  readonly purpose: SourceKeyPurpose;
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

export interface SourceKeyEnvelopeV2 {
  readonly magic: 'skytwin-envelope';
  readonly version: 2;
  readonly algorithm: 'aes-256-gcm';
  readonly ownerKind: 'user';
  readonly purpose: SourceKeyPurpose;
  readonly keyVersion: number;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

interface SourceKeyBrokerRequestBase {
  readonly type: 'skytwin:vault:request';
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly capability: string;
  readonly role: SourceKeyBrokerRole;
  readonly generation: number;
  readonly context: SourceKeyBrokerContext;
}

export interface SourceKeyBrokerEncryptRequest extends SourceKeyBrokerRequestBase {
  readonly operation: 'encrypt';
  readonly plaintext: string;
}

export interface SourceKeyBrokerDecryptRequest extends SourceKeyBrokerRequestBase {
  readonly operation: 'decrypt';
  readonly envelope: SourceKeyEnvelopeV2;
}

export interface SourceKeyBrokerRewrapRequest extends SourceKeyBrokerRequestBase {
  readonly operation: 'rewrap';
  readonly envelope: SourceKeyEnvelopeV2;
}

export interface SourceKeyBrokerStateRequest extends SourceKeyBrokerRequestBase {
  readonly operation: 'state';
}

export type SourceKeyBrokerRequest =
  | SourceKeyBrokerEncryptRequest
  | SourceKeyBrokerDecryptRequest
  | SourceKeyBrokerRewrapRequest
  | SourceKeyBrokerStateRequest;

export interface SourceKeyBrokerFailure<
  O extends SourceKeyBrokerOperation = SourceKeyBrokerOperation,
> {
  readonly success: false;
  readonly operation: O;
  readonly error: SourceKeyBrokerFailureCode;
}

export interface SourceKeyBrokerStateSuccess {
  readonly success: true;
  readonly operation: 'state';
  readonly state: SourceKeyVaultState;
}

export interface SourceKeyBrokerEncryptSuccess {
  readonly success: true;
  readonly operation: 'encrypt';
  readonly envelope: SourceKeyEnvelopeV2;
}

export interface SourceKeyBrokerDecryptSuccess {
  readonly success: true;
  readonly operation: 'decrypt';
  readonly plaintext: string;
}

export interface SourceKeyBrokerRewrapSuccess {
  readonly success: true;
  readonly operation: 'rewrap';
  readonly envelope: SourceKeyEnvelopeV2;
}

export type SourceKeyBrokerSuccess =
  | SourceKeyBrokerStateSuccess
  | SourceKeyBrokerEncryptSuccess
  | SourceKeyBrokerDecryptSuccess
  | SourceKeyBrokerRewrapSuccess;

export type SourceKeyBrokerResult =
  SourceKeyBrokerSuccess | SourceKeyBrokerFailure;

export type SourceKeyBrokerResultFor<O extends SourceKeyBrokerOperation> =
  | Extract<SourceKeyBrokerSuccess, { readonly operation: O }>
  | SourceKeyBrokerFailure<O>;

export interface SourceKeyBrokerResponse {
  readonly type: 'skytwin:vault:response';
  readonly protocolVersion: 1;
  readonly requestId: string;
  /** Exact request generation, echoed to prevent a stale response being reused. */
  readonly generation: number;
  /** Exact request context, echoed so clients can reject cross-owner/field responses. */
  readonly context: SourceKeyBrokerContext;
  readonly result: SourceKeyBrokerResult;
}

export interface SourceKeyBrokerResponseExpectation {
  readonly requestId: string;
  readonly generation: number;
  readonly operation: SourceKeyBrokerOperation;
  readonly context: SourceKeyBrokerContext;
}

export interface SourceKeyBrokerCapabilityMessage {
  readonly type: 'skytwin:vault:capability';
  readonly protocolVersion: 1;
  readonly role: SourceKeyBrokerRole;
  readonly capability: string;
}

export interface SourceKeyBrokerLockMessage {
  readonly type: 'skytwin:vault:lock';
  readonly protocolVersion: 1;
  readonly lockId: string;
  readonly ownerKind: 'user';
  readonly ownerId: string;
  readonly generation: number;
}

export interface SourceKeyBrokerLockAckMessage {
  readonly type: 'skytwin:vault:lock-ack';
  readonly protocolVersion: 1;
  readonly lockId: string;
  readonly capability: string;
  readonly role: SourceKeyBrokerRole;
  readonly ownerKind: 'user';
  readonly ownerId: string;
  readonly generation: number;
}

export interface SourceKeyBrokerGenerationMessage {
  readonly type: 'skytwin:vault:generation';
  readonly protocolVersion: 1;
  readonly ownerKind: 'user';
  readonly ownerId: string;
  readonly generation: number;
}

export type SourceKeyBrokerControlMessage =
  | SourceKeyBrokerCapabilityMessage
  | SourceKeyBrokerLockMessage
  | SourceKeyBrokerLockAckMessage
  | SourceKeyBrokerGenerationMessage;

const REQUEST_ID = /^[a-f0-9]{32}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SQL_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/;
const CAPABILITY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES;

function isMember<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

/**
 * Copy own enumerable data properties once. Proxies, accessors, symbols,
 * inherited values, undefined members, and unexpected fields are rejected.
 */
function exactOwnRecord(
  value: unknown,
  required: readonly string[],
): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return null;

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== required.length ||
    keys.some((key) => typeof key !== 'string' || !required.includes(key)) ||
    required.some((key) => !keys.includes(key))
  )
    return null;

  const snapshot: Record<string, unknown> = {};
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.value === undefined
    )
      return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor &&
    descriptor.enumerable &&
    Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isKeyVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function utf8LengthAtMost(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum
  );
}

function decodeCanonicalBase64(
  value: unknown,
  exactBytes?: number,
  maximumBytes = MAX_CIPHERTEXT_BYTES,
  allowEmpty = false,
): Buffer | null {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > Math.ceil(maximumBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return null;
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.length > maximumBytes ||
    decoded.toString('base64') !== value ||
    (exactBytes !== undefined && decoded.length !== exactBytes)
  ) {
    decoded.fill(0);
    return null;
  }
  return decoded;
}

function isCanonicalBase64(
  value: unknown,
  exactBytes?: number,
  maximumBytes?: number,
  allowEmpty?: boolean,
): value is string {
  const decoded = decodeCanonicalBase64(
    value,
    exactBytes,
    maximumBytes,
    allowEmpty,
  );
  if (!decoded) return false;
  decoded.fill(0);
  return true;
}

export function snapshotSourceKeyBrokerContext(
  value: unknown,
): SourceKeyBrokerContext | null {
  try {
    const record = exactOwnRecord(value, [
      'ownerKind',
      'ownerId',
      'purpose',
      'table',
      'column',
      'rowId',
    ]);
    if (
      !record ||
      record['ownerKind'] !== 'user' ||
      typeof record['ownerId'] !== 'string' ||
      !UUID.test(record['ownerId']) ||
      !isMember(SOURCE_KEY_PURPOSES, record['purpose']) ||
      typeof record['table'] !== 'string' ||
      !SQL_IDENTIFIER.test(record['table']) ||
      typeof record['column'] !== 'string' ||
      !SQL_IDENTIFIER.test(record['column']) ||
      typeof record['rowId'] !== 'string' ||
      !ROW_ID.test(record['rowId'])
    )
      return null;
    return Object.freeze({
      ownerKind: 'user',
      ownerId: record['ownerId'],
      purpose: record['purpose'],
      table: record['table'],
      column: record['column'],
      rowId: record['rowId'],
    });
  } catch {
    return null;
  }
}

export function snapshotSourceKeyEnvelope(
  value: unknown,
  context?: SourceKeyBrokerContext,
): SourceKeyEnvelopeV2 | null {
  try {
    const record = exactOwnRecord(value, [
      'magic',
      'version',
      'algorithm',
      'ownerKind',
      'purpose',
      'keyVersion',
      'iv',
      'tag',
      'ciphertext',
    ]);
    if (
      !record ||
      record['magic'] !== 'skytwin-envelope' ||
      record['version'] !== SOURCE_KEY_ENVELOPE_VERSION ||
      record['algorithm'] !== 'aes-256-gcm' ||
      record['ownerKind'] !== 'user' ||
      !isMember(SOURCE_KEY_PURPOSES, record['purpose']) ||
      !isKeyVersion(record['keyVersion']) ||
      !isCanonicalBase64(record['iv'], IV_BYTES, IV_BYTES) ||
      !isCanonicalBase64(record['tag'], TAG_BYTES, TAG_BYTES) ||
      !isCanonicalBase64(
        record['ciphertext'],
        undefined,
        MAX_CIPHERTEXT_BYTES,
        true,
      ) ||
      (context !== undefined &&
        (record['ownerKind'] !== context.ownerKind ||
          record['purpose'] !== context.purpose))
    )
      return null;
    return Object.freeze({
      magic: 'skytwin-envelope',
      version: SOURCE_KEY_ENVELOPE_VERSION,
      algorithm: 'aes-256-gcm',
      ownerKind: 'user',
      purpose: record['purpose'],
      keyVersion: record['keyVersion'],
      iv: record['iv'],
      tag: record['tag'],
      ciphertext: record['ciphertext'],
    });
  } catch {
    return null;
  }
}

export function sourceKeyBrokerFailure<O extends SourceKeyBrokerOperation>(
  operation: O,
  error: SourceKeyBrokerFailureCode,
): Readonly<SourceKeyBrokerFailure<O>> {
  return Object.freeze({ success: false, operation, error });
}

export function snapshotSourceKeyBrokerControlMessage(
  value: unknown,
): SourceKeyBrokerControlMessage | null {
  try {
    const type = ownDataProperty(value, 'type');
    if (type === 'skytwin:vault:capability') {
      const record = exactOwnRecord(value, [
        'type',
        'protocolVersion',
        'role',
        'capability',
      ]);
      if (
        !record ||
        record['protocolVersion'] !== SOURCE_KEY_BROKER_PROTOCOL_VERSION ||
        !isMember(SOURCE_KEY_BROKER_ROLES, record['role']) ||
        !isCanonicalBase64(
          record['capability'],
          CAPABILITY_BYTES,
          CAPABILITY_BYTES,
        )
      )
        return null;
      return Object.freeze({
        type,
        protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
        role: record['role'],
        capability: record['capability'],
      });
    }

    const commonFields = [
      'type',
      'protocolVersion',
      'ownerKind',
      'ownerId',
      'generation',
    ];
    const extraFields =
      type === 'skytwin:vault:lock'
        ? ['lockId']
        : type === 'skytwin:vault:lock-ack'
          ? ['lockId', 'capability', 'role']
          : type === 'skytwin:vault:generation'
            ? []
            : null;
    if (!extraFields) return null;
    const record = exactOwnRecord(value, [...commonFields, ...extraFields]);
    if (
      !record ||
      record['protocolVersion'] !== SOURCE_KEY_BROKER_PROTOCOL_VERSION ||
      record['ownerKind'] !== 'user' ||
      typeof record['ownerId'] !== 'string' ||
      !UUID.test(record['ownerId']) ||
      !isGeneration(record['generation'])
    )
      return null;
    const common = {
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      ownerKind: 'user' as const,
      ownerId: record['ownerId'],
      generation: record['generation'],
    };
    if (type === 'skytwin:vault:generation') {
      return Object.freeze({ type, ...common });
    }
    if (
      typeof record['lockId'] !== 'string' ||
      !REQUEST_ID.test(record['lockId'])
    ) {
      return null;
    }
    if (type === 'skytwin:vault:lock') {
      return Object.freeze({ type, ...common, lockId: record['lockId'] });
    }
    if (
      !isMember(SOURCE_KEY_BROKER_ROLES, record['role']) ||
      !isCanonicalBase64(
        record['capability'],
        CAPABILITY_BYTES,
        CAPABILITY_BYTES,
      )
    )
      return null;
    return Object.freeze({
      type: 'skytwin:vault:lock-ack',
      ...common,
      lockId: record['lockId'],
      capability: record['capability'],
      role: record['role'],
    });
  } catch {
    return null;
  }
}

export function snapshotSourceKeyBrokerRequest(
  value: unknown,
): SourceKeyBrokerRequest | null {
  try {
    const operation = ownDataProperty(value, 'operation');
    if (!isMember(SOURCE_KEY_BROKER_OPERATIONS, operation)) return null;
    const payloadField =
      operation === 'encrypt'
        ? 'plaintext'
        : operation === 'decrypt' || operation === 'rewrap'
          ? 'envelope'
          : null;
    const fields = [
      'type',
      'protocolVersion',
      'requestId',
      'capability',
      'role',
      'generation',
      'operation',
      'context',
      ...(payloadField === null ? [] : [payloadField]),
    ];
    const record = exactOwnRecord(value, fields);
    const context = record
      ? snapshotSourceKeyBrokerContext(record['context'])
      : null;
    if (
      !record ||
      record['type'] !== 'skytwin:vault:request' ||
      record['protocolVersion'] !== SOURCE_KEY_BROKER_PROTOCOL_VERSION ||
      typeof record['requestId'] !== 'string' ||
      !REQUEST_ID.test(record['requestId']) ||
      !isCanonicalBase64(
        record['capability'],
        CAPABILITY_BYTES,
        CAPABILITY_BYTES,
      ) ||
      !isMember(SOURCE_KEY_BROKER_ROLES, record['role']) ||
      !isGeneration(record['generation']) ||
      !context
    )
      return null;
    const base = {
      type: 'skytwin:vault:request' as const,
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      requestId: record['requestId'],
      capability: record['capability'],
      role: record['role'],
      generation: record['generation'],
      context,
    };
    if (operation === 'state') return Object.freeze({ ...base, operation });
    if (operation === 'encrypt') {
      if (!utf8LengthAtMost(record['plaintext'], MAX_PLAINTEXT_BYTES))
        return null;
      return Object.freeze({
        ...base,
        operation,
        plaintext: record['plaintext'],
      });
    }
    const envelope = snapshotSourceKeyEnvelope(record['envelope'], context);
    if (!envelope) return null;
    return Object.freeze({ ...base, operation, envelope });
  } catch {
    return null;
  }
}

export function snapshotSourceKeyBrokerResult(
  value: unknown,
  operation: SourceKeyBrokerOperation,
  context: SourceKeyBrokerContext,
): SourceKeyBrokerResult | null {
  try {
    const success = ownDataProperty(value, 'success');
    if (success === false) {
      const record = exactOwnRecord(value, ['success', 'operation', 'error']);
      if (
        !record ||
        record['operation'] !== operation ||
        !isMember(SOURCE_KEY_BROKER_FAILURE_CODES, record['error'])
      )
        return null;
      return sourceKeyBrokerFailure(operation, record['error']);
    }
    if (success !== true || ownDataProperty(value, 'operation') !== operation)
      return null;
    if (operation === 'state') {
      const record = exactOwnRecord(value, ['success', 'operation', 'state']);
      if (!record || !isMember(SOURCE_KEY_VAULT_STATES, record['state'])) {
        return null;
      }
      return Object.freeze({
        success: true,
        operation,
        state: record['state'] as SourceKeyVaultState,
      });
    }
    if (operation === 'decrypt') {
      const record = exactOwnRecord(value, [
        'success',
        'operation',
        'plaintext',
      ]);
      if (
        !record ||
        !utf8LengthAtMost(record['plaintext'], MAX_PLAINTEXT_BYTES)
      )
        return null;
      return Object.freeze({
        success: true,
        operation,
        plaintext: record['plaintext'],
      });
    }
    const record = exactOwnRecord(value, ['success', 'operation', 'envelope']);
    const envelope = record
      ? snapshotSourceKeyEnvelope(record['envelope'], context)
      : null;
    if (!record || !envelope) return null;
    return Object.freeze({ success: true, operation, envelope });
  } catch {
    return null;
  }
}

function sameContext(
  left: SourceKeyBrokerContext,
  right: SourceKeyBrokerContext,
): boolean {
  return (
    left.ownerKind === right.ownerKind &&
    left.ownerId === right.ownerId &&
    left.purpose === right.purpose &&
    left.table === right.table &&
    left.column === right.column &&
    left.rowId === right.rowId
  );
}

/**
 * Strictly snapshots a response and binds it to one pending request. Callers
 * must map a null return to `vault_broker_unavailable` and discard the payload.
 */
export function snapshotSourceKeyBrokerResponse(
  value: unknown,
  expected: SourceKeyBrokerResponseExpectation,
): SourceKeyBrokerResponse | null {
  try {
    const expectedContext = snapshotSourceKeyBrokerContext(expected.context);
    if (
      !REQUEST_ID.test(expected.requestId) ||
      !isGeneration(expected.generation) ||
      !isMember(SOURCE_KEY_BROKER_OPERATIONS, expected.operation) ||
      !expectedContext
    )
      return null;
    const record = exactOwnRecord(value, [
      'type',
      'protocolVersion',
      'requestId',
      'generation',
      'context',
      'result',
    ]);
    const context = record
      ? snapshotSourceKeyBrokerContext(record['context'])
      : null;
    if (
      !record ||
      record['type'] !== 'skytwin:vault:response' ||
      record['protocolVersion'] !== SOURCE_KEY_BROKER_PROTOCOL_VERSION ||
      record['requestId'] !== expected.requestId ||
      record['generation'] !== expected.generation ||
      !context ||
      !sameContext(context, expectedContext)
    )
      return null;
    const result = snapshotSourceKeyBrokerResult(
      record['result'],
      expected.operation,
      context,
    );
    if (!result) return null;
    return Object.freeze({
      type: 'skytwin:vault:response',
      protocolVersion: SOURCE_KEY_BROKER_PROTOCOL_VERSION,
      requestId: expected.requestId,
      generation: expected.generation,
      context,
      result,
    });
  } catch {
    return null;
  }
}
