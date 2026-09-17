/**
 * passphrase-vault.ts — secure-device-backed "remember my passphrase" store (#401).
 *
 * The credential-vault package can encrypt OAuth tokens with a scrypt-derived
 * key, but current production OAuth writes are not wired through that path.
 * Today the derived key lives only in the API process's in-memory KeyCache.
 * This module lets the desktop app optionally remember the preparatory vault
 * passphrase on the *local device* so a relaunch can restore that API-local key
 * state without a re-prompt. It does not make an OAuth-at-rest claim.
 *
 * SECURITY MODEL
 * ──────────────
 * The passphrase is encrypted with Electron `safeStorage` only when it is
 * backed by an OS-native secret store:
 *   - macOS   → Keychain
 *   - Windows → DPAPI (Credential Manager)
 *   - Linux   → Secret Service (libsecret) / KWallet
 * The resulting ciphertext (NOT the plaintext) is persisted via the injected
 * key-value store (electron-store in production, in the OS userData dir). Even
 * with filesystem access to that store, the ciphertext is only decryptable on
 * the same machine + user account that wrote it.
 *
 * GRACEFUL FALLBACK (AC: "if no, current behavior unchanged")
 * ───────────────────────────────────────────────────────────
 * Electron's Linux `basic_text` backend uses a hard-coded password and is not a
 * secret store. On Linux we therefore require one of the reviewed secure
 * backend names in addition to `safeStorage.isEncryptionAvailable()`. Missing,
 * unknown, or `basic_text` backends return a typed
 * `{ ok: false, reason: 'unsupported' }`. We never weaken the boundary to that
 * fallback.
 *
 * The class is dependency-injected (ports for safeStorage + the key-value
 * store) so the core logic is unit-testable without spawning Electron.
 */

import { resolveSecureStorageBackend, type SecureStorageBackendPort } from './secure-storage-backend.js';

/** The subset of Electron's `safeStorage` this module depends on. */
export interface SafeStoragePort extends SecureStorageBackendPort {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

/**
 * The subset of a key-value store (electron-store) this module depends on.
 * Values are JSON records containing a version, backend identity, and
 * base64-encoded safeStorage ciphertext.
 */
export interface PassphraseKeyValueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(): string[];
}

/** Result of an attempt to read a remembered passphrase. */
export type RememberedPassphraseResult =
  | { ok: true; passphrase: string }
  | { ok: false; reason: 'unsupported' | 'not_found' | 'corrupt' };

/** Result of an attempt to remember / forget a passphrase. */
export type RememberWriteResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'empty_passphrase' };

/**
 * Storage-key prefix. Per-user so multiple device accounts each keep their own
 * remembered passphrase without clobbering each other.
 */
const STORE_KEY_PREFIX = 'vault-passphrase:';
const STORED_RECORD_VERSION = 1;

interface StoredPassphraseRecord {
  version: typeof STORED_RECORD_VERSION;
  backend: string;
  ciphertext: string;
}

function storeKeyFor(userId: string): string {
  return `${STORE_KEY_PREFIX}${userId}`;
}

function parseStoredRecord(value: string): StoredPassphraseRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.version !== STORED_RECORD_VERSION
      || typeof candidate.backend !== 'string'
      || candidate.backend === ''
      || typeof candidate.ciphertext !== 'string'
      || candidate.ciphertext === ''
    ) {
      return null;
    }
    return {
      version: STORED_RECORD_VERSION,
      backend: candidate.backend,
      ciphertext: candidate.ciphertext,
    };
  } catch {
    return null;
  }
}

export class PassphraseVault {
  private readonly safeStorage: SafeStoragePort;
  private readonly store: PassphraseKeyValueStore;
  private readonly platform: NodeJS.Platform;

  constructor(
    safeStorage: SafeStoragePort,
    store: PassphraseKeyValueStore,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.safeStorage = safeStorage;
    this.store = store;
    this.platform = platform;
  }

  /**
   * Whether remembering the passphrase is supported on this device. False on
   * platforms / environments where the OS secret store is unavailable (the
   * renderer hides the "Remember on this device?" prompt in that case).
   */
  isSupported(): boolean {
    return this.currentBackend() !== null;
  }

