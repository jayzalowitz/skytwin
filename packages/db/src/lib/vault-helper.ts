/**
 * vault-helper.ts — shared column-level envelope-encryption helpers (#374).
 *
 * Application-level encryption AT REST for the highest-value tables
 * (preferences, twin_profiles, brain_pages). Reuses the credential-vault
 * primitives (AES-256-GCM `encrypt`/`decrypt`, the per-user scrypt-derived
 * key, and the `KeyCache`) that already protect OAuth tokens.
 *
 * Packed ciphertext format (identical to the DbTokenStore precedent so the
 * two paths can share a future unify): [IV (12 bytes)] + [tag (16 bytes)] +
 * [ciphertext]. Each column is encrypted independently with a fresh IV — a
 * single IV is never reused across two AES-256-GCM encryptions.
 *
 * Repository wiring contract:
 *   - WRITE: `encryptColumn(plaintext, key)` → packed BYTES for `<col>_encrypted`,
 *     and set the plaintext `<col>` to NULL on the same row.
 *   - READ:  prefer `<col>_encrypted` (decrypt with `decryptColumn`); fall back
 *     to the plaintext `<col>` when `<col>_encrypted` is NULL (lazy-migration
 *     window). When `<col>_encrypted` is present but the vault is locked, the
 *     repository must surface `vault_locked` and NEVER return the raw ciphertext.
 *
 * All expected failure modes are returned as typed result objects rather than
 * thrown, per CLAUDE.md code style.
 */

import { encrypt, decrypt, IV_LENGTH, TAG_LENGTH } from '@skytwin/credential-vault';

/** Minimum length of a well-formed packed buffer: IV (12) + tag (16). */
const MIN_PACKED_LENGTH = IV_LENGTH + TAG_LENGTH;

/**
 * Provider of per-user derived keys. Structurally compatible with
 * `KeyCache` from @skytwin/credential-vault; declared as an interface here so
 * the DB layer does not take a hard runtime dependency on the cache class and
 * tests can supply a trivial stub.
 */
export interface VaultKeyProvider {
  /** Return the cached 32-byte key for userId, or null when the vault is locked. */
  get(userId: string): Buffer | null;
}

/**
 * Typed result for a vault read. `vault_locked` means the row carries
 * ciphertext but no key is available — the caller must surface this and must
 * never fall back to returning ciphertext as if it were plaintext.
 */
export type VaultReadResult =
  | { success: true; value: string }
  | { success: false; error: 'vault_locked' | 'decrypt_failed' };

/**
 * Pack an EncryptResult triple into a single BYTES buffer for storage in a
 * `<col>_encrypted` column.
 */
export function packEncrypted(result: {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}): Buffer {
  return Buffer.concat([result.iv, result.tag, result.ciphertext]);
}

/**
 * Reverse of {@link packEncrypted}. Validates length up-front so corruption
 * surfaces as a clear error rather than the cryptic AES-GCM
 * "Unsupported state or unable to authenticate data".
 */
export function unpackEncrypted(packed: Buffer): {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
} {
  if (!Buffer.isBuffer(packed) || packed.length < MIN_PACKED_LENGTH) {
    throw new Error(
      `unpackEncrypted: packed buffer too short (got ${
        packed?.length ?? 0
      } bytes, need at least ${MIN_PACKED_LENGTH} for IV + tag)`,
    );
  }
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
  return { iv, tag, ciphertext };
}

/**
 * Encrypt a plaintext column value into the packed BYTES form for storage.
 * The caller writes the returned buffer to `<col>_encrypted` and sets the
 * plaintext `<col>` to NULL on the same row.
 *
 * @param plaintext - UTF-8 string. JSONB columns must be `JSON.stringify`'d by
 *                    the caller before encryption (the DB layer round-trips
 *                    them as strings; the repository re-parses on read).
 * @param key       - 32-byte per-user derived key.
 */
export function encryptColumn(plaintext: string, key: Buffer): Buffer {
  return packEncrypted(encrypt(plaintext, key));
}

/**
 * Decrypt a packed `<col>_encrypted` value back to its plaintext string.
 * Returns a typed result: `decrypt_failed` on a wrong key / tampered
 * ciphertext / malformed buffer rather than throwing, so a single corrupt row
 * cannot crash a read path.
 */
export function decryptColumn(packed: Buffer, key: Buffer): VaultReadResult {
  try {
    const { iv, tag, ciphertext } = unpackEncrypted(packed);
    return { success: true, value: decrypt({ ciphertext, iv, tag }, key) };
  } catch {
    return { success: false, error: 'decrypt_failed' };
  }
}

/**
 * Resolve a plaintext column value during the lazy-migration window.
 *
 * Decision table:
 *   1. `<col>_encrypted` present + key available  → decrypt.
 *   2. `<col>_encrypted` present + NO key (locked) → `vault_locked` (never leak ciphertext).
 *   3. `<col>_encrypted` NULL    + plaintext present → return plaintext (pre-migration row).
 *   4. both NULL                                   → return `fallbackWhenEmpty` (default '').
 *
 * @param encrypted - the `<col>_encrypted` BYTES column (Buffer | null).
 * @param plaintext - the plaintext `<col>` column (string | null).
 * @param key       - the per-user key, or null when the vault is locked.
 */
export function readColumn(
  encrypted: Buffer | null | undefined,
  plaintext: string | null | undefined,
  key: Buffer | null,
  fallbackWhenEmpty = '',
): VaultReadResult {
  if (encrypted && encrypted.length > 0) {
    if (key === null) {
      return { success: false, error: 'vault_locked' };
    }
    return decryptColumn(encrypted, key);
  }
  if (plaintext !== null && plaintext !== undefined) {
    return { success: true, value: plaintext };
  }
  return { success: true, value: fallbackWhenEmpty };
}

/**
 * Resolve the per-user key from a provider, returning a typed `vault_locked`
 * result when the vault is locked. A `null` provider means the vault feature
 * is not wired for this deployment (e.g. tests, or vault-not-yet-enabled
 * users) — in that mode encryption is a no-op and callers operate on
 * plaintext, preserving backward compatibility.
 *
 *   - provider === null               → { mode: 'plaintext' }   (feature off)
 *   - provider.get(userId) === Buffer → { mode: 'unlocked', key }
 *   - provider.get(userId) === null   → { mode: 'locked' }      (vault locked)
 */
export type VaultKeyState =
  | { mode: 'plaintext' }
  | { mode: 'unlocked'; key: Buffer }
  | { mode: 'locked' };

export function resolveKey(
  provider: VaultKeyProvider | null,
  userId: string,
): VaultKeyState {
  if (provider === null) {
    return { mode: 'plaintext' };
  }
  const key = provider.get(userId);
  if (key === null) {
    return { mode: 'locked' };
  }
  return { mode: 'unlocked', key };
}
