import { describe, expect, it, vi } from 'vitest';
import type { GoogleOAuthConfig, MicrosoftOAuthConfig } from '@skytwin/connectors';
import {
  buildAccountConnectorTopology,
  buildUserOAuthConnectors,
  isMicrosoftConnectionAdmitted,
  loadUserOAuthConnections,
} from '../connector-discovery.js';

describe('buildAccountConnectorTopology', () => {
  it('constructs every provider surface for every admitted account', () => {
    const connectors = buildAccountConnectorTopology({
      googleAccounts: [{ id: 'google-a' }, { id: 'google-b' }],
      microsoftAccounts: [{ id: 'microsoft-a' }, { id: 'microsoft-b' }],
      createGmail: ({ id }) => `gmail:${id}`,
      createGoogleCalendar: ({ id }) => `google-calendar:${id}`,
      createOutlookMail: ({ id }) => `outlook-mail:${id}`,
      createOutlookCalendar: ({ id }) => `outlook-calendar:${id}`,
    });

    expect(connectors).toEqual([
      'gmail:google-a',
      'google-calendar:google-a',
      'gmail:google-b',
      'google-calendar:google-b',
      'outlook-mail:microsoft-a',
      'outlook-calendar:microsoft-a',
      'outlook-mail:microsoft-b',
      'outlook-calendar:microsoft-b',
    ]);
  });
});

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

  it('does not resolve retained Microsoft credentials in packaged Google-only mode', async () => {
    const deps = dependencies({
      googleConnectionMode: 'experimental',
      hasGoogleToken: false,
      hasMicrosoftToken: true,
    });

    const connectors = await buildUserOAuthConnectors({
      ...deps.input,
      ...deps,
      googleOnly: true,
    });

    expect(connectors).toEqual([]);
    expect(deps.resolveMicrosoftConfig).not.toHaveBeenCalled();
    expect(deps.createTokenStore).not.toHaveBeenCalled();
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

describe('isMicrosoftConnectionAdmitted', () => {
  it('requires source experimental mode and rejects packaged Google-only mode', () => {
    expect(isMicrosoftConnectionAdmitted('disabled', false)).toBe(false);
    expect(isMicrosoftConnectionAdmitted('experimental', false)).toBe(true);
    expect(isMicrosoftConnectionAdmitted('experimental', true)).toBe(false);
  });
});

describe('loadUserOAuthConnections', () => {
  it('does not read retained credential rows while account connections are disabled', async () => {
    const loadConnections = vi.fn(async () => [{ provider: 'google' }]);

    await expect(loadUserOAuthConnections('disabled', loadConnections)).resolves.toEqual([]);

    expect(loadConnections).not.toHaveBeenCalled();
  });

  it('preserves credential-row discovery for the exact experimental mode', async () => {
    const rows = [{ provider: 'google' }, { provider: 'microsoft' }];
    const loadConnections = vi.fn(async () => rows);

    await expect(loadUserOAuthConnections('experimental', loadConnections)).resolves.toBe(rows);

    expect(loadConnections).toHaveBeenCalledOnce();
  });
});
