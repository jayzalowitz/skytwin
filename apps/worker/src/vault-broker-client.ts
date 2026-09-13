import {
  VaultBrokerClient,
  type VaultBrokerControlResult,
} from '@skytwin/credential-vault';

/** Shared service-authenticated client for Electron-managed worker IPC. */
export const workerVaultBroker = new VaultBrokerClient();

export type WorkerOwnerDiscovery =
  | { success: true; userIds: Iterable<string> }
  | { success: false; error: 'discovery_unavailable' };

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

/** Only a complete database snapshot is authoritative enough to replace grants. */
export async function reconcileWorkerDiscovery(
  discovery: WorkerOwnerDiscovery,
  client: Pick<VaultBrokerClient, 'reconcileAuthenticatedOwners'> = workerVaultBroker,
): Promise<VaultBrokerControlResult> {
  if (!discovery.success) {
    return { success: false, error: 'vault_broker_unavailable' };
  }
  return await grantWorkerOwners(discovery.userIds, client);
}
