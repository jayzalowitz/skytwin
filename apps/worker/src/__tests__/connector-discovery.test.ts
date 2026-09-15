import { describe, expect, it, vi } from 'vitest';
import type { GoogleOAuthConfig, MicrosoftOAuthConfig } from '@skytwin/connectors';
import { buildUserOAuthConnectors } from '../connector-discovery.js';

const googleConfig: GoogleOAuthConfig = {
  clientId: 'google-client',
  clientSecret: 'google-secret',
  redirectUri: 'http://localhost/google',
};
const microsoftConfig: MicrosoftOAuthConfig = {
  clientId: 'microsoft-client',
  clientSecret: 'microsoft-secret',
  redirectUri: 'http://localhost/microsoft',
  tenant: 'common',
};

function dependencies(input: {
  googleConnectionMode: 'disabled' | 'experimental';
  hasGoogleToken: boolean;
  hasMicrosoftToken: boolean;
}, resolvedGoogleConfig: GoogleOAuthConfig | null = googleConfig) {
  const tokenStore = { kind: 'token-store' };
  return {
    tokenStore,
    resolveGoogleConfig: vi.fn(async () => resolvedGoogleConfig),
    resolveMicrosoftConfig: vi.fn(async () => microsoftConfig),
    createTokenStore: vi.fn(() => tokenStore),
    createGmailConnector: vi.fn(() => 'gmail'),
    createGoogleCalendarConnector: vi.fn(() => 'google-calendar'),
    createOutlookMailConnector: vi.fn(() => 'outlook-mail'),
    createOutlookCalendarConnector: vi.fn(() => 'outlook-calendar'),
    input,
  };
}

describe('buildUserOAuthConnectors', () => {
  it('does not resolve credentials or construct connectors from old Google tokens while disabled', async () => {
    const deps = dependencies({
      googleConnectionMode: 'disabled',
      hasGoogleToken: true,
      hasMicrosoftToken: false,
    });

    const connectors = await buildUserOAuthConnectors({ ...deps.input, ...deps });

    expect(connectors).toEqual([]);
    expect(deps.resolveGoogleConfig).not.toHaveBeenCalled();
    expect(deps.resolveMicrosoftConfig).not.toHaveBeenCalled();
    expect(deps.createTokenStore).not.toHaveBeenCalled();
    expect(deps.createGmailConnector).not.toHaveBeenCalled();
    expect(deps.createGoogleCalendarConnector).not.toHaveBeenCalled();
    expect(deps.createOutlookMailConnector).not.toHaveBeenCalled();
    expect(deps.createOutlookCalendarConnector).not.toHaveBeenCalled();
  });

  it('does not resolve or construct Microsoft connectors from a stale token while disabled', async () => {
    const deps = dependencies({
      googleConnectionMode: 'disabled',
      hasGoogleToken: true,
      hasMicrosoftToken: true,
    });

    const connectors = await buildUserOAuthConnectors({ ...deps.input, ...deps });

    expect(connectors).toEqual([]);
    expect(deps.resolveGoogleConfig).not.toHaveBeenCalled();
    expect(deps.resolveMicrosoftConfig).not.toHaveBeenCalled();
    expect(deps.createTokenStore).not.toHaveBeenCalled();
    expect(deps.createGmailConnector).not.toHaveBeenCalled();
    expect(deps.createGoogleCalendarConnector).not.toHaveBeenCalled();
    expect(deps.createOutlookMailConnector).not.toHaveBeenCalled();
    expect(deps.createOutlookCalendarConnector).not.toHaveBeenCalled();
  });

  it('admits Microsoft connectors only after exact experimental opt-in', async () => {
    const deps = dependencies({
      googleConnectionMode: 'experimental',
      hasGoogleToken: false,
      hasMicrosoftToken: true,
    });

    const connectors = await buildUserOAuthConnectors({ ...deps.input, ...deps });

    expect(connectors).toEqual(['outlook-mail', 'outlook-calendar']);
    expect(deps.resolveMicrosoftConfig).toHaveBeenCalledOnce();
    expect(deps.createTokenStore).toHaveBeenCalledWith(undefined, microsoftConfig);
    expect(deps.createOutlookMailConnector).toHaveBeenCalledWith(deps.tokenStore);
    expect(deps.createOutlookCalendarConnector).toHaveBeenCalledWith(deps.tokenStore);
  });

  it('admits Google connectors only after exact experimental opt-in and usable config', async () => {
    const deps = dependencies({
      googleConnectionMode: 'experimental',
      hasGoogleToken: true,
      hasMicrosoftToken: false,
    });

    const connectors = await buildUserOAuthConnectors({ ...deps.input, ...deps });

    expect(connectors).toEqual(['gmail', 'google-calendar']);
    expect(deps.resolveGoogleConfig).toHaveBeenCalledOnce();
    expect(deps.createTokenStore).toHaveBeenCalledWith(googleConfig, undefined);
    expect(deps.createGmailConnector).toHaveBeenCalledWith(deps.tokenStore);
    expect(deps.createGoogleCalendarConnector).toHaveBeenCalledWith(deps.tokenStore);
  });

  it('does not construct a token store when experimental Google config is unavailable', async () => {
    const deps = dependencies({
      googleConnectionMode: 'experimental',
      hasGoogleToken: true,
      hasMicrosoftToken: false,
    }, null);

    const connectors = await buildUserOAuthConnectors({ ...deps.input, ...deps });

    expect(connectors).toEqual([]);
    expect(deps.resolveGoogleConfig).toHaveBeenCalledOnce();
    expect(deps.createTokenStore).not.toHaveBeenCalled();
    expect(deps.createGmailConnector).not.toHaveBeenCalled();
    expect(deps.createGoogleCalendarConnector).not.toHaveBeenCalled();
  });
});
