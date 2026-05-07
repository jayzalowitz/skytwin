import { userRepository, mcpServerRepository } from '@skytwin/db';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface WhoamiArgs {
  // no arguments required
}

/**
 * Return identity info for the authenticated user.
 * No scope required — any valid token can call this.
 */
export async function whoami(userId: string): Promise<CallToolResult> {
  const user = await userRepository.findById(userId);
  if (!user) {
    return {
      isError: true,
      content: [{ type: 'text', text: `User not found: ${userId}` }],
    };
  }

  // Collect per-server trust tiers (earnedTrustTiers)
  let earnedTrustTiers: Record<string, string> = {};
  try {
    const servers = await mcpServerRepository.listForUser(userId);
    for (const server of servers) {
      if (server.registry_id) {
        earnedTrustTiers[server.registry_id] = server.trust_tier;
      }
    }
  } catch {
    // Non-critical — return empty map rather than failing
    earnedTrustTiers = {};
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          userId: user.id,
          displayName: user.name ?? user.email ?? user.id,
          twinIdentity: {
            email: user.email,
            trustTier: user.trust_tier,
          },
          earnedTrustTiers,
        }),
      },
    ],
  };
}
