import { fetchJSON, escapeHtml } from '../api-client.js';
import { getEffectiveUserId } from '../sample-session.js';
import { isGoogleAccountIntegration } from '../google-preview-boundary.js';

// Module-level sync lookup for dynamic integration card rendering
let _syncLookup = {};

/**
 * Render the service setup page.
 *
 * Design goals:
 * - IronClaw and OpenClaw auto-detect; show their live status, not setup forms
 * - Google account setup is visibly unavailable on the preview surface
 * - Advanced override section for IronClaw/OpenClaw (collapsed by default)
 */
export async function renderSetup(container, _userId) {
  let status = null;
  let credentials = [];
  let schema = null;
  let ironclawSync = null;

  try {
    const [statusResult, credsResult, schemaResult, ironclawSyncResult] = await Promise.allSettled([
      fetchJSON('/api/credentials/status'),
      fetchJSON('/api/credentials'),
      fetchJSON('/api/credentials/schema'),
      fetchJSON('/api/credentials/ironclaw-status'),
    ]);
    status = statusResult.status === 'fulfilled' ? statusResult.value : null;
    credentials = credsResult.status === 'fulfilled' ? (credsResult.value?.credentials ?? []) : [];
    schema = schemaResult.status === 'fulfilled' ? schemaResult.value : null;
    ironclawSync = ironclawSyncResult.status === 'fulfilled' ? ironclawSyncResult.value : null;
  } catch { /* empty */ }

  // Build credential lookup
  const credLookup = {};
  for (const cred of credentials) {
    if (!credLookup[cred.service]) credLookup[cred.service] = {};
    credLookup[cred.service][cred.credentialKey] = cred;
  }
  buildSyncLookup(ironclawSync);

  const ironclaw = status?.adapters?.ironclaw ?? { registered: false, healthy: false, url: '' };
  const openclaw = status?.adapters?.openclaw ?? { registered: false, healthy: false, url: '' };
  const direct = status?.adapters?.direct ?? { registered: true, healthy: true, url: 'local' };

  // Friendly summary of what's working under the hood. We don't name the
  // adapters; the user just needs to know "yes, your twin can do things".
  const anyEngineHealthy = (ironclaw.registered && ironclaw.healthy)
    || (direct.registered && direct.healthy)
    || (openclaw.registered && openclaw.healthy);

  container.innerHTML = `
    <div class="card" style="border-left: 3px solid var(--primary); background: linear-gradient(135deg, var(--bg-card) 0%, var(--bg) 100%);">
      <div class="card-header">
        <span class="card-title">Let's connect your twin to your life</span>
      </div>
      <div class="card-subtitle">
        Review the integrations available in this preview. The isolated sample
        remains the supported way to explore the decision loop without an account.
      </div>
      <div style="margin-top: 0.75rem; display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.85rem;">
        <span style="display: inline-flex; align-items: center; gap: 0.4rem;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim);"></span>
          Gmail and Google Calendar unavailable
        </span>
        <span style="display: inline-flex; align-items: center; gap: 0.4rem;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: ${anyEngineHealthy ? 'var(--success)' : 'var(--warning, #e6a700)'};"></span>
          Twin ${anyEngineHealthy ? 'is ready to act on your behalf' : 'is still warming up'}
        </span>
      </div>
    </div>

    <div class="card" id="google-setup-card">
      <div class="card-header" style="display: flex; justify-content: space-between; align-items: center;">
        <span class="card-title">Google (Gmail + Calendar)</span>
        <span style="color: var(--text-dim); font-weight: 600; font-size: 0.85rem;">Unavailable in preview</span>
      </div>
      <div class="card-subtitle" style="line-height: 1.7;">
        Google account connection and credential entry are disabled on this preview surface.
        SkyTwin will not ask for a Google client ID, client secret, or account grant here.
      </div>
    </div>

    <!-- ── What's next ── -->

    <div class="card">
      <div class="card-header">
        <span class="card-title">What happens next</span>
      </div>
      <div class="card-subtitle" style="line-height: 1.7;">
        Try the account-free sample to inspect fictional decisions, policy results,
        explanations, and corrections without granting access to a real account.
      </div>
      <a class="btn btn-primary" href="#/sample">Open the sample</a>
    </div>

    <!-- ── Dynamic integrations from adapters ── -->
    ${renderDynamicIntegrations(schema?.integrations ?? {}, credLookup)}

    <!-- ── Advanced: manual overrides for execution engines ── -->

    <details class="card collapsible-card">
      <summary class="card-header collapsible-header">
        <span class="card-title">Advanced — how SkyTwin actually runs your actions</span>
        <span class="collapse-icon"></span>
      </summary>
      <div class="collapsible-body">
        <div class="card-subtitle" style="margin-bottom: 1rem;">
          When your twin decides to do something, it routes that action through one of the engines
          below. They auto-detect when running on your machine — you only need this section if
          you're swapping in a hosted server or debugging a connection.
        </div>

        <div style="margin-bottom: 1.25rem;">
          <div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 0.5rem;">Live status</div>
          ${renderAdapterStatus('Sandboxed execution server (IronClaw)', ironclaw, 'Highest trust — actions are sandboxed, audited, and reversible. Auto-detects on localhost:4000.', true)}
          ${renderAdapterStatus('Built-in handlers', direct, 'Local handlers are available where required account connections are supported. Gmail and Google Calendar actions are unavailable in this preview.')}
          ${renderAdapterStatus('Local-AI execution (OpenClaw)', openclaw, 'Community engine that uses a local LLM for broader skills. Optional.', true)}
          <div style="margin-top: 0.5rem; font-size: 0.8rem; color: var(--text-muted);">
            Your twin automatically picks the most trusted engine that's available and falls back if one is down.
          </div>
        </div>

        <div style="margin-bottom: 1.5rem;">
          <div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 0.25rem;">Sandboxed execution server (IronClaw)</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            Only set these if you're pointing your twin at a remote IronClaw — the local one is auto-discovered.
          </div>
          <div class="form-group" style="margin-bottom: 0.5rem;">
            <label>API URL</label>
            <input class="form-input" type="text" id="cred-ironclaw-api_url"
              placeholder="http://localhost:4000"
              value="${escapeHtml(credLookup['ironclaw']?.['api_url']?.credentialValue ?? '')}"
              data-service="ironclaw" data-key="api_url" autocomplete="off">
          </div>
          <div class="form-group" style="margin-bottom: 0.5rem;">
            <label>Webhook Secret</label>
            <input class="form-input" type="password" id="cred-ironclaw-webhook_secret"
              placeholder="HMAC shared secret"
              value=""
              data-service="ironclaw" data-key="webhook_secret" autocomplete="off">
            ${credLookup['ironclaw']?.['webhook_secret']?.hasValue ? '<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Currently set. Leave blank to keep.</div>' : ''}
          </div>
          <div class="form-group" style="margin-bottom: 0.5rem;">
            <label>Owner ID</label>
            <input class="form-input" type="text" id="cred-ironclaw-owner_id"
              placeholder="skytwin-default"
              value="${escapeHtml(credLookup['ironclaw']?.['owner_id']?.credentialValue ?? '')}"
              data-service="ironclaw" data-key="owner_id" autocomplete="off">
          </div>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <button class="btn btn-outline btn-sm" data-save-service="ironclaw">Save connection</button>
            <span id="save-status-ironclaw" style="font-size: 0.85rem;"></span>
          </div>
        </div>

        <div>
          <div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 0.25rem;">Local-AI execution (OpenClaw)</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            Optional. Only fill this in if you're running OpenClaw on a different machine.
          </div>
          <div class="form-group" style="margin-bottom: 0.5rem;">
            <label>API URL</label>
            <input class="form-input" type="text" id="cred-openclaw-api_url"
              placeholder="http://localhost:3456"
              value="${escapeHtml(credLookup['openclaw']?.['api_url']?.credentialValue ?? '')}"
              data-service="openclaw" data-key="api_url" autocomplete="off">
          </div>
          <div class="form-group" style="margin-bottom: 0.5rem;">
            <label>API Key <span style="color: var(--text-muted); font-weight: 400;">(optional)</span></label>
            <input class="form-input" type="password" id="cred-openclaw-api_key"
              placeholder="API key"
              value=""
              data-service="openclaw" data-key="api_key" autocomplete="off">
            ${credLookup['openclaw']?.['api_key']?.hasValue ? '<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Currently set. Leave blank to keep.</div>' : ''}
          </div>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <button class="btn btn-outline btn-sm" data-save-service="openclaw">Save connection</button>
            <span id="save-status-openclaw" style="font-size: 0.85rem;"></span>
          </div>
        </div>

        <div style="margin-top: 1rem; padding: 0.75rem; background: var(--bg); border-radius: var(--radius-sm); font-size: 0.8rem; color: var(--text-muted);">
          <strong>Note:</strong> Overrides saved here are stored in the database. They take effect on the next server restart
          (the execution engines are initialized once at startup). Environment variables still take precedence if set.
        </div>
      </div>
    </details>
  `;

  // Bind dynamic integration save buttons via event delegation (avoids XSS
  // risk from inline onclick with user-controlled service keys)
  container.querySelectorAll('button[data-save-service]').forEach(btn => {
    btn.addEventListener('click', () => {
      const service = btn.getAttribute('data-save-service');
      if (!service) return;
      const autoConnect = btn.getAttribute('data-auto-connect') === 'true';
      window.saveServiceCredentials(service, autoConnect ? { autoConnect: true } : {});
    });
  });
  container.querySelectorAll('button[data-sync-service]').forEach(btn => {
    btn.addEventListener('click', () => {
      const service = btn.getAttribute('data-sync-service');
      if (service) window.syncServiceToIronClaw(service);
    });
  });
}

