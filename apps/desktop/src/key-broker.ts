import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'crypto';
import type { ChildProcess } from 'child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type {
  SourceKeyBrokerContext,
  SourceKeyBrokerControlMessage,
  SourceKeyBrokerFailureCode,
  SourceKeyBrokerRequest,
  SourceKeyBrokerResponse,
  SourceKeyBrokerRole,
  SourceKeyEnvelopeV2,
  SourceKeyPurpose,
  SourceKeyVaultState,
} from '@skytwin/shared-types';
import {
  resolveSecureStorageBackend,
  type SecureStorageBackendPort,
} from './secure-storage-backend.js';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_LOCK_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_CHILD_EXIT_TIMEOUT_MS = 2_000;
const MAX_SECRET_BYTES = 16 * 1024 * 1024;
const MAX_DEVICE_WRAPPER_BYTES = 4_096;
const KDF = {
  algorithm: 'scrypt' as const,
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 128 * 1024 * 1024,
};

export type BrokerRole = SourceKeyBrokerRole;
export type BrokerPurpose = SourceKeyPurpose;
export type VaultFailureCode = SourceKeyBrokerFailureCode;
export type VaultState = SourceKeyVaultState;
export type VaultStateResult =
  | { success: true; state: VaultState }
  | { success: false; error: 'vault_broker_unavailable' | 'ciphertext_invalid' };
export type VaultLockResult =
  | { success: true; generation: number }
  | { success: false; error: 'vault_broker_unavailable'; generation: number };

export interface BrokerContext {
  userId: string;
  purpose: BrokerPurpose;
  table: string;
  column: string;
  rowId: string;
}

export type BrokerEnvelope = SourceKeyEnvelopeV2;

export interface WrappedUserKey {
  magic: 'skytwin-user-key';
  wrapperVersion: 1;
  userId: string;
  keyVersion: number;
  algorithm: 'aes-256-gcm';
  kdf: typeof KDF & { salt: string };
  iv: string;
  tag: string;
  ciphertext: string;
  canary: BrokerEnvelope;
}

/** Persistence implementations must make create/deleteIfMatch atomic. */
export interface WrappedKeyStore {
  get(userId: string): unknown | Promise<unknown>;
  create(userId: string, value: WrappedUserKey): boolean | Promise<boolean>;
  deleteIfMatch(userId: string, value: WrappedUserKey): boolean | Promise<boolean>;
}

export interface WrappedKeyValueStore {
  get(key: string): unknown;
  set(key: string, value: WrappedUserKey): void;
  delete(key: string): void;
}

export interface DeviceWrapperStore {
  get(userId: string): string | undefined;
  set(userId: string, ciphertext: string): void;
  delete(userId: string): void;
  keys(): string[];
}

export interface DeviceProtectionPort extends SecureStorageBackendPort {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface SourceKeyProtocolValidators {
  readonly snapshotSourceKeyBrokerControlMessage: (
    value: unknown,
  ) => SourceKeyBrokerControlMessage | null;
  readonly snapshotSourceKeyBrokerRequest: (
    value: unknown,
  ) => SourceKeyBrokerRequest | null;
}

let protocolValidatorsPromise: Promise<SourceKeyProtocolValidators> | null = null;

function loadSourceKeyProtocolValidators(): Promise<SourceKeyProtocolValidators> {
  const protocolEntry = join(
    __dirname,
    '..',
    'node_modules',
    '@skytwin',
    'shared-types',
    'dist',
    'index.js',
  );
  protocolValidatorsPromise ??= (
    new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<SourceKeyProtocolValidators>
  )(pathToFileURL(protocolEntry).href);
  return protocolValidatorsPromise;
}

export interface BrokerField {
  readonly purpose: BrokerPurpose;
  readonly table: string;
  readonly column: string;
}

const brokerField = (
  purpose: BrokerPurpose,
  table: string,
  column: string,
): BrokerField => Object.freeze({ purpose, table, column });

const USER_FIELDS: readonly BrokerField[] = Object.freeze([
  brokerField('credentials', 'oauth_tokens', 'access_token'),
  brokerField('credentials', 'oauth_tokens', 'refresh_token'),
  brokerField('credentials', 'ai_provider_settings', 'api_key'),
  brokerField('portable_config', 'mcp_servers', 'args'),
  brokerField('portable_config', 'mcp_servers', 'command'),
  brokerField('portable_config', 'mcp_servers', 'display_name'),
  brokerField('portable_config', 'mcp_servers', 'env'),
  brokerField('portable_config', 'mcp_servers', 'url'),
  brokerField('portable_config', 'federation_peers', 'endpoint_url'),
  brokerField('portable_config', 'federation_peers', 'label'),
  brokerField('portable_config', 'federation_peers', 'last_sync_error'),
  brokerField('portable_config', 'federation_peers', 'local_secret_key'),
  brokerField('portable_config', 'connector_cursors', 'cursor_value'),
  brokerField('portable_config', 'dxt_imports', 'artifact_blob'),
  brokerField('portable_config', 'dxt_imports', 'error_message'),
]);
export const ROLE_FIELDS: Readonly<Record<BrokerRole, readonly BrokerField[]>> = Object.freeze({
  api: USER_FIELDS,
  worker: USER_FIELDS,
});

interface Unlocked {
  key: Buffer;
  keyVersion: number;
  expiresAt: number;
}

interface PendingLockAck {
  userId: string;
  generation: number;
  finish(): void;
}

interface Binding {
  role: BrokerRole;
  capability: Buffer;
  users: ReadonlySet<string>;
  inFlight: Map<string, number>;
  lockAcks: Map<string, PendingLockAck>;
}

interface StoredDeviceWrapper {
  version: 1;
  backend: string;
  ciphertext: string;
}

const validId = (value: unknown, max = 512): value is string =>
  typeof value === 'string'
  && value.length >= 1
  && value.length <= max
  && /^[A-Za-z0-9_.-]+$/.test(value);

export const isValidVaultUserId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && sortedExpected.every((key, index) => actual[index] === key);
}

