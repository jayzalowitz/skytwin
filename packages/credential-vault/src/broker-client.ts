import { randomBytes } from 'crypto';

export type VaultBrokerRole = 'api' | 'worker';
export type VaultBrokerPurpose = 'oauth' | 'provider_credentials' | 'mcp_config' | 'federation' | 'oauth_transient' | 'connector_cursor' | 'dxt_database';
export type VaultBrokerFailure = 'vault_uninitialized' | 'vault_locked' | 'vault_broker_unavailable' | 'key_version_unavailable' | 'ciphertext_invalid' | 'grant_expired' | 'grant_revoked' | 'capability_mismatch';
export interface VaultBrokerContext { userId: string; purpose: VaultBrokerPurpose; table: string; column: string; rowId: string }
/** Exact API-session authority required for every user-originated secret operation. */
export interface VaultBrokerSessionAuthority { sessionId: string }
export interface VaultBrokerEnvelope { magic: 'skytwin-envelope'; version: 2; algorithm: 'aes-256-gcm'; ownerKind: 'user'; purpose: VaultBrokerPurpose; keyVersion: number; iv: string; tag: string; ciphertext: string }
export type VaultBrokerResult =
  | { success: true; state: 'locked' | 'unlocked' | 'uninitialized' }
  | { success: true; envelope: VaultBrokerEnvelope }
  | { success: true; plaintext: string }
  | { success: false; error: VaultBrokerFailure };
export type VaultBrokerControlFailure = 'vault_broker_unavailable' | 'grant_expired' | 'grant_revoked' | 'capability_mismatch';
export type VaultBrokerControlResult =
  | { success: true }
  | { success: false; error: VaultBrokerControlFailure };

interface SessionGrant {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface IpcProcess {
  connected?: boolean;
  send?: (message: unknown) => boolean;
  on(event: 'message' | 'disconnect', listener: (message?: unknown) => void): unknown;
  off(event: 'message' | 'disconnect', listener: (message?: unknown) => void): unknown;
}

interface Pending { userId: string; operation: 'control' | 'state' | 'encrypt' | 'decrypt'; context?: VaultBrokerContext; resolve: (value: VaultBrokerResult) => void; timer: ReturnType<typeof setTimeout> }

/**
 * Capability-authenticated client for the Electron-owned source-key broker.
 * It starts unavailable and never queues plaintext while IPC is absent.
 */
export class VaultBrokerClient {
  private capability: Buffer | null = null;
  private role: VaultBrokerRole | null = null;
  private generations = new Map<string, number>();
  private grantedOwners = new Set<string>();
  private sessionGrants = new Map<string, Map<string, SessionGrant>>();
  private ownerEpochs = new Map<string, number>();
  private sessionEpochs = new Map<string, number>();
  private pending = new Map<string, Pending>();
  private listening = false;
  private capabilityIssued = false;
  private readonly onMessage = (raw?: unknown): void => { this.handle(raw); };
  private readonly onDisconnect = (): void => { this.reset(); };

  constructor(private readonly ipc: IpcProcess = process, private readonly timeoutMs = 3_000) {
    if (typeof ipc.send === 'function') {
      ipc.on('message', this.onMessage);
      ipc.on('disconnect', this.onDisconnect);
      this.listening = true;
    }
  }

  close(): void {
    if (this.listening) {
      this.ipc.off('message', this.onMessage);
      this.ipc.off('disconnect', this.onDisconnect);
      this.listening = false;
    }
    this.reset();
  }

  isAvailable(): boolean { return this.capability !== null && this.ipc.connected !== false && typeof this.ipc.send === 'function'; }

  /** Called only after the API has authenticated and freshly revalidated this session. */
  async grantAuthenticatedSession(
    userId: string,
    sessionId: string,
    validUntil: Date,
  ): Promise<VaultBrokerControlResult> {
    if (
      !this.validUserId(userId)
      || !this.validId(sessionId)
      || !this.capability
      || this.role !== 'api'
    ) return { success: false, error: 'vault_broker_unavailable' };
    const expiresAt = validUntil.getTime();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      return { success: false, error: 'grant_expired' };
    }
    const ownerEpoch = this.ownerEpochs.get(userId) ?? 0;
    const sessionKey = this.sessionKey(userId, sessionId);
    const sessionEpoch = this.sessionEpochs.get(sessionKey) ?? 0;
    const requestId = randomBytes(16).toString('hex');
    const response = await this.exchange(requestId, userId, {
      type: 'skytwin:vault:grant', requestId, capability: this.capability.toString('base64'),
      role: 'api', userId, authentication: 'session', sessionId, expiresAt,
    }, 'control');
    if (!response.success) {
      if (response.error === 'capability_mismatch') this.reset();
      return { success: false, error: this.controlError(response.error) };
    }
    if (!('state' in response)) return { success: false, error: 'vault_broker_unavailable' };
    if (
      ownerEpoch !== (this.ownerEpochs.get(userId) ?? 0)
      || sessionEpoch !== (this.sessionEpochs.get(sessionKey) ?? 0)
    ) return { success: false, error: 'grant_revoked' };
    this.grantedOwners.add(userId);
    this.scheduleRevocation(userId, sessionId, expiresAt);
    return { success: true };
  }

