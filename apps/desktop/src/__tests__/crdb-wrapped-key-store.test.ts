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
  async deleteInitialIfMatch(input: SourceKeyRegistryRecord): Promise<boolean> {
    if (JSON.stringify(this.row) !== JSON.stringify(input)) return false;
    this.row = null;
    return true;
  }
}

describe('CockroachWrappedKeyStore', () => {
  it('round-trips the complete recovery wrapper through the registry', async () => {
    const registry = new Registry(), store = new CockroachWrappedKeyStore(async () => registry);
    expect(await store.create(wrapper.userId, wrapper)).toBe(true);
    expect(await store.get(wrapper.userId)).toEqual(wrapper);
    expect(await store.deleteIfMatch(wrapper.userId, wrapper)).toBe(true);
    expect(await store.get(wrapper.userId)).toBeUndefined();
  });

  it('rejects owner conflicts and corrupt registry metadata', async () => {
    const registry = new Registry(), store = new CockroachWrappedKeyStore(async () => registry);
    await expect(store.create('user-0002', wrapper)).rejects.toThrow('owner mismatch');
    registry.row = { user_id: wrapper.userId, key_version: 2, wrapper_version: 1, algorithm: 'aes-256-gcm', kdf_record: wrapper.kdf, recovery_wrapper: wrapper };
    expect(await store.get(wrapper.userId)).toBeUndefined();
  });

  it('does not delete a pre-existing registry row after a create collision', async () => {
    const registry = new Registry(); registry.row = { user_id: wrapper.userId, key_version: 1, wrapper_version: 1, algorithm: 'aes-256-gcm', kdf_record: wrapper.kdf, recovery_wrapper: wrapper };
    const store = new CockroachWrappedKeyStore(async () => registry);
    expect(await store.create(wrapper.userId, wrapper)).toBe(false);
    expect(await store.deleteIfMatch(wrapper.userId, { ...wrapper, iv: 'different' })).toBe(false);
    expect(registry.row).not.toBeNull();
  });

  it('does not report cleanup unless the exact wrapper was deleted', async () => {
    const registry = new Registry(), store = new CockroachWrappedKeyStore(async () => registry);
    expect(await store.create(wrapper.userId, wrapper)).toBe(true);
    registry.deleteInitialIfMatch = async () => false;
    expect(await store.deleteIfMatch(wrapper.userId, wrapper)).toBe(false);
    expect(registry.row).not.toBeNull();
  });
});
