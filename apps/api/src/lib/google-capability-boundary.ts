import { isGoogleAccountIntegration } from '@skytwin/shared-types';

export interface GoogleCapabilityDescriptor {
  registryId?: string | null;
  oauthProvider?: string | null;
  /** Denial-only signal for imported or cached capability tool names. */
  skills?: readonly string[];
}

export interface PreviewServerDescriptor {
  id: string;
  registry_id: string | null;
  oauth_provider: string | null;
}

/**
 * Classify trusted capability metadata against the account-free preview.
 *
 * Registry ids are matched by the shared stable-id inventory. The OAuth
 * provider comes only from SkyTwin's curated registry or persisted server
 * metadata, never from display names or peer-authored descriptions.
 */
export function isGoogleCapabilityBlocked(
  googleConnectionMode: string | undefined,
  descriptor: GoogleCapabilityDescriptor,
): boolean {
  if (googleConnectionMode === 'experimental') return false;
  return isGoogleAccountIntegration({
    key: descriptor.registryId ?? undefined,
    integration: descriptor.oauthProvider ?? undefined,
    skills: descriptor.skills,
  });
}

/**
 * Classify a persisted server using both stable metadata and its cached tool
 * inventory. Missing inventory state fails closed because list, onboarding,
 * and resume are all activation/discovery surfaces in the account-free mode.
 */
export async function isAccountFreePreviewServerBlocked(
  googleConnectionMode: string | undefined,
  server: PreviewServerDescriptor,
  readSkills: (serverId: string) => Promise<readonly string[]>,
): Promise<boolean> {
  if (isGoogleCapabilityBlocked(googleConnectionMode, {
    registryId: server.registry_id,
    oauthProvider: server.oauth_provider,
  })) return true;
  if (googleConnectionMode === 'experimental') return false;

  try {
    const skills = await readSkills(server.id);
    return isGoogleCapabilityBlocked(googleConnectionMode, {
      registryId: server.registry_id,
      oauthProvider: server.oauth_provider,
      skills,
    });
  } catch {
    return true;
  }
}
