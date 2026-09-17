import type { GoogleConnectionMode } from '@skytwin/config';
import type { GoogleOAuthConfig, MicrosoftOAuthConfig } from '@skytwin/connectors';

export interface UserOAuthConnectorDiscovery<TTokenStore, TConnector> {
  googleConnectionMode: GoogleConnectionMode;
  googleOnly?: boolean;
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

/** Packaged BYO-Google releases must not revive retained Microsoft grants. */
export function isMicrosoftConnectionAdmitted(
  googleConnectionMode: GoogleConnectionMode,
  googleOnly: boolean,
): boolean {
  return googleConnectionMode === 'experimental' && !googleOnly;
}

/**
 * Keep retained credential rows outside the disabled worker process entirely.
 * The loader is intentionally admitted before it is invoked so the poll loop
 * cannot materialize secret-bearing rows merely to learn that no provider is
 * enabled.
 */
export async function loadUserOAuthConnections<T>(
  googleConnectionMode: GoogleConnectionMode,
  loadConnections: () => Promise<T[]>,
): Promise<T[]> {
  if (googleConnectionMode !== 'experimental') return [];
  return loadConnections();
}

export interface AccountConnectorTopology<TGoogle, TMicrosoft, TConnector> {
  googleAccounts: readonly TGoogle[];
  microsoftAccounts: readonly TMicrosoft[];
  createGmail(account: TGoogle): TConnector;
  createGoogleCalendar(account: TGoogle): TConnector;
  createOutlookMail(account: TMicrosoft): TConnector;
  createOutlookCalendar(account: TMicrosoft): TConnector;
}

/**
 * Expand every admitted credential account into its complete connector pair.
 * Keeping this pure makes it impossible for refresh-order changes to silently
 * select a different `tokens[0]` account.
 */
export function buildAccountConnectorTopology<TGoogle, TMicrosoft, TConnector>(
  input: AccountConnectorTopology<TGoogle, TMicrosoft, TConnector>,
): TConnector[] {
  const connectors: TConnector[] = [];
  for (const account of input.googleAccounts) {
    connectors.push(input.createGmail(account));
    connectors.push(input.createGoogleCalendar(account));
  }
  for (const account of input.microsoftAccounts) {
    connectors.push(input.createOutlookMail(account));
    connectors.push(input.createOutlookCalendar(account));
  }
  return connectors;
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
  const microsoftConfig = input.hasMicrosoftToken &&
    isMicrosoftConnectionAdmitted(input.googleConnectionMode, input.googleOnly === true)
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