  async revokeAuthenticatedSession(
    userId: string,
    sessionId: string,
    validUntil: Date,
  ): Promise<VaultBrokerControlResult> {
    const sessionKey = this.sessionKey(userId, sessionId);
    this.sessionEpochs.set(sessionKey, (this.sessionEpochs.get(sessionKey) ?? 0) + 1);
    this.removeSessionGrant(userId, sessionId);
    const expiresAt = validUntil.getTime();
    if (!this.capability || this.role !== 'api' || !this.validUserId(userId) || !this.validId(sessionId) || !Number.isSafeInteger(expiresAt)) {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    const requestId = randomBytes(16).toString('hex');
    const response = await this.exchange(requestId, userId, {
      type: 'skytwin:vault:revoke', requestId, capability: this.capability.toString('base64'),
      role: 'api', userId, authentication: 'session', sessionId, expiresAt,
    }, 'control');
    if (!response.success) {
      if (response.error === 'capability_mismatch') this.reset();
      return { success: false, error: this.controlError(response.error) };
    }
    return 'state' in response
      ? { success: true }
      : { success: false, error: 'vault_broker_unavailable' };
  }

  /**
   * Permanently fence an owner in the current desktop-broker lifetime after
   * the authoritative user purge has committed. The parent clears every child
   * grant, drains in-flight work, drops the root key, and removes its device
   * wrapper before acknowledging.
   */
  async purgeOwner(userId: string): Promise<VaultBrokerControlResult> {
    this.ownerEpochs.set(userId, (this.ownerEpochs.get(userId) ?? 0) + 1);
    this.removeAllSessionGrants(userId);
    if (!this.validUserId(userId)) {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    // Absence of a capability cannot prove that this machine has no native
    // wrapper or remembered passphrase. The database purge is committed, but
    // callers must report native cleanup as pending until Electron acknowledges.
    if (!this.capability && !this.capabilityIssued) {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    if (!this.capability || this.role !== 'api') {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    const requestId = randomBytes(16).toString('hex');
    const response = await this.exchange(requestId, userId, {
      type: 'skytwin:vault:purge-owner', requestId,
      capability: this.capability.toString('base64'),
      role: 'api', authentication: 'session', userId,
    }, 'control');
    if (!response.success) {
      if (response.error === 'capability_mismatch') this.reset();
      return { success: false, error: this.controlError(response.error) };
    }
    return 'state' in response
      ? { success: true }
      : { success: false, error: 'vault_broker_unavailable' };
  }

  async reconcileAuthenticatedOwners(userIds: Iterable<string>): Promise<VaultBrokerControlResult> {
    const desired = new Set(userIds);
    if (this.role !== 'worker' || !this.capability || [...desired].some(id => !this.validUserId(id))) {
      this.clearAuthority();
      return { success: false, error: 'vault_broker_unavailable' };
    }
    const requestId = randomBytes(16).toString('hex');
    const response = await this.exchange(requestId, 'worker-set', { type: 'skytwin:vault:reconcile', requestId, capability: this.capability.toString('base64'), role: 'worker', authentication: 'service', userIds: [...desired] }, 'control');
    if (!response.success || !('state' in response)) {
      this.clearAuthority();
      if (!response.success && response.error === 'capability_mismatch') this.reset();
      return {
        success: false,
        error: !response.success ? this.controlError(response.error) : 'vault_broker_unavailable',
      };
    }
    this.grantedOwners = desired;
    return { success: true };
  }

  async state(context: VaultBrokerContext, authority?: VaultBrokerSessionAuthority): Promise<VaultBrokerResult> { return this.request('state', context, {}, authority); }
  async encrypt(context: VaultBrokerContext, plaintext: string, authority?: VaultBrokerSessionAuthority): Promise<VaultBrokerResult> { return this.request('encrypt', context, { plaintext }, authority); }
  async decrypt(context: VaultBrokerContext, envelope: VaultBrokerEnvelope, authority?: VaultBrokerSessionAuthority): Promise<VaultBrokerResult> { return this.request('decrypt', context, { envelope }, authority); }

  private async request(
    operation: 'encrypt' | 'decrypt' | 'state',
    context: VaultBrokerContext,
    extra: { plaintext?: string; envelope?: VaultBrokerEnvelope } = {},
    authority?: VaultBrokerSessionAuthority,
  ): Promise<VaultBrokerResult> {
    if (!this.capability || !this.grantedOwners.has(context.userId)) return { success: false, error: 'vault_broker_unavailable' };
    let requestAuthority: { role: 'api'; authentication: 'session'; sessionId: string }
      | { role: 'worker'; authentication: 'service' };
    if (this.role === 'api') {
      if (!authority || !this.validId(authority.sessionId)) {
        return { success: false, error: 'vault_broker_unavailable' };
      }
      const grant = this.sessionGrants.get(context.userId)?.get(authority.sessionId);
      if (!grant || grant.expiresAt <= Date.now()) {
        this.removeSessionGrant(context.userId, authority.sessionId);
        return { success: false, error: 'vault_broker_unavailable' };
      }
      requestAuthority = {
        role: 'api', authentication: 'session', sessionId: authority.sessionId,
      };
    } else if (this.role === 'worker') {
      requestAuthority = { role: 'worker', authentication: 'service' };
    } else {
      return { success: false, error: 'vault_broker_unavailable' };
    }
    const requestId = randomBytes(16).toString('hex');
    return this.exchange(requestId, context.userId, {
      type: 'skytwin:vault:request', requestId, capability: this.capability.toString('base64'),
      generation: this.generations.get(context.userId) ?? 0, operation, context,
      ...requestAuthority, ...extra,
    }, operation, context);
  }

  private exchange(requestId: string, userId: string, message: unknown, operation: Pending['operation'], context?: VaultBrokerContext): Promise<VaultBrokerResult> {
    if (!this.isAvailable()) return Promise.resolve({ success: false, error: 'vault_broker_unavailable' });
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve({ success: false, error: 'vault_broker_unavailable' }); }, this.timeoutMs);
      this.pending.set(requestId, { userId, operation, context, resolve, timer });
      try { if (this.ipc.send?.(message) === false) throw new Error('IPC send rejected'); }
      catch { clearTimeout(timer); this.pending.delete(requestId); resolve({ success: false, error: 'vault_broker_unavailable' }); }
    });
  }

