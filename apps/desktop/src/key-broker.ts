import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import type { ChildProcess } from 'child_process';
const KEY_BYTES = 32, IV_BYTES = 12, TAG_BYTES = 16, SALT_BYTES = 16;
const DEFAULT_TTL_MS = 3_600_000, MAX_SECRET_BYTES = 16 * 1024 * 1024;
const KDF = { algorithm: 'scrypt' as const, N: 32_768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export type BrokerRole = 'api' | 'worker';
export type BrokerPurpose = 'oauth' | 'provider_credentials' | 'mcp_config' | 'federation' | 'oauth_transient' | 'connector_cursor' | 'dxt_database';
export type VaultFailureCode = 'vault_uninitialized' | 'vault_locked' | 'vault_broker_unavailable' | 'key_version_unavailable' | 'ciphertext_invalid';
export interface BrokerContext { userId: string; purpose: BrokerPurpose; table: string; column: string; rowId: string }
export interface BrokerEnvelope { magic: 'skytwin-envelope'; version: 2; algorithm: 'aes-256-gcm'; ownerKind: 'user'; purpose: BrokerPurpose; keyVersion: number; iv: string; tag: string; ciphertext: string }
export interface WrappedUserKey { magic: 'skytwin-user-key'; wrapperVersion: 1; userId: string; keyVersion: number; algorithm: 'aes-256-gcm'; kdf: typeof KDF & { salt: string }; iv: string; tag: string; ciphertext: string; canary: BrokerEnvelope }
export interface WrappedKeyStore { get(userId: string): WrappedUserKey | undefined | Promise<WrappedUserKey | undefined>; set(userId: string, value: WrappedUserKey): void | Promise<void>; delete(userId: string): void | Promise<void>; commit?(userId: string): void | Promise<void>; rollbackPending?(userId: string): void | Promise<void> }
export interface WrappedKeyValueStore { get(key: string): WrappedUserKey | undefined; set(key: string, value: WrappedUserKey): void; delete(key: string): void }
export interface DeviceWrapperStore { get(userId: string): string | undefined; set(userId: string, ciphertext: string): void; delete(userId: string): void }
export interface DeviceProtectionPort { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; getSelectedStorageBackend?(): string }
export interface BrokerRequest { type: 'skytwin:vault:request'; requestId: string; capability: string; generation: number; operation: 'encrypt' | 'decrypt' | 'state'; context: BrokerContext; plaintext?: string; envelope?: BrokerEnvelope }
export interface BrokerResponse { type: 'skytwin:vault:response'; requestId: string; generation: number; contextUserId: string; result: { success: true; state: 'locked' | 'unlocked' | 'uninitialized' } | { success: true; envelope: BrokerEnvelope } | { success: true; plaintext: string } | { success: false; error: VaultFailureCode } }

interface Field { purpose: BrokerPurpose; table: string; column: string }
const COMMON: readonly Field[] = [
  { purpose: 'oauth', table: 'oauth_tokens', column: 'access_token' }, { purpose: 'oauth', table: 'oauth_tokens', column: 'refresh_token' },
  { purpose: 'provider_credentials', table: 'ai_provider_settings', column: 'api_key' }, { purpose: 'mcp_config', table: 'mcp_servers', column: 'config' },
  { purpose: 'federation', table: 'federation_peers', column: 'private_key' }, { purpose: 'connector_cursor', table: 'connector_cursors', column: 'cursor' },
  { purpose: 'dxt_database', table: 'dxt_imports', column: 'artifact' },
];
const ROLE_FIELDS: Record<BrokerRole, readonly Field[]> = { api: [...COMMON, { purpose: 'oauth_transient', table: 'oauth_pending_signins', column: 'code_verifier' }], worker: COMMON };
interface Unlocked { key: Buffer; keyVersion: number; expiresAt: number }
interface LockAck { userId: string; generation: number; finish: () => void }
interface Binding { role: BrokerRole; capability: Buffer; users: Map<string, number | null>; inFlight: Map<string, number>; lockAcks: Map<string, LockAck> }

const validId = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max && /^[A-Za-z0-9_.-]+$/.test(v);
export const isValidVaultUserId = (v: unknown): v is string => typeof v === 'string' && v.length >= 8 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v);
export class PersistentWrappedKeyStore implements WrappedKeyStore {
  constructor(private readonly store: WrappedKeyValueStore) {}
  get(userId: string): WrappedUserKey | undefined { return this.store.get(`source-key:${userId}`); }
  set(userId: string, value: WrappedUserKey): void { this.store.set(`source-key:${userId}`, value); }
  delete(userId: string): void { this.store.delete(`source-key:${userId}`); }
}
function validContext(v: unknown): v is BrokerContext { if (!v || typeof v !== 'object') return false; const c = v as Partial<BrokerContext>; return isValidVaultUserId(c.userId) && validId(c.table) && validId(c.column) && validId(c.rowId) && COMMON.concat(ROLE_FIELDS.api).some(f => f.purpose === c.purpose); }
function b64(v: unknown, exact?: number, max = MAX_SECRET_BYTES): Buffer | null { if (typeof v !== 'string' || v.length > Math.ceil(max * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)) return null; const out = Buffer.from(v, 'base64'); return out.toString('base64') === v && (exact === undefined || out.length === exact) ? out : null; }
const wrapperAad = (u: string, v: number) => Buffer.from(JSON.stringify(['skytwin', 'user-key', 1, u, v]));
const envelopeAad = (c: BrokerContext, v: number) => Buffer.from(JSON.stringify(['skytwin', 2, 'user', c.userId, c.purpose, v, c.table, c.column, c.rowId]));
function dek(root: Buffer, c: BrokerContext, v: number): Buffer { return Buffer.from(hkdfSync('sha256', root, Buffer.from(`skytwin:${c.userId}:${v}`), Buffer.from(`skytwin:${c.purpose}:v2`), KEY_BYTES)); }
async function wrappingKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(passphrase, salt, KEY_BYTES, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem }, (error, result) => error ? reject(error) : resolve(result));
  });
}

