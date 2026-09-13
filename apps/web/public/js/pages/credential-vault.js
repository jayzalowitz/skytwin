/**
 * credential-vault.js — Credential vault page.
 *
 * Hash route: #/credential-vault
 *
 * Sections:
 *   - Status card (initialized / unlocked / key version / last rotated)
 *   - Init form (shown when not initialized)
 *   - Rotate form (current passphrase + new passphrase + confirm)
 *   - Lock button (when unlocked)
 *
 * Uses the singleton-delegator pattern with a hash-route gate.
 * The `_credentialVaultListenerWired` guard ensures the delegator is attached
 * exactly once regardless of how many times renderCredentialVault is called.
 */

import { fetchJSON, escapeHtml } from '../api-client.js';
import { showToast } from '../toast.js';
import { getEffectiveUserId } from '../sample-session.js';

// ─── Desktop secure-storage passphrase bridge (#401) ───────────────────────
// On the desktop app, `window.skytwinDesktop` exposes a passphrase store backed
// by Electron safeStorage only when a reviewed secure OS credential backend is
// active. In pure-web mode these are all no-ops, so the page falls back to the
// per-session passphrase prompt with no behavioral change.

function desktopBridge() {
  return (typeof window !== 'undefined' && window.skytwinDesktop?.isDesktop)
    ? window.skytwinDesktop
    : null;
}

/** Whether "remember on this device" has a secure desktop storage backend. */
async function rememberSupported() {
  const bridge = desktopBridge();
  if (!bridge?.vaultPassphraseSupported) return false;
  try {
    return await bridge.vaultPassphraseSupported();
  } catch {
    return false;
  }
}

/** Persist the passphrase through secure desktop storage. Returns true on success. */
async function rememberPassphrase(userId, passphrase) {
  const bridge = desktopBridge();
  if (!bridge?.vaultPassphraseRemember) return false;
  try {
    const result = await bridge.vaultPassphraseRemember(userId, passphrase);
    return result?.ok === true;
  } catch {
    return false;
  }
}

/** Read the remembered passphrase for this user, or null if none/unsupported. */
async function getRememberedPassphrase(userId) {
  const bridge = desktopBridge();
  if (!bridge?.vaultPassphraseGet) return null;
  try {
    const result = await bridge.vaultPassphraseGet(userId);
    return result?.ok === true ? result.passphrase : null;
  } catch {
    return null;
  }
}

/** Whether a remembered passphrase exists for this user. */
async function hasRememberedPassphrase(userId) {
  const bridge = desktopBridge();
  if (!bridge?.vaultPassphraseHas) return false;
  try {
    return await bridge.vaultPassphraseHas(userId);
  } catch {
    return false;
  }
}

/** Forget the remembered passphrase. */
async function forgetPassphrase(userId) {
  const bridge = desktopBridge();
  if (!bridge?.vaultPassphraseForget) return;
  try {
    await bridge.vaultPassphraseForget(userId);
  } catch {
    // best-effort
  }
}

/**
 * After a successful init/unlock, offer to remember the passphrase on this
 * device. Only prompts on desktop where secure OS credential storage is
 * available and a passphrase isn't already remembered.
 */
async function maybeOfferRemember(userId, passphrase) {
  if (!userId || !passphrase) return;
  if (!(await rememberSupported())) return;
  if (await hasRememberedPassphrase(userId)) return;
  const yes = window.confirm(
    'Remember this passphrase on this device?\n\n'
    + 'A protected copy will be stored using this device\'s secure OS credential '
    + 'storage so the preparatory vault key state can unlock next time. Unlocking '
    + 'passes it through the desktop UI to SkyTwin\'s local API process.',
  );
  if (!yes) return;
  const ok = await rememberPassphrase(userId, passphrase);
  showToast(ok ? 'Passphrase remembered on this device' : 'Could not save to secure device storage', ok ? 'success' : 'error');
}

// ─── Singleton delegator ───────────────────────────────────────────────────

let _credentialVaultListenerWired = false;

