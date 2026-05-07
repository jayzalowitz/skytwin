/**
 * @skytwin/credential-vault
 *
 * Envelope encryption for OAuth tokens stored in CockroachDB.
 *
 * Public API:
 *   deriveKey(passphrase, salt)  — derive 32-byte AES key via scrypt
 *   generateSalt()               — random per-user salt for vault init
 *   hashDerivedKey(key)          — SHA-256 of derived key for verification
 *   verifyPassphrase(...)        — timing-safe passphrase check
 *   encrypt(plaintext, key)      — AES-256-GCM encrypt
 *   decrypt({ ciphertext, iv, tag }, key) — AES-256-GCM decrypt
 *   KeyCache                     — in-process derived-key cache (TTL-based)
 *   MIN_PASSPHRASE_LENGTH        — minimum passphrase length constant
 *   IV_LENGTH / TAG_LENGTH       — byte lengths for GCM IV and tag
 */

export {
  deriveKey,
  generateSalt,
  hashDerivedKey,
  verifyPassphrase,
  MIN_PASSPHRASE_LENGTH,
  SALT_LENGTH,
} from './key-derivation.js';

export { encrypt, decrypt, IV_LENGTH, TAG_LENGTH } from './envelope.js';
export type { EncryptResult } from './envelope.js';

export { KeyCache } from './key-cache.js';
export type { KeyCacheOptions } from './key-cache.js';
