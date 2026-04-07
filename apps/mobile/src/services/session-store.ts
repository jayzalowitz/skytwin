import * as SecureStore from 'expo-secure-store';

const KEY_TOKEN = 'skytwin_session_token';
const KEY_BASE_URL = 'skytwin_base_url';
const KEY_USER_ID = 'skytwin_user_id';

interface Session {
  token: string;
  baseUrl: string;
  userId: string;
}

/**
 * Save a session to the device secure store.
 * All values are encrypted at rest using the OS keychain.
 */
export async function saveSession(
  token: string,
  baseUrl: string,
  userId: string,
): Promise<void> {
  await SecureStore.setItemAsync(KEY_TOKEN, token);
  await SecureStore.setItemAsync(KEY_BASE_URL, baseUrl);
  await SecureStore.setItemAsync(KEY_USER_ID, userId);
}

/**
 * Retrieve the stored session, or null if no session exists.
 */
export async function getSession(): Promise<Session | null> {
  const token = await SecureStore.getItemAsync(KEY_TOKEN);
  const baseUrl = await SecureStore.getItemAsync(KEY_BASE_URL);
  const userId = await SecureStore.getItemAsync(KEY_USER_ID);

  if (!token || !baseUrl || !userId) {
    return null;
  }

  return { token, baseUrl, userId };
}

/**
 * Clear the stored session. Returns the user to the pairing flow.
 */
export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_TOKEN);
  await SecureStore.deleteItemAsync(KEY_BASE_URL);
  await SecureStore.deleteItemAsync(KEY_USER_ID);
}
