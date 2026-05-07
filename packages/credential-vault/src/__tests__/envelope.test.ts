import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, IV_LENGTH, TAG_LENGTH } from '../envelope.js';
import { randomBytes } from 'node:crypto';

function makeKey(): Buffer {
  return randomBytes(32);
}

describe('encrypt', () => {
  it('returns a ciphertext, iv, and tag of the expected byte lengths', () => {
    const key = makeKey();
    const result = encrypt('hello world', key);

    expect(result.iv.length).toBe(IV_LENGTH);
    expect(result.tag.length).toBe(TAG_LENGTH);
    expect(result.ciphertext.length).toBeGreaterThan(0);
  });

  it('produces a different IV on every call (no IV reuse)', () => {
    const key = makeKey();
    const r1 = encrypt('same plaintext', key);
    const r2 = encrypt('same plaintext', key);

    expect(r1.iv.equals(r2.iv)).toBe(false);
  });

  it('throws when key length is not 32 bytes', () => {
    const shortKey = randomBytes(16);
    expect(() => encrypt('test', shortKey)).toThrow(/key must be 32 bytes/);
  });
});

describe('decrypt', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const key = makeKey();
    const original = 'ya29.some-google-access-token-value';

    const { ciphertext, iv, tag } = encrypt(original, key);
    const recovered = decrypt({ ciphertext, iv, tag }, key);

    expect(recovered).toBe(original);
  });

  it('round-trips empty string', () => {
    const key = makeKey();
    const { ciphertext, iv, tag } = encrypt('', key);
    expect(decrypt({ ciphertext, iv, tag }, key)).toBe('');
  });

  it('round-trips a long token (1024 chars)', () => {
    const key = makeKey();
    const longToken = 'x'.repeat(1024);
    const { ciphertext, iv, tag } = encrypt(longToken, key);
    expect(decrypt({ ciphertext, iv, tag }, key)).toBe(longToken);
  });

  it('throws on tampered ciphertext (auth tag mismatch)', () => {
    const key = makeKey();
    const { ciphertext, iv, tag } = encrypt('sensitive-token', key);

    // Flip a byte in the ciphertext
    const tampered = Buffer.from(ciphertext);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    tampered[0] = tampered[0]! ^ 0xff;

    expect(() => decrypt({ ciphertext: tampered, iv, tag }, key)).toThrow();
  });

  it('throws on tampered tag', () => {
    const key = makeKey();
    const { ciphertext, iv, tag } = encrypt('sensitive-token', key);

    const tamperedTag = Buffer.from(tag);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    tamperedTag[0] = tamperedTag[0]! ^ 0xff;

    expect(() => decrypt({ ciphertext, iv, tag: tamperedTag }, key)).toThrow();
  });

  it('throws when decrypted with a wrong key', () => {
    const key1 = makeKey();
    const key2 = makeKey();

    const { ciphertext, iv, tag } = encrypt('my-secret-token', key1);

    expect(() => decrypt({ ciphertext, iv, tag }, key2)).toThrow();
  });

  it('throws when key length is not 32 bytes', () => {
    const goodKey = makeKey();
    const { ciphertext, iv, tag } = encrypt('data', goodKey);
    const shortKey = randomBytes(16);

    expect(() => decrypt({ ciphertext, iv, tag }, shortKey)).toThrow(/key must be 32 bytes/);
  });
});