function b64(value: unknown, exact?: number, max = MAX_SECRET_BYTES): Buffer | null {
  if (
    typeof value !== 'string'
    || value.length > Math.ceil(max / 3) * 4
    || value.length % 4 !== 0
  ) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const contentLength = value.length - padding;
  if (
    (padding === 1 && contentLength % 4 !== 3)
    || (padding === 2 && contentLength % 4 !== 2)
  ) return null;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const isAlphabet =
      (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f;
    if (!isAlphabet) return null;
  }
  const output = Buffer.from(value, 'base64');
  if (
    output.length > max
    || output.toString('base64') !== value
    || (exact !== undefined && output.length !== exact)
  ) {
    output.fill(0);
    return null;
  }
  return output;
}

function isCanonicalB64(value: unknown, exact?: number, max?: number): boolean {
  const decoded = b64(value, exact, max);
  if (!decoded) return false;
  decoded.fill(0);
  return true;
}

function parseEnvelope(value: unknown): BrokerEnvelope | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, [
      'magic', 'version', 'algorithm', 'ownerKind', 'purpose',
      'keyVersion', 'iv', 'tag', 'ciphertext',
    ])) return null;
    if (
      value['magic'] !== 'skytwin-envelope'
      || value['version'] !== 2
      || value['algorithm'] !== 'aes-256-gcm'
      || value['ownerKind'] !== 'user'
      || !USER_FIELDS.some(field => field.purpose === value['purpose'])
      || !Number.isSafeInteger(value['keyVersion'])
      || (value['keyVersion'] as number) <= 0
      || !isCanonicalB64(value['iv'], IV_BYTES, IV_BYTES)
      || !isCanonicalB64(value['tag'], TAG_BYTES, TAG_BYTES)
      || !isCanonicalB64(value['ciphertext'])
    ) return null;
    return Object.freeze({
      magic: 'skytwin-envelope',
      version: 2,
      algorithm: 'aes-256-gcm',
      ownerKind: 'user',
      purpose: value['purpose'] as BrokerPurpose,
      keyVersion: value['keyVersion'] as number,
      iv: value['iv'] as string,
      tag: value['tag'] as string,
      ciphertext: value['ciphertext'] as string,
    });
  } catch {
    return null;
  }
}

function parseWrappedUserKey(value: unknown): WrappedUserKey | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, [
      'magic', 'wrapperVersion', 'userId', 'keyVersion', 'algorithm',
      'kdf', 'iv', 'tag', 'ciphertext', 'canary',
    ])) return null;
    const kdf = value['kdf'];
    const canary = parseEnvelope(value['canary']);
    if (
      value['magic'] !== 'skytwin-user-key'
      || value['wrapperVersion'] !== 1
      || !isValidVaultUserId(value['userId'])
      || !Number.isSafeInteger(value['keyVersion'])
      || (value['keyVersion'] as number) <= 0
      || value['algorithm'] !== 'aes-256-gcm'
      || !isRecord(kdf)
      || !hasExactKeys(kdf, ['algorithm', 'N', 'r', 'p', 'maxmem', 'salt'])
      || kdf['algorithm'] !== KDF.algorithm
      || kdf['N'] !== KDF.N
      || kdf['r'] !== KDF.r
      || kdf['p'] !== KDF.p
      || kdf['maxmem'] !== KDF.maxmem
      || !isCanonicalB64(kdf['salt'], SALT_BYTES, SALT_BYTES)
      || !isCanonicalB64(value['iv'], IV_BYTES, IV_BYTES)
      || !isCanonicalB64(value['tag'], TAG_BYTES, TAG_BYTES)
      || !isCanonicalB64(value['ciphertext'], KEY_BYTES, KEY_BYTES)
      || !canary
      || canary.keyVersion !== value['keyVersion']
    ) return null;
    return Object.freeze({
      magic: 'skytwin-user-key',
      wrapperVersion: 1,
      userId: value['userId'],
      keyVersion: value['keyVersion'] as number,
      algorithm: 'aes-256-gcm',
      kdf: Object.freeze({ ...KDF, salt: kdf['salt'] as string }),
      iv: value['iv'] as string,
      tag: value['tag'] as string,
      ciphertext: value['ciphertext'] as string,
      canary,
    });
  } catch {
    return null;
  }
}

function sameWrappedUserKey(left: unknown, right: WrappedUserKey): boolean {
  const parsed = parseWrappedUserKey(left);
  return parsed !== null && JSON.stringify(parsed) === JSON.stringify(right);
}