/**
 * Render integration sections that adapters have dynamically registered.
 * These appear when e.g. OpenClaw adds a skill that needs Twitter API keys.
 */
export function renderDynamicIntegrations(integrations, credLookup) {
  const keys = Object.keys(integrations).filter(
    (key) => !isGoogleAccountIntegration({ key, ...integrations[key] }),
  );
  if (keys.length === 0) return '';

  return keys.map(key => {
    const integ = integrations[key];
    const creds = credLookup[key] || {};
    const allSet = integ.fields.filter(f => !f.optional).every(f => creds[f.key]?.hasValue);
    const serviceKey = key; // e.g. "openclaw:twitter"

    return `
      <div class="card" style="border-left: 3px solid ${allSet ? 'var(--success)' : 'var(--warning, #e6a700)'};">
        <div class="card-header" style="display: flex; justify-content: space-between; align-items: center;">
          <span class="card-title">${escapeHtml(integ.label)}</span>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="font-size: 0.75rem; color: var(--text-muted); background: var(--bg); padding: 0.15rem 0.5rem; border-radius: 10px;">
              via ${escapeHtml(integ.adapter)}
            </span>
            ${allSet
              ? '<span style="color: var(--success); font-weight: 600; font-size: 0.85rem;">Ready</span>'
              : '<span style="color: var(--warning, #e6a700); font-weight: 600; font-size: 0.85rem;">Needs credentials</span>'}
          </div>
        </div>
        ${integ.description ? `<div class="card-subtitle" style="margin-bottom: 0.75rem;">${escapeHtml(integ.description)}</div>` : ''}
        ${integ.skills?.length ? `
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            Enables: ${integ.skills.map(s => `<code style="background: var(--bg); padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.75rem;">${escapeHtml(s)}</code>`).join(' ')}
          </div>
        ` : ''}
        ${integ.fields.map(field => {
          const existing = creds[field.key];
          const hasValue = existing?.hasValue ?? false;
          return `
            <div class="form-group" style="margin-bottom: 0.5rem;">
              <label style="display: flex; justify-content: space-between; align-items: center;">
                <span>${escapeHtml(field.label)}${field.optional ? ' <span style="color: var(--text-muted); font-weight: 400;">(optional)</span>' : ''}</span>
                ${hasValue ? '<span style="font-size: 0.75rem; color: var(--success);">saved</span>' : ''}
              </label>
              <input
                class="form-input"
                type="${field.secret ? 'password' : 'text'}"
                id="cred-${escapeHtml(serviceKey)}-${escapeHtml(field.key)}"
                placeholder="${escapeHtml(field.placeholder || '')}"
                value="${hasValue && field.secret ? '' : escapeHtml(existing?.credentialValue ?? '')}"
                data-service="${escapeHtml(serviceKey)}"
                data-key="${escapeHtml(field.key)}"
                autocomplete="off"
              >
              ${hasValue && field.secret ? '<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Currently set. Leave blank to keep.</div>' : ''}
            </div>
          `;
        }).join('')}
        <div style="display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem;">
          <button class="btn btn-primary btn-sm" data-save-service="${escapeHtml(serviceKey)}">${allSet ? 'Update' : 'Save'}</button>
          <span id="save-status-${escapeHtml(serviceKey)}" style="font-size: 0.85rem;"></span>
        </div>
        ${renderIronClawSyncSummary(serviceKey, _syncLookup || {})}
      </div>
    `;
  }).join('');
}

