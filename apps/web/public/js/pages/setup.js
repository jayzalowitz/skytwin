import { fetchJSON, escapeHtml } from '../api-client.js';

// Module-level sync lookup for dynamic integration card rendering
let _syncLookup = {};

/**
 * Render the service setup page.
 *
 * Design goals:
 * - IronClaw and OpenClaw auto-detect; show their live status, not setup forms
 * - Google OAuth is the one thing that genuinely needs manual user setup
 * - Rich step-by-step instructions for Google credentials
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
  const syncLookup = buildSyncLookup(ironclawSync);

  const googleCreds = credLookup['google'] || {};
  const googleConfigured = status?.google?.configured ?? false;

  const ironclaw = status?.adapters?.ironclaw ?? { registered: false, healthy: false, url: '' };
  const openclaw = status?.adapters?.openclaw ?? { registered: false, healthy: false, url: '' };
  const direct = status?.adapters?.direct ?? { registered: true, healthy: true, url: 'local' };

  container.innerHTML = `
    <div class="card" style="border-left: 3px solid var(--primary);">
      <div class="card-header">
        <span class="card-title">Setup</span>
      </div>
      <div class="card-subtitle">
        SkyTwin connects to a few services to work. Most of them auto-detect — the main thing
        you need to set up yourself is a Google account connection.
      </div>
    </div>

    <!-- ── Execution engines: auto-detected status ── -->

    <div class="card">
      <div class="card-header">
        <span class="card-title">Execution engines</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        These run actions on your behalf. They auto-detect when running locally — no setup needed.
      </div>

      ${renderAdapterStatus('IronClaw', ironclaw, 'The primary execution server. Highest trust — actions are sandboxed, audited, and reversible.')}
      ${renderAdapterStatus('Direct (built-in)', direct, 'Built-in handlers for email, calendar, finance, and more. Always available.')}
      ${renderAdapterStatus('OpenClaw', openclaw, 'Optional community execution engine using local AI. Broader skills but weaker guarantees.')}

      <div style="margin-top: 0.75rem; font-size: 0.8rem; color: var(--text-muted);">
        SkyTwin automatically picks the most trusted available engine for each action and falls back through the chain if one is down.
      </div>
    </div>

    <!-- ── Google OAuth: the one manual step ── -->

    <div class="card" id="google-setup-card" style="border-left: 3px solid ${googleConfigured ? 'var(--success)' : 'var(--warning, #e6a700)'};">
      <div class="card-header" style="display: flex; justify-content: space-between; align-items: center;">
        <span class="card-title">Google account credentials</span>
        ${googleConfigured
          ? '<span style="color: var(--success); font-weight: 600; font-size: 0.85rem;">Configured</span>'
          : '<span style="color: var(--warning, #e6a700); font-weight: 600; font-size: 0.85rem;">Needs setup</span>'}
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        To read your email and calendar, SkyTwin needs API credentials from Google Cloud.
        This is a one-time setup that takes about 5 minutes.
      </div>

      <details ${googleConfigured ? '' : 'open'} style="margin-bottom: 1.25rem;">
        <summary style="cursor: pointer; color: var(--primary); font-size: 0.9rem; font-weight: 600; margin-bottom: 0.75rem;">
          Step-by-step instructions
        </summary>
        <div style="font-size: 0.85rem; line-height: 1.9; color: var(--text-secondary, var(--text-muted));">
          <div style="margin-bottom: 1rem;">
            <strong>Step 1 — Create a Google Cloud project</strong>
            <ol style="padding-left: 1.25rem; margin-top: 0.25rem;">
              <li>Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a></li>
              <li>Click the project selector at the top and choose <strong>New Project</strong></li>
              <li>Name it anything (e.g. "SkyTwin") and click <strong>Create</strong></li>
            </ol>
          </div>

          <div style="margin-bottom: 1rem;">
            <strong>Step 2 — Enable the Gmail and Calendar APIs</strong>
            <ol style="padding-left: 1.25rem; margin-top: 0.25rem;">
              <li>In your new project, go to <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener">APIs &amp; Services &gt; Library</a></li>
              <li>Search for <strong>Gmail API</strong> and click <strong>Enable</strong></li>
              <li>Go back to Library, search for <strong>Google Calendar API</strong> and click <strong>Enable</strong></li>
            </ol>
          </div>

          <div style="margin-bottom: 1rem;">
            <strong>Step 3 — Configure the OAuth consent screen</strong>
            <ol style="padding-left: 1.25rem; margin-top: 0.25rem;">
              <li>Go to <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" rel="noopener">APIs &amp; Services &gt; OAuth consent screen</a></li>
              <li>Choose <strong>External</strong> (unless you have a Google Workspace org)</li>
              <li>Fill in the app name (e.g. "SkyTwin") and your email as developer contact</li>
              <li>On the <strong>Scopes</strong> page, add:
                <ul style="list-style: disc; padding-left: 1.25rem;">
                  <li><code>https://www.googleapis.com/auth/gmail.readonly</code></li>
                  <li><code>https://www.googleapis.com/auth/gmail.modify</code></li>
                  <li><code>https://www.googleapis.com/auth/calendar.readonly</code></li>
                  <li><code>https://www.googleapis.com/auth/calendar.events</code></li>
                </ul>
              </li>
              <li>On the <strong>Test users</strong> page, add the Google account you'll use with SkyTwin</li>
              <li>Click <strong>Save and Continue</strong> through the rest</li>
            </ol>
          </div>

          <div style="margin-bottom: 1rem;">
            <strong>Step 4 — Create OAuth credentials</strong>
            <ol style="padding-left: 1.25rem; margin-top: 0.25rem;">
              <li>Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">APIs &amp; Services &gt; Credentials</a></li>
              <li>Click <strong>Create Credentials</strong> &gt; <strong>OAuth client ID</strong></li>
              <li>Application type: <strong>Web application</strong></li>
              <li>Name: anything (e.g. "SkyTwin local")</li>
              <li>Under <strong>Authorized redirect URIs</strong>, add:<br>
                <code style="user-select: all; background: var(--bg); padding: 0.15rem 0.4rem; border-radius: 3px;">http://localhost:3100/api/oauth/google/callback</code>
              </li>
              <li>Click <strong>Create</strong></li>
              <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> shown in the dialog</li>
            </ol>
          </div>

          <div style="padding: 0.75rem; background: var(--bg); border-radius: var(--radius-sm); border-left: 2px solid var(--primary);">
            <strong>Tip:</strong> Your project will be in "Testing" mode, which is fine for personal use.
            The consent screen will show a warning, but you can click through it since this is your own app.
          </div>
        </div>
      </details>

      <div style="margin-bottom: 0.5rem; font-weight: 600; font-size: 0.9rem;">Paste your credentials here</div>

      <div class="form-group" style="margin-bottom: 0.75rem;">
        <label style="display: flex; justify-content: space-between; align-items: center;">
          <span>Client ID</span>
          ${googleCreds['client_id']?.hasValue ? '<span style="font-size: 0.75rem; color: var(--success);">saved</span>' : ''}
        </label>
        <input
          class="form-input"
          type="text"
          id="cred-google-client_id"
          placeholder="e.g. 123456789-abc.apps.googleusercontent.com"
          value="${escapeHtml(googleCreds['client_id']?.credentialValue ?? '')}"
          data-service="google"
          data-key="client_id"
          autocomplete="off"
        >
      </div>

      <div class="form-group" style="margin-bottom: 0.75rem;">
        <label style="display: flex; justify-content: space-between; align-items: center;">
          <span>Client Secret</span>
          ${googleCreds['client_secret']?.hasValue ? '<span style="font-size: 0.75rem; color: var(--success);">saved</span>' : ''}
        </label>
        <input
          class="form-input"
          type="password"
          id="cred-google-client_secret"
          placeholder="e.g. GOCSPX-..."
          value=""
          data-service="google"
          data-key="client_secret"
          autocomplete="off"
        >
        ${googleCreds['client_secret']?.hasValue ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Currently set (${escapeHtml(googleCreds['client_secret'].credentialValue)}). Leave blank to keep.</div>` : ''}
      </div>

      <div class="form-group" style="margin-bottom: 0.75rem;">
        <label style="display: flex; justify-content: space-between; align-items: center;">
          <span>Redirect URI <span style="color: var(--text-muted); font-weight: 400;">(usually leave as default)</span></span>
        </label>
        <input
          class="form-input"
          type="text"
          id="cred-google-redirect_uri"
          placeholder="http://localhost:3100/api/oauth/google/callback"
          value="${escapeHtml(googleCreds['redirect_uri']?.credentialValue ?? '')}"
          data-service="google"
          data-key="redirect_uri"
          autocomplete="off"
        >
      </div>

      <div style="display: flex; gap: 0.5rem; align-items: center;">
        <button class="btn btn-primary btn-sm" onclick="saveServiceCredentials('google')">
          ${googleConfigured ? 'Update' : 'Save'}
        </button>
        <span id="save-status-google" style="font-size: 0.85rem;"></span>
      </div>
      ${renderIronClawSyncSummary('google', syncLookup)}
    </div>

    <!-- ── What's next ── -->

    <div class="card">
      <div class="card-header">
        <span class="card-title">What's next?</span>
      </div>
      <div class="card-subtitle" style="line-height: 1.8;">
        ${googleConfigured
          ? `Your Google credentials are configured. Now:<br>
             <strong>1.</strong> Go to <a href="#/settings">Settings</a> and click <strong>Connect</strong> next to Google<br>
             <strong>2.</strong> Sign in with the Google account you added as a test user<br>
             <strong>3.</strong> Choose how much autonomy your twin should have<br>
             <strong>4.</strong> Your twin will start learning from your email and calendar`
          : `After pasting your Google credentials above:<br>
             <strong>1.</strong> Click <strong>Save</strong><br>
             <strong>2.</strong> Go to <a href="#/settings">Settings</a> and click <strong>Connect</strong> next to Google<br>
             <strong>3.</strong> Sign in with the Google account you added as a test user<br>
             <strong>4.</strong> Choose how much autonomy your twin should have`
        }
      </div>
    </div>

    <!-- ── Dynamic integrations from adapters ── -->
    ${renderDynamicIntegrations(schema?.integrations ?? {}, credLookup)}

    <!-- ── Advanced: manual overrides for execution engines ── -->

    <details class="card collapsible-card">
      <summary class="card-header collapsible-header">
        <span class="card-title">Advanced: execution engine overrides</span>
        <span class="collapse-icon"></span>
      </summary>
      <div class="collapsible-body">
        <div class="card-subtitle" style="margin-bottom: 1rem;">
          The execution engines auto-detect when running locally. Only use these overrides if you're
          connecting to a remote instance or need to change the default configuration.
        </div>

        <div style="margin-bottom: 1.5rem;">
          <div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 0.75rem;">IronClaw</div>
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
            <button class="btn btn-outline btn-sm" onclick="saveServiceCredentials('ironclaw')">Save override</button>
            <span id="save-status-ironclaw" style="font-size: 0.85rem;"></span>
          </div>
          ${renderIronClawSyncSummary('ironclaw', syncLookup)}
        </div>

        <div>
          <div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 0.75rem;">OpenClaw</div>
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
            <button class="btn btn-outline btn-sm" onclick="saveServiceCredentials('openclaw')">Save override</button>
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
      if (service) window.saveServiceCredentials(service);
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
function renderDynamicIntegrations(integrations, credLookup) {
  const keys = Object.keys(integrations);
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
  for (const row of ironclawSync?.credentials ?? []) {
    if (!lookup[row.service]) lookup[row.service] = [];
    lookup[row.service].push(row);
  }
  _syncLookup = lookup;
  return lookup;
}

function renderIronClawSyncSummary(service, syncLookup) {
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

function renderAdapterStatus(name, adapter, description) {
  const dot = adapter.registered && adapter.healthy
    ? '<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--success); margin-right: 0.5rem;"></span>'
    : adapter.registered
      ? '<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--warning, #e6a700); margin-right: 0.5rem;"></span>'
      : '<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); margin-right: 0.5rem;"></span>';

  const statusText = adapter.registered && adapter.healthy
    ? '<span style="color: var(--success); font-size: 0.8rem;">Running</span>'
    : adapter.registered
      ? '<span style="color: var(--warning, #e6a700); font-size: 0.8rem;">Registered but unreachable</span>'
      : '<span style="color: var(--text-muted); font-size: 0.8rem;">Not detected</span>';

  const urlText = adapter.url && adapter.url !== 'local'
    ? `<span style="color: var(--text-muted); font-size: 0.75rem; margin-left: 0.5rem;">${escapeHtml(adapter.url)}</span>`
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
      </div>
      <div>${statusText}</div>
    </div>
  `;
}

window.saveServiceCredentials = async function(service) {
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

  statusEl.innerHTML = '<span style="color: var(--text-muted);">Saving...</span>';

  try {
    await fetchJSON(`/api/credentials/${service}`, {
      method: 'PUT',
      body: JSON.stringify({ credentials }),
    });
    statusEl.innerHTML = '<span style="color: var(--success);">Saved!</span>';

    // Re-render to update status badges
    setTimeout(async () => {
      const { renderSetup } = await import('./setup.js');
      await renderSetup(document.getElementById('page-content'), localStorage.getItem('skytwin_userId'));
    }, 800);
  } catch (err) {
    statusEl.innerHTML = `<span style="color: var(--danger);">${escapeHtml(err.message)}</span>`;
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
      await renderSetup(document.getElementById('page-content'), localStorage.getItem('skytwin_userId'));
    }, 800);
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color: var(--danger);">${escapeHtml(err.message)}</span>`;
  }
};
