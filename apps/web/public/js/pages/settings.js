import { fetchUser, updateTrustTier, fetchOAuthStatus, getGoogleAuthUrl, disconnectProvider, escapeHtml } from '../api-client.js';

const TIERS = [
  { value: 'observer', name: 'Watch only', desc: 'Your twin observes everything but never takes action. Good for seeing what it would do without any risk.' },
  { value: 'suggest', name: 'Suggest first', desc: 'Your twin suggests actions and waits for you to approve each one. The safest way to get started.' },
  { value: 'low_autonomy', name: 'Handle routine stuff', desc: 'Auto-handles low-risk repetitive tasks (like archiving junk emails). Asks about everything else.' },
  { value: 'moderate_autonomy', name: 'Mostly autonomous', desc: 'Handles most things on its own. Only asks about high-risk or unusual situations.' },
  { value: 'high_autonomy', name: 'Full autopilot', desc: 'Handles everything within your policies. Only stops for critical decisions or spending limits.' },
];

export async function renderSettings(container, userId) {
  let user = null;
  let googleStatus = null;

  try {
    const [userResult, oauthResult] = await Promise.allSettled([
      fetchUser(userId),
      fetchOAuthStatus(userId, 'google'),
    ]);
    user = userResult.status === 'fulfilled' ? userResult.value?.user : null;
    googleStatus = oauthResult.status === 'fulfilled' ? oauthResult.value : null;
  } catch { /* empty */ }

  const currentTier = user?.trust_tier ?? 'suggest';
  const googleConnected = googleStatus?.connected ?? false;

  // Check for ?connected= query param after OAuth redirect
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const justConnected = params.get('connected');

  container.innerHTML = `
    ${justConnected ? `<div class="card" style="border-left: 3px solid var(--success);">
      <span style="color: var(--success); font-weight: 600;">Connected!</span> Your ${justConnected} account is now linked. Your twin will start learning from your data.
    </div>` : ''}

    <div class="card">
      <div class="card-header">
        <span class="card-title">Your identity</span>
      </div>
      <div class="form-group">
        <label>User ID</label>
        <div style="display: flex; gap: 0.5rem;">
          <input class="form-input" id="userId-input" value="${userId}">
          <button class="btn btn-outline btn-sm" onclick="window.skyTwinSetUserId(document.getElementById('userId-input').value)">Switch</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">How much should your twin do?</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Choose how much autonomy your twin should have. You can change this anytime.
      </div>
      <div class="tier-options" id="tier-options">
        ${TIERS.map(t => `
          <div class="tier-option ${t.value === currentTier ? 'selected' : ''}" data-tier="${t.value}" onclick="selectTier(this)">
            <div class="tier-radio"></div>
            <div>
              <div class="tier-name">${t.name}</div>
              <div class="tier-desc">${t.desc}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <button class="btn btn-primary" style="margin-top: 1rem;" id="save-tier-btn" onclick="saveTier('${userId}')">Save</button>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Connected accounts</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Connect your accounts so your twin can see your email and calendar.
        Your twin only reads data — it never sends emails or accepts invites without your permission (based on your autonomy level above).
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.75rem; background: var(--bg); border-radius: var(--radius-sm);">
        <div>
          <div style="font-weight: 600; font-size: 0.9rem;">Google (Gmail + Calendar)</div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">
            ${googleConnected ? 'Connected — your twin is learning from your email and calendar' : 'Not connected'}
          </div>
        </div>
        <div>
          ${googleConnected
            ? `<button class="btn btn-outline btn-sm" onclick="handleDisconnectGoogle('${userId}')">Disconnect</button>`
            : `<button class="btn btn-primary btn-sm" onclick="handleConnectGoogle('${userId}')">Connect</button>`
          }
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Privacy & data</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Your twin's data stays in your database. You own all of it.
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.8;">
        <strong>What's stored:</strong> Your preferences, behavioral patterns, decision history, and feedback.<br>
        <strong>What's not stored:</strong> Raw email content, calendar details, or passwords.<br>
        <strong>OAuth tokens:</strong> ${googleConnected ? 'Stored securely. Disconnect above to revoke access.' : 'No tokens stored.'}<br>
      </div>
    </div>

    <div class="card" style="border-left: 3px solid var(--danger);">
      <div class="card-header">
        <span class="card-title">Pause your twin</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        Temporarily stop all auto-execution without disconnecting accounts.
        Your twin will continue watching but won't take any action.
      </div>
      <button class="btn btn-outline btn-sm" onclick="pauseTwin('${userId}')">
        ${currentTier === 'observer' ? 'Twin is paused (watch only)' : 'Pause twin'}
      </button>
    </div>
  `;
}

window.selectTier = function(el) {
  document.querySelectorAll('.tier-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
};

window.saveTier = async function(userId) {
  const selected = document.querySelector('.tier-option.selected');
  if (!selected) return;
  const tier = selected.getAttribute('data-tier');
  const btn = document.getElementById('save-tier-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await updateTrustTier(userId, tier);
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
  } catch (err) {
    btn.textContent = 'Save';
    btn.disabled = false;
    btn.insertAdjacentHTML('afterend', `<div class="error-banner" style="margin-top: 0.5rem;">${escapeHtml(err.message)}</div>`);
  }
};

window.handleConnectGoogle = async function(userId) {
  try {
    const data = await getGoogleAuthUrl(userId);
    if (data.url) {
      window.location.href = data.url;
    } else {
      document.getElementById('page-content').insertAdjacentHTML(
        'afterbegin',
        '<div class="error-banner">Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.</div>',
      );
    }
  } catch (err) {
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">${escapeHtml(err.message)}</div>`,
    );
  }
};

window.handleDisconnectGoogle = async function(userId) {
  try {
    await disconnectProvider('google', userId);
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">${escapeHtml(err.message)}</div>`,
    );
  }
};

window.pauseTwin = async function(userId) {
  try {
    await updateTrustTier(userId, 'observer');
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">${escapeHtml(err.message)}</div>`,
    );
  }
};
