/**
 * backup-archive.test.ts — encode/decode round-trips and fail-closed behavior
 * for the encrypted backup archive codec (#400).
 *
 * No DB needed: archive.ts is pure crypto over a JSON string.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeArchive,
  decodeArchive,
  MIN_ARCHIVE_PASSPHRASE_LENGTH,
} from '../backup/archive.js';

const PASSPHRASE = 'correct horse battery staple';
const PAYLOAD = JSON.stringify({ hello: 'world', list: [1, 2, 3], nested: { a: true } });

describe('encodeArchive / decodeArchive', () => {
  it('round-trips a JSON payload with the right passphrase', async () => {
    const archive = await encodeArchive(PAYLOAD, PASSPHRASE);
    expect(Buffer.isBuffer(archive)).toBe(true);
    // header(49) + tag(16) + ciphertext(>0)
    expect(archive.length).toBeGreaterThan(65);

    const decoded = await decodeArchive(archive, PASSPHRASE);
    expect(decoded.success).toBe(true);
    if (decoded.success) {
      expect(decoded.json).toBe(PAYLOAD);
      expect(JSON.parse(decoded.json)).toEqual(JSON.parse(PAYLOAD));
    }
  });

  it('starts with the STBK magic header and version byte', async () => {
    const archive = await encodeArchive(PAYLOAD, PASSPHRASE);
    expect(archive.subarray(0, 4).toString('ascii')).toBe('STBK');
    expect(archive[4]).toBe(1); // FORMAT_VERSION
  });

  it('produces a different ciphertext each call (random salt + IV)', async () => {
    const a = await encodeArchive(PAYLOAD, PASSPHRASE);
    const b = await encodeArchive(PAYLOAD, PASSPHRASE);
    expect(a.equals(b)).toBe(false);
    // both still decode to the same plaintext
    const da = await decodeArchive(a, PASSPHRASE);
    const db = await decodeArchive(b, PASSPHRASE);
    expect(da.success && db.success && da.json === db.json).toBe(true);
  });

  it('rejects a short passphrase at encode time', async () => {
    await expect(encodeArchive(PAYLOAD, 'short')).rejects.toThrow(
      new RegExp(`${MIN_ARCHIVE_PASSPHRASE_LENGTH} characters`),
    );
  });

  it('fails closed on the wrong passphrase', async () => {
    const archive = await encodeArchive(PAYLOAD, PASSPHRASE);
    const decoded = await decodeArchive(archive, 'wrong passphrase here');
    expect(decoded.success).toBe(false);
    if (!decoded.success) expect(decoded.reason).toBe('decrypt_failed');
  });

  it('fails closed when the ciphertext is tampered with', async () => {
    const archive = await encodeArchive(PAYLOAD, PASSPHRASE);
    const tampered = Buffer.from(archive);
    // flip a bit in the ciphertext region (past the 65-byte header+tag)
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    const decoded = await decodeArchive(tampered, PASSPHRASE);
    expect(decoded.success).toBe(false);
    if (!decoded.success) expect(decoded.reason).toBe('decrypt_failed');
  });

  it('fails closed when the version byte is downgraded (AAD bound)', async () => {
    const archive = await encodeArchive(PAYLOAD, PASSPHRASE);
    const tampered = Buffer.from(archive);
    tampered[4] = 99; // mutate the version byte
    const decoded = await decodeArchive(tampered, PASSPHRASE);
    expect(decoded.success).toBe(false);
    // an unknown version is caught before decrypt
    if (!decoded.success) expect(decoded.reason).toBe('unsupported_version');
  });

  it('rejects a file that is not a SkyTwin archive', async () => {
    const garbage = Buffer.from('this is just some random text, not an archive');
    const decoded = await decodeArchive(garbage, PASSPHRASE);
    expect(decoded.success).toBe(false);
    if (!decoded.success) expect(decoded.reason).toBe('not_an_archive');
  });

  it('rejects a too-small buffer as truncated', async () => {
    const tiny = Buffer.from('STBK\x01');
    const decoded = await decodeArchive(tiny, PASSPHRASE);
    expect(decoded.success).toBe(false);
    if (!decoded.success) expect(decoded.reason).toBe('truncated');
  });

  it('rejects an empty buffer as not an archive', async () => {
    const decoded = await decodeArchive(Buffer.alloc(0), PASSPHRASE);
    expect(decoded.success).toBe(false);
    if (!decoded.success) expect(decoded.reason).toBe('not_an_archive');
  });
});
