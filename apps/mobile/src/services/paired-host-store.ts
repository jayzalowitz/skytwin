/**
 * Remembered manual-pairing host (#384 P2.4).
 *
 * When a user pairs by typing their computer's IP (because mDNS was
 * blocked), we remember the entered address so the next pair pre-fills
 * it — they shouldn't have to re-find their IP every time. Stored in the
 * OS secure store alongside the session (it's low-sensitivity, but
 * keeping all pairing state in one place is simpler than mixing stores).
 */

import * as SecureStore from 'expo-secure-store';

const KEY_LAST_MANUAL_HOST = 'skytwin_last_manual_host';

/** Persist the raw address the user typed for a successful manual pair. */
export async function rememberManualHost(rawAddress: string): Promise<void> {
  const value = rawAddress.trim();
  if (value.length === 0) return;
  await SecureStore.setItemAsync(KEY_LAST_MANUAL_HOST, value);
}

/** The last successfully-paired manual address, or null if none. */
export async function getRememberedManualHost(): Promise<string | null> {
  const value = await SecureStore.getItemAsync(KEY_LAST_MANUAL_HOST);
  return value && value.length > 0 ? value : null;
}

/** Forget the remembered host (e.g. on full disconnect / reset). */
export async function clearRememberedManualHost(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_LAST_MANUAL_HOST);
}
