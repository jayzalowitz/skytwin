import { twinRepository } from '@skytwin/db';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface GetPreferencesArgs {
  domain?: string;
}

/**
 * Return preference vectors from the user's twin model.
 * Requires scope: read.
 *
 * If no twin-model package is wired in this repo, this falls back to
 * the raw twin_profiles row from the DB, which contains the same preference
 * data before @skytwin/twin-model adds its scoring layer.
 *
 * TODO: When @skytwin/twin-model exposes a typed getPreferences() method,
 * wire it here to get scored preference vectors.
 */
export async function getPreferences(
  userId: string,
  args: GetPreferencesArgs,
): Promise<CallToolResult> {
  const { domain } = args;

  const profile = await twinRepository.getProfile(userId);
  if (!profile) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ preferences: [], note: 'No twin profile found for this user' }),
        },
      ],
    };
  }

  // preferences is stored as a JSON array in twin_profiles
  let preferences: unknown[] = [];
  try {
    const raw = profile.preferences;
    preferences = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : []);
  } catch {
    preferences = [];
  }

  // Filter by domain if provided
  if (domain && typeof domain === 'string') {
    preferences = preferences.filter((p) => {
      if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
        const pObj = p as Record<string, unknown>;
        return pObj['domain'] === domain || pObj['category'] === domain;
      }
      return true;
    });
  }

  // Also return domain_heuristics if a domain filter is active
  let domainHeuristics: unknown = undefined;
  if (domain && profile.domain_heuristics) {
    try {
      const dh = typeof profile.domain_heuristics === 'string'
        ? JSON.parse(profile.domain_heuristics)
        : profile.domain_heuristics;
      if (dh && typeof dh === 'object') {
        domainHeuristics = (dh as Record<string, unknown>)[domain];
      }
    } catch {
      // ignore parse errors
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          preferences,
          ...(domain ? { domain, domainHeuristics: domainHeuristics ?? null } : {}),
        }),
      },
    ],
  };
}
