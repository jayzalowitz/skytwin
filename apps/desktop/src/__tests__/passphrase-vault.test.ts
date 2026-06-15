import { describe, it, expect, beforeEach } from 'vitest';
import {
  PassphraseVault,
  type PassphraseKeyValueStore,
  type SafeStoragePort,
} from '../passphrase-vault.js';

/** In-memory key-value store standing in for electron-store. */
function makeStore(): PassphraseKeyValueStore & { _map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    _map: map,
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); },
    delete: (key) => { map.delete(key); },
  };
}

/**
 * Fake safeStorage. The "encryption" is a reversible XOR so we can assert the
 * persisted value is NOT the plaintext, while still round-tripping cleanly.
 */
function makeSafeStorage(overrides: Partial<SafeStoragePort> = {}): SafeStoragePort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => {
      const buf = Buffer.from(plaintext, 'utf8');
      return Buffer.from(buf.map((b) => b ^ 0x5a));
    },
    decryptString: (ciphertext: Buffer) =>
      Buffer.from(ciphertext.map((b) => b ^ 0x5a)).toString('utf8'),
    ...overrides,
  };
}

const USER = 'user-123';
const PASSPHRASE = 'correct horse battery';

describe('PassphraseVault', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  describe('happy path — remember + retrieve', () => {
    it('persists encrypted ciphertext (never plaintext) and round-trips', () => {
      const vault = new PassphraseVault(makeSafeStorage(), store);

      const write = vault.remember(USER, PASSPHRASE);
      expect(write).toEqual({ ok: true });

      // The stored value must not contain the plaintext.
      const stored = [...store._map.values()][0];
      expect(stored).toBeDefined();
      expect(stored).not.toContain(PASSPHRASE);

      const read = vault.getRemembered(USER);
      expect(read).toEqual({ ok: true, passphrase: PASSPHRASE });
    });

    it('reports has() correctly without decrypting', () => {
      const vault = new PassphraseVault(makeSafeStorage(), store);
      expect(vault.has(USER)).toBe(false);
      vault.remember(USER, PASSPHRASE);
      expect(vault.has(USER)).toBe(true);
    });

    it('keys per-user — one user does not clobber another', () => {
      const vault = new PassphraseVault(makeSafeStorage(), store);
      vault.remember('alice', 'alice-pass-phrase');
      vault.remember('bob', 'bob-pass-phrase-12');
      expect(vault.getRemembered('alice')).toEqual({ ok: true, passphrase: 'alice-pass-phrase' });
      expect(vault.getRemembered('bob')).toEqual({ ok: true, passphrase: 'bob-pass-phrase-12' });
    });

    it('forget removes the entry and is idempotent', () => {
      const vault = new PassphraseVault(makeSafeStorage(), store);
      vault.remember(USER, PASSPHRASE);
      expect(vault.has(USER)).toBe(true);
      vault.forget(USER);
      expect(vault.has(USER)).toBe(false);
      expect(vault.getRemembered(USER)).toEqual({ ok: false, reason: 'not_found' });
      // second forget does not throw
      expect(() => vault.forget(USER)).not.toThrow();
    });

    it('remember overwrites a previous passphrase', () => {
      const vault = new PassphraseVault(makeSafeStorage(), store);
      vault.remember(USER, 'first-passphrase-x');
      vault.remember(USER, 'second-passphrase-y');
      expect(vault.getRemembered(USER)).toEqual({ ok: true, passphrase: 'second-passphrase-y' });
    });
  });

  describe('graceful fallback — OS keychain unavailable', () => {
    it('remember returns unsupported and stores nothing', () => {
      const safeStorage = makeSafeStorage({ isEncryptionAvailable: () => false });
      const vault = new PassphraseVault(safeStorage, store);

      const result = vault.remember(USER, PASSPHRASE);
      expect(result).toEqual({ ok: false, reason: 'unsupported' });
      expect(store._map.size).toBe(0);
    });

    it('getRemembered returns unsupported', () => {
      const safeStorage = makeSafeStorage({ isEncryptionAvailable: () => false });
      const vault = new PassphraseVault(safeStorage, store);
      expect(vault.getRemembered(USER)).toEqual({ ok: false, reason: 'unsupported' });
    });

    it('isSupported is false when isEncryptionAvailable throws (fail safe)', () => {
      const safeStorage = makeSafeStorage({
        isEncryptionAvailable: () => { throw new Error('no backend'); },
      });
      const vault = new PassphraseVault(safeStorage, store);
      expect(vault.isSupported()).toBe(false);
      expect(vault.remember(USER, PASSPHRASE)).toEqual({ ok: false, reason: 'unsupported' });
    });
  });

  describe('edge cases', () => {
    it('refuses to remember an empty passphrase', () => {
      const vault = new PassphraseVault(makeSafeStorage(), store);
      expect(vault.remember(USER, '')).toEqual({ ok: false, reason: 'empty_passphrase' });
      expect(store._map.size).toBe(0);
    });

    it('returns not_found when nothing is stored', () => {
      const vault = new PassphraseVault(makeSafeStorage(), store);
      expect(vault.getRemembered(USER)).toEqual({ ok: false, reason: 'not_found' });
    });

    it('treats an undecryptable entry as corrupt and evicts it', () => {
      // Store a value, then swap in a safeStorage whose decrypt throws — as if
      // the store was copied to a different machine / account.
      const goodVault = new PassphraseVault(makeSafeStorage(), store);
      goodVault.remember(USER, PASSPHRASE);
      expect(store._map.size).toBe(1);

      const brokenSafeStorage = makeSafeStorage({
        decryptString: () => { throw new Error('decrypt failed: wrong machine'); },
      });
      const vault = new PassphraseVault(brokenSafeStorage, store);
      const read = vault.getRemembered(USER);
      expect(read).toEqual({ ok: false, reason: 'corrupt' });
      // The bad entry was evicted so we stop retrying.
      expect(store._map.size).toBe(0);
    });

    it('treats a decrypt-to-empty result as corrupt and evicts it', () => {
      const goodVault = new PassphraseVault(makeSafeStorage(), store);
      goodVault.remember(USER, PASSPHRASE);

      const emptySafeStorage = makeSafeStorage({ decryptString: () => '' });
      const vault = new PassphraseVault(emptySafeStorage, store);
      expect(vault.getRemembered(USER)).toEqual({ ok: false, reason: 'corrupt' });
      expect(store._map.size).toBe(0);
    });
  });
});
