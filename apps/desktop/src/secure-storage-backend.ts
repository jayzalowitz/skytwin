/** The safeStorage capability needed to decide whether persistence is genuine. */
export interface SecureStorageBackendPort {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
}

const SECURE_LINUX_STORAGE_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
]);

/**
 * Return a stable identity only for reviewed OS-backed secret stores.
 * Unknown platforms and future Linux backend names fail closed until reviewed.
 */
export function resolveSecureStorageBackend(
  safeStorage: SecureStorageBackendPort,
  platform: NodeJS.Platform = process.platform,
): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    if (platform === 'darwin') return 'darwin:keychain';
    if (platform === 'win32') return 'win32:dpapi';
    if (platform !== 'linux') return null;
    const backend = safeStorage.getSelectedStorageBackend?.();
    return backend !== undefined && SECURE_LINUX_STORAGE_BACKENDS.has(backend)
      ? `linux:${backend}`
      : null;
  } catch {
    return null;
  }
}
