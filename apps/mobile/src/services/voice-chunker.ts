/**
 * Pure base64 chunker for resumable voice upload (#386 P2.6).
 *
 * The recording is held client-side as one base64 string (expo-file-
 * system `File.base64()`). For flaky cellular we slice it into fixed-
 * size string pieces, upload each independently (retrying just the
 * failed piece on a drop), and let the server concatenate them back in
 * index order before decoding once. Slicing the STRING — not the binary
 * — means there's no per-chunk base64 alignment to worry about: only the
 * reassembled whole must be valid, which it is by construction.
 *
 * Pure + dependency-free so it unit-tests without Expo / a device.
 */

export interface UploadChunk {
  index: number;
  /** Character offset of this slice within the full base64 string. */
  offset: number;
  /** The base64 substring for this chunk. */
  data: string;
  /** True for the final chunk. */
  isLast: boolean;
}

/** ~256KB of base64 chars ≈ ~192KB binary on the wire per chunk. */
export const DEFAULT_CHUNK_CHARS = 256 * 1024;

/**
 * Split a base64 string into `chunkChars`-sized pieces. The last piece
 * carries the remainder. An empty input yields no chunks (callers should
 * treat zero chunks as "nothing to upload"). Throws on a non-positive
 * chunk size — a silent fallback would mask a caller bug.
 */
export function chunkBase64(base64: string, chunkChars: number = DEFAULT_CHUNK_CHARS): UploadChunk[] {
  if (!Number.isInteger(chunkChars) || chunkChars <= 0) {
    throw new Error(`chunkChars must be a positive integer, got ${chunkChars}`);
  }
  const chunks: UploadChunk[] = [];
  if (base64.length === 0) return chunks;

  const total = Math.ceil(base64.length / chunkChars);
  for (let i = 0; i < total; i++) {
    const offset = i * chunkChars;
    const data = base64.slice(offset, offset + chunkChars);
    chunks.push({ index: i, offset, data, isLast: i === total - 1 });
  }
  return chunks;
}

/** How many chunks `chunkBase64` would produce, without allocating them. */
export function countChunks(base64Length: number, chunkChars: number = DEFAULT_CHUNK_CHARS): number {
  if (!Number.isInteger(chunkChars) || chunkChars <= 0) {
    throw new Error(`chunkChars must be a positive integer, got ${chunkChars}`);
  }
  if (base64Length <= 0) return 0;
  return Math.ceil(base64Length / chunkChars);
}

/**
 * Reassemble chunks (possibly received out of order) back into the
 * original base64 string, or report the gaps. Mirrors the server's
 * finalize logic so the client can verify locally before finalizing.
 */
export function reassembleChunks(
  chunks: UploadChunk[],
  total: number,
): { ok: true; base64: string } | { ok: false; missing: number[] } {
  const byIndex = new Map<number, string>();
  for (const c of chunks) byIndex.set(c.index, c.data);
  const missing: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!byIndex.has(i)) missing.push(i);
  }
  if (missing.length > 0) return { ok: false, missing };
  let base64 = '';
  for (let i = 0; i < total; i++) base64 += byIndex.get(i)!;
  return { ok: true, base64 };
}
