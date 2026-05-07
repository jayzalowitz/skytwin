import { describe, it, expect } from 'vitest';
import {
  deriveKey,
  generateSalt,
  hashDerivedKey,
  verifyPassphrase,
  SALT_LENGTH,
  MIN_PASSPHRASE_LENGTH,
} from '../key-derivation.js';

describe('generateSalt', () => {
  it(`returns a Buffer of ${SALT_LENGTH} bytes`, () => {
    const salt = generateSalt();
    expect(Buffer.isBuffer(salt)).toBe(true);
    expect(salt.length).toBe(SALT_LENGTH);
  });

  it('returns different values on consecutive calls', () => {
    const s1 = generateSalt();
    const s2 = generateSalt();
    expect(s1.equals(s2)).toBe(false);
  });
});

describe('deriveKey', () => {
  it('same passphrase + same salt = same 32-byte key', async () => {
    const passphrase = 'correct-horse-battery-staple-123';
    const salt = generateSalt();

    const k1 = await deriveKey(passphrase, salt);
    const k2 = await deriveKey(passphrase, salt);

    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  }, 30_000); // scrypt is intentionally slow

  it('same passphrase + different salt = different key', async () => {
    const passphrase = 'correct-horse-battery-staple-123';
    const salt1 = generateSalt();
    const salt2 = generateSalt();

    const k1 = await deriveKey(passphrase, salt1);
    const k2 = await deriveKey(passphrase, salt2);

    expect(k1.equals(k2)).toBe(false);
  }, 30_000);

  it('different passphrase + same salt = different key', async () => {
    const salt = generateSalt();

    const k1 = await deriveKey('passphrase-one', salt);
    const k2 = await deriveKey('passphrase-two', salt);

    expect(k1.equals(k2)).toBe(false);
  }, 30_000);
});

describe('hashDerivedKey', () => {
  it('returns a 32-byte SHA-256 hash', () => {
    const fakeKey = Buffer.alloc(32, 0xab);
    const hash = hashDerivedKey(fakeKey);
    expect(hash.length).toBe(32);
  });

  it('same key always produces same hash', () => {
    const key = Buffer.alloc(32, 0x01);
    expect(hashDerivedKey(key).equals(hashDerivedKey(key))).toBe(true);
  });

  it('different keys produce different hashes', () => {
    const k1 = Buffer.alloc(32, 0x01);
    const k2 = Buffer.alloc(32, 0x02);
    expect(hashDerivedKey(k1).equals(hashDerivedKey(k2))).toBe(false);
  });
});

describe('verifyPassphrase', () => {
  it('returns true for the correct passphrase', async () => {
    const passphrase = 'correct-horse-battery-staple-123';
    const salt = generateSalt();
    const key = await deriveKey(passphrase, salt);
    const storedHash = hashDerivedKey(key);

    const result = await verifyPassphrase(passphrase, salt, storedHash);
    expect(result).toBe(true);
  }, 30_000);

  it('returns false for a wrong passphrase', async () => {
    const passphrase = 'correct-horse-battery-staple-123';
    const salt = generateSalt();
    const key = await deriveKey(passphrase, salt);
    const storedHash = hashDerivedKey(key);

    const result = await verifyPassphrase('wrong-passphrase-here', salt, storedHash);
    expect(result).toBe(false);
  }, 30_000);

  it('returns false when salt is different (different user)', async () => {
    const passphrase = 'shared-passphrase-123';
    const salt1 = generateSalt();
    const salt2 = generateSalt();

    const key1 = await deriveKey(passphrase, salt1);
    const hash1 = hashDerivedKey(key1);

    // Try to verify against a hash derived from a different salt
    const result = await verifyPassphrase(passphrase, salt2, hash1);
    expect(result).toBe(false);
  }, 30_000);
});

describe('MIN_PASSPHRASE_LENGTH', () => {
  it('is at least 12', () => {
    expect(MIN_PASSPHRASE_LENGTH).toBeGreaterThanOrEqual(12);
  });
});

describe('rotation sanity — new salt produces a different key', () => {
  /**
   * This test verifies the core rotation invariant: deriving a key with a new
   * salt (even for the same passphrase) produces a distinct key. If this
   * failed, rotation would not actually change the encryption key.
   */
  it('old key !== new key after generating a new salt', async () => {
    const passphrase = 'rotation-test-passphrase-long-enough';

    const oldSalt = generateSalt();
    const newSalt = generateSalt();

    const oldKey = await deriveKey(passphrase, oldSalt);
    const newKey = await deriveKey(passphrase, newSalt);

    expect(oldKey.equals(newKey)).toBe(false);
    expect(oldKey.length).toBe(32);
    expect(newKey.length).toBe(32);
  }, 30_000);

  it('verifyPassphrase succeeds for old passphrase before rotation', async () => {
    const passphrase = 'pre-rotation-passphrase-test-xyz';
    const salt = generateSalt();
    const key = await deriveKey(passphrase, salt);
    const hash = hashDerivedKey(key);

    expect(await verifyPassphrase(passphrase, salt, hash)).toBe(true);
  }, 30_000);

  it('old passphrase fails against new hash after rotation (new salt + new passphrase)', async () => {
    const oldPassphrase = 'old-passphrase-rotation-test-123';
    const newPassphrase = 'new-passphrase-rotation-test-456';

    const oldSalt = generateSalt();
    const oldKey = await deriveKey(oldPassphrase, oldSalt);
    void hashDerivedKey(oldKey); // compute to verify it doesn't throw, but not compared here

    // Simulate rotation: new salt, new passphrase, new hash
    const newSalt = generateSalt();
    const newKey = await deriveKey(newPassphrase, newSalt);
    const newHash = hashDerivedKey(newKey);

    // Old passphrase should NOT verify against new hash
    expect(await verifyPassphrase(oldPassphrase, newSalt, newHash)).toBe(false);
    // New passphrase SHOULD verify against new hash
    expect(await verifyPassphrase(newPassphrase, newSalt, newHash)).toBe(true);
  }, 60_000);
});
