/**
 * OAuth failure recovery helper (D: oauth-recovery).
 *
 * Layering:
 *   1. Primary: RegistryClient.getOAuthQuirks(id) — static lookup in
 *      oauth_quirks.json. Fast, deterministic, no LLM cost.
 *   2. Secondary (this module): recoverOAuthFlow — adaptive LLM path for
 *      failures not covered by the static quirks table. The model receives
 *      the failure trace and any published auth metadata to reason about
 *      a recovery action.
 *
 * Returns null if no LLM client is configured, if the LLM path falls back
 * to deterministic, or if any error occurs. The caller should treat null as
 * "no automated recovery available — surface error to user."
 */

import type { LlmClient } from '@skytwin/llm-client';
import { runPrompt } from '@skytwin/policy-prompts';

/** Recovery action returned by the adaptive path */
export interface OAuthRecoveryAction {
  action: string;
  args: Record<string, unknown>;
}

/** Output shape the LLM is expected to return */
interface OAuthRecoveryLlmOutput {
  action: string;
  args: Record<string, unknown>;
}

/**
 * Attempt to recover from an OAuth handshake failure using the LLM.
 *
 * This is the secondary path — call only AFTER getOAuthQuirks() returns
 * null or a quirk entry that doesn't cover the specific failure trace.
 *
 * @param opts.registryId   - The MCP server registry ID
 * @param opts.failureTrace - The error message / stack from the failed OAuth attempt
 * @param opts.authMetadata - Optional: the server's published auth metadata (e.g. OIDC discovery)
 * @param opts.llmClient    - Optional: when absent, returns null immediately
 *
 * @returns A recovery action plan, or null if recovery is not possible.
 */
export async function recoverOAuthFlow(opts: {
  registryId: string;
  failureTrace: string;
  authMetadata?: unknown;
  llmClient?: LlmClient;
}): Promise<OAuthRecoveryAction | null> {
  // No LLM → no adaptive recovery
  if (!opts.llmClient) return null;

  try {
    // Map to the snake_case keys the prompt template expects.
    // Template: {{failure_trace}} {{server_auth_metadata}}
    const result = await runPrompt<OAuthRecoveryLlmOutput>({
      promptName: 'oauth-recovery',
      inputs: {
        failure_trace: opts.failureTrace,
        server_auth_metadata: opts.authMetadata ?? null,
      },
      user: { userId: 'system' },
      llmClient: opts.llmClient,
    });

    if (result.fellBackToDeterministic) return null;

    const output = result.output;
    if (typeof output?.action !== 'string' || !output.action) return null;

    return {
      action: output.action,
      args: typeof output.args === 'object' && output.args !== null
        ? (output.args as Record<string, unknown>)
        : {},
    };
  } catch {
    return null;
  }
}
