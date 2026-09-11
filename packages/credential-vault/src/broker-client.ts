import { randomBytes } from 'crypto';

export type VaultBrokerRole = 'api' | 'worker';
export type VaultBrokerPurpose = 'oauth' | 'provider_credentials' | 'mcp_config' | 'federation' | 'oauth_transient' | 'connector_cursor' | 'dxt_database';
export type VaultBrokerFailure = 'vault_uninitialized' | 'vault_locked' | 'vault_broker_unavailable' | 'key_version_unavailable' | 'ciphertext_invalid';
export interface VaultBrokerContext { userId: string; purpose: VaultBrokerPurpose; table: string; column: string; rowId: string }
export interface VaultBrokerEnvelope { magic: 'skytwin-envelope'; version: 2; algorithm: 'aes-256-gcm'; ownerKind: 'user'; purpose: VaultBrokerPurpose; keyVersion: number; iv: string; tag: string; ciphertext: string }
export type VaultBrokerResult =
  | { success: true; state: 'locked' | 'unlocked' | 'uninitialized' }
  | { success: true; envelope: VaultBrokerEnvelope }
  | { success: true; plaintext: string }
  | { success: false; error: VaultBrokerFailure };

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
  private grantTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private grantDeadlines = new Map<string, number>();
  private pending = new Map<string, Pending>();
  private listening = false;
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

  /** Called only after the host process has authenticated this owner. */
  async grantAuthenticatedOwner(userId: string, validUntil?: Date): Promise<boolean> {
    if (!this.validUserId(userId) || !this.capability || !this.role) return false;
    if (this.grantedOwners.has(userId) && this.role === 'worker') return true;
    const requestedExpiry = validUntil?.getTime();
    const expiresAt = this.role === 'api' ? Math.max(this.grantDeadlines.get(userId) ?? 0, requestedExpiry ?? 0) : null;
    if (this.role === 'api' && (!Number.isSafeInteger(expiresAt) || Number(expiresAt) <= Date.now())) return false;
    const requestId = randomBytes(16).toString('hex');
    const response = await this.exchange(requestId, userId, {
      type: 'skytwin:vault:grant', requestId, capability: this.capability.toString('base64'),
      role: this.role, userId, authentication: this.role === 'api' ? 'session' : 'service', expiresAt,
    }, 'control');
    if (!response.success || !('state' in response)) { this.reset(); return false; }
    this.grantedOwners.add(userId);
    this.scheduleRevocation(userId, expiresAt === null ? undefined : new Date(expiresAt));
    return true;
  }

  async revokeAuthenticatedOwner(userId: string): Promise<boolean> {
    const timer = this.grantTimers.get(userId); if (timer) clearTimeout(timer); this.grantTimers.delete(userId);
    this.grantedOwners.delete(userId);
    if (!this.capability || !this.role || !this.validUserId(userId)) return false;
    const requestId = randomBytes(16).toString('hex');
    const response = await this.exchange(requestId, userId, { type: 'skytwin:vault:revoke', requestId, capability: this.capability.toString('base64'), role: this.role, userId, authentication: this.role === 'api' ? 'session' : 'service' }, 'control');
    const success = response.success && 'state' in response;
    if (!success) this.reset();
    return success;
  }

  async reconcileAuthenticatedOwners(userIds: Iterable<string>): Promise<void> {
    const desired = new Set(userIds);
    if (this.role !== 'worker' || !this.capability || [...desired].some(id => !this.validUserId(id))) { this.reset(); throw new Error('vault owner reconciliation unavailable'); }
    const requestId = randomBytes(16).toString('hex');
    const response = await this.exchange(requestId, 'worker-set', { type: 'skytwin:vault:reconcile', requestId, capability: this.capability.toString('base64'), role: 'worker', authentication: 'service', userIds: [...desired] }, 'control');
    if (!response.success || !('state' in response)) { this.reset(); throw new Error('vault owner reconciliation failed'); }
    this.grantedOwners = desired;
  }

  async state(context: VaultBrokerContext): Promise<VaultBrokerResult> { return this.request('state', context); }
  async encrypt(context: VaultBrokerContext, plaintext: string): Promise<VaultBrokerResult> { return this.request('encrypt', context, { plaintext }); }
  async decrypt(context: VaultBrokerContext, envelope: VaultBrokerEnvelope): Promise<VaultBrokerResult> { return this.request('decrypt', context, { envelope }); }

  private async request(operation: 'encrypt' | 'decrypt' | 'state', context: VaultBrokerContext, extra: { plaintext?: string; envelope?: VaultBrokerEnvelope } = {}): Promise<VaultBrokerResult> {
    if (!this.capability || !this.grantedOwners.has(context.userId)) return { success: false, error: 'vault_broker_unavailable' };
    const requestId = randomBytes(16).toString('hex');
    return this.exchange(requestId, context.userId, {
      type: 'skytwin:vault:request', requestId, capability: this.capability.toString('base64'),
      generation: this.generations.get(context.userId) ?? 0, operation, context, ...extra,
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
      this.reset(); this.capability = decoded; this.role = message['role'];
      return;
    }
    if (message['type'] === 'skytwin:vault:lock' && typeof message['userId'] === 'string' && Number.isSafeInteger(message['generation']) && this.capability) {
      const userId = message['userId']; this.generations.set(userId, message['generation'] as number);
      for (const [id, pending] of this.pending) {
        if (pending.userId !== userId) continue;
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
    this.capability?.fill(0); this.capability = null; this.role = null; this.generations.clear(); this.grantedOwners.clear();
    for (const timer of this.grantTimers.values()) clearTimeout(timer); this.grantTimers.clear(); this.grantDeadlines.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve({ success: false, error: 'vault_broker_unavailable' }); }
    this.pending.clear();
  }

  private validUserId(value: string): boolean { return value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value); }
  private validResult(value: unknown, pending: Pending): value is VaultBrokerResult {
    if (!value || typeof value !== 'object') return false;
    const result = value as Record<string, unknown>;
    if (result['success'] === false) return Object.keys(result).every(k => k === 'success' || k === 'error') && ['vault_uninitialized', 'vault_locked', 'vault_broker_unavailable', 'key_version_unavailable', 'ciphertext_invalid'].includes(String(result['error']));
    if (result['success'] !== true) return false;
    if (['locked', 'unlocked', 'uninitialized'].includes(String(result['state']))) return (pending.operation === 'state' || pending.operation === 'control') && Object.keys(result).every(k => k === 'success' || k === 'state');
    if (typeof result['plaintext'] === 'string') return pending.operation === 'decrypt' && Object.keys(result).every(k => k === 'success' || k === 'plaintext');
    const envelope = result['envelope']; if (!envelope || typeof envelope !== 'object' || !Object.keys(result).every(k => k === 'success' || k === 'envelope')) return false;
    const e = envelope as Record<string, unknown>;
    return pending.operation === 'encrypt' && !!pending.context && e['magic'] === 'skytwin-envelope' && e['version'] === 2 && e['algorithm'] === 'aes-256-gcm' && e['ownerKind'] === 'user' && e['purpose'] === pending.context.purpose && Number.isSafeInteger(e['keyVersion']) && Number(e['keyVersion']) > 0 && this.validBase64(e['iv'], 12) && this.validBase64(e['tag'], 16) && this.validBase64(e['ciphertext']);
  }
  private validBase64(value: unknown, exact?: number): boolean { if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false; const decoded = Buffer.from(value, 'base64'); return decoded.toString('base64') === value && (exact === undefined || decoded.length === exact); }
  private scheduleRevocation(userId: string, validUntil?: Date): void {
    if (!validUntil) return;
    const deadline = validUntil.getTime(); if ((this.grantDeadlines.get(userId) ?? 0) >= deadline) return;
    this.grantDeadlines.set(userId, deadline);
    const prior = this.grantTimers.get(userId); if (prior) clearTimeout(prior);
    const timer = setTimeout(() => { this.grantDeadlines.delete(userId); void this.revokeAuthenticatedOwner(userId); }, Math.max(0, deadline - Date.now())); timer.unref?.(); this.grantTimers.set(userId, timer);
  }
}