function ensureCredentialVaultListener() {
  if (_credentialVaultListenerWired) return;
  _credentialVaultListenerWired = true;

  document.addEventListener('click', async (e) => {
    const currentPage = window.location.hash.split('?')[0];
    if (currentPage !== '#/credential-vault') return;

    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const userId = getCurrentUserId();

    if (action === 'vault-init') {
      const passphrase = document.getElementById('vault-init-passphrase')?.value ?? '';
      const confirm = document.getElementById('vault-init-confirm')?.value ?? '';

      if (!passphrase || !confirm) {
        showToast('Please fill in both fields', 'error');
        return;
      }
      if (passphrase !== confirm) {
        showToast('Passphrases do not match', 'error');
        return;
      }

      try {
        await fetchJSON(`/api/credential-vault/init`, {
          method: 'POST',
          body: JSON.stringify({ passphrase, userId }),
        });
        showToast('Vault initialized and unlocked');
        await maybeOfferRemember(userId, passphrase);
        const container = document.getElementById('page-content');
        if (container) await renderCredentialVault(container, userId);
      } catch (err) {
        showToast(err.friendlyMessage ?? 'Failed to initialize vault', 'error');
      }
      return;
    }

    if (action === 'vault-rotate') {
      const current = document.getElementById('vault-rotate-current')?.value ?? '';
      const next = document.getElementById('vault-rotate-new')?.value ?? '';
      const confirm = document.getElementById('vault-rotate-confirm')?.value ?? '';

      if (!current || !next || !confirm) {
        showToast('Please fill in all fields', 'error');
        return;
      }
      if (next !== confirm) {
        showToast('New passphrases do not match', 'error');
        return;
      }

      try {
        const data = await fetchJSON(`/api/credential-vault/rotate`, {
          method: 'POST',
          body: JSON.stringify({
            currentPassphrase: current,
            newPassphrase: next,
            userId,
          }),
        });
        showToast(
          `Passphrase rotated. ${data.tokensReencrypted} token(s) re-encrypted. Key version: ${data.keyVersion}`,
        );
        // Clear form fields
        const currentEl = document.getElementById('vault-rotate-current');
        const newEl = document.getElementById('vault-rotate-new');
        const confirmEl = document.getElementById('vault-rotate-confirm');
        if (currentEl) currentEl.value = '';
        if (newEl) newEl.value = '';
        if (confirmEl) confirmEl.value = '';
        const container = document.getElementById('page-content');
        if (container) await renderCredentialVault(container, userId);
      } catch (err) {
        showToast(err.friendlyMessage ?? 'Rotation failed', 'error');
      }
      return;
    }

    if (action === 'vault-lock') {
      try {
        await fetchJSON(`/api/credential-vault/lock`, { method: 'POST', body: JSON.stringify({ userId }) });
        showToast('Vault locked');
        const container = document.getElementById('page-content');
        if (container) await renderCredentialVault(container, userId);
      } catch (err) {
        showToast(err.friendlyMessage ?? 'Failed to lock vault', 'error');
      }
      return;
    }

    if (action === 'vault-unlock') {
      const passphrase = document.getElementById('vault-unlock-passphrase')?.value ?? '';
      if (!passphrase) {
        showToast('Please enter your passphrase', 'error');
        return;
      }
      try {
        await fetchJSON(`/api/credential-vault/unlock`, {
          method: 'POST',
          body: JSON.stringify({ passphrase, userId }),
        });
        showToast('Vault unlocked');
        await maybeOfferRemember(userId, passphrase);
        const container = document.getElementById('page-content');
        if (container) await renderCredentialVault(container, userId);
      } catch (err) {
        showToast(err.friendlyMessage ?? 'Failed to unlock vault', 'error');
      }
      return;
    }

    if (action === 'vault-forget-passphrase') {
      const ok = window.confirm(
        'Forget the passphrase saved on this device?\n\n'
        + 'You will need to type it again next time you unlock the vault.',
      );
      if (!ok) return;
      await forgetPassphrase(userId);
      showToast('Removed the remembered passphrase from this device');
      const container = document.getElementById('page-content');
      if (container) await renderCredentialVault(container, userId);
      return;
    }
  });
}

function getCurrentUserId() {
  return getEffectiveUserId();
}

/**
 * Render the credential vault page into `container`.
 */