function parseDeviceWrapper(value: unknown): StoredDeviceWrapper | null {
  try {
    if (typeof value !== 'string' || value.length > 8_192) return null;
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !hasExactKeys(parsed, ['version', 'backend', 'ciphertext'])) return null;
    if (
      parsed['version'] !== 1
      || typeof parsed['backend'] !== 'string'
      || parsed['backend'].length === 0
      || !isCanonicalB64(parsed['ciphertext'], undefined, MAX_DEVICE_WRAPPER_BYTES)
    ) return null;
    return Object.freeze({
      version: 1,
      backend: parsed['backend'],
      ciphertext: parsed['ciphertext'] as string,
    });
  } catch {
    return null;
  }
}

export class PersistentWrappedKeyStore implements WrappedKeyStore {
  constructor(private readonly store: WrappedKeyValueStore) {}

  get(userId: string): unknown {
    return this.store.get(`source-key:${userId}`);
  }

  create(userId: string, value: WrappedUserKey): boolean {
    const key = `source-key:${userId}`;
    if (this.store.get(key) !== undefined) return false;
    this.store.set(key, value);
    return true;
  }

  deleteIfMatch(userId: string, value: WrappedUserKey): boolean {
    const key = `source-key:${userId}`;
    if (!sameWrappedUserKey(this.store.get(key), value)) return false;
    this.store.delete(key);
    return true;
  }
}

function validContext(value: unknown): value is BrokerContext {
  if (!isRecord(value)) return false;
  return isValidVaultUserId(value['userId'])
    && validId(value['table'])
    && validId(value['column'])
    && validId(value['rowId'])
    && USER_FIELDS.some(field => field.purpose === value['purpose']);
}

const wrapperAad = (userId: string, version: number) =>
  Buffer.from(JSON.stringify(['skytwin', 'user-key', 1, userId, version]));
const envelopeAad = (context: BrokerContext, version: number) =>
  Buffer.from(JSON.stringify([
    'skytwin', 2, 'user', context.userId, context.purpose,
    version, context.table, context.column, context.rowId,
  ]));

function deriveDataKey(root: Buffer, context: BrokerContext, version: number): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    root,
    Buffer.from(`skytwin:${context.userId}:${version}`),
    Buffer.from(`skytwin:${context.purpose}:v2`),
    KEY_BYTES,
  ));
}

async function wrappingKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_BYTES,
      { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem },
      (error, result) => error ? reject(error) : resolve(result),
    );
  });
}

export class DesktopKeyBroker {
  private readonly unlocked = new Map<string, Unlocked>();
  private readonly generations = new Map<string, number>();
  private readonly operationEpochs = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly children = new Map<ChildProcess, Binding>();
  private readonly initializing = new Set<string>();
  private readonly lockDepth = new Map<string, number>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly containmentFailures = new Set<string>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly lockAckTimeoutMs: number;
  private readonly childExitTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly deviceProtection?: DeviceProtectionPort;
  private readonly deviceStore?: DeviceWrapperStore;
  private readonly protocolValidators?: SourceKeyProtocolValidators;

