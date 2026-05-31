import { describe, it, expect } from 'vitest';
import {
  chunkBase64,
  countChunks,
  reassembleChunks,
  DEFAULT_CHUNK_CHARS,
} from '../services/voice-chunker';

describe('chunkBase64', () => {
  it('splits into fixed-size pieces with correct offsets', () => {
    const data = 'abcdefghij'; // 10 chars
    const chunks = chunkBase64(data, 4);
    expect(chunks.map((c) => c.data)).toEqual(['abcd', 'efgh', 'ij']);
    expect(chunks.map((c) => c.offset)).toEqual([0, 4, 8]);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('marks only the last chunk isLast', () => {
    const chunks = chunkBase64('abcdefghij', 4);
    expect(chunks.map((c) => c.isLast)).toEqual([false, false, true]);
  });

  it('handles an exact multiple (no short remainder)', () => {
    const chunks = chunkBase64('abcdefgh', 4);
    expect(chunks.map((c) => c.data)).toEqual(['abcd', 'efgh']);
    expect(chunks[1]!.isLast).toBe(true);
  });

  it('produces a single chunk when smaller than the chunk size', () => {
    const chunks = chunkBase64('abc', 4);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, offset: 0, data: 'abc', isLast: true });
  });

  it('returns no chunks for empty input', () => {
    expect(chunkBase64('', 4)).toEqual([]);
  });

  it('throws on a non-positive chunk size', () => {
    expect(() => chunkBase64('abc', 0)).toThrow();
    expect(() => chunkBase64('abc', -1)).toThrow();
  });

  it('uses the default chunk size when omitted', () => {
    const data = 'x'.repeat(DEFAULT_CHUNK_CHARS + 10);
    const chunks = chunkBase64(data);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.data).toHaveLength(DEFAULT_CHUNK_CHARS);
    expect(chunks[1]!.data).toHaveLength(10);
  });
});

describe('countChunks', () => {
  it('matches chunkBase64 length without allocating', () => {
    for (const len of [0, 1, 4, 5, 8, 9, 100]) {
      const data = 'x'.repeat(len);
      expect(countChunks(len, 4)).toBe(chunkBase64(data, 4).length);
    }
  });

  it('returns 0 for empty', () => {
    expect(countChunks(0, 256)).toBe(0);
  });
});

describe('reassembleChunks', () => {
  it('reassembles in-order chunks back to the original', () => {
    const data = 'abcdefghij';
    const chunks = chunkBase64(data, 4);
    const r = reassembleChunks(chunks, 3);
    expect(r.ok && r.base64).toBe(data);
  });

  it('reassembles correctly when chunks arrive out of order', () => {
    const data = 'abcdefghij';
    const chunks = chunkBase64(data, 4);
    const shuffled = [chunks[2]!, chunks[0]!, chunks[1]!];
    const r = reassembleChunks(shuffled, 3);
    expect(r.ok && r.base64).toBe(data);
  });

  it('reports the gap list when a chunk is missing', () => {
    const chunks = chunkBase64('abcdefghij', 4);
    const partial = [chunks[0]!, chunks[2]!]; // missing index 1
    const r = reassembleChunks(partial, 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual([1]);
  });
});
