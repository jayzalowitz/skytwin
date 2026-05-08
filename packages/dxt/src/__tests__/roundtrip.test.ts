/**
 * roundtrip.test.ts — Encode/decode round-trip tests for the DXT format.
 */

import { describe, it, expect } from 'vitest';
import { serialize } from '../serialize.js';
import { deserialize } from '../deserialize.js';
import { DXT_MAGIC, DXT_VERSION, HEADER_LENGTH } from '../format.js';
import type { DxtArtifactInput } from '../types.js';

const MINIMAL_INPUT: DxtArtifactInput = {
  sourceInstanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  registryId: '@modelcontextprotocol/server-filesystem',
  transport: 'stdio',
  command: 'node',
  args: ['dist/index.js', '--root=/home/user'],
  skills: ['read_file', 'write_file', 'list_dir'],
};

describe('DXT round-trip', () => {
  it('deserializes a serialized artifact back to the original payload', async () => {
    const { blob } = await serialize(MINIMAL_INPUT);
    const result = deserialize(blob);

    expect(result.success).toBe(true);
    if (!result.success) return; // narrowing

    const { payload } = result.data;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.sourceInstanceId).toBe(MINIMAL_INPUT.sourceInstanceId);
    expect(payload.capability.registryId).toBe(MINIMAL_INPUT.registryId);
    expect(payload.capability.transport).toBe('stdio');
    expect(payload.capability.skills).toEqual(MINIMAL_INPUT.skills);
  });

  it('binary starts with the correct magic header "DXT1"', async () => {
    const { blob } = await serialize(MINIMAL_INPUT);

    expect(blob.subarray(0, 4)).toEqual(DXT_MAGIC);
  });

  it('binary encodes version 1 at bytes 4-7', async () => {
    const { blob } = await serialize(MINIMAL_INPUT);

    expect(blob.readUInt32BE(4)).toBe(DXT_VERSION);
  });

  it('serialize sha256 return value matches the sha256 embedded in the blob', async () => {
    const { blob, sha256 } = await serialize(MINIMAL_INPUT);

    // Sha256 lives at offset 8, length 32
    const embeddedHash = blob.subarray(8, 40);
    expect(sha256).toEqual(embeddedHash);
  });

  it('preserves optional fields (promptOverrides, recipeRefs, perAppSpendCaps)', async () => {
    const input: DxtArtifactInput = {
      ...MINIMAL_INPUT,
      perAppSpendCaps: { perActionCents: 50, dailyCents: 1000 },
      promptOverrides: [{ slug: 'summarize', version: 2, body: 'Summarize briefly.' }],
      recipeRefs: ['developer-pack'],
    };

    const { blob } = await serialize(input);
    const result = deserialize(blob);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { payload } = result.data;
    expect(payload.perAppSpendCaps?.perActionCents).toBe(50);
    expect(payload.promptOverrides?.[0]?.slug).toBe('summarize');
    expect(payload.recipeRefs).toEqual(['developer-pack']);
  });

  it('redacts --token= arg before serialization', async () => {
    const input: DxtArtifactInput = {
      ...MINIMAL_INPUT,
      args: ['--token=sk-supersecret', '--port=3000'],
    };

    const { blob } = await serialize(input);
    const result = deserialize(blob);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { payload } = result.data;
    const args = payload.capability.args ?? [];
    expect(args).not.toContain('--token=sk-supersecret');
    expect(args[0]).toBe('--token=<redacted>');
    expect(args[1]).toBe('--port=3000');
    // Secret must not appear anywhere in the raw blob bytes
    expect(blob.toString('utf8')).not.toContain('sk-supersecret');
  });

  it('round-trips an http-transport server (no command/args)', async () => {
    const input: DxtArtifactInput = {
      sourceInstanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      registryId: '@example/http-server',
      transport: 'http',
      url: 'https://mcp.example.com/v1',
      skills: ['do_thing'],
    };

    const { blob } = await serialize(input);
    const result = deserialize(blob);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.payload.capability.transport).toBe('http');
    expect(result.data.payload.capability.url).toBe('https://mcp.example.com/v1');
    expect(result.data.payload.capability.command).toBeUndefined();
  });

  it('blob length equals HEADER_LENGTH + json payload byte length', async () => {
    const { blob } = await serialize(MINIMAL_INPUT);

    const declaredLen = blob.readUInt32BE(44); // low 32 bits of the length field at offset 40
    expect(blob.length).toBe(HEADER_LENGTH + declaredLen);
  });
});
