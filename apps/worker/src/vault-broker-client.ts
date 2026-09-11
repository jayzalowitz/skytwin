import { VaultBrokerClient } from '@skytwin/credential-vault';

/** Shared service-authenticated client for Electron-managed worker IPC. */
export const workerVaultBroker = new VaultBrokerClient();

export async function grantWorkerOwners(userIds: Iterable<string>): Promise<void> {
  await workerVaultBroker.reconcileAuthenticatedOwners(userIds);
}
