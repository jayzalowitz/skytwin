import {
  VaultBrokerClient,
  type VaultBrokerControlResult,
} from '@skytwin/credential-vault';

/** Shared service-authenticated client for Electron-managed worker IPC. */
export const workerVaultBroker = new VaultBrokerClient();

export async function grantWorkerOwners(
  userIds: Iterable<string>,
  client: Pick<VaultBrokerClient, 'reconcileAuthenticatedOwners'> = workerVaultBroker,
): Promise<VaultBrokerControlResult> {
  // Standalone `pnpm dev` and the desktop headless daemon intentionally have
  // no Electron broker capability. Reconciliation is therefore a bounded,
  // per-operation fail-closed result, not a reason to terminate the worker's
  // non-sensitive signal processing.
  return await client.reconcileAuthenticatedOwners(userIds);
}