export class DesktopKeyBroker {
  private unlocked = new Map<string, Unlocked>(); private generations = new Map<string, number>(); private operationEpochs = new Map<string, number>(); private timers = new Map<string, ReturnType<typeof setTimeout>>(); private children = new Map<ChildProcess, Binding>(); private initializing = new Set<string>(); private lockDepth = new Map<string, number>(); private lockTails = new Map<string, Promise<void>>();
  private readonly now: () => number; private readonly ttlMs: number;
  constructor(private readonly store: WrappedKeyStore, options: { now?: () => number; ttlMs?: number; deviceProtection?: DeviceProtectionPort; deviceStore?: DeviceWrapperStore } = {}) { this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS; this.deviceProtection = options.deviceProtection; this.deviceStore = options.deviceStore; }
  private readonly deviceProtection?: DeviceProtectionPort; private readonly deviceStore?: DeviceWrapperStore;

  async initialize(userId: string, passphrase: string): Promise<{ success: true } | { success: false; error: 'already_initialized' | 'invalid_passphrase' | 'ciphertext_invalid' }> {
    if (!isValidVaultUserId(userId) || passphrase.length < 12 || passphrase.length > 1024) return { success: false, error: 'invalid_passphrase' };
    if (this.initializing.has(userId)) return { success: false, error: 'already_initialized' };
    const operationEpoch = this.operationEpoch(userId);
    this.initializing.add(userId);
    const root = randomBytes(KEY_BYTES), salt = randomBytes(SALT_BYTES); let wrap: Buffer | null = null, wrote = false;
    try {
      await this.store.rollbackPending?.(userId);
      if (await this.store.get(userId)) return { success: false, error: 'already_initialized' };
      wrap = await wrappingKey(passphrase, salt); const iv = randomBytes(IV_BYTES), cipher = createCipheriv('aes-256-gcm', wrap, iv); cipher.setAAD(wrapperAad(userId, 1)); const ciphertext = Buffer.concat([cipher.update(root), cipher.final()]);
      const cc: BrokerContext = { userId, purpose: 'oauth', table: 'oauth_tokens', column: 'access_token', rowId: 'vault-canary' };
      const record: WrappedUserKey = { magic: 'skytwin-user-key', wrapperVersion: 1, userId, keyVersion: 1, algorithm: 'aes-256-gcm', kdf: { ...KDF, salt: salt.toString('base64') }, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), canary: this.encryptWith(root, cc, 1, 'skytwin-canary').envelope };
      await this.store.set(userId, record); wrote = true; const reread = await this.store.get(userId); const check = reread && await this.unwrap(userId, passphrase, reread);
      if (!check) { await this.rollbackInitialization(userId); return { success: false, error: 'ciphertext_invalid' }; }
      check.fill(0); await this.store.commit?.(userId); await this.cache(userId, root, 1, operationEpoch); return { success: true };
    } catch { if (wrote) await this.rollbackInitialization(userId); return { success: false, error: 'ciphertext_invalid' }; } finally { this.initializing.delete(userId); wrap?.fill(0); root.fill(0); salt.fill(0); }
  }
  async unlock(userId: string, passphrase: string): Promise<{ success: true; generation: number } | { success: false; error: VaultFailureCode }> {
    if (!isValidVaultUserId(userId) || passphrase.length > 1024) return { success: false, error: 'ciphertext_invalid' }; const operationEpoch = this.operationEpoch(userId); const record = await this.store.get(userId); if (!record) return { success: false, error: 'vault_uninitialized' };
    const root = await this.unwrap(userId, passphrase, record); if (!root) return { success: false, error: 'ciphertext_invalid' };
    try { const cc: BrokerContext = { userId, purpose: 'oauth', table: 'oauth_tokens', column: 'access_token', rowId: 'vault-canary' }; const result = this.decryptWith(root, cc, record.keyVersion, record.canary); if (!result.success || result.plaintext !== 'skytwin-canary') return { success: false, error: 'ciphertext_invalid' }; if (!await this.cache(userId, root, record.keyVersion, operationEpoch)) return { success: false, error: 'vault_locked' }; return { success: true, generation: this.generation(userId) }; } finally { root.fill(0); }
  }
  deviceWrapperState(userId: string): 'absent' | 'present' | 'unsupported' {
    if (!this.genuineDeviceProtection()) return 'unsupported';
    return this.deviceStore?.get(userId) ? 'present' : 'absent';
  }
  rememberDevice(userId: string): { success: true } | { success: false; error: VaultFailureCode } {
    if ((this.lockDepth.get(userId) ?? 0) > 0) return { success: false, error: 'vault_locked' };
    const active = this.active(userId);
    if (!active) return { success: false, error: 'vault_locked' };
    if (!this.genuineDeviceProtection() || !this.deviceStore || !this.deviceProtection) return { success: false, error: 'vault_broker_unavailable' };
    // safeStorage's API accepts strings only. Keep this conversion scoped to
    // the call and never return or persist the unwrapped representation.
    const payload = JSON.stringify({ magic: 'skytwin-device-key', version: 1, userId, keyVersion: active.keyVersion, root: active.key.toString('base64') });
    try { this.deviceStore.set(userId, this.deviceProtection.encryptString(payload).toString('base64')); return { success: true }; }
    catch { this.deviceStore.delete(userId); return { success: false, error: 'vault_broker_unavailable' }; }
  }
  async unlockFromDevice(userId: string): Promise<{ success: true; generation: number } | { success: false; error: VaultFailureCode }> {
    if (!isValidVaultUserId(userId) || !this.genuineDeviceProtection() || !this.deviceStore || !this.deviceProtection) return { success: false, error: 'vault_broker_unavailable' };
    const operationEpoch = this.operationEpoch(userId); const encoded = this.deviceStore.get(userId), registry = await this.store.get(userId); if (!encoded || !registry) return { success: false, error: 'vault_uninitialized' };
    const wrapped = b64(encoded, undefined, 4096); if (!wrapped) { this.deviceStore.delete(userId); return { success: false, error: 'ciphertext_invalid' }; }
    let root: Buffer | null = null;
    try { const parsed = JSON.parse(this.deviceProtection.decryptString(wrapped)) as { magic?: unknown; version?: unknown; userId?: unknown; keyVersion?: unknown; root?: unknown }; if (parsed.magic !== 'skytwin-device-key' || parsed.version !== 1 || parsed.userId !== userId || parsed.keyVersion !== registry.keyVersion) throw new Error('wrapper mismatch'); root = b64(parsed.root, KEY_BYTES, KEY_BYTES); if (!root) throw new Error('invalid root'); const cc: BrokerContext = { userId, purpose: 'oauth', table: 'oauth_tokens', column: 'access_token', rowId: 'vault-canary' }; const canary = this.decryptWith(root, cc, registry.keyVersion, registry.canary); if (!canary.success || canary.plaintext !== 'skytwin-canary') throw new Error('canary mismatch'); if (!await this.cache(userId, root, registry.keyVersion, operationEpoch)) return { success: false, error: 'vault_locked' }; return { success: true, generation: this.generation(userId) }; }
    catch { this.deviceStore.delete(userId); return { success: false, error: 'ciphertext_invalid' }; }
    finally { root?.fill(0); wrapped.fill(0); }
  }
  forgetDevice(userId: string): void { this.deviceStore?.delete(userId); }
  async lock(userId: string): Promise<{ success: true; generation: number }> {
    this.operationEpochs.set(userId, this.operationEpoch(userId) + 1);
    this.lockDepth.set(userId, (this.lockDepth.get(userId) ?? 0) + 1);
    const previous = this.lockTails.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const timer = this.timers.get(userId); if (timer) clearTimeout(timer); this.timers.delete(userId);
      const nextGeneration = this.generation(userId) + 1;
      try {
        await Promise.all([...this.children.entries()].filter(([, binding]) => binding.users.has(userId)).map(([child, binding]) => this.requestLockAck(child, binding, userId, nextGeneration)));
        const deadline = Date.now() + 1_000;
        while ([...this.children.values()].some(x => (x.inFlight.get(userId) ?? 0) > 0) && Date.now() < deadline) await new Promise<void>(r => setTimeout(r, 1));
        for (const [child, binding] of this.children) if ((binding.inFlight.get(userId) ?? 0) > 0) this.detachChild(child, binding, true);
      } finally {
        const old = this.unlocked.get(userId); this.unlocked.delete(userId); this.generations.set(userId, nextGeneration); old?.key.fill(0);
      }
    });
    this.lockTails.set(userId, current);
    try { await current; return { success: true, generation: this.generation(userId) }; }
    finally {
      const depth = (this.lockDepth.get(userId) ?? 1) - 1; if (depth === 0) this.lockDepth.delete(userId); else this.lockDepth.set(userId, depth);
      if (this.lockTails.get(userId) === current) this.lockTails.delete(userId);
    }
  }
  async state(userId: string): Promise<'locked' | 'unlocked' | 'uninitialized'> { return !await this.store.get(userId) ? 'uninitialized' : this.active(userId) ? 'unlocked' : 'locked'; }
  encrypt(c: BrokerContext, plaintext: string): { success: true; envelope: BrokerEnvelope } | { success: false; error: VaultFailureCode } { if (!validContext(c) || Buffer.byteLength(plaintext) > MAX_SECRET_BYTES) return { success: false, error: 'ciphertext_invalid' }; const a = this.active(c.userId); return a ? this.encryptWith(a.key, c, a.keyVersion, plaintext) : { success: false, error: 'vault_locked' }; }
  decrypt(c: BrokerContext, e: BrokerEnvelope): { success: true; plaintext: string } | { success: false; error: VaultFailureCode } { if (!validContext(c)) return { success: false, error: 'ciphertext_invalid' }; const a = this.active(c.userId); return a ? this.decryptWith(a.key, c, a.keyVersion, e) : { success: false, error: 'vault_locked' }; }
  attachChild(child: ChildProcess, role: BrokerRole, authorizedUsers: ReadonlySet<string>): void { const capability = randomBytes(KEY_BYTES); const binding: Binding = { role, capability, users: new Map([...authorizedUsers].map(id => [id, null])), inFlight: new Map(), lockAcks: new Map() }; this.children.set(child, binding); child.send?.({ type: 'skytwin:vault:capability', capability: capability.toString('base64'), role }); child.on('message', m => { void this.handle(child, m); }); child.once('exit', () => { this.detachChild(child, binding, false); }); }
  private async handle(child: ChildProcess, raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const q = raw as Record<string, unknown>, binding = this.children.get(child), cap = b64(q['capability'], KEY_BYTES, KEY_BYTES);
    if (!binding || !cap || !timingSafeEqual(cap, binding.capability)) return;
    if (q['type'] === 'skytwin:vault:lock-ack' && validId(q['lockId'], 128) && isValidVaultUserId(q['userId']) && Number.isSafeInteger(q['generation'])) {
      const expected = binding.lockAcks.get(q['lockId']);
      if (expected?.userId === q['userId'] && expected.generation === q['generation']) expected.finish();
      return;
    }
    if (q['type'] === 'skytwin:vault:grant' && validId(q['requestId'], 128) && isValidVaultUserId(q['userId'])) {
      const expectedAuthentication = binding.role === 'api' ? 'session' : 'service';
      const expiry = q['expiresAt'];
      const allowedExpiry = binding.role === 'worker' ? expiry === null : Number.isSafeInteger(expiry) && Number(expiry) > Date.now();
      const allowed = q['role'] === binding.role && q['authentication'] === expectedAuthentication && allowedExpiry;
      if (allowed) binding.users.set(q['userId'], binding.role === 'api' ? Number(expiry) : null);
      const userId = q['userId'];
      child.send?.({ type: 'skytwin:vault:response', requestId: q['requestId'], contextUserId: userId, generation: this.generation(userId), result: allowed ? { success: true, state: await this.state(userId) } : { success: false, error: 'vault_broker_unavailable' } });
      return;
    }
    if (q['type'] === 'skytwin:vault:revoke' && validId(q['requestId'], 128) && isValidVaultUserId(q['userId'])) {
      const expectedAuthentication = binding.role === 'api' ? 'session' : 'service';
      const allowed = q['role'] === binding.role && q['authentication'] === expectedAuthentication;
      if (allowed) binding.users.delete(q['userId']);
      const userId = q['userId'];
      child.send?.({ type: 'skytwin:vault:response', requestId: q['requestId'], contextUserId: userId, generation: this.generation(userId), result: allowed ? { success: true, state: 'locked' } : { success: false, error: 'vault_broker_unavailable' } });
      return;
    }
    if (q['type'] === 'skytwin:vault:reconcile' && validId(q['requestId'], 128) && q['role'] === 'worker' && binding.role === 'worker' && q['authentication'] === 'service' && Array.isArray(q['userIds'])) {
      const userIds = q['userIds'];
      const allowed = userIds.length <= 10_000 && userIds.every(isValidVaultUserId) && new Set(userIds).size === userIds.length;
      if (allowed) binding.users = new Map((userIds as string[]).map(id => [id, null]));
      child.send?.({ type: 'skytwin:vault:response', requestId: q['requestId'], contextUserId: 'worker-set', generation: 0, result: allowed ? { success: true, state: 'locked' } : { success: false, error: 'vault_broker_unavailable' } });
      return;
    }
    const request = q as unknown as Partial<BrokerRequest>;
    if (request.type !== 'skytwin:vault:request' || !validId(request.requestId, 128)) return;
    const contextUserId = validContext(request.context) ? request.context.userId : '';
    const deny = (error: VaultFailureCode) => child.send?.({ type: 'skytwin:vault:response', requestId: request.requestId, contextUserId, generation: contextUserId ? this.generation(contextUserId) : -1, result: { success: false, error } });
    if (!validContext(request.context) || !this.hasActiveGrant(binding, request.context.userId) || (this.lockDepth.get(request.context.userId) ?? 0) > 0) { deny('vault_broker_unavailable'); return; }
    const requestUserId = request.context.userId; binding.inFlight.set(requestUserId, (binding.inFlight.get(requestUserId) ?? 0) + 1);
    try {
      if (request.operation === 'state') { child.send?.({ type: 'skytwin:vault:response', requestId: request.requestId, contextUserId: requestUserId, generation: this.generation(requestUserId), result: { success: true, state: await this.state(requestUserId) } }); return; }
      if (request.generation !== this.generation(requestUserId) || !ROLE_FIELDS[binding.role].some(f => f.purpose === request.context!.purpose && f.table === request.context!.table && f.column === request.context!.column)) { deny('vault_locked'); return; }
      const result = request.operation === 'encrypt' && typeof request.plaintext === 'string' ? this.encrypt(request.context, request.plaintext) : request.operation === 'decrypt' && request.envelope ? this.decrypt(request.context, request.envelope) : { success: false as const, error: 'ciphertext_invalid' as const };
      child.send?.({ type: 'skytwin:vault:response', requestId: request.requestId, contextUserId: requestUserId, generation: this.generation(requestUserId), result });
    } finally { const remaining = (binding.inFlight.get(requestUserId) ?? 1) - 1; if (remaining === 0) binding.inFlight.delete(requestUserId); else binding.inFlight.set(requestUserId, remaining); }
  }
  private requestLockAck(child: ChildProcess, binding: Binding, userId: string, generation: number): Promise<void> {
    const lockId = randomBytes(16).toString('hex');
    return new Promise(resolve => {
      let settled = false;
      const finish = (): void => { if (settled) return; settled = true; clearTimeout(timer); binding.lockAcks.delete(lockId); resolve(); };
      const timer = setTimeout(() => { this.detachChild(child, binding, true); finish(); }, 1_000);
      binding.lockAcks.set(lockId, { userId, generation, finish });
      try { if (child.send?.({ type: 'skytwin:vault:lock', lockId, userId, generation }) === false) throw new Error('IPC send rejected'); }
      catch { this.detachChild(child, binding, true); finish(); }
    });
  }
  private detachChild(child: ChildProcess, binding: Binding, terminate: boolean): void {
    if (this.children.get(child) !== binding) return;
    this.children.delete(child); binding.capability.fill(0);
    for (const ack of binding.lockAcks.values()) ack.finish();
    if (terminate) { try { child.kill(); } catch { /* already gone */ } }
  }
  private hasActiveGrant(binding: Binding, userId: string): boolean {
    if (!binding.users.has(userId)) return false;
    const expiry = binding.users.get(userId); if (expiry !== null && expiry !== undefined && expiry <= Date.now()) { binding.users.delete(userId); return false; }
    return true;
  }
  private async rollbackInitialization(userId: string): Promise<void> {
    try { await this.store.delete(userId); } catch { /* retained by the store for a later retry */ }
  }
  private encryptWith(root: Buffer, c: BrokerContext, v: number, plaintext: string): { success: true; envelope: BrokerEnvelope } { const key = dek(root, c, v); try { const iv = randomBytes(IV_BYTES), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(envelopeAad(c, v)); const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]); return { success: true, envelope: { magic: 'skytwin-envelope', version: 2, algorithm: 'aes-256-gcm', ownerKind: 'user', purpose: c.purpose, keyVersion: v, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') } }; } finally { key.fill(0); } }
  private decryptWith(root: Buffer, c: BrokerContext, v: number, e: BrokerEnvelope): { success: true; plaintext: string } | { success: false; error: VaultFailureCode } { if (e?.magic !== 'skytwin-envelope' || e.version !== 2 || e.algorithm !== 'aes-256-gcm' || e.ownerKind !== 'user' || e.purpose !== c.purpose || e.keyVersion !== v) return { success: false, error: 'key_version_unavailable' }; const iv = b64(e.iv, IV_BYTES, IV_BYTES), tag = b64(e.tag, TAG_BYTES, TAG_BYTES), text = b64(e.ciphertext, undefined); if (!iv || !tag || !text) return { success: false, error: 'ciphertext_invalid' }; const key = dek(root, c, v); try { const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(envelopeAad(c, v)); decipher.setAuthTag(tag); return { success: true, plaintext: Buffer.concat([decipher.update(text), decipher.final()]).toString('utf8') }; } catch { return { success: false, error: 'ciphertext_invalid' }; } finally { key.fill(0); } }
  private async unwrap(userId: string, passphrase: string, r: WrappedUserKey): Promise<Buffer | null> { if (r.magic !== 'skytwin-user-key' || r.wrapperVersion !== 1 || r.userId !== userId || r.algorithm !== 'aes-256-gcm' || r.kdf?.algorithm !== KDF.algorithm || r.kdf.N !== KDF.N || r.kdf.r !== KDF.r || r.kdf.p !== KDF.p || r.kdf.maxmem !== KDF.maxmem) return null; const salt = b64(r.kdf.salt, SALT_BYTES, SALT_BYTES), iv = b64(r.iv, IV_BYTES, IV_BYTES), tag = b64(r.tag, TAG_BYTES, TAG_BYTES), text = b64(r.ciphertext, KEY_BYTES, KEY_BYTES); if (!salt || !iv || !tag || !text) return null; let key: Buffer | null = null; try { key = await wrappingKey(passphrase, salt); const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(wrapperAad(userId, r.keyVersion)); decipher.setAuthTag(tag); const root = Buffer.concat([decipher.update(text), decipher.final()]); return root.length === KEY_BYTES ? root : null; } catch { return null; } finally { key?.fill(0); salt.fill(0); } }
  private async cache(userId: string, source: Buffer, keyVersion: number, operationEpoch: number): Promise<boolean> {
    if (this.operationEpoch(userId) !== operationEpoch) return false;
    this.lockDepth.set(userId, (this.lockDepth.get(userId) ?? 0) + 1);
    const previous = this.lockTails.get(userId) ?? Promise.resolve();
    let installed = false;
    const current = previous.catch(() => undefined).then(async () => {
      if (this.operationEpoch(userId) !== operationEpoch) return;
      const timer = this.timers.get(userId); if (timer) clearTimeout(timer); this.timers.delete(userId);
      const deadline = Date.now() + 1_000;
      while ([...this.children.values()].some(x => (x.inFlight.get(userId) ?? 0) > 0) && Date.now() < deadline) await new Promise<void>(r => setTimeout(r, 1));
      for (const [child, binding] of this.children) if ((binding.inFlight.get(userId) ?? 0) > 0) this.detachChild(child, binding, true);
      if (this.operationEpoch(userId) !== operationEpoch) return;
      const old = this.unlocked.get(userId); old?.key.fill(0);
      this.unlocked.set(userId, { key: Buffer.from(source), keyVersion, expiresAt: this.now() + this.ttlMs });
      this.generations.set(userId, this.generation(userId) + 1);
      for (const [child, binding] of this.children) if (this.hasActiveGrant(binding, userId)) child.send?.({ type: 'skytwin:vault:generation', userId, generation: this.generation(userId) });
      const nextTimer = setTimeout(() => { void this.lock(userId); }, this.ttlMs); nextTimer.unref?.(); this.timers.set(userId, nextTimer); installed = true;
    });
    this.lockTails.set(userId, current);
    try { await current; return installed; }
    finally {
      const depth = (this.lockDepth.get(userId) ?? 1) - 1; if (depth === 0) this.lockDepth.delete(userId); else this.lockDepth.set(userId, depth);
      if (this.lockTails.get(userId) === current) this.lockTails.delete(userId);
    }
  }
  private active(userId: string): Unlocked | null { const a = this.unlocked.get(userId); if (!a) return null; if (a.expiresAt <= this.now()) { void this.lock(userId); return null; } return a; }
  private generation(userId: string): number { return this.generations.get(userId) ?? 0; }
  private operationEpoch(userId: string): number { return this.operationEpochs.get(userId) ?? 0; }
  private genuineDeviceProtection(): boolean {
    try {
      if (!this.deviceProtection?.isEncryptionAvailable()) return false;
      if (process.platform !== 'linux') return true;
      const backend = this.deviceProtection.getSelectedStorageBackend?.();
      return !!backend && backend !== 'basic_text';
    } catch { return false; }
  }
}