  private handle(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as Record<string, unknown>;
    if (message['type'] === 'skytwin:vault:capability' && typeof message['capability'] === 'string' && (message['role'] === 'api' || message['role'] === 'worker')) {
      const decoded = Buffer.from(message['capability'], 'base64');
      if (decoded.length !== 32 || decoded.toString('base64') !== message['capability']) { decoded.fill(0); return; }
      this.reset(); this.capability = decoded; this.role = message['role']; this.capabilityIssued = true;
      return;
    }
    if (message['type'] === 'skytwin:vault:lock' && typeof message['userId'] === 'string' && Number.isSafeInteger(message['generation']) && this.capability) {
      const userId = message['userId']; this.generations.set(userId, message['generation'] as number);
      for (const [id, pending] of this.pending) {
        if (pending.userId !== userId || pending.operation === 'control') continue;
        clearTimeout(pending.timer); pending.resolve({ success: false, error: 'vault_locked' }); this.pending.delete(id);
      }
      this.ipc.send?.({ type: 'skytwin:vault:lock-ack', lockId: message['lockId'], userId, generation: message['generation'], capability: this.capability.toString('base64') });
      return;
    }
    if (message['type'] === 'skytwin:vault:generation' && typeof message['userId'] === 'string' && Number.isSafeInteger(message['generation']) && this.capability) {
      this.generations.set(message['userId'], message['generation'] as number); return;
    }
    if (message['type'] !== 'skytwin:vault:response' || typeof message['requestId'] !== 'string') return;
    const pending = this.pending.get(message['requestId']); if (!pending) return;
    if (message['contextUserId'] !== pending.userId || !Number.isSafeInteger(message['generation'])) return;
    clearTimeout(pending.timer); this.pending.delete(message['requestId']);
    this.generations.set(pending.userId, message['generation'] as number);
    pending.resolve(this.validResult(message['result'], pending) ? message['result'] : { success: false, error: 'vault_broker_unavailable' });
  }

