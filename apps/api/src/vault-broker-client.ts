import { VaultBrokerClient } from '@skytwin/credential-vault';

/** Shared child-process client. It remains unavailable outside Electron IPC. */
export const apiVaultBroker = new VaultBrokerClient();
