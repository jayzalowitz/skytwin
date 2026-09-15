import type { GoogleConnectionMode } from '@skytwin/config';
import type { GoogleOAuthConfig, MicrosoftOAuthConfig } from '@skytwin/connectors';

export interface UserOAuthConnectorDiscovery<TTokenStore, TConnector> {
  googleConnectionMode: GoogleConnectionMode;
  hasGoogleToken: boolean;
  hasMicrosoftToken: boolean;
  resolveGoogleConfig(): Promise<GoogleOAuthConfig | null>;
  resolveMicrosoftConfig(): Promise<MicrosoftOAuthConfig | null>;
  createTokenStore(
    googleConfig: GoogleOAuthConfig | undefined,
    microsoftConfig: MicrosoftOAuthConfig | undefined,
  ): TTokenStore;
  createGmailConnector(tokenStore: TTokenStore): TConnector;
  createGoogleCalendarConnector(tokenStore: TTokenStore): TConnector;
  createOutlookMailConnector(tokenStore: TTokenStore): TConnector;
  createOutlookCalendarConnector(tokenStore: TTokenStore): TConnector;
}

/**
 * Resolve provider admission before constructing anything that can read or
 * refresh a credential. Account-backed providers require the explicit
 * experimental mode; old token rows alone never activate a resolver, token
 * store, or connector.
 */
export async function buildUserOAuthConnectors<TTokenStore, TConnector>(
  input: UserOAuthConnectorDiscovery<TTokenStore, TConnector>,
): Promise<TConnector[]> {
  const googleConfig = input.hasGoogleToken && input.googleConnectionMode === 'experimental'
    ? await input.resolveGoogleConfig()
    : null;
  const microsoftConfig = input.hasMicrosoftToken && input.googleConnectionMode === 'experimental'
    ? await input.resolveMicrosoftConfig()
    : null;

  const usableGoogle = input.hasGoogleToken && googleConfig !== null;
  const usableMicrosoft = input.hasMicrosoftToken && microsoftConfig !== null;
  if (!usableGoogle && !usableMicrosoft) return [];

  const tokenStore = input.createTokenStore(
    googleConfig ?? undefined,
    microsoftConfig ?? undefined,
  );
  const connectors: TConnector[] = [];
  if (usableGoogle) {
    connectors.push(input.createGmailConnector(tokenStore));
    connectors.push(input.createGoogleCalendarConnector(tokenStore));
  }
  if (usableMicrosoft) {
    connectors.push(input.createOutlookMailConnector(tokenStore));
    connectors.push(input.createOutlookCalendarConnector(tokenStore));
  }
  return connectors;
}
