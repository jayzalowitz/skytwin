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
  deleteInitialIfMatch(input: SourceKeyRegistryRecord): Promise<boolean>;
  listPendingDeletions(): Promise<string[]>;
  completeDeletion(userId: string): Promise<void>;
}

/** CockroachDB-backed recovery-wrapper store. Device wrappers stay local. */
export class CockroachWrappedKeyStore implements WrappedKeyStore {
  private portPromise: Promise<SourceKeyRegistryPort> | null = null;

  constructor(private readonly loadPort: () => Promise<SourceKeyRegistryPort>) {}

  async get(userId: string): Promise<WrappedUserKey | undefined> {
    const row = await (await this.port()).getCurrent(userId);
    if (!row) return undefined;
    if (!this.isWrappedUserKey(row.recovery_wrapper)) {
      throw new Error('source-key registry wrapper is invalid');
    }
    const wrapper = row.recovery_wrapper;
    if (wrapper.userId !== row.user_id || wrapper.keyVersion !== row.key_version || wrapper.wrapperVersion !== row.wrapper_version || wrapper.algorithm !== row.algorithm || !this.kdfMatches(row.kdf_record, wrapper.kdf)) {
      throw new Error('source-key registry metadata mismatch');
    }
    return wrapper;
  }

  async create(userId: string, value: WrappedUserKey): Promise<boolean> {
    if (value.userId !== userId) throw new Error('source-key owner mismatch');
    return await (await this.port()).createInitial({
      user_id: userId, key_version: value.keyVersion, wrapper_version: value.wrapperVersion,
      algorithm: value.algorithm, kdf_record: value.kdf, recovery_wrapper: value,
    });
  }

  async deleteIfMatch(userId: string, value: WrappedUserKey): Promise<boolean> {
    if (value.userId !== userId) return false;
    return await (await this.port()).deleteInitialIfMatch({
      user_id: userId, key_version: value.keyVersion, wrapper_version: value.wrapperVersion,
      algorithm: value.algorithm, kdf_record: value.kdf, recovery_wrapper: value,
    });
  }

  async listPendingDeletions(): Promise<string[]> {
    return await (await this.port()).listPendingDeletions();
  }

  async completeDeletion(userId: string): Promise<void> {
    await (await this.port()).completeDeletion(userId);
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
