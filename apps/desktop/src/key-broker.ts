import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'crypto';
import type { ChildProcess } from 'child_process';
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

export type BrokerRole = 'api' | 'worker';
export type BrokerPurpose =
  | 'oauth'
  | 'provider_credentials'
  | 'mcp_config'
  | 'federation'
  | 'oauth_transient'
  | 'connector_cursor'
  | 'dxt_database';
export type VaultFailureCode =
  | 'vault_uninitialized'
  | 'vault_locked'
  | 'vault_broker_unavailable'
  | 'key_version_unavailable'
  | 'ciphertext_invalid';
export type VaultState = 'locked' | 'unlocked' | 'uninitialized';
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

export interface BrokerEnvelope {
  magic: 'skytwin-envelope';
  version: 2;
  algorithm: 'aes-256-gcm';
  ownerKind: 'user';
  purpose: BrokerPurpose;
  keyVersion: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

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

export interface BrokerRequest {
  type: 'skytwin:vault:request';
  requestId: string;
  capability: string;
  generation: number;
  operation: 'encrypt' | 'decrypt' | 'state';
  context: BrokerContext;
  plaintext?: string;
  envelope?: BrokerEnvelope;
}

export interface BrokerLockAck {
  type: 'skytwin:vault:lock-ack';
  lockId: string;
  capability: string;
  userId: string;
  generation: number;
}

interface BrokerLockRequest {
  type: 'skytwin:vault:lock';
  lockId: string;
  userId: string;
  generation: number;
}

interface BrokerCapabilityMessage {
  type: 'skytwin:vault:capability';
  capability: string;
  role: BrokerRole;
}

interface BrokerGenerationMessage {
  type: 'skytwin:vault:generation';
  userId: string;
  generation: number;
}

export interface BrokerResponse {
  type: 'skytwin:vault:response';
  requestId: string;
  contextUserId: string;
  generation: number;
  result:
    | { success: true; state: VaultState }
    | { success: true; envelope: BrokerEnvelope }
    | { success: true; plaintext: string }
    | { success: false; error: VaultFailureCode };
}

interface Field {
  purpose: BrokerPurpose;
  table: string;
  column: string;
}

const COMMON: readonly Field[] = [
  { purpose: 'oauth', table: 'oauth_tokens', column: 'access_token' },
  { purpose: 'oauth', table: 'oauth_tokens', column: 'refresh_token' },
  { purpose: 'provider_credentials', table: 'ai_provider_settings', column: 'api_key' },
  { purpose: 'mcp_config', table: 'mcp_servers', column: 'config' },
  { purpose: 'federation', table: 'federation_peers', column: 'private_key' },
  { purpose: 'connector_cursor', table: 'connector_cursors', column: 'cursor' },
  { purpose: 'dxt_database', table: 'dxt_imports', column: 'artifact' },
];
const ROLE_FIELDS: Record<BrokerRole, readonly Field[]> = {
  api: [
    ...COMMON,
    {
      purpose: 'oauth_transient',
      table: 'oauth_pending_signins',
      column: 'code_verifier',
    },
  ],
  worker: COMMON,
};

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
  users: Map<string, number | null>;
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
  && value.length >= 8
  && value.length <= 128
  && /^[A-Za-z0-9_-]+$/.test(value);

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
    || value.length > Math.ceil(max * 4 / 3) + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return null;
  const output = Buffer.from(value, 'base64');
  return output.toString('base64') === value
    && (exact === undefined || output.length === exact)
    ? output
    : null;
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
      || !COMMON.concat(ROLE_FIELDS.api).some(field => field.purpose === value['purpose'])
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
    && COMMON.concat(ROLE_FIELDS.api).some(field => field.purpose === value['purpose']);
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
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly lockAckTimeoutMs: number;
  private readonly childExitTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly deviceProtection?: DeviceProtectionPort;
  private readonly deviceStore?: DeviceWrapperStore;

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
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.lockAckTimeoutMs = options.lockAckTimeoutMs ?? DEFAULT_LOCK_ACK_TIMEOUT_MS;
    this.childExitTimeoutMs = options.childExitTimeoutMs ?? DEFAULT_CHILD_EXIT_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
    this.deviceProtection = options.deviceProtection;
    this.deviceStore = options.deviceStore;
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
    try {
      wrap = await wrappingKey(passphrase, salt);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', wrap, iv);
      cipher.setAAD(wrapperAad(userId, 1));
      const ciphertext = Buffer.concat([cipher.update(root), cipher.final()]);
      const canaryContext: BrokerContext = {
        userId,
        purpose: 'oauth',
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
      const reread = parseWrappedUserKey(await this.store.get(userId));
      const check = reread && await this.unwrap(userId, passphrase, reread);
      if (!check) {
        const rolledBack = await this.store.deleteIfMatch(userId, created);
        return {
          success: false,
          error: rolledBack ? 'ciphertext_invalid' : 'vault_broker_unavailable',
        };
      }
      check.fill(0);
      await this.cache(userId, root, 1, operationEpoch);
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
        purpose: 'oauth',
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
        purpose: 'oauth',
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
      barrierComplete = await this.drainChildren(userId, generation);
      const old = this.unlocked.get(userId);
      this.unlocked.delete(userId);
      old?.key.fill(0);
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
    let raw: unknown;
    try {
      raw = await this.store.get(userId);
    } catch {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    if (raw === undefined) return { success: true, state: 'uninitialized' };
    const record = parseWrappedUserKey(raw);
    if (!record || record.userId !== userId) return { success: false, error: 'ciphertext_invalid' };
    return { success: true, state: this.active(userId) ? 'unlocked' : 'locked' };
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

  attachChild(child: ChildProcess, role: BrokerRole): void {
    const capability = randomBytes(KEY_BYTES);
    const previous = this.children.get(child);
    if (previous) {
      previous.capability.fill(0);
      for (const ack of previous.lockAcks.values()) ack.finish();
    }
    const binding: Binding = {
      role,
      capability,
      users: new Map(),
      inFlight: new Map(),
      lockAcks: new Map(),
    };
    this.children.set(child, binding);
    if (!this.safeSend(child, {
      type: 'skytwin:vault:capability',
      capability: capability.toString('base64'),
      role,
    })) {
      capability.fill(0);
      this.children.delete(child);
      return;
    }
    child.on('message', message => {
      void this.handle(child, message).catch(() => {
        this.safeSend(child, {
          type: 'skytwin:vault:response',
          requestId: 'invalid-request',
          contextUserId: '',
          generation: -1,
          result: { success: false, error: 'vault_broker_unavailable' },
        });
      });
    });
    child.once('exit', () => this.releaseChild(child, binding));
  }

  private async handle(child: ChildProcess, raw: unknown): Promise<void> {
    if (!isRecord(raw)) return;
    const binding = this.children.get(child);
    const capability = b64(raw['capability'], KEY_BYTES, KEY_BYTES);
    try {
      if (!binding || !capability || !timingSafeEqual(capability, binding.capability)) return;
      if (raw['type'] === 'skytwin:vault:lock-ack') {
        const lockId = raw['lockId'];
        const pending = typeof lockId === 'string' ? binding.lockAcks.get(lockId) : undefined;
        if (
          pending
          && raw['userId'] === pending.userId
          && raw['generation'] === pending.generation
        ) pending.finish();
        return;
      }
      if (
        raw['type'] === 'skytwin:vault:grant'
        && validId(raw['requestId'], 128)
        && isValidVaultUserId(raw['userId'])
      ) {
        const requestId = raw['requestId'];
        const userId = raw['userId'];
        const expectedAuthentication = binding.role === 'api' ? 'session' : 'service';
        const expiresAt = raw['expiresAt'];
        const validExpiry = binding.role === 'worker'
          ? expiresAt === null
          : Number.isSafeInteger(expiresAt) && Number(expiresAt) > this.now();
        const allowed = raw['role'] === binding.role
          && raw['authentication'] === expectedAuthentication
          && validExpiry;
        if (allowed) binding.users.set(userId, binding.role === 'api' ? Number(expiresAt) : null);
        this.safeSend(child, {
          type: 'skytwin:vault:response',
          requestId,
          contextUserId: userId,
          generation: this.generation(userId),
          result: allowed
            ? await this.state(userId)
            : { success: false, error: 'vault_broker_unavailable' },
        });
        return;
      }
      if (
        raw['type'] === 'skytwin:vault:revoke'
        && validId(raw['requestId'], 128)
        && isValidVaultUserId(raw['userId'])
      ) {
        const requestId = raw['requestId'];
        const userId = raw['userId'];
        const expectedAuthentication = binding.role === 'api' ? 'session' : 'service';
        const allowed = raw['role'] === binding.role
          && raw['authentication'] === expectedAuthentication;
        if (allowed) binding.users.delete(userId);
        this.safeSend(child, {
          type: 'skytwin:vault:response',
          requestId,
          contextUserId: userId,
          generation: this.generation(userId),
          result: allowed
            ? { success: true, state: 'locked' }
            : { success: false, error: 'vault_broker_unavailable' },
        });
        return;
      }
      if (
        raw['type'] === 'skytwin:vault:reconcile'
        && validId(raw['requestId'], 128)
        && raw['role'] === 'worker'
        && binding.role === 'worker'
        && raw['authentication'] === 'service'
        && Array.isArray(raw['userIds'])
      ) {
        const userIds = raw['userIds'];
        const allowed = userIds.length <= 10_000
          && userIds.every(isValidVaultUserId)
          && new Set(userIds).size === userIds.length;
        if (allowed) {
          binding.users = new Map((userIds as string[]).map(userId => [userId, null]));
        }
        this.safeSend(child, {
          type: 'skytwin:vault:response',
          requestId: raw['requestId'],
          contextUserId: 'worker-set',
          generation: 0,
          result: allowed
            ? { success: true, state: 'locked' }
            : { success: false, error: 'vault_broker_unavailable' },
        });
        return;
      }
      if (raw['type'] !== 'skytwin:vault:request' || !validId(raw['requestId'], 128)) return;
      const requestId = raw['requestId'];
      const context = raw['context'];
      const requestGeneration = raw['generation'];
      const deny = (error: VaultFailureCode) => this.safeSend(child, {
        type: 'skytwin:vault:response',
        requestId,
        contextUserId: validContext(context) ? context.userId : '',
        generation: validContext(context) ? this.generation(context.userId) : -1,
        result: { success: false, error },
      });
      if (
        !validContext(context)
        || !this.hasActiveGrant(binding, context.userId)
        || (this.lockDepth.get(context.userId) ?? 0) > 0
      ) {
        deny('vault_broker_unavailable');
        return;
      }
      const userId = context.userId;
      binding.inFlight.set(userId, (binding.inFlight.get(userId) ?? 0) + 1);
      try {
        if (raw['operation'] === 'state') {
          const result = await this.state(userId);
          this.safeSend(child, {
            type: 'skytwin:vault:response',
            requestId,
            contextUserId: userId,
            generation: this.generation(userId),
            result,
          });
          return;
        }
        if (
          requestGeneration !== this.generation(userId)
          || !ROLE_FIELDS[binding.role].some(field =>
            field.purpose === context.purpose
            && field.table === context.table
            && field.column === context.column)
        ) {
          deny('vault_locked');
          return;
        }
        const result = raw['operation'] === 'encrypt' && typeof raw['plaintext'] === 'string'
          ? this.encrypt(context, raw['plaintext'])
          : raw['operation'] === 'decrypt'
            ? this.decrypt(context, raw['envelope'])
            : { success: false as const, error: 'ciphertext_invalid' as const };
        this.safeSend(child, {
          type: 'skytwin:vault:response',
          requestId,
          contextUserId: userId,
          generation: this.generation(userId),
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
      if (!await this.drainChildren(userId, this.generation(userId))) return;
      if (this.operationEpoch(userId) !== operationEpoch) return;
      const old = this.unlocked.get(userId);
      old?.key.fill(0);
      this.unlocked.set(userId, {
        key: Buffer.from(source),
        keyVersion,
        expiresAt: this.now() + this.ttlMs,
      });
      this.generations.set(userId, this.generation(userId) + 1);
      const generation = this.generation(userId);
      for (const [child, binding] of this.children) {
        if (!this.hasActiveGrant(binding, userId)) continue;
        this.safeSend(child, { type: 'skytwin:vault:generation', userId, generation });
      }
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

  private hasActiveGrant(binding: Binding, userId: string): boolean {
    if (!binding.users.has(userId)) return false;
    const expiresAt = binding.users.get(userId);
    if (expiresAt !== null && expiresAt !== undefined && expiresAt <= this.now()) {
      binding.users.delete(userId);
      return false;
    }
    return true;
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
      lockId,
      userId,
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
    message: BrokerResponse | BrokerLockRequest | BrokerCapabilityMessage | BrokerGenerationMessage,
  ): boolean {
    try {
      if (child.connected === false || !child.send) return false;
      return child.send(message) !== false;
    } catch {
      return false;
    }
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
