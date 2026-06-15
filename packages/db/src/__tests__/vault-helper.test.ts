import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptColumn,
  decryptColumn,
  readColumn,
  resolveKey,
  packEncrypted,
  unpackEncrypted,
  type VaultKeyProvider,
} from '../lib/vault-helper.js';

const KEY = randomBytes(32);
const WRONG_KEY = randomBytes(32);

/** Minimal stub of the credential-vault KeyCache for resolveKey tests. */
function stubProvider(map: Record<string, Buffer>): VaultKeyProvider {
  return { get: (userId: string) => map[userId] ?? null };
}

describe('vault-helper: encryptColumn / decryptColumn round-trip', () => {
  it('round-trips a plain STRING value', () => {
    const packed = encryptColumn('hello world', KEY);
    const result = decryptColumn(packed, KEY);
    expect(result).toEqual({ success: true, value: 'hello world' });
  });

  it('round-trips a JSON-stringified JSONB value', () => {
    const obj = { tone: 'concise', maxLen: 120, tags: ['a', 'b'] };
    const packed = encryptColumn(JSON.stringify(obj), KEY);
    const result = decryptColumn(packed, KEY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(JSON.parse(result.value)).toEqual(obj);
    }
  });

  it('round-trips a JSON-stringified array (STRING[]-shaped) value', () => {
    const arr = ['evidence-1', 'evidence-2'];
    const packed = encryptColumn(JSON.stringify(arr), KEY);
    const result = decryptColumn(packed, KEY);
    expect(result.success).toBe(true);
    if (result.success) expect(JSON.parse(result.value)).toEqual(arr);
  });

  it('round-trips an empty string', () => {
    const packed = encryptColumn('', KEY);
    expect(decryptColumn(packed, KEY)).toEqual({ success: true, value: '' });
  });

  it('produces ciphertext that is NOT readable as the plaintext STRING', () => {
    const secret = 'super-secret-preference-value';
    const packed = encryptColumn(secret, KEY);
    // The packed buffer must not contain the plaintext bytes anywhere.
    expect(packed.toString('utf8')).not.toContain(secret);
    expect(packed.toString('latin1')).not.toContain(secret);
  });

  it('uses a fresh IV per call (same plaintext → different ciphertext)', () => {
    const a = encryptColumn('same', KEY);
    const b = encryptColumn('same', KEY);
    expect(a.equals(b)).toBe(false);
    // Both still decrypt to the same plaintext.
    expect(decryptColumn(a, KEY)).toEqual({ success: true, value: 'same' });
    expect(decryptColumn(b, KEY)).toEqual({ success: true, value: 'same' });
  });
});

describe('vault-helper: decryptColumn failure modes (typed, never throws)', () => {
  it('returns decrypt_failed for a wrong key rather than throwing', () => {
    const packed = encryptColumn('secret', KEY);
    expect(decryptColumn(packed, WRONG_KEY)).toEqual({
      success: false,
      error: 'decrypt_failed',
    });
  });

  it('returns decrypt_failed for a tampered ciphertext (GCM auth tag)', () => {
    const packed = encryptColumn('secret', KEY);
    const tampered = Buffer.from(packed);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff; // flip a ciphertext bit
    expect(decryptColumn(tampered, KEY)).toEqual({
      success: false,
      error: 'decrypt_failed',
    });
  });

  it('returns decrypt_failed for a too-short / malformed buffer', () => {
    expect(decryptColumn(Buffer.alloc(4), KEY)).toEqual({
      success: false,
      error: 'decrypt_failed',
    });
  });
});

describe('vault-helper: pack / unpack', () => {
  it('unpackEncrypted reverses packEncrypted', () => {
    const iv = randomBytes(12);
    const tag = randomBytes(16);
    const ciphertext = randomBytes(20);
    const unpacked = unpackEncrypted(packEncrypted({ iv, tag, ciphertext }));
    expect(unpacked.iv.equals(iv)).toBe(true);
    expect(unpacked.tag.equals(tag)).toBe(true);
    expect(unpacked.ciphertext.equals(ciphertext)).toBe(true);
  });

  it('unpackEncrypted throws a clear error on a short buffer', () => {
    expect(() => unpackEncrypted(Buffer.alloc(10))).toThrow(/too short/);
  });
});

describe('vault-helper: readColumn lazy-migration decision table', () => {
  it('case 1: encrypted present + key available → decrypt', () => {
    const packed = encryptColumn('value-x', KEY);
    expect(readColumn(packed, null, KEY)).toEqual({
      success: true,
      value: 'value-x',
    });
  });

  it('case 2: encrypted present + NO key → vault_locked (never leaks ciphertext)', () => {
    const packed = encryptColumn('value-x', KEY);
    const result = readColumn(packed, null, null);
    expect(result).toEqual({ success: false, error: 'vault_locked' });
  });

  it('case 3: encrypted NULL + plaintext present → returns plaintext (pre-migration)', () => {
    expect(readColumn(null, 'legacy-plaintext', KEY)).toEqual({
      success: true,
      value: 'legacy-plaintext',
    });
  });

  it('case 3b: encrypted zero-length + plaintext present → returns plaintext', () => {
    expect(readColumn(Buffer.alloc(0), 'legacy-plaintext', null)).toEqual({
      success: true,
      value: 'legacy-plaintext',
    });
  });

  it('case 4: both NULL → returns the configured empty fallback', () => {
    expect(readColumn(null, null, KEY)).toEqual({ success: true, value: '' });
    expect(readColumn(null, null, KEY, '[]')).toEqual({
      success: true,
      value: '[]',
    });
  });
});

describe('vault-helper: resolveKey', () => {
  it('returns plaintext mode when no provider is wired (feature off)', () => {
    expect(resolveKey(null, 'user-1')).toEqual({ mode: 'plaintext' });
  });

  it('returns unlocked + key when the provider has the key cached', () => {
    const state = resolveKey(stubProvider({ 'user-1': KEY }), 'user-1');
    expect(state.mode).toBe('unlocked');
    if (state.mode === 'unlocked') expect(state.key.equals(KEY)).toBe(true);
  });

  it('returns locked when the provider has no key for the user', () => {
    expect(resolveKey(stubProvider({}), 'user-1')).toEqual({ mode: 'locked' });
  });
});