export async function renderCredentialVault(container, userId) {
  ensureCredentialVaultListener();

  let status = null;
  try {
    status = await fetchJSON(`/api/credential-vault/status?userId=${encodeURIComponent(userId)}`);
  } catch {
    container.innerHTML = `<div class="card">
      <div class="card-header"><span class="card-title">Credential Vault</span></div>
      <p style="color:var(--error)">Unable to load vault status. The API may be offline.</p>
    </div>`;
    return;
  }

  const initialized = status?.initialized ?? false;
  let unlocked = status?.unlocked ?? false;
  const keyVersion = status?.keyVersion ?? null;
  const lastRotated = status?.lastRotated ?? null;

  // Desktop auto-unlock (#401): if the preparatory key state is initialized +
  // locked and the user opted to remember the passphrase on this device,
  // restore it from secure desktop storage and unlock silently. This does not
  // migrate or decrypt plaintext OAuth rows. A corrupt/wrong remembered
  // passphrase falls through to the manual unlock form below.
  const remembered = await hasRememberedPassphrase(userId);
  if (initialized && !unlocked && remembered) {
    const passphrase = await getRememberedPassphrase(userId);
    if (passphrase) {
      try {
        await fetchJSON(`/api/credential-vault/unlock`, {
          method: 'POST',
          body: JSON.stringify({ passphrase, userId }),
        });
        unlocked = true;
        showToast('Vault unlocked from this device');
      } catch {
        // Remembered passphrase no longer valid (e.g. rotated elsewhere).
        // Drop it so we stop auto-retrying, and fall back to the prompt.
        await forgetPassphrase(userId);
      }
    }
  }

  const statusBadge = initialized
    ? `<span style="color:var(--success);font-weight:600;">Initialized</span>`
    : `<span style="color:var(--muted)">Not initialized</span>`;

  const lockBadge = initialized
    ? (unlocked
      ? `<span style="color:var(--success);font-weight:600;">Unlocked</span>`
      : `<span style="color:var(--warning)">Locked</span>`)
    : '';

  const keyVersionDisplay = keyVersion != null
    ? `<span>Key version: <strong>${escapeHtml(String(keyVersion))}</strong></span>`
    : '';

  const lastRotatedDisplay = lastRotated
    ? `<span>Last rotated: ${escapeHtml(new Date(lastRotated).toLocaleString())}</span>`
    : '';

  const initSection = !initialized ? `
    <div class="card" style="margin-top:1rem;">
      <div class="card-header">
        <span class="card-title">Initialize vault</span>
      </div>
      <div class="card-subtitle" style="margin-bottom:1rem;">
        Create preparatory API-local vault key state. This does not encrypt current OAuth token
        rows or new OAuth grants. The API stores a passphrase verifier; the desktop stores a
        protected passphrase copy only if you separately choose Remember on this device and a
        secure OS credential backend is available.
      </div>
      <div class="form-group">
        <label for="vault-init-passphrase">Passphrase (min 12 characters)</label>
        <input class="form-input" id="vault-init-passphrase" type="password"
               autocomplete="new-password" placeholder="Enter passphrase">
      </div>
      <div class="form-group">
        <label for="vault-init-confirm">Confirm passphrase</label>
        <input class="form-input" id="vault-init-confirm" type="password"
               autocomplete="new-password" placeholder="Confirm passphrase">
      </div>
      <button class="btn btn-primary" data-action="vault-init">Initialize vault</button>
    </div>
  ` : '';

  const unlockSection = initialized && !unlocked ? `
    <div class="card" style="margin-top:1rem;">
      <div class="card-header">
        <span class="card-title">Unlock vault</span>
      </div>
      <div class="card-subtitle" style="margin-bottom:1rem;">
        Unlock the preparatory API-local key cache for this session. This does not decrypt or
        migrate OAuth tokens written by current production paths.
      </div>
      <div class="form-group">
        <label for="vault-unlock-passphrase">Passphrase</label>
        <input class="form-input" id="vault-unlock-passphrase" type="password"
               autocomplete="current-password" placeholder="Enter passphrase">
      </div>
      <button class="btn btn-primary" data-action="vault-unlock">Unlock</button>
    </div>
  ` : '';

  const lockSection = initialized && unlocked ? `
    <div style="margin-top:0.75rem;">
      <button class="btn btn-outline btn-sm" data-action="vault-lock">Lock vault</button>
    </div>
  ` : '';

  const rotateSection = initialized ? `
    <div class="card" style="margin-top:1rem;">
      <div class="card-header">
        <span class="card-title">Rotate passphrase</span>
      </div>
      <div class="card-subtitle" style="margin-bottom:1rem;">
        Change the key used by OAuth rows that are already encrypted, if any. Plaintext OAuth
        rows are not encrypted by this operation, and new grants still use the current plaintext
        write path. If rotation fails, the original passphrase continues to work for the
        preparatory key state.
      </div>
      <div class="form-group">
        <label for="vault-rotate-current">Current passphrase</label>
        <input class="form-input" id="vault-rotate-current" type="password"
               autocomplete="current-password" placeholder="Current passphrase">
      </div>
      <div class="form-group">
        <label for="vault-rotate-new">New passphrase (min 12 characters)</label>
        <input class="form-input" id="vault-rotate-new" type="password"
               autocomplete="new-password" placeholder="New passphrase">
      </div>
      <div class="form-group">
        <label for="vault-rotate-confirm">Confirm new passphrase</label>
        <input class="form-input" id="vault-rotate-confirm" type="password"
               autocomplete="new-password" placeholder="Confirm new passphrase">
      </div>
      <button class="btn btn-primary" data-action="vault-rotate">Rotate passphrase</button>
    </div>
  ` : '';

  // Re-check after the auto-unlock attempt above (which forgets a stale entry).
  const rememberedNow = initialized ? await hasRememberedPassphrase(userId) : false;
  const rememberSection = rememberedNow ? `
    <div style="margin-top:0.5rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
      <span style="color:var(--muted)">Preparatory vault passphrase protected by this device's secure credential storage.</span>
      <button class="btn btn-outline btn-sm" data-action="vault-forget-passphrase">Forget on this device</button>
    </div>
  ` : '';

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Credential Vault</span>
      </div>
      <div class="card-subtitle" style="margin-bottom:0.5rem;">
        <strong style="color:var(--danger)">OAuth token encryption is not active in this build.</strong>
        Current production OAuth write paths store access and refresh tokens in plaintext.
        These controls manage preparatory API-local key state only. Protect the database with
        full-disk encryption until the production token path is migrated and verified.
      </div>
      <div style="display:flex;flex-direction:column;gap:0.25rem;">
        <div>Preparatory key state: ${statusBadge} ${lockBadge}</div>
        ${keyVersionDisplay}
        ${lastRotatedDisplay}
      </div>
      ${lockSection}
      ${rememberSection}
    </div>
    ${initSection}
    ${unlockSection}
    ${rotateSection}
  `;
}
