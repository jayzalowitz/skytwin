import * as SecureStore from 'expo-secure-store';

const KEY_WELCOME_SEEN = 'skytwin_welcome_seen';

/**
 * Has the user dismissed the welcome / getting-started tour?
 *
 * Lives in the secure store so it survives app reinstalls on the same
 * device fingerprint without exposing anything sensitive.
 */
export async function hasSeenWelcome(): Promise<boolean> {
  const v = await SecureStore.getItemAsync(KEY_WELCOME_SEEN);
  return v === '1';
}

export async function markWelcomeSeen(): Promise<void> {
  await SecureStore.setItemAsync(KEY_WELCOME_SEEN, '1');
}

/** Test/debug only — reset the flag so the welcome shows again next launch. */
export async function resetWelcome(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_WELCOME_SEEN);
}
