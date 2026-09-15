import { createProcessSourceKeyBrokerClient } from '@skytwin/credential-vault';

/**
 * Fixed-role, fail-closed source-key broker boundary for the API child.
 *
 * No repository path consumes this client yet. Production desktop composition
 * intentionally grants this process no owners until a later reviewed slice.
 */
export const apiSourceKeyBrokerClient = createProcessSourceKeyBrokerClient('api');
