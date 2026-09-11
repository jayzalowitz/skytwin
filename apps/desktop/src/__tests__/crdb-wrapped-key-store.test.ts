import { describe, expect, it } from 'vitest';
import { CockroachWrappedKeyStore, type SourceKeyRegistryPort, type SourceKeyRegistryRecord } from '../crdb-wrapped-key-store.js';
import type { WrappedUserKey } from '../key-broker.js';

const wrapper: WrappedUserKey = {
  magic: 'skytwin-user-key', wrapperVersion: 1, userId: 'user-0001', keyVersion: 1, algorithm: 'aes-256-gcm',
  kdf: { algorithm: 'scrypt', N: 32768, r: 8, p: 1, maxmem: 134217728, salt: 'AA==' },
  iv: 'AA==', tag: 'AA==', ciphertext: 'AA==',
  canary: { magic: 'skytwin-envelope', version: 2, algorithm: 'aes-256-gcm', ownerKind: 'user', purpose: 'oauth', keyVersion: 1, iv: 'AA==', tag: 'AA==', ciphertext: 'AA==' },
};

class Registry implements SourceKeyRegistryPort {
  row: SourceKeyRegistryRecord | null = null;
  async getCurrent(): Promise<SourceKeyRegistryRecord | null> { return this.row; }
  async createInitial(input: SourceKeyRegistryRecord): Promise<boolean> { if (this.row) return false; this.row = structuredClone(input); return true; }
  async deleteVersion(userId: string, keyVersion: number): Promise<boolean> { if (this.row?.user_id !== userId || this.row.key_version !== keyVersion) return false; this.row = null; return true; }
}

describe('CockroachWrappedKeyStore', () => {
  it('round-trips the complete recovery wrapper through the registry', async () => {
    const registry = new Registry(), store = new CockroachWrappedKeyStore(async () => registry);
    await store.set(wrapper.userId, wrapper);
    expect(await store.get(wrapper.userId)).toEqual(wrapper);
    await store.delete(wrapper.userId);
    expect(await store.get(wrapper.userId)).toBeUndefined();
  });

  it('rejects owner conflicts and corrupt registry metadata', async () => {
    const registry = new Registry(), store = new CockroachWrappedKeyStore(async () => registry);
    await expect(store.set('user-0002', wrapper)).rejects.toThrow('owner mismatch');
    registry.row = { user_id: wrapper.userId, key_version: 2, wrapper_version: 1, algorithm: 'aes-256-gcm', kdf_record: wrapper.kdf, recovery_wrapper: wrapper };
    expect(await store.get(wrapper.userId)).toBeUndefined();
  });

  it('does not delete a pre-existing registry row after a create collision', async () => {
    const registry = new Registry(); registry.row = { user_id: wrapper.userId, key_version: 1, wrapper_version: 1, algorithm: 'aes-256-gcm', kdf_record: wrapper.kdf, recovery_wrapper: wrapper };
    const store = new CockroachWrappedKeyStore(async () => registry);
    await expect(store.set(wrapper.userId, wrapper)).rejects.toThrow('already initialized');
    await store.delete(wrapper.userId);
    expect(registry.row).not.toBeNull();
  });

  it('retains a failed rollback marker and retries cleanup before initialization', async () => {
    const registry = new Registry(), store = new CockroachWrappedKeyStore(async () => registry);
    await store.set(wrapper.userId, wrapper);
    const original = registry.deleteVersion.bind(registry); let attempts = 0;
    registry.deleteVersion = async (userId, version) => ++attempts === 1 ? false : original(userId, version);
    await expect(store.delete(wrapper.userId)).rejects.toThrow('not confirmed');
    await store.rollbackPending(wrapper.userId);
    expect(attempts).toBe(2); expect(registry.row).toBeNull();
  });
});
