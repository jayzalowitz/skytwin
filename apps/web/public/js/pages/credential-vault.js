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
import { KEY_USER_ID } from '../storage-keys.js';

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
          body: JSON.stringify({ passphrase }),
        });
        showToast('Vault initialized and unlocked');
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
        await fetchJSON(`/api/credential-vault/lock`, { method: 'POST' });
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
          body: JSON.stringify({ passphrase }),
        });
        showToast('Vault unlocked');
        const container = document.getElementById('page-content');
        if (container) await renderCredentialVault(container, userId);
      } catch (err) {
        showToast(err.friendlyMessage ?? 'Failed to unlock vault', 'error');
      }
      return;
    }
  });
}

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
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
  const unlocked = status?.unlocked ?? false;
  const keyVersion = status?.keyVersion ?? null;
  const lastRotated = status?.lastRotated ?? null;

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
        Set a passphrase to encrypt your stored OAuth tokens. The passphrase is never stored —
        only a verification hash is kept. You will need to unlock the vault each session.
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
        Enter your passphrase to decrypt your OAuth tokens for this session.
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
        Change your vault passphrase. All encrypted OAuth tokens will be re-encrypted
        with the new key inside a single atomic transaction. If anything fails the
        original passphrase continues to work.
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

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Credential Vault</span>
      </div>
      <div class="card-subtitle" style="margin-bottom:0.5rem;">
        OAuth tokens are encrypted at rest using AES-256-GCM with a key derived from
        your passphrase via scrypt.
      </div>
      <div style="display:flex;flex-direction:column;gap:0.25rem;">
        <div>Status: ${statusBadge} ${lockBadge}</div>
        ${keyVersionDisplay}
        ${lastRotatedDisplay}
      </div>
      ${lockSection}
    </div>
    ${initSection}
    ${unlockSection}
    ${rotateSection}
  `;
}
