/**
 * deserialize.ts — Unpack and verify a DXT binary artifact.
 *
 * Returns a typed DxtResult so the API layer can produce a 400 (user error)
 * rather than a 500 (server crash) when given a malformed blob.
 *
 * Verification steps:
 *   1. Buffer must be at least HEADER_LENGTH bytes (48).
 *   2. First 4 bytes must match DXT_MAGIC ("DXT1").
 *   3. Version uint32 BE must equal DXT_VERSION (1).
 *   4. Declared payload length (uint64 BE) must match actual remaining bytes.
 *   5. SHA-256 of the payload must match the 32-byte hash in the header.
 *   6. Payload must be valid UTF-8 JSON that satisfies the schema.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { DXT_MAGIC, DXT_VERSION, HEADER_LENGTH } from './format.js';
import type {
  DxtArtifactContents,
  DxtJsonPayload,
  DxtResult,
} from './types.js';

/**
 * Parse and verify a DXT binary blob.
 *
 * Never throws on user-supplied data — all failure modes are returned as
 * `{ success: false, error, code }`.
 *
 * @param blob - Raw bytes of the .dxt artifact.
 * @returns Typed result containing the parsed payload and computed SHA-256.
 */
export function deserialize(
  blob: Buffer,
): DxtResult<DxtArtifactContents> {
  // ── 1. Minimum length ──────────────────────────────────────────────────────
  if (blob.length < HEADER_LENGTH) {
    return {
      success: false,
      error: `Artifact is too short: ${blob.length} bytes (minimum ${HEADER_LENGTH})`,
      code: 'TRUNCATED',
    };
  }

  let offset = 0;

  // ── 2. Magic ───────────────────────────────────────────────────────────────
  const magic = blob.subarray(offset, offset + 4);
  offset += 4;

  if (!magic.equals(DXT_MAGIC)) {
    return {
      success: false,
      error: `Magic mismatch: expected "DXT1", got "${magic.toString('ascii')}"`,
      code: 'MAGIC_MISMATCH',
    };
  }

  // ── 3. Version ─────────────────────────────────────────────────────────────
  const version = blob.readUInt32BE(offset);
  offset += 4;

  if (version !== DXT_VERSION) {
    return {
      success: false,
      error: `Unsupported DXT version: ${version} (this library supports version ${DXT_VERSION})`,
      code: 'UNSUPPORTED_VERSION',
    };
  }

  // ── 4. SHA-256 header ──────────────────────────────────────────────────────
  const headerSha256 = blob.subarray(offset, offset + 32);
  offset += 32;

  // ── 5. Payload length ──────────────────────────────────────────────────────
  // Two uint32 BE words = uint64 BE. High word must be zero for sane sizes.
  const lenHigh = blob.readUInt32BE(offset);
  const lenLow = blob.readUInt32BE(offset + 4);
  offset += 8;

  if (lenHigh !== 0) {
    return {
      success: false,
      error: 'Declared payload length exceeds safe integer range',
      code: 'LENGTH_MISMATCH',
    };
  }

  const declaredLen = lenLow;
  const remaining = blob.length - HEADER_LENGTH;

  if (remaining !== declaredLen) {
    return {
      success: false,
      error: `Payload length mismatch: header declares ${declaredLen} bytes, artifact has ${remaining} bytes`,
      code: 'LENGTH_MISMATCH',
    };
  }

  // ── 6. Extract payload ─────────────────────────────────────────────────────
  const jsonBytes = blob.subarray(offset, offset + declaredLen);

  // ── 7. SHA-256 verification ────────────────────────────────────────────────
  const computedSha256 = createHash('sha256').update(jsonBytes).digest();

  // Use timingSafeEqual to prevent timing attacks against the hash comparison.
  if (!timingSafeEqual(headerSha256, computedSha256)) {
    return {
      success: false,
      error: 'SHA-256 mismatch: artifact has been tampered with or is corrupted',
      code: 'SHA256_MISMATCH',
    };
  }

  // ── 8. JSON parse ──────────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBytes.toString('utf8'));
  } catch {
    return {
      success: false,
      error: 'Payload is not valid JSON',
      code: 'PARSE_ERROR',
    };
  }

  // Basic structural validation — we only need enough to prevent crashes
  // upstream. Full schema validation is the caller's responsibility.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>)['schemaVersion'] !== 1
  ) {
    return {
      success: false,
      error: 'Payload does not match DxtJsonPayload schema (schemaVersion must be 1)',
      code: 'PARSE_ERROR',
    };
  }

  return {
    success: true,
    data: {
      payload: parsed as DxtJsonPayload,
      computedSha256,
    },
  };
}