  /**
   * Remove records that cannot be proven to have been written by the secure
   * backend selected for this process. Call this once after Electron's `ready`
   * event so Linux backend discovery has completed.
   *
   * Pre-v1 values were bare base64 strings and did not record which backend
   * wrote them. They are deliberately deleted without attempting decryption:
   * an older release may have created them through Linux `basic_text`.
   */
  purgeUntrustedEntries(): number {
    const backend = this.currentBackend();
    let removed = 0;
    for (const key of this.store.keys()) {
      if (!key.startsWith(STORE_KEY_PREFIX)) continue;
      const stored = this.store.get(key);
      const record = stored === undefined ? null : parseStoredRecord(stored);
      if (backend === null || record === null || record.backend !== backend) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private currentBackend(): string | null {
    return resolveSecureStorageBackend(this.safeStorage, this.platform);
  }

  /**
   * Encrypt + persist `passphrase` for `userId`. No-op-safe to call repeatedly
   * (overwrites the previous ciphertext). Returns a typed failure when the OS
   * secret store is unavailable or the passphrase is empty — never stores
   * plaintext as a fallback.
   */
  remember(userId: string, passphrase: string): RememberWriteResult {
    const backend = this.currentBackend();
    if (backend === null) {
      return { ok: false, reason: 'unsupported' };
    }
    if (passphrase.length === 0) {
      // Refuse to persist an empty passphrase — that's never a real unlock
      // secret and would silently "unlock" with nothing.
      return { ok: false, reason: 'empty_passphrase' };
    }
    const ciphertext = this.safeStorage.encryptString(passphrase);
    const record: StoredPassphraseRecord = {
      version: STORED_RECORD_VERSION,
      backend,
      ciphertext: ciphertext.toString('base64'),
    };
    this.store.set(storeKeyFor(userId), JSON.stringify(record));
    return { ok: true };
  }

  /**
   * Decrypt the remembered passphrase for `userId`, if any. Returns a typed
   * failure when unsupported, absent, or undecryptable (e.g. the keychain
   * entry was rotated out from under us, or the store was copied to a
   * different machine). On a `corrupt` result the caller should fall back to
   * the passphrase prompt; we proactively evict the bad entry.
   */
  getRemembered(userId: string): RememberedPassphraseResult {
    const backend = this.currentBackend();
    if (backend === null) {
      // A previous build may have persisted through Linux `basic_text`.
      // Discard that entry instead of leaving a recoverable passphrase behind.
      this.forget(userId);
      return { ok: false, reason: 'unsupported' };
    }
    const stored = this.store.get(storeKeyFor(userId));
    if (stored === undefined || stored === '') {
      return { ok: false, reason: 'not_found' };
    }
    const record = parseStoredRecord(stored);
    if (record === null || record.backend !== backend) {
      this.forget(userId);
      return { ok: false, reason: 'corrupt' };
    }
    try {
      const ciphertext = Buffer.from(record.ciphertext, 'base64');
      const passphrase = this.safeStorage.decryptString(ciphertext);
      if (passphrase.length === 0) {
        // Decrypted to nothing — treat as corrupt rather than handing back an
        // empty unlock secret.
        this.forget(userId);
        return { ok: false, reason: 'corrupt' };
      }
      return { ok: true, passphrase };
    } catch {
      // Undecryptable on this machine/account — drop it so we stop retrying a
      // permanently-broken entry, and fall back to the prompt.
      this.forget(userId);
      return { ok: false, reason: 'corrupt' };
    }
  }

  /** Whether a remembered passphrase exists for `userId` (does not decrypt). */
  has(userId: string): boolean {
    const backend = this.currentBackend();
    if (backend === null) {
      this.forget(userId);
      return false;
    }
    const stored = this.store.get(storeKeyFor(userId));
    if (stored === undefined || stored === '') return false;
    const record = parseStoredRecord(stored);
    if (record === null || record.backend !== backend) {
      this.forget(userId);
      return false;
    }
    return true;
  }

  /**
   * Forget the remembered passphrase for `userId`. Idempotent — safe to call
   * when nothing is stored. Works regardless of `isSupported()` so a user can
   * always clear a stale entry.
   */
  forget(userId: string): void {
    this.store.delete(storeKeyFor(userId));
  }
}
