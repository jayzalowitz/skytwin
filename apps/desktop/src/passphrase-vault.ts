/**
 * passphrase-vault.ts — OS-keychain-backed "remember my passphrase" store (#401).
 *
 * The credential vault (`@skytwin/credential-vault`) encrypts OAuth tokens at
 * rest with a scrypt-derived key. The derived key lives only in the API
 * process's in-memory KeyCache, so the user must re-type their vault passphrase
 * on every restart. This module lets the desktop app optionally remember that
 * passphrase on the *local device* — and only the local device — so a relaunch
 * can unlock the vault without a re-prompt.
 *
 * SECURITY MODEL
 * ──────────────
 * The passphrase is encrypted with Electron `safeStorage`, which is backed by
 * the OS-native secret store:
 *   - macOS   → Keychain
 *   - Windows → DPAPI (Credential Manager)
 *   - Linux   → Secret Service (libsecret) / kwallet
 * The resulting ciphertext (NOT the plaintext) is persisted via the injected
 * key-value store (electron-store in production, in the OS userData dir). Even
 * with filesystem access to that store, the ciphertext is only decryptable on
 * the same machine + user account that wrote it.
 *
 * GRACEFUL FALLBACK (AC: "if no, current behavior unchanged")
 * ───────────────────────────────────────────────────────────
 * On a headless Linux box, a freshly-installed distro with no Secret Service,
 * or any environment where `safeStorage.isEncryptionAvailable()` is false, we
 * MUST NOT persist the passphrase in plaintext. Instead every operation returns
 * a typed `{ ok: false, reason: 'unsupported' }` and the renderer keeps the
 * current behavior (prompt for the passphrase every session). We never weaken
 * the boundary to a plaintext fallback.
 *
 * The class is dependency-injected (ports for safeStorage + the key-value
 * store) so the core logic is unit-testable without spawning Electron.
 */

/** The subset of Electron's `safeStorage` this module depends on. */
export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

/**
 * The subset of a key-value store (electron-store) this module depends on.
 * Values are base64-encoded safeStorage ciphertext strings.
 */
export interface PassphraseKeyValueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
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

function storeKeyFor(userId: string): string {
  return `${STORE_KEY_PREFIX}${userId}`;
}

export class PassphraseVault {
  private readonly safeStorage: SafeStoragePort;
  private readonly store: PassphraseKeyValueStore;

  constructor(safeStorage: SafeStoragePort, store: PassphraseKeyValueStore) {
    this.safeStorage = safeStorage;
    this.store = store;
  }

  /**
   * Whether remembering the passphrase is supported on this device. False on
   * platforms / environments where the OS secret store is unavailable (the
   * renderer hides the "Remember on this device?" prompt in that case).
   */
  isSupported(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable();
    } catch {
      // Some Electron builds throw rather than return false when the platform
      // backend is missing. Treat any failure as "not supported" — fail safe.
      return false;
    }
  }

  /**
   * Encrypt + persist `passphrase` for `userId`. No-op-safe to call repeatedly
   * (overwrites the previous ciphertext). Returns a typed failure when the OS
   * secret store is unavailable or the passphrase is empty — never stores
   * plaintext as a fallback.
   */
  remember(userId: string, passphrase: string): RememberWriteResult {
    if (!this.isSupported()) {
      return { ok: false, reason: 'unsupported' };
    }
    if (passphrase.length === 0) {
      // Refuse to persist an empty passphrase — that's never a real unlock
      // secret and would silently "unlock" with nothing.
      return { ok: false, reason: 'empty_passphrase' };
    }
    const ciphertext = this.safeStorage.encryptString(passphrase);
    this.store.set(storeKeyFor(userId), ciphertext.toString('base64'));
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
    if (!this.isSupported()) {
      return { ok: false, reason: 'unsupported' };
    }
    const stored = this.store.get(storeKeyFor(userId));
    if (stored === undefined || stored === '') {
      return { ok: false, reason: 'not_found' };
    }
    try {
      const ciphertext = Buffer.from(stored, 'base64');
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
    const stored = this.store.get(storeKeyFor(userId));
    return stored !== undefined && stored !== '';
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
