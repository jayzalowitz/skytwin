/**
 * @skytwin/dxt — DXT artifact serialization, deserialization, and format types.
 *
 * A DXT (Desktop eXtension Transfer) artifact is a packed binary file that
 * carries MCP server capability configuration between SkyTwin instances.
 *
 * Usage:
 *   import { serialize, deserialize, redactCommand } from '@skytwin/dxt';
 */

export { serialize } from './serialize.js';
export { deserialize } from './deserialize.js';
export { redactCommand, DXT_MAGIC, DXT_VERSION, HEADER_LENGTH } from './format.js';
export type {
  DxtJsonPayload,
  DxtArtifactInput,
  DxtArtifactContents,
  DxtResult,
  DxtErrorCode,
} from './types.js';