function buildSyncLookup(ironclawSync) {
  const lookup = {};
  // IronClaw credential-sync only applies when a real, reachable IronClaw is
  // configured. When it's unreachable (the common case: no IronClaw, the local
  // mock, or a remote that's down) syncing is impossible — surface nothing
  // rather than a misleading "Not fully synced to IronClaw" + a "Sync to
  // IronClaw" button that can only fail with a connection error.
  if (ironclawSync?.reachable) {
    for (const row of ironclawSync.credentials ?? []) {
      if (!lookup[row.service]) lookup[row.service] = [];
      lookup[row.service].push(row);
    }
  }
  _syncLookup = lookup;
  return lookup;
}

function renderIronClawSyncSummary(service, syncLookup) {
  if (service === 'ironclaw' || service === 'openclaw') return '';
  const rows = syncLookup[service] || [];
  if (rows.length === 0) return '';
  const syncedCount = rows.filter(row => row.synced).length;
  const allSynced = syncedCount === rows.length;
  const text = allSynced
    ? `Synced to IronClaw (${syncedCount}/${rows.length})`
    : `Not fully synced to IronClaw (${syncedCount}/${rows.length})`;
  const color = allSynced ? 'var(--success)' : 'var(--warning, #e6a700)';

  return `
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-top: 0.75rem; padding: 0.5rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm);">
      <span style="font-size: 0.8rem; color: ${color};">${escapeHtml(text)}</span>
      <button class="btn btn-outline btn-sm" data-sync-service="${escapeHtml(service)}">Sync to IronClaw</button>
    </div>
  `;
}

