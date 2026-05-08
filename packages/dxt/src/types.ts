/**
 * types.ts — Public types for the DXT artifact format.
 *
 * DXT (Desktop eXtension Transfer) artifacts carry MCP server capability
 * configuration between SkyTwin instances. They contain no OAuth tokens,
 * no twin profile data, and no memory contents.
 */

/** JSON payload carried inside every DXT binary artifact. */
export interface DxtJsonPayload {
  schemaVersion: 1;
  /** ISO 8601 timestamp of when the artifact was produced. */
  exportedAt: string;
  /** UUID identifying the source SkyTwin install. */
  sourceInstanceId: string;
  capability: {
    registryId: string;
    transport: 'stdio' | 'http' | 'sse';
    /** For stdio transport: the command to execute. */
    command?: string;
    /** For stdio transport: arguments passed to the command. */
    args?: string[];
    /** For http/sse transport: the server URL. */
    url?: string;
    /** Tool names declared by this server. */
    skills: string[];
  };
  autonomyOverrides?: Record<string, unknown>;
  perAppSpendCaps?: {
    perActionCents?: number;
    dailyCents?: number;
    monthlyCents?: number;
  };
  promptOverrides?: Array<{ slug: string; version: number; body: string }>;
  /** Recipe slugs the capability was installed from (if any). */
  recipeRefs?: string[];
}

/** Input to serialize() — mirrors the mcp_servers row plus skills. */
export interface DxtArtifactInput {
  sourceInstanceId: string;
  registryId: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  skills: string[];
  autonomyOverrides?: Record<string, unknown>;
  perAppSpendCaps?: {
    perActionCents?: number;
    dailyCents?: number;
    monthlyCents?: number;
  };
  promptOverrides?: Array<{ slug: string; version: number; body: string }>;
  recipeRefs?: string[];
}

/** Result of deserialize() on a valid artifact. */
export interface DxtArtifactContents {
  payload: DxtJsonPayload;
  /** SHA-256 of the JSON payload as stored in the artifact header. */
  computedSha256: Buffer;
}

/** Typed result for operations that can fail with user-visible errors. */
export type DxtResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: DxtErrorCode };

export type DxtErrorCode =
  | 'MAGIC_MISMATCH'
  | 'UNSUPPORTED_VERSION'
  | 'LENGTH_MISMATCH'
  | 'SHA256_MISMATCH'
  | 'PARSE_ERROR'
  | 'TRUNCATED';
