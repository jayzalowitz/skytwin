import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OwnerDeletionFence,
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
    keys: () => [...map.keys()],
  };
}

/**
 * Fake safeStorage. The "encryption" is a reversible XOR so we can assert the
 * persisted value is NOT the plaintext, while still round-tripping cleanly.
 */
function makeSafeStorage(overrides: Partial<SafeStoragePort> = {}): SafeStoragePort {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
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
    it('fails closed until owner deletion state is available', () => {
      const fence = new OwnerDeletionFence();
      const vault = new PassphraseVault(makeSafeStorage(), store, 'linux', fence);
      expect(vault.remember(USER, PASSPHRASE))
        .toEqual({ ok: false, reason: 'owner_state_unavailable' });
      fence.open();
      expect(vault.remember(USER, PASSPHRASE)).toEqual({ ok: true });
    });

    it('preserves an unaffected owner record while deletion state is unavailable', () => {
      const fence = new OwnerDeletionFence(true);
      const vault = new PassphraseVault(makeSafeStorage(), store, 'linux', fence);
      expect(vault.remember(USER, PASSPHRASE)).toEqual({ ok: true });
      const seededRecord = store._map.get(`vault-passphrase:${USER}`);

      fence.close();
      expect(vault.remember(USER, 'replacement passphrase'))
        .toEqual({ ok: false, reason: 'owner_state_unavailable' });
      expect(vault.getRemembered(USER))
        .toEqual({ ok: false, reason: 'owner_state_unavailable' });
      expect(vault.has(USER)).toBe(false);
      expect(store._map.get(`vault-passphrase:${USER}`)).toBe(seededRecord);

      fence.open();
      expect(vault.getRemembered(USER)).toEqual({ ok: true, passphrase: PASSPHRASE });
    });

    it('rejects a write when its captured owner generation is revoked', () => {
      const fence = new OwnerDeletionFence(true);
      const safeStorage = makeSafeStorage({
        encryptString: plaintext => {
          fence.block(USER);
          return Buffer.from(plaintext);
        },
      });
      const vault = new PassphraseVault(safeStorage, store, 'linux', fence);
      expect(vault.remember(USER, PASSPHRASE))
        .toEqual({ ok: false, reason: 'owner_deleted' });
      expect(store._map.size).toBe(0);
    });

    it('persists encrypted ciphertext (never plaintext) and round-trips', () => {
      const vault = new PassphraseVault(makeSafeStorage(), store);

      const write = vault.remember(USER, PASSPHRASE);
      expect(write).toEqual({ ok: true });

      // The stored value must not contain the plaintext.
      const stored = [...store._map.values()][0];
      expect(stored).toBeDefined();
      expect(stored).not.toContain(PASSPHRASE);
      expect(JSON.parse(stored)).toMatchObject({
        version: 1,
        backend: process.platform === 'linux'
          ? 'linux:gnome_libsecret'
          : process.platform === 'win32'
            ? 'win32:dpapi'
            : 'darwin:keychain',
        ciphertext: expect.any(String),
      });

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

  describe('graceful fallback — secure storage unavailable', () => {
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

    it.each(['basic_text', 'unknown', 'future_unreviewed_backend'])(
      'rejects the Linux %s backend and stores nothing',
      (backend) => {
        const safeStorage = makeSafeStorage({
          getSelectedStorageBackend: () => backend,
        });
        const vault = new PassphraseVault(safeStorage, store, 'linux');

        expect(vault.isSupported()).toBe(false);
        expect(vault.remember(USER, PASSPHRASE)).toEqual({
          ok: false,
          reason: 'unsupported',
        });
        expect(store._map.size).toBe(0);
      },
    );

    it('rejects Linux storage when backend inspection throws', () => {
      const vault = new PassphraseVault(
        makeSafeStorage({
          getSelectedStorageBackend: () => { throw new Error('backend unavailable'); },
        }),
        store,
        'linux',
      );

      expect(vault.isSupported()).toBe(false);
      expect(vault.remember(USER, PASSPHRASE)).toEqual({
        ok: false,
        reason: 'unsupported',
      });
      expect(store._map.size).toBe(0);
    });

    it.each(['darwin', 'win32'] satisfies NodeJS.Platform[])(
      'uses native secure storage on %s without consulting the Linux backend',
      (platform) => {
        const getSelectedStorageBackend = () => {
          throw new Error('Linux-only inspection must not run');
        };
        const vault = new PassphraseVault(
          makeSafeStorage({ getSelectedStorageBackend }),
          store,
          platform,
        );

        expect(vault.isSupported()).toBe(true);
        expect(vault.remember(USER, PASSPHRASE)).toEqual({ ok: true });
      },
    );

    it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
      'accepts the reviewed Linux %s backend',
      (backend) => {
        const safeStorage = makeSafeStorage({
          getSelectedStorageBackend: () => backend,
        });
        const vault = new PassphraseVault(safeStorage, store, 'linux');

        expect(vault.isSupported()).toBe(true);
        expect(vault.remember(USER, PASSPHRASE)).toEqual({ ok: true });
        expect(JSON.parse(store._map.get(`vault-passphrase:${USER}`) ?? '{}')).toMatchObject({
          version: 1,
          backend: `linux:${backend}`,
        });
      },
    );

    it('rejects and deletes an unversioned legacy value under a currently secure backend', () => {
      const decryptString = vi.fn(() => PASSPHRASE);
      store._map.set(`vault-passphrase:${USER}`, Buffer.from(PASSPHRASE).toString('base64'));
      const vault = new PassphraseVault(makeSafeStorage({ decryptString }), store, 'linux');

      expect(vault.getRemembered(USER)).toEqual({ ok: false, reason: 'corrupt' });
      expect(decryptString).not.toHaveBeenCalled();
      expect(store._map.has(`vault-passphrase:${USER}`)).toBe(false);
    });

    it('eagerly purges legacy entries across users without touching unrelated keys', () => {
      const decryptString = vi.fn(() => PASSPHRASE);
      store._map.set('vault-passphrase:alice', Buffer.from('legacy-a').toString('base64'));
      store._map.set('vault-passphrase:bob', Buffer.from('legacy-b').toString('base64'));
      store._map.set('unrelated-setting', 'keep-me');
      const vault = new PassphraseVault(makeSafeStorage({ decryptString }), store, 'linux');

      expect(vault.purgeUntrustedEntries()).toBe(2);
      expect(decryptString).not.toHaveBeenCalled();
      expect([...store._map.entries()]).toEqual([['unrelated-setting', 'keep-me']]);
    });

    it('eagerly purges every remembered entry when the current backend is unsupported', () => {
      const secureVault = new PassphraseVault(
        makeSafeStorage({ getSelectedStorageBackend: () => 'kwallet6' }),
        store,
        'linux',
      );
      expect(secureVault.remember('alice', 'alice-pass-phrase')).toEqual({ ok: true });
      expect(secureVault.remember('bob', 'bob-pass-phrase-12')).toEqual({ ok: true });

      const unsupportedVault = new PassphraseVault(
        makeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }),
        store,
        'linux',
      );
      expect(unsupportedVault.purgeUntrustedEntries()).toBe(2);
      expect(store._map.size).toBe(0);
    });

    it('rejects and deletes a record written by a different secure backend without decrypting', () => {
      const kwalletVault = new PassphraseVault(
        makeSafeStorage({ getSelectedStorageBackend: () => 'kwallet6' }),
        store,
        'linux',
      );
      expect(kwalletVault.remember(USER, PASSPHRASE)).toEqual({ ok: true });

      const decryptString = vi.fn(() => PASSPHRASE);
      const libsecretVault = new PassphraseVault(
        makeSafeStorage({
          getSelectedStorageBackend: () => 'gnome_libsecret',
          decryptString,
        }),
        store,
        'linux',
      );
      expect(libsecretVault.getRemembered(USER)).toEqual({ ok: false, reason: 'corrupt' });
      expect(decryptString).not.toHaveBeenCalled();
      expect(store._map.size).toBe(0);
    });

    it('eagerly removes a secure-backend mismatch across users without decrypting', () => {
      const kwalletVault = new PassphraseVault(
        makeSafeStorage({ getSelectedStorageBackend: () => 'kwallet6' }),
        store,
        'linux',
      );
      expect(kwalletVault.remember('alice', 'alice-pass-phrase')).toEqual({ ok: true });
      expect(kwalletVault.remember('bob', 'bob-pass-phrase-12')).toEqual({ ok: true });

      const decryptString = vi.fn(() => PASSPHRASE);
      const libsecretVault = new PassphraseVault(
        makeSafeStorage({
          getSelectedStorageBackend: () => 'gnome_libsecret',
          decryptString,
        }),
        store,
        'linux',
      );
      expect(libsecretVault.purgeUntrustedEntries()).toBe(2);
      expect(decryptString).not.toHaveBeenCalled();
      expect(store._map.size).toBe(0);
    });

    it('removes a remembered entry on read when the Linux backend is no longer secure', () => {
      const secureVault = new PassphraseVault(
        makeSafeStorage({ getSelectedStorageBackend: () => 'kwallet6' }),
        store,
        'linux',
      );
      expect(secureVault.remember(USER, PASSPHRASE)).toEqual({ ok: true });
      expect(store._map.size).toBe(1);

      const fallbackVault = new PassphraseVault(
        makeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }),
        store,
        'linux',
      );
      expect(fallbackVault.getRemembered(USER)).toEqual({
        ok: false,
        reason: 'unsupported',
      });
      expect(store._map.size).toBe(0);
    });

    it('removes a remembered entry on existence checks when Linux storage becomes unsafe', () => {
      const secureVault = new PassphraseVault(
        makeSafeStorage({ getSelectedStorageBackend: () => 'kwallet6' }),
        store,
        'linux',
      );
      expect(secureVault.remember(USER, PASSPHRASE)).toEqual({ ok: true });

      const fallbackVault = new PassphraseVault(
        makeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }),
        store,
        'linux',
      );
      expect(fallbackVault.has(USER)).toBe(false);
      expect(store._map.size).toBe(0);
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