function renderAdapterStatus(name, adapter, description, optional = false) {
  const dot = adapter.registered && adapter.healthy
    ? '<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--success); margin-right: 0.5rem;"></span>'
    : adapter.registered
      ? '<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--warning, #e6a700); margin-right: 0.5rem;"></span>'
      : '<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); margin-right: 0.5rem;"></span>';

  const statusText = adapter.registered && adapter.healthy
    ? '<span style="color: var(--success); font-size: 0.8rem;">Running</span>'
    : adapter.registered
      ? '<span style="color: var(--warning, #e6a700); font-size: 0.8rem;">Registered but unreachable</span>'
      // An optional adapter that simply isn't set up is not a failure — say so
      // plainly instead of "Not detected" (which reads like something's wrong).
      : optional
        ? '<span style="color: var(--text-muted); font-size: 0.8rem;">Optional — not connected</span>'
        : '<span style="color: var(--text-muted); font-size: 0.8rem;">Not detected</span>';

  const urlText = adapter.url && adapter.url !== 'local'
    ? `<span style="color: var(--text-muted); font-size: 0.75rem; margin-left: 0.5rem;">${escapeHtml(adapter.url)}</span>`
    : '';

  const versionParts = [];
  if (adapter.knownStableVersion) versionParts.push(`stable ${adapter.knownStableVersion}`);
  if (adapter.knownPrereleaseVersion) versionParts.push(`beta ${adapter.knownPrereleaseVersion}`);
  if (adapter.knownVersionCheckedAt) versionParts.push(`checked ${adapter.knownVersionCheckedAt}`);
  const versionText = versionParts.length > 0
    ? `
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.1rem; padding-left: 1rem;">
          ${adapter.knownStableUrl
            ? `<a href="${escapeHtml(adapter.knownStableUrl)}" target="_blank" rel="noreferrer" style="color: inherit;">${escapeHtml(versionParts.join(' · '))}</a>`
            : escapeHtml(versionParts.join(' · '))}
        </div>
      `
    : '';

  return `
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.6rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
      <div style="flex: 1;">
        <div style="display: flex; align-items: center;">
          ${dot}
          <span style="font-weight: 600; font-size: 0.9rem;">${escapeHtml(name)}</span>
          ${urlText}
        </div>
        <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; padding-left: 1rem;">
          ${escapeHtml(description)}
        </div>
        ${versionText}
      </div>
      <div>${statusText}</div>
    </div>
  `;
}

