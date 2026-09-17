import { createProcessSourceKeyBrokerClient } from '@skytwin/credential-vault';
import { getRequestContext } from '@skytwin/db';

/**
 * Fixed-role, fail-closed source-key broker boundary for the API child.
 *
 * No repository path consumes this client yet. Its Electron binding starts
 * empty and accepts only request-scoped grants for exact live API sessions.
 */
export const apiSourceKeyBrokerClient = createProcessSourceKeyBrokerClient(
  'api',
  undefined,
  {
    sessionAuthorityProvider: () =>
      getRequestContext()?.sourceKeySessionAuthority,
  },
);
