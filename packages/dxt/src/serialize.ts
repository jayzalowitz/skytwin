/**
 * serialize.ts — Pack a DxtArtifactInput into the DXT binary format.
 *
 * The packed format is:
 *   [4 bytes magic][4 bytes version][32 bytes sha256][8 bytes len][N bytes json]
 *
 * Secret CLI args (--token=, --api-key=, --secret=, etc.) are redacted via
 * redactCommand() before the JSON payload is produced, so they are never
 * written to disk or to the dxt_exports table.
 */

import { createHash } from 'node:crypto';
import { DXT_MAGIC, DXT_VERSION, HEADER_LENGTH, redactCommand } from './format.js';
import type { DxtArtifactInput, DxtJsonPayload } from './types.js';

/**
 * Serialize a capability config into a packed DXT binary artifact.
 *
 * @param input - Capability configuration to pack.
 * @returns `blob` — the full binary artifact ready for storage/download,
 *          `sha256` — the 32-byte SHA-256 of the JSON payload (also embedded in the blob).
 */
export async function serialize(
  input: DxtArtifactInput,
): Promise<{ blob: Buffer; sha256: Buffer }> {
  const redactedArgs =
    input.args !== undefined ? redactCommand(input.args) : undefined;

  const payload: DxtJsonPayload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceInstanceId: input.sourceInstanceId,
    capability: {
      registryId: input.registryId,
      transport: input.transport,
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(redactedArgs !== undefined ? { args: redactedArgs } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      skills: input.skills,
    },
    ...(input.autonomyOverrides !== undefined
      ? { autonomyOverrides: input.autonomyOverrides }
      : {}),
    ...(input.perAppSpendCaps !== undefined
      ? { perAppSpendCaps: input.perAppSpendCaps }
      : {}),
    ...(input.promptOverrides !== undefined
      ? { promptOverrides: input.promptOverrides }
      : {}),
    ...(input.recipeRefs !== undefined ? { recipeRefs: input.recipeRefs } : {}),
  };

  const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sha256 = createHash('sha256').update(jsonBytes).digest();

  // Build header: magic(4) + version(4) + sha256(32) + length(8)
  const header = Buffer.allocUnsafe(HEADER_LENGTH);
  let offset = 0;

  DXT_MAGIC.copy(header, offset);
  offset += 4;

  header.writeUInt32BE(DXT_VERSION, offset);
  offset += 4;

  sha256.copy(header, offset);
  offset += 32;

  // Write uint64 BE as two uint32 BE words (high and low).
  // JavaScript's Buffer.writeBigUInt64BE is available in Node 10+, but we
  // use the two-word approach to stay compatible with the BigInt-free path.
  const len = jsonBytes.length;
  header.writeUInt32BE(0, offset); // high 32 bits — payload will never exceed 4 GB
  header.writeUInt32BE(len, offset + 4);
  offset += 8;

  const blob = Buffer.concat([header, jsonBytes]);
  return { blob, sha256 };
}
