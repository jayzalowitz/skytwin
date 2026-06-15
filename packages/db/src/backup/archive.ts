/**
 * archive.ts — encrypted backup archive codec (#400).
 *
 * A SkyTwin backup is a single self-describing binary blob: a fixed header
 * followed by an AES-256-GCM ciphertext whose plaintext is the UTF-8 JSON of
 * the user's exported data. The key is derived from a user-supplied passphrase
 * with scrypt + a per-archive random salt, so the same crypto choices that
 * guard the credential vault (`@skytwin/credential-vault`) guard the backup.
 *
 * Layout (all multi-byte integers big-endian):
 *
 *   offset  size  field
 *   ------  ----  -----------------------------------------------------------
 *   0       4     MAGIC          ascii "STBK"
 *   4       1     FORMAT_VERSION 1
 *   5       32    salt           scrypt salt (random per archive)
 *   37      12    iv             AES-256-GCM IV (random per archive)
 *   49      16    tag            AES-256-GCM auth tag
 *   65      …     ciphertext     AES-256-GCM(JSON, key)
 *
 * The header (MAGIC..iv, the bytes that are NOT the tag or ciphertext) is fed
 * to the cipher as additional authenticated data (AAD). That binds the format
 * version and salt to the ciphertext: an attacker can't downgrade the version
 * byte or swap the salt without the GCM tag failing closed.
 *
 * All expected failure modes (wrong passphrase, truncated/garbage file, bad
 * magic, unsupported version) return a typed result object rather than
 * throwing — see `DecodeArchiveResult`.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

const MAGIC = Buffer.from('STBK', 'ascii');
const FORMAT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';

const SALT_LENGTH = 32;
const IV_LENGTH = 12; // 96-bit GCM standard
const TAG_LENGTH = 16; // 128-bit GCM tag
const KEY_LENGTH = 32; // AES-256

/**
 * scrypt parameters. Mirror `@skytwin/credential-vault` so the backup archive
 * and the credential vault have the same memory-hardness story.
 *   N = 2^15, r = 8, p = 1, keylen = 32, maxmem = 64 MiB.
 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;

const HEADER_LENGTH = MAGIC.length + 1 + SALT_LENGTH + IV_LENGTH; // 49
const MIN_ARCHIVE_LENGTH = HEADER_LENGTH + TAG_LENGTH; // 65 (+ empty ciphertext)

/** Minimum passphrase length accepted by the archive codec. */
export const MIN_ARCHIVE_PASSPHRASE_LENGTH = 12;

/**
 * Discriminated result of `decodeArchive`. Every expected failure mode is a
 * typed `success: false` — the caller never has to wrap this in try/catch for
 * a wrong passphrase or a corrupt file.
 */
export type DecodeArchiveResult =
  | { success: true; json: string }
  | {
      success: false;
      /** Stable machine-readable reason. */
      reason:
        | 'not_an_archive'
        | 'unsupported_version'
        | 'truncated'
        | 'decrypt_failed';
      /** Human-readable detail for CLI output. */
      message: string;
    };

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEM },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

/**
 * Encrypt a UTF-8 JSON payload into a backup archive buffer.
 *
 * @throws if the passphrase is shorter than {@link MIN_ARCHIVE_PASSPHRASE_LENGTH}.
 *   A weak passphrase is a programmer/operator error, not an expected runtime
 *   failure, so this throws rather than returning a result object.
 */
export async function encodeArchive(json: string, passphrase: string): Promise<Buffer> {
  if (passphrase.length < MIN_ARCHIVE_PASSPHRASE_LENGTH) {
    throw new Error(
      `backup passphrase must be at least ${MIN_ARCHIVE_PASSPHRASE_LENGTH} characters`,
    );
  }

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = await deriveKey(passphrase, salt);

  const header = Buffer.concat([
    MAGIC,
    Buffer.from([FORMAT_VERSION]),
    salt,
    iv,
  ]);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([header, tag, ciphertext]);
}

/**
 * Decrypt a backup archive buffer back to its UTF-8 JSON payload.
 *
 * Fails closed: a wrong passphrase, a tampered byte, a truncated file, or a
 * non-SkyTwin blob all return `{ success: false }` with a stable reason. The
 * GCM auth tag (with the header as AAD) is what makes a wrong passphrase or a
 * flipped version byte indistinguishable from corruption — both surface as
 * `decrypt_failed`.
 */
export async function decodeArchive(
  archive: Buffer,
  passphrase: string,
): Promise<DecodeArchiveResult> {
  // Magic check first: a blob that doesn't start with STBK is "not an
  // archive" regardless of length. Only a blob that DOES start with STBK but
  // is shorter than a complete header+tag is "truncated".
  if (
    archive.length < MAGIC.length ||
    !archive.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    return {
      success: false,
      reason: 'not_an_archive',
      message: 'file does not start with the SkyTwin backup magic header',
    };
  }

  if (archive.length < MIN_ARCHIVE_LENGTH) {
    return {
      success: false,
      reason: 'truncated',
      message: `archive is too small to be a complete SkyTwin backup (${archive.length} bytes)`,
    };
  }

  const version = archive[MAGIC.length];
  if (version !== FORMAT_VERSION) {
    return {
      success: false,
      reason: 'unsupported_version',
      message: `unsupported backup format version ${version}; this build reads version ${FORMAT_VERSION}`,
    };
  }

  const saltStart = MAGIC.length + 1;
  const ivStart = saltStart + SALT_LENGTH;
  const tagStart = ivStart + IV_LENGTH; // == HEADER_LENGTH
  const ciphertextStart = tagStart + TAG_LENGTH;

  const salt = archive.subarray(saltStart, ivStart);
  const iv = archive.subarray(ivStart, tagStart);
  const tag = archive.subarray(tagStart, ciphertextStart);
  const ciphertext = archive.subarray(ciphertextStart);
  const header = archive.subarray(0, HEADER_LENGTH);

  try {
    const key = await deriveKey(passphrase, Buffer.from(salt));
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { success: true, json: plaintext.toString('utf8') };
  } catch {
    // GCM final() throws on tag mismatch — wrong passphrase OR tampering.
    // We deliberately do not distinguish the two: leaking "right passphrase,
    // wrong data" vs "wrong passphrase" would be an oracle.
    return {
      success: false,
      reason: 'decrypt_failed',
      message: 'could not decrypt the archive — wrong passphrase or the file is corrupt',
    };
  }
}