window.saveServiceCredentials = async function(service, opts = {}) {
  const statusEl = document.getElementById(`save-status-${service}`);
  // Collect inputs for this service
  const inputs = document.querySelectorAll(`input[data-service="${service}"]`);

  const credentials = {};
  let hasAny = false;
  for (const input of inputs) {
    const key = input.getAttribute('data-key');
    const value = input.value.trim();
    if (value) {
      credentials[key] = value;
      hasAny = true;
    }
  }

  if (!hasAny) {
    statusEl.innerHTML = '<span style="color: var(--warning, #e6a700);">Enter at least one value</span>';
    setTimeout(() => { statusEl.innerHTML = ''; }, 3000);
    return;
  }

  statusEl.innerHTML = '<span style="color: var(--text-muted);">Saving…</span>';

  try {
    await fetchJSON(`/api/credentials/${service}`, {
      method: 'PUT',
      body: JSON.stringify({ credentials }),
    });

    // For Google, if the caller asked us to connect immediately after
    // saving (the "Save and connect now" path) we kick off OAuth right
    // here so the user goes paste → save → Google sign-in in one motion.
    if (service === 'google' && opts.autoConnect) {
      statusEl.innerHTML = '<span style="color: var(--success);">Saved! Sending you to Google…</span>';
      try {
        const userId = getEffectiveUserId();
        const { startGoogleSignIn } = await import('../google-signin.js');
        const result = await startGoogleSignIn({ userId, onComplete: reRenderSetupOnConnect });
        if (result.status === 'redirecting' || result.status === 'polling') return;
        if (result.status === 'error') throw new Error(result.error || 'sign-in failed');
      } catch (err) {
        statusEl.innerHTML = `<span style="color: var(--warning, #e6a700);">Saved, but couldn't start sign-in: ${escapeHtml(err.message || 'try the Connect button below.')}</span>`;
      }
    } else {
      statusEl.innerHTML = '<span style="color: var(--success);">Saved!</span>';
    }

    // Re-render to update status badges
    setTimeout(async () => {
      const { renderSetup } = await import('./setup.js');
      await renderSetup(document.getElementById('page-content'), getEffectiveUserId());
    }, 800);
  } catch (err) {
    statusEl.innerHTML = `<span style="color: var(--danger);">${escapeHtml(err.message)}</span>`;
  }
};

// Desktop sign-in polls in the background; when the account lands,
// re-render the setup page so status badges reflect the connection
// instead of going stale until a manual reload.
async function reRenderSetupOnConnect(connected) {
  if (!connected) {
    const el = document.getElementById('save-status-google');
    if (el) el.innerHTML = '<span style="color: var(--warning, #e6a700);">Sign-in timed out. Reload to try again.</span>';
    return;
  }
  if (window.location.hash.split('?')[0] !== '#/setup') return;
  const container = document.getElementById('page-content');
  if (!container) return;
  // renderSetup is exported from this same module — call it directly
  // rather than dynamically re-importing the module that's executing.
  await renderSetup(container, getEffectiveUserId());
}

window.handleConnectGoogleFromSetup = async function() {
  const statusEl = document.getElementById('save-status-google');
  if (statusEl) statusEl.innerHTML = '<span style="color: var(--text-muted);">Sending you to Google…</span>';
  try {
    const userId = getEffectiveUserId();
    const { startGoogleSignIn } = await import('../google-signin.js');
    const result = await startGoogleSignIn({ userId, onComplete: reRenderSetupOnConnect });
    if (result.status === 'error') throw new Error(result.error || 'sign-in failed');
    if (result.status === 'polling' && statusEl) {
      statusEl.innerHTML = '<span style="color: var(--text-muted);">Waiting for Google sign-in to complete in your browser…</span>';
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color: var(--danger);">${escapeHtml(err.message)}</span>`;
  }
};

window.syncServiceToIronClaw = async function(service) {
  const statusEl = document.getElementById(`save-status-${service}`);
  if (statusEl) statusEl.innerHTML = '<span style="color: var(--text-muted);">Syncing...</span>';

  try {
    await fetchJSON(`/api/credentials/${service}/sync`, { method: 'POST' });
    if (statusEl) statusEl.innerHTML = '<span style="color: var(--success);">Synced!</span>';
    setTimeout(async () => {
      const { renderSetup } = await import('./setup.js');
      await renderSetup(document.getElementById('page-content'), getEffectiveUserId());
    }, 800);
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color: var(--danger);">${escapeHtml(err.message)}</span>`;
  }
};
