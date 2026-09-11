import type { WrappedKeyStore, WrappedUserKey } from './key-broker.js';

export interface SourceKeyRegistryRecord {
  user_id: string;
  key_version: number;
  wrapper_version: number;
  algorithm: 'aes-256-gcm';
  kdf_record: unknown;
  recovery_wrapper: unknown;
}

export interface SourceKeyRegistryPort {
  getCurrent(userId: string): Promise<SourceKeyRegistryRecord | null>;
  createInitial(input: SourceKeyRegistryRecord): Promise<boolean>;
  deleteVersion(userId: string, keyVersion: number): Promise<boolean>;
}

/** CockroachDB-backed recovery-wrapper store. Device wrappers stay local. */
export class CockroachWrappedKeyStore implements WrappedKeyStore {
  private portPromise: Promise<SourceKeyRegistryPort> | null = null;
  private rollbackVersions = new Map<string, number>();

  constructor(private readonly loadPort: () => Promise<SourceKeyRegistryPort>) {}

  async get(userId: string): Promise<WrappedUserKey | undefined> {
    const row = await (await this.port()).getCurrent(userId);
    if (!row || !this.isWrappedUserKey(row.recovery_wrapper)) return undefined;
    const wrapper = row.recovery_wrapper;
    if (wrapper.userId !== row.user_id || wrapper.keyVersion !== row.key_version || wrapper.wrapperVersion !== row.wrapper_version || wrapper.algorithm !== row.algorithm || !this.kdfMatches(row.kdf_record, wrapper.kdf)) return undefined;
    return wrapper;
  }

  async set(userId: string, value: WrappedUserKey): Promise<void> {
    if (value.userId !== userId) throw new Error('source-key owner mismatch');
    const created = await (await this.port()).createInitial({
      user_id: userId, key_version: value.keyVersion, wrapper_version: value.wrapperVersion,
      algorithm: value.algorithm, kdf_record: value.kdf, recovery_wrapper: value,
    });
    if (!created) throw new Error('source-key registry already initialized');
    this.rollbackVersions.set(userId, value.keyVersion);
  }

  commit(userId: string): void { this.rollbackVersions.delete(userId); }
  async rollbackPending(userId: string): Promise<void> { await this.retryRollback(userId); }

  async delete(userId: string): Promise<void> {
    const version = this.rollbackVersions.get(userId);
    if (version === undefined) return;
    const deleted = await (await this.port()).deleteVersion(userId, version);
    if (!deleted) throw new Error('source-key rollback was not confirmed');
    this.rollbackVersions.delete(userId);
  }

  private async retryRollback(userId: string): Promise<void> {
    const version = this.rollbackVersions.get(userId); if (version === undefined) return;
    const deleted = await (await this.port()).deleteVersion(userId, version);
    if (!deleted) throw new Error('source-key rollback was not confirmed');
    this.rollbackVersions.delete(userId);
  }

  private async port(): Promise<SourceKeyRegistryPort> {
    this.portPromise ??= this.loadPort();
    return this.portPromise;
  }

  private isWrappedUserKey(value: unknown): value is WrappedUserKey {
    if (!value || typeof value !== 'object') return false;
    const row = value as Partial<WrappedUserKey>;
    return row.magic === 'skytwin-user-key' && row.wrapperVersion === 1 && typeof row.userId === 'string' && Number.isSafeInteger(row.keyVersion) && row.algorithm === 'aes-256-gcm' && !!row.kdf && !!row.canary;
  }

  private kdfMatches(value: unknown, expected: WrappedUserKey['kdf']): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record['algorithm'] === expected.algorithm && record['N'] === expected.N && record['r'] === expected.r && record['p'] === expected.p && record['maxmem'] === expected.maxmem && record['salt'] === expected.salt;
  }
}
