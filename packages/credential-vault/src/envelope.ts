/**
 * envelope.ts — AES-256-GCM envelope encryption.
 *
 * Each call to encrypt() generates a fresh 96-bit (12-byte) IV.
 * Reusing IVs with GCM would catastrophically break confidentiality;
 * this module never reuses them.
 *
 * The returned { ciphertext, iv, tag } triple should be stored together:
 *   - ciphertext  → encrypted_access_token / encrypted_refresh_token column
 *   - iv          → encryption_iv column
 *   - tag         → encryption_tag column
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

/** Length of the IV generated per encryption call (bytes). */
export const IV_LENGTH = 12; // 96 bits — GCM standard

/** Length of the GCM authentication tag (bytes). */
export const TAG_LENGTH = 16; // 128 bits

export interface EncryptResult {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * Encrypt a UTF-8 plaintext string with AES-256-GCM.
 *
 * @param plaintext - The value to encrypt (e.g. an OAuth access token).
 * @param key       - A 32-byte derived key. Must NOT be persisted.
 * @returns ciphertext, a fresh IV, and the GCM auth tag.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptResult {
  if (key.length !== 32) {
    throw new Error(`encrypt: key must be 32 bytes, got ${key.length}`);
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAutoPadding(false);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { ciphertext: encrypted, iv, tag };
}

/**
 * Decrypt an AES-256-GCM ciphertext.
 *
 * @param params - { ciphertext, iv, tag } as stored in the DB columns.
 * @param key    - The same 32-byte derived key used during encryption.
 * @returns The original plaintext UTF-8 string.
 * @throws If the key is wrong or the ciphertext has been tampered with
 *         (GCM auth tag verification fails).
 */
export function decrypt(
  params: { ciphertext: Buffer; iv: Buffer; tag: Buffer },
  key: Buffer,
): string {
  if (key.length !== 32) {
    throw new Error(`decrypt: key must be 32 bytes, got ${key.length}`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, params.iv);
  decipher.setAuthTag(params.tag);
  decipher.setAutoPadding(false);

  const decrypted = Buffer.concat([
    decipher.update(params.ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