  constructor(
    private readonly store: WrappedKeyStore,
    options: {
      now?: () => number;
      ttlMs?: number;
      lockAckTimeoutMs?: number;
      childExitTimeoutMs?: number;
      platform?: NodeJS.Platform;
      deviceProtection?: DeviceProtectionPort;
      deviceStore?: DeviceWrapperStore;
      protocolValidators?: SourceKeyProtocolValidators;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.lockAckTimeoutMs = options.lockAckTimeoutMs ?? DEFAULT_LOCK_ACK_TIMEOUT_MS;
    this.childExitTimeoutMs = options.childExitTimeoutMs ?? DEFAULT_CHILD_EXIT_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
    this.deviceProtection = options.deviceProtection;
    this.deviceStore = options.deviceStore;
    this.protocolValidators = options.protocolValidators;
  }

  async initialize(
    userId: string,
    passphrase: string,
  ): Promise<
    | { success: true }
    | { success: false; error: 'already_initialized' | 'invalid_passphrase' | 'ciphertext_invalid' | 'vault_broker_unavailable' }
  > {
    if (
      !isValidVaultUserId(userId)
      || typeof passphrase !== 'string'
      || passphrase.length < 12
      || passphrase.length > 1024
    ) return { success: false, error: 'invalid_passphrase' };
    if (this.initializing.has(userId)) return { success: false, error: 'already_initialized' };

    const operationEpoch = this.operationEpoch(userId);
    this.initializing.add(userId);
    const root = randomBytes(KEY_BYTES);
    const salt = randomBytes(SALT_BYTES);
    let wrap: Buffer | null = null;
    let created: WrappedUserKey | null = null;
    let persistedRoot: Buffer | null = null;
    try {
      wrap = await wrappingKey(passphrase, salt);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', wrap, iv);
      cipher.setAAD(wrapperAad(userId, 1));
      const ciphertext = Buffer.concat([cipher.update(root), cipher.final()]);
      const canaryContext: BrokerContext = {
        userId,
        purpose: 'credentials',
        table: 'oauth_tokens',
        column: 'access_token',
        rowId: 'vault-canary',
      };
      created = {
        magic: 'skytwin-user-key',
        wrapperVersion: 1,
        userId,
        keyVersion: 1,
        algorithm: 'aes-256-gcm',
        kdf: { ...KDF, salt: salt.toString('base64') },
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        canary: this.encryptWith(root, canaryContext, 1, 'skytwin-canary').envelope,
      };
      if (!await this.store.create(userId, created)) {
        return { success: false, error: 'already_initialized' };
      }
      const rereadRaw = await this.store.get(userId);
      const reread = parseWrappedUserKey(rereadRaw);
      if (!reread || !sameWrappedUserKey(rereadRaw, created)) {
        const rolledBack = await this.store.deleteIfMatch(userId, created);
        return {
          success: false,
          error: rolledBack ? 'ciphertext_invalid' : 'vault_broker_unavailable',
        };
      }
      persistedRoot = await this.unwrap(userId, passphrase, reread);
      const canary = persistedRoot
        ? this.decryptWith(persistedRoot, canaryContext, reread.keyVersion, reread.canary)
        : null;
      if (!persistedRoot || !canary?.success || canary.plaintext !== 'skytwin-canary') {
        const rolledBack = await this.store.deleteIfMatch(userId, created);
        return {
          success: false,
          error: rolledBack ? 'ciphertext_invalid' : 'vault_broker_unavailable',
        };
      }
      await this.cache(userId, persistedRoot, reread.keyVersion, operationEpoch);
      return { success: true };
    } catch {
      if (created) {
        try {
          if (!await this.store.deleteIfMatch(userId, created)) {
            return { success: false, error: 'vault_broker_unavailable' };
          }
        } catch {
          return { success: false, error: 'vault_broker_unavailable' };
        }
      }
      return { success: false, error: 'vault_broker_unavailable' };
    } finally {
      this.initializing.delete(userId);
      persistedRoot?.fill(0);
      wrap?.fill(0);
      root.fill(0);
      salt.fill(0);
    }
  }

  async unlock(
    userId: string,
    passphrase: string,
  ): Promise<{ success: true; generation: number } | { success: false; error: VaultFailureCode }> {
    if (!isValidVaultUserId(userId) || typeof passphrase !== 'string' || passphrase.length > 1024) {
      return { success: false, error: 'ciphertext_invalid' };
    }
    const operationEpoch = this.operationEpoch(userId);
    let raw: unknown;
    try {
      raw = await this.store.get(userId);
    } catch {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    if (raw === undefined) return { success: false, error: 'vault_uninitialized' };
    const record = parseWrappedUserKey(raw);
    if (!record || record.userId !== userId) return { success: false, error: 'ciphertext_invalid' };
    const root = await this.unwrap(userId, passphrase, record);
    if (!root) return { success: false, error: 'ciphertext_invalid' };
    try {
      const canaryContext: BrokerContext = {
        userId,
        purpose: 'credentials',
        table: 'oauth_tokens',
        column: 'access_token',
        rowId: 'vault-canary',
      };
      const result = this.decryptWith(root, canaryContext, record.keyVersion, record.canary);
      if (!result.success || result.plaintext !== 'skytwin-canary') {
        return { success: false, error: 'ciphertext_invalid' };
      }
      if (!await this.cache(userId, root, record.keyVersion, operationEpoch)) {
        return { success: false, error: 'vault_locked' };
      }
      return { success: true, generation: this.generation(userId) };
    } finally {
      root.fill(0);
    }
  }

  deviceWrapperState(userId: string): 'absent' | 'present' | 'unsupported' {
    if (!isValidVaultUserId(userId) || !this.deviceStore) return 'unsupported';
    const backend = this.deviceBackend();
    let stored: string | undefined;
    try {
      stored = this.deviceStore.get(userId);
    } catch {
      return 'unsupported';
    }
    if (stored === undefined) return backend === null ? 'unsupported' : 'absent';
    const record = parseDeviceWrapper(stored);
    if (backend === null || !record || record.backend !== backend) {
      this.tryDeleteDevice(userId);
      return backend === null ? 'unsupported' : 'absent';
    }
    return 'present';
  }

  purgeUntrustedDeviceWrappers():
    | { success: true; removed: number }
    | { success: false; error: 'vault_broker_unavailable' } {
    if (!this.deviceStore) return { success: true, removed: 0 };
    const backend = this.deviceBackend();
    let users: string[];
    try {
      users = [...this.deviceStore.keys()];
    } catch {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    let removed = 0;
    for (const userId of users) {
      try {
        const stored = this.deviceStore.get(userId);
        const record = parseDeviceWrapper(stored);
        if (backend === null || !record || record.backend !== backend) {
          this.deviceStore.delete(userId);
          removed += 1;
        }
      } catch {
        return { success: false, error: 'vault_broker_unavailable' };
      }
    }
    return { success: true, removed };
  }

  rememberDevice(userId: string): { success: true } | { success: false; error: VaultFailureCode } {
    if (!isValidVaultUserId(userId) || (this.lockDepth.get(userId) ?? 0) > 0) {
      return { success: false, error: 'vault_locked' };
    }
    const active = this.active(userId);
    if (!active) return { success: false, error: 'vault_locked' };
    const backend = this.deviceBackend();
    if (!backend || !this.deviceStore || !this.deviceProtection) {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    const payload = JSON.stringify({
      magic: 'skytwin-device-key',
      version: 1,
      userId,
      keyVersion: active.keyVersion,
      root: active.key.toString('base64'),
    });
    let protectedBytes: Buffer | null = null;
    try {
      protectedBytes = this.deviceProtection.encryptString(payload);
      if (protectedBytes.length > MAX_DEVICE_WRAPPER_BYTES) throw new Error('device wrapper too large');
      const record: StoredDeviceWrapper = {
        version: 1,
        backend,
        ciphertext: protectedBytes.toString('base64'),
      };
      this.deviceStore.set(userId, JSON.stringify(record));
      return { success: true };
    } catch {
      this.tryDeleteDevice(userId);
      return { success: false, error: 'vault_broker_unavailable' };
    } finally {
      protectedBytes?.fill(0);
    }
  }

  async unlockFromDevice(
    userId: string,
  ): Promise<{ success: true; generation: number } | { success: false; error: VaultFailureCode }> {
    if (!isValidVaultUserId(userId) || !this.deviceStore || !this.deviceProtection) {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    const backend = this.deviceBackend();
    if (!backend) {
      this.tryDeleteDevice(userId);
      return { success: false, error: 'vault_broker_unavailable' };
    }
    const operationEpoch = this.operationEpoch(userId);
    let encoded: string | undefined;
    let rawRegistry: unknown;
    try {
      encoded = this.deviceStore.get(userId);
      rawRegistry = await this.store.get(userId);
    } catch {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    if (!encoded || rawRegistry === undefined) return { success: false, error: 'vault_uninitialized' };
    const deviceRecord = parseDeviceWrapper(encoded);
    const registry = parseWrappedUserKey(rawRegistry);
    if (!deviceRecord || deviceRecord.backend !== backend || !registry || registry.userId !== userId) {
      this.tryDeleteDevice(userId);
      return { success: false, error: 'ciphertext_invalid' };
    }
    const wrapped = b64(deviceRecord.ciphertext, undefined, MAX_DEVICE_WRAPPER_BYTES);
    if (!wrapped) {
      this.tryDeleteDevice(userId);
      return { success: false, error: 'ciphertext_invalid' };
    }
    let root: Buffer | null = null;
    try {
      const parsed: unknown = JSON.parse(this.deviceProtection.decryptString(wrapped));
      if (!isRecord(parsed) || !hasExactKeys(parsed, [
        'magic', 'version', 'userId', 'keyVersion', 'root',
      ])) throw new Error('invalid device wrapper');
      if (
        parsed['magic'] !== 'skytwin-device-key'
        || parsed['version'] !== 1
        || parsed['userId'] !== userId
        || parsed['keyVersion'] !== registry.keyVersion
      ) throw new Error('wrapper mismatch');
      root = b64(parsed['root'], KEY_BYTES, KEY_BYTES);
      if (!root) throw new Error('invalid root');
      const canaryContext: BrokerContext = {
        userId,
        purpose: 'credentials',
        table: 'oauth_tokens',
        column: 'access_token',
        rowId: 'vault-canary',
      };
      const canary = this.decryptWith(root, canaryContext, registry.keyVersion, registry.canary);
      if (!canary.success || canary.plaintext !== 'skytwin-canary') throw new Error('canary mismatch');
      if (!await this.cache(userId, root, registry.keyVersion, operationEpoch)) {
        return { success: false, error: 'vault_locked' };
      }
      return { success: true, generation: this.generation(userId) };
    } catch {
      this.tryDeleteDevice(userId);
      return { success: false, error: 'ciphertext_invalid' };
    } finally {
      root?.fill(0);
      wrapped.fill(0);
    }
  }

  forgetDevice(userId: string): { success: true } | { success: false; error: 'vault_broker_unavailable' } {
    return this.tryDeleteDevice(userId)
      ? { success: true }
      : { success: false, error: 'vault_broker_unavailable' };
  }

  async lock(userId: string): Promise<VaultLockResult> {
    this.operationEpochs.set(userId, this.operationEpoch(userId) + 1);
    this.lockDepth.set(userId, (this.lockDepth.get(userId) ?? 0) + 1);
    const generation = this.generation(userId) + 1;
    this.generations.set(userId, generation);
    const previous = this.lockTails.get(userId) ?? Promise.resolve();
    let barrierComplete = true;
    const current = previous.catch(() => undefined).then(async () => {
      const timer = this.timers.get(userId);
      if (timer) clearTimeout(timer);
      this.timers.delete(userId);
      try {
        barrierComplete = await this.drainChildren(userId, generation);
      } catch {
        barrierComplete = false;
      }
      const old = this.unlocked.get(userId);
      this.unlocked.delete(userId);
      old?.key.fill(0);
      if (barrierComplete) this.containmentFailures.delete(userId);
      else this.containmentFailures.add(userId);
    });
    this.lockTails.set(userId, current);
    try {
      await current;
      const currentGeneration = this.generation(userId);
      return barrierComplete
        ? { success: true, generation: currentGeneration }
        : { success: false, error: 'vault_broker_unavailable', generation: currentGeneration };
    } finally {
      const depth = (this.lockDepth.get(userId) ?? 1) - 1;
      if (depth === 0) this.lockDepth.delete(userId);
      else this.lockDepth.set(userId, depth);
      if (this.lockTails.get(userId) === current) this.lockTails.delete(userId);
    }
  }

  async state(userId: string): Promise<VaultStateResult> {
    if (!isValidVaultUserId(userId)) return { success: false, error: 'ciphertext_invalid' };
    if (
      (this.lockDepth.get(userId) ?? 0) > 0
      || this.containmentFailures.has(userId)
    ) return { success: false, error: 'vault_broker_unavailable' };
    let raw: unknown;
    try {
      raw = await this.store.get(userId);
    } catch {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    if (raw === undefined) return { success: true, state: 'uninitialized' };
    const record = parseWrappedUserKey(raw);
    if (!record || record.userId !== userId) return { success: false, error: 'ciphertext_invalid' };
    if (
      (this.lockDepth.get(userId) ?? 0) > 0
      || this.containmentFailures.has(userId)
    ) return { success: false, error: 'vault_broker_unavailable' };
    const unlocked = this.unlocked.get(userId);
    if (
      (this.lockDepth.get(userId) ?? 0) > 0
      || this.containmentFailures.has(userId)
    ) return { success: false, error: 'vault_broker_unavailable' };
    if (!unlocked) return { success: true, state: 'locked' };
    if (unlocked.expiresAt > this.now()) return { success: true, state: 'unlocked' };
    const locked = await this.lock(userId);
    return locked.success
      ? { success: true, state: 'locked' }
      : { success: false, error: 'vault_broker_unavailable' };
  }

  encrypt(
    context: BrokerContext,
    plaintext: string,
  ): { success: true; envelope: BrokerEnvelope } | { success: false; error: VaultFailureCode } {
    if (
      !validContext(context)
      || typeof plaintext !== 'string'
      || Buffer.byteLength(plaintext) > MAX_SECRET_BYTES
    ) return { success: false, error: 'ciphertext_invalid' };
    const active = this.active(context.userId);
    return active
      ? this.encryptWith(active.key, context, active.keyVersion, plaintext)
      : { success: false, error: 'vault_locked' };
  }

  decrypt(
    context: BrokerContext,
    envelope: unknown,
  ): { success: true; plaintext: string } | { success: false; error: VaultFailureCode } {
    if (!validContext(context)) return { success: false, error: 'ciphertext_invalid' };
    const parsed = parseEnvelope(envelope);
    if (!parsed) return { success: false, error: 'ciphertext_invalid' };
    const active = this.active(context.userId);
    return active
      ? this.decryptWith(active.key, context, active.keyVersion, parsed)
      : { success: false, error: 'vault_locked' };
  }

  async attachChild(
    child: ChildProcess,
    role: BrokerRole,
    authorizedUsers: ReadonlySet<string>,
  ): Promise<boolean> {
    if (this.children.has(child)) return false;
    let protocol: SourceKeyProtocolValidators;
    try {
      protocol = this.protocolValidators ?? await loadSourceKeyProtocolValidators();
    } catch {
      return false;
    }
    if (this.children.has(child)) return false;
    const capability = randomBytes(KEY_BYTES);
    const users = new Set([...authorizedUsers].filter(isValidVaultUserId));
    const binding: Binding = {
      role,
      capability,
      users,
      inFlight: new Map(),
      lockAcks: new Map(),
    };
    this.children.set(child, binding);
    if (!await this.sendForAttachment(child, {
      type: 'skytwin:vault:capability',
      protocolVersion: 1,
      capability: capability.toString('base64'),
      role,
    })) {
      capability.fill(0);
      this.children.delete(child);
      return false;
    }
    for (const userId of users) {
      if (!await this.sendForAttachment(child, {
        type: 'skytwin:vault:generation',
        protocolVersion: 1,
        ownerKind: 'user',
        ownerId: userId,
        generation: this.generation(userId),
      })) {
        capability.fill(0);
        this.children.delete(child);
        return false;
      }
    }
    child.on('message', message => {
      void this.handle(child, message, protocol).catch(() => undefined);
    });
    child.once('exit', () => this.releaseChild(child, binding));
    return true;
  }

  private async handle(
    child: ChildProcess,
    raw: unknown,
    protocol: SourceKeyProtocolValidators,
  ): Promise<void> {
    const binding = this.children.get(child);
    if (!binding) return;
    const control = protocol.snapshotSourceKeyBrokerControlMessage(raw);
    if (control?.type === 'skytwin:vault:lock-ack') {
      const capability = b64(control.capability, KEY_BYTES, KEY_BYTES);
      try {
        if (
          !capability
          || !timingSafeEqual(capability, binding.capability)
          || control.role !== binding.role
        ) return;
        const pending = binding.lockAcks.get(control.lockId);
        if (
          pending
          && control.ownerId === pending.userId
          && control.generation === pending.generation
        ) pending.finish();
      } finally {
        capability?.fill(0);
      }
      return;
    }

    const request = protocol.snapshotSourceKeyBrokerRequest(raw);
    if (!request) return;
    const capability = b64(request.capability, KEY_BYTES, KEY_BYTES);
    try {
      if (
        !capability
        || !timingSafeEqual(capability, binding.capability)
        || request.role !== binding.role
      ) return;
      const context: BrokerContext = {
        userId: request.context.ownerId,
        purpose: request.context.purpose,
        table: request.context.table,
        column: request.context.column,
        rowId: request.context.rowId,
      };
      const deny = (error: VaultFailureCode) => this.safeSend(child, {
        type: 'skytwin:vault:response',
        protocolVersion: 1,
        requestId: request.requestId,
        generation: request.generation,
        context: request.context,
        result: { success: false, operation: request.operation, error },
      });
      if (
        !binding.users.has(context.userId)
        || (this.lockDepth.get(context.userId) ?? 0) > 0
      ) {
        deny('vault_broker_unavailable');
        return;
      }
      const userId = context.userId;
      binding.inFlight.set(userId, (binding.inFlight.get(userId) ?? 0) + 1);
      try {
        if (request.generation !== this.generation(userId)) {
          deny('vault_locked');
          return;
        }
        if (!ROLE_FIELDS[binding.role].some(field =>
          field.purpose === context.purpose
          && field.table === context.table
          && field.column === context.column)) {
          deny('vault_broker_unavailable');
          return;
        }
        if (request.operation === 'state') {
          const result = await this.state(userId);
          this.safeSend(child, {
            type: 'skytwin:vault:response',
            protocolVersion: 1,
            requestId: request.requestId,
            generation: request.generation,
            context: request.context,
            result: result.success
              ? { success: true, operation: 'state', state: result.state }
              : { success: false, operation: 'state', error: result.error },
          });
          return;
        }
        if (request.operation === 'rewrap') {
          deny('rotation_in_progress');
          return;
        }
        const result = request.operation === 'encrypt'
          ? (() => {
              const encrypted = this.encrypt(context, request.plaintext);
              return encrypted.success
                ? { success: true as const, operation: 'encrypt' as const, envelope: encrypted.envelope }
                : { success: false as const, operation: 'encrypt' as const, error: encrypted.error };
            })()
          : (() => {
              const decrypted = this.decrypt(context, request.envelope);
              return decrypted.success
                ? { success: true as const, operation: 'decrypt' as const, plaintext: decrypted.plaintext }
                : { success: false as const, operation: 'decrypt' as const, error: decrypted.error };
            })();
        this.safeSend(child, {
          type: 'skytwin:vault:response',
          protocolVersion: 1,
          requestId: request.requestId,
          generation: request.generation,
          context: request.context,
          result,
        });
      } finally {
        const remaining = (binding.inFlight.get(userId) ?? 1) - 1;
        if (remaining === 0) binding.inFlight.delete(userId);
        else binding.inFlight.set(userId, remaining);
      }
    } finally {
      capability?.fill(0);
    }
  }

  private encryptWith(
    root: Buffer,
    context: BrokerContext,
    version: number,
    plaintext: string,
  ): { success: true; envelope: BrokerEnvelope } {
    const key = deriveDataKey(root, context, version);
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(envelopeAad(context, version));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return {
        success: true,
        envelope: {
          magic: 'skytwin-envelope',
          version: 2,
          algorithm: 'aes-256-gcm',
          ownerKind: 'user',
          purpose: context.purpose,
          keyVersion: version,
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        },
      };
    } finally {
      key.fill(0);
    }
  }

  private decryptWith(
    root: Buffer,
    context: BrokerContext,
    version: number,
    envelope: BrokerEnvelope,
  ): { success: true; plaintext: string } | { success: false; error: VaultFailureCode } {
    if (envelope.purpose !== context.purpose || envelope.keyVersion !== version) {
      return { success: false, error: 'key_version_unavailable' };
    }
    const iv = b64(envelope.iv, IV_BYTES, IV_BYTES);
    const tag = b64(envelope.tag, TAG_BYTES, TAG_BYTES);
    const ciphertext = b64(envelope.ciphertext);
    if (!iv || !tag || !ciphertext) return { success: false, error: 'ciphertext_invalid' };
    const key = deriveDataKey(root, context, version);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(envelopeAad(context, version));
      decipher.setAuthTag(tag);
      return {
        success: true,
        plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
      };
    } catch {
      return { success: false, error: 'ciphertext_invalid' };
    } finally {
      key.fill(0);
      iv.fill(0);
      tag.fill(0);
      ciphertext.fill(0);
    }
  }

  private async unwrap(
    userId: string,
    passphrase: string,
    record: WrappedUserKey,
  ): Promise<Buffer | null> {
    const salt = b64(record.kdf.salt, SALT_BYTES, SALT_BYTES);
    const iv = b64(record.iv, IV_BYTES, IV_BYTES);
    const tag = b64(record.tag, TAG_BYTES, TAG_BYTES);
    const ciphertext = b64(record.ciphertext, KEY_BYTES, KEY_BYTES);
    if (!salt || !iv || !tag || !ciphertext) return null;
    let key: Buffer | null = null;
    try {
      key = await wrappingKey(passphrase, salt);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(wrapperAad(userId, record.keyVersion));
      decipher.setAuthTag(tag);
      const root = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return root.length === KEY_BYTES ? root : null;
    } catch {
      return null;
    } finally {
      key?.fill(0);
      salt.fill(0);
      iv.fill(0);
      tag.fill(0);
      ciphertext.fill(0);
    }
  }

  private async cache(
    userId: string,
    source: Buffer,
    keyVersion: number,
    operationEpoch: number,
  ): Promise<boolean> {
    if (this.operationEpoch(userId) !== operationEpoch) return false;
    this.lockDepth.set(userId, (this.lockDepth.get(userId) ?? 0) + 1);
    const previous = this.lockTails.get(userId) ?? Promise.resolve();
    let installed = false;
    const current = previous.catch(() => undefined).then(async () => {
      if (this.operationEpoch(userId) !== operationEpoch) return;
      const timer = this.timers.get(userId);
      if (timer) clearTimeout(timer);
      this.timers.delete(userId);
      const generation = this.generation(userId) + 1;
      this.generations.set(userId, generation);
      const old = this.unlocked.get(userId);
      this.unlocked.delete(userId);
      old?.key.fill(0);
      let barrierComplete = false;
      try {
        barrierComplete = await this.drainChildren(userId, generation);
      } catch {
        barrierComplete = false;
      }
      if (!barrierComplete) {
        this.containmentFailures.add(userId);
        return;
      }
      this.containmentFailures.delete(userId);
      if (this.operationEpoch(userId) !== operationEpoch) return;
      this.unlocked.set(userId, {
        key: Buffer.from(source),
        keyVersion,
        expiresAt: this.now() + this.ttlMs,
      });
      const nextTimer = setTimeout(() => {
        void this.lock(userId).catch(() => undefined);
      }, this.ttlMs);
      nextTimer.unref?.();
      this.timers.set(userId, nextTimer);
      installed = true;
    });
    this.lockTails.set(userId, current);
    try {
      await current;
      return installed;
    } finally {
      const depth = (this.lockDepth.get(userId) ?? 1) - 1;
      if (depth === 0) this.lockDepth.delete(userId);
      else this.lockDepth.set(userId, depth);
      if (this.lockTails.get(userId) === current) this.lockTails.delete(userId);
    }
  }

  private async drainChildren(userId: string, generation: number): Promise<boolean> {
    const waits: Promise<boolean>[] = [];
    for (const [child, binding] of this.children) {
      if (!binding.users.has(userId) && (binding.inFlight.get(userId) ?? 0) === 0) continue;
      waits.push(this.waitForChildLock(child, binding, userId, generation));
    }
    const results = await Promise.all(waits);
    return results.every(Boolean);
  }

  private async waitForChildLock(
    child: ChildProcess,
    binding: Binding,
    userId: string,
    generation: number,
  ): Promise<boolean> {
    const lockId = randomBytes(16).toString('hex');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failAcknowledgement = () => {};
    const acknowledged = new Promise<boolean>(resolve => {
      let settled = false;
      const settle = (result: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        binding.lockAcks.delete(lockId);
        resolve(result);
      };
      const finish = () => settle(true);
      failAcknowledgement = () => settle(false);
      binding.lockAcks.set(lockId, { userId, generation, finish });
      timer = setTimeout(() => settle(false), this.lockAckTimeoutMs);
    });
    const sent = this.safeSend(child, {
      type: 'skytwin:vault:lock',
      protocolVersion: 1,
      lockId,
      ownerKind: 'user',
      ownerId: userId,
      generation,
    });
    if (!sent) failAcknowledgement();
    if (await acknowledged) return true;

    if (await this.waitForExitAfterSignal(child, 'SIGTERM')) {
      this.releaseChild(child, binding);
      return true;
    }
    if (await this.waitForExitAfterSignal(child, 'SIGKILL')) {
      this.releaseChild(child, binding);
      return true;
    }

    // Retain the revoked-generation binding when termination cannot be proven.
    // Future lock/unlock attempts must encounter and drain it again instead of
    // silently treating the child as gone and reinstalling key material.
    return false;
  }

  private async waitForExitAfterSignal(
    child: ChildProcess,
    signal: NodeJS.Signals,
  ): Promise<boolean> {
    if (this.childHasExited(child)) return true;
    return await new Promise<boolean>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.removeListener('exit', onExit);
        child.removeListener('close', onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      child.once('exit', onExit);
      child.once('close', onExit);
      timer = setTimeout(() => finish(this.childHasExited(child)), this.childExitTimeoutMs);
      try {
        child.kill(signal);
      } catch {
        if (this.childHasExited(child)) finish(true);
      }
    });
  }

  private childHasExited(child: ChildProcess): boolean {
    return (child.exitCode !== null && child.exitCode !== undefined)
      || (child.signalCode !== null && child.signalCode !== undefined);
  }

  private releaseChild(child: ChildProcess, expected: Binding): void {
    if (this.children.get(child) !== expected) return;
    this.children.delete(child);
    expected.capability.fill(0);
    for (const ack of [...expected.lockAcks.values()]) ack.finish();
  }

  private safeSend(
    child: ChildProcess,
    message: SourceKeyBrokerResponse | SourceKeyBrokerControlMessage,
  ): boolean {
    try {
      if (child.connected === false || !child.send) return false;
      child.send(message, () => {
        // Delivery errors are contained by the callback. They never prove a
        // lock acknowledgement or release the child from the barrier.
      });
      // Node's boolean return is a backpressure signal, not delivery status.
      return true;
    } catch {
      return false;
    }
  }

  private async sendForAttachment(
    child: ChildProcess,
    message: SourceKeyBrokerControlMessage,
  ): Promise<boolean> {
    if (child.connected === false || !child.send) return false;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (sent: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(sent);
      };
      const timer = setTimeout(() => finish(false), this.lockAckTimeoutMs);
      try {
        // Node's callback is the delivery authority. A false return only
        // signals backpressure and must not reject a successfully queued IPC.
        child.send(message, (error) => finish(error === null));
      } catch {
        finish(false);
      }
    });
  }

  private tryDeleteDevice(userId: string): boolean {
    if (!this.deviceStore) return true;
    try {
      this.deviceStore.delete(userId);
      return true;
    } catch {
      return false;
    }
  }

  private active(userId: string): Unlocked | null {
    if ((this.lockDepth.get(userId) ?? 0) > 0) return null;
    const active = this.unlocked.get(userId);
    if (!active) return null;
    if (active.expiresAt <= this.now()) {
      void this.lock(userId).catch(() => undefined);
      return null;
    }
    return active;
  }

  private generation(userId: string): number {
    return this.generations.get(userId) ?? 0;
  }

  private operationEpoch(userId: string): number {
    return this.operationEpochs.get(userId) ?? 0;
  }

  private deviceBackend(): string | null {
    return this.deviceProtection
      ? resolveSecureStorageBackend(this.deviceProtection, this.platform)
      : null;
  }
}
