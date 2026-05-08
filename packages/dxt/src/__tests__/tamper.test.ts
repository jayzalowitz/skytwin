/**
 * tamper.test.ts — Tamper-detection tests for the DXT format.
 *
 * Modifying any byte of the JSON payload must cause deserialize() to
 * return { success: false, code: 'SHA256_MISMATCH' }.
 */

import { describe, it, expect } from 'vitest';
import { serialize } from '../serialize.js';
import { deserialize } from '../deserialize.js';
import { HEADER_LENGTH } from '../format.js';
import type { DxtArtifactInput } from '../types.js';

const BASE_INPUT: DxtArtifactInput = {
  sourceInstanceId: 'ffffffff-0000-0000-0000-000000000001',
  registryId: '@skytwin/test-server',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  skills: ['ping'],
};

describe('DXT tamper detection', () => {
  it('rejects a blob with a single flipped bit in the payload', async () => {
    const { blob } = await serialize(BASE_INPUT);

    // Flip the first byte of the JSON payload
    const tampered = Buffer.from(blob);
    tampered[HEADER_LENGTH] = tampered[HEADER_LENGTH]! ^ 0x01;

    const result = deserialize(tampered);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('SHA256_MISMATCH');
  });

  it('rejects a blob with a flipped byte near the end of the payload', async () => {
    const { blob } = await serialize(BASE_INPUT);

    const tampered = Buffer.from(blob);
    // Flip the last byte
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;

    const result = deserialize(tampered);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('SHA256_MISMATCH');
  });

  it('rejects a blob with wrong magic header', async () => {
    const { blob } = await serialize(BASE_INPUT);

    const tampered = Buffer.from(blob);
    // Overwrite magic "DXT1" with "XXXX"
    tampered.write('XXXX', 0, 'ascii');

    const result = deserialize(tampered);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('MAGIC_MISMATCH');
  });

  it('rejects a blob with an unsupported version number', async () => {
    const { blob } = await serialize(BASE_INPUT);

    const tampered = Buffer.from(blob);
    // Overwrite version uint32 BE at offset 4 with 99
    tampered.writeUInt32BE(99, 4);

    const result = deserialize(tampered);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('UNSUPPORTED_VERSION');
  });

  it('rejects a truncated blob (shorter than HEADER_LENGTH)', async () => {
    const tinyBlob = Buffer.alloc(10);

    const result = deserialize(tinyBlob);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('TRUNCATED');
  });

  it('rejects a blob where declared length does not match actual payload', async () => {
    const { blob } = await serialize(BASE_INPUT);

    const tampered = Buffer.from(blob);
    // Inflate the declared length by 1 without adding a byte
    const currentLen = tampered.readUInt32BE(44);
    tampered.writeUInt32BE(currentLen + 1, 44);

    const result = deserialize(tampered);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('LENGTH_MISMATCH');
  });

  it('a valid artifact deserializes successfully (control)', async () => {
    const { blob } = await serialize(BASE_INPUT);
    const result = deserialize(blob);
    expect(result.success).toBe(true);
  });
});
