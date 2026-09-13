import { KeyCache } from '@skytwin/credential-vault';

/** Worker-local cache; remains empty until cross-process unlock IPC is implemented. */
export const workerCredentialKeyCache = new KeyCache({ ttlMs: 60 * 60 * 1000 });