  private reset(): void {
    this.capability?.fill(0); this.capability = null; this.role = null;
    this.clearAuthority();
  }

  private clearAuthority(): void {
    this.generations.clear(); this.grantedOwners.clear();
    for (const grants of this.sessionGrants.values()) {
      for (const grant of grants.values()) clearTimeout(grant.timer);
    }
    this.sessionGrants.clear();
    this.ownerEpochs.clear(); this.sessionEpochs.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve({ success: false, error: 'vault_broker_unavailable' }); }
    this.pending.clear();
  }

  private validUserId(value: string): boolean { return value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value); }
  private validId(value: string): boolean { return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(value); }
  private controlError(error: VaultBrokerFailure): VaultBrokerControlFailure {
    return ['grant_expired', 'grant_revoked', 'capability_mismatch'].includes(error)
      ? error as 'grant_expired' | 'grant_revoked' | 'capability_mismatch'
      : 'vault_broker_unavailable';
  }
  private validResult(value: unknown, pending: Pending): value is VaultBrokerResult {
    if (!value || typeof value !== 'object') return false;
    const result = value as Record<string, unknown>;
    if (result['success'] === false) return Object.keys(result).every(k => k === 'success' || k === 'error') && ['vault_uninitialized', 'vault_locked', 'vault_broker_unavailable', 'key_version_unavailable', 'ciphertext_invalid', 'grant_expired', 'grant_revoked', 'capability_mismatch'].includes(String(result['error']));
    if (result['success'] !== true) return false;
    if (['locked', 'unlocked', 'uninitialized'].includes(String(result['state']))) return (pending.operation === 'state' || pending.operation === 'control') && Object.keys(result).every(k => k === 'success' || k === 'state');
    if (typeof result['plaintext'] === 'string') return pending.operation === 'decrypt' && Object.keys(result).every(k => k === 'success' || k === 'plaintext');
    const envelope = result['envelope']; if (!envelope || typeof envelope !== 'object' || !Object.keys(result).every(k => k === 'success' || k === 'envelope')) return false;
    const e = envelope as Record<string, unknown>;
    return pending.operation === 'encrypt' && !!pending.context && e['magic'] === 'skytwin-envelope' && e['version'] === 2 && e['algorithm'] === 'aes-256-gcm' && e['ownerKind'] === 'user' && e['purpose'] === pending.context.purpose && Number.isSafeInteger(e['keyVersion']) && Number(e['keyVersion']) > 0 && this.validBase64(e['iv'], 12) && this.validBase64(e['tag'], 16) && this.validBase64(e['ciphertext']);
  }
  private validBase64(value: unknown, exact?: number): boolean { if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false; const decoded = Buffer.from(value, 'base64'); return decoded.toString('base64') === value && (exact === undefined || decoded.length === exact); }
  private scheduleRevocation(userId: string, sessionId: string, deadline: number): void {
    let grants = this.sessionGrants.get(userId);
    if (!grants) {
      grants = new Map();
      this.sessionGrants.set(userId, grants);
    }
    const prior = grants.get(sessionId);
    if (prior && prior.expiresAt >= deadline) return;
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      this.removeSessionGrant(userId, sessionId);
      void this.revokeAuthenticatedSession(userId, sessionId, new Date(deadline));
    }, Math.max(0, deadline - Date.now())); timer.unref?.();
    grants.set(sessionId, { expiresAt: deadline, timer });
    this.grantedOwners.add(userId);
  }

  private removeSessionGrant(userId: string, sessionId: string): void {
    const grants = this.sessionGrants.get(userId);
    const grant = grants?.get(sessionId);
    if (grant) clearTimeout(grant.timer);
    grants?.delete(sessionId);
    if (grants && grants.size > 0) return;
    this.sessionGrants.delete(userId);
    this.grantedOwners.delete(userId);
  }

  private removeAllSessionGrants(userId: string): void {
    const grants = this.sessionGrants.get(userId);
    if (grants) {
      for (const grant of grants.values()) clearTimeout(grant.timer);
    }
    this.sessionGrants.delete(userId);
    this.grantedOwners.delete(userId);
  }

  private sessionKey(userId: string, sessionId: string): string {
    return `${userId}\u0000${sessionId}`;
  }
}
