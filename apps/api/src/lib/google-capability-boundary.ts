import { isGoogleAccountIntegration } from '@skytwin/shared-types';

export interface GoogleCapabilityDescriptor {
  registryId?: string | null;
  oauthProvider?: string | null;
  /** Denial-only signal for imported or cached capability tool names. */
  skills?: readonly string[];
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
