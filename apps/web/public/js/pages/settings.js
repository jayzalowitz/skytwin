import { fetchUser, updateTrustTier, fetchOAuthStatus, getGoogleAuthUrl, disconnectProvider, escapeHtml, fetchSettings, updateAutonomySettings, upsertDomainPolicy, deleteDomainPolicy, createEscalationTrigger, deleteEscalationTrigger, createSession, fetchSessions, revokeSession } from '../api-client.js';

const TIERS = [
  { value: 'observer', name: 'Just watch', desc: 'Your assistant watches but never does anything. Good for seeing what it would do.' },
  { value: 'suggest', name: 'Ask me first', desc: 'Your assistant suggests actions and waits for your OK. The safest way to start.' },
  { value: 'low_autonomy', name: 'Handle small stuff', desc: 'Handles small, routine tasks (like archiving junk mail). Asks about everything else.' },
  { value: 'moderate_autonomy', name: 'Handle most things', desc: 'Handles most things on its own. Only asks about big or unusual decisions.' },
  { value: 'high_autonomy', name: 'Full autopilot', desc: 'Handles everything within your rules. Only stops for important decisions or spending limits.' },
];

export async function renderSettings(container, userId) {
  let user = null;
  let googleStatus = null;
  let settings = null;
  let sessions = [];

  try {
    const [userResult, oauthResult, settingsResult, sessionsResult] = await Promise.allSettled([
      fetchUser(userId),
      fetchOAuthStatus(userId, 'google'),
      fetchSettings(userId),
      fetchSessions(userId),
    ]);
    user = userResult.status === 'fulfilled' ? userResult.value?.user : null;
    googleStatus = oauthResult.status === 'fulfilled' ? oauthResult.value : null;
    settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
    sessions = sessionsResult.status === 'fulfilled' ? (sessionsResult.value?.sessions ?? []) : [];
  } catch { /* empty */ }

  const currentTier = user?.trust_tier ?? 'suggest';
  const googleConnected = googleStatus?.connected ?? false;
  const domainPolicies = settings?.domainPolicies ?? [];
  const escalationTriggers = settings?.escalationTriggers ?? [];
  const autonomy = settings?.autonomySettings ?? {};

  // Check for ?connected= query param after OAuth redirect
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const justConnected = params.get('connected');

  container.innerHTML = `
    ${justConnected ? `<div class="card" style="border-left: 3px solid var(--success);">
      <span style="color: var(--success); font-weight: 600;">Connected!</span> Your ${escapeHtml(justConnected)} account is now linked. Your twin will start learning from your data.
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

    <div class="card">
      <div class="card-header">
        <span class="card-title">Spending guardrails</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Put a cap on how much your assistant can spend without asking you first.
      </div>
      <div class="form-group">
        <label>Most I can spend at once (in cents)</label>
        <input class="form-input" type="number" id="max-per-action" value="${autonomy.maxSpendPerActionCents ?? 10000}" min="0">
        <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem;">e.g. 10000 = $100.00</div>
      </div>
      <div class="form-group">
        <label>Most I can spend in one day (in cents)</label>
        <input class="form-input" type="number" id="max-daily" value="${autonomy.maxDailySpendCents ?? 50000}" min="0">
        <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem;">e.g. 50000 = $500.00</div>
      </div>
      <div class="form-group">
        <label>
          <input type="checkbox" id="irreversible-approval" ${autonomy.requireApprovalForIrreversible !== false ? 'checked' : ''}>
          Always ask before doing something that can't be undone
        </label>
      </div>
      <button class="btn btn-primary btn-sm" onclick="saveSpendLimits('${userId}')">Save</button>
    </div>

    <details class="card collapsible-card">
      <summary class="card-header collapsible-header">
        <span class="card-title">Domain overrides (advanced)</span>
        <span class="collapse-icon"></span>
      </summary>
      <div class="collapsible-body">
        <div class="card-subtitle" style="margin-bottom: 1rem;">
          Want different rules for different areas? For example, stricter controls for shopping but more freedom for email. Most people don't need this.
        </div>
        <div id="domain-policies-inner">
          ${domainPolicies.map(p => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
              <div>
                <span style="font-weight: 600;">${escapeHtml(p.domain)}</span>
                <span style="color: var(--text-muted); margin-left: 0.5rem;">${escapeHtml(p.trustTier)}</span>
                ${p.maxSpendPerActionCents != null ? `<span style="color: var(--text-muted); margin-left: 0.5rem;">(max ${p.maxSpendPerActionCents}c/action)</span>` : ''}
              </div>
              <button class="btn btn-outline btn-sm" onclick="removeDomainPolicy('${userId}', '${escapeHtml(p.domain)}')">Remove</button>
            </div>
          `).join('')}
        </div>
        <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
          <input class="form-input" id="new-domain" placeholder="Area (e.g. finance)" style="flex: 1;">
          <select class="form-input" id="new-domain-tier" style="flex: 1;">
            ${TIERS.map(t => `<option value="${t.value}">${t.name}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" onclick="addDomainPolicy('${userId}')">Add</button>
        </div>
      </div>
    </details>

    <details class="card collapsible-card">
      <summary class="card-header collapsible-header">
        <span class="card-title">Escalation triggers (advanced)</span>
        <span class="collapse-icon"></span>
      </summary>
      <div class="collapsible-body">
        <div class="card-subtitle" style="margin-bottom: 1rem;">
          Tell your assistant when to stop and ask. For example: "Always ask me if it costs more than $50." Most people don't need to change these.
        </div>
        <div id="escalation-triggers">
          ${escalationTriggers.map(t => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
              <div>
                <span style="font-weight: 600;">${escapeHtml(t.triggerType)}</span>
                <span style="color: var(--text-muted); margin-left: 0.5rem;">${escapeHtml(JSON.stringify(t.conditions))}</span>
                <span style="color: ${t.enabled ? 'var(--success)' : 'var(--text-muted)'}; margin-left: 0.5rem;">${t.enabled ? 'active' : 'disabled'}</span>
              </div>
              <button class="btn btn-outline btn-sm" onclick="removeEscalationTrigger('${userId}', '${escapeHtml(t.id)}')">Remove</button>
            </div>
          `).join('')}
        </div>
        <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
          <select class="form-input" id="new-trigger-type" style="flex: 1;">
            <option value="amount_threshold">Costs more than...</option>
            <option value="risk_tier_threshold">Risk is above...</option>
            <option value="low_confidence">Not sure enough</option>
            <option value="novel_situation">Never seen before</option>
            <option value="consecutive_rejections">You said no several times</option>
          </select>
          <input class="form-input" id="new-trigger-value" placeholder="Value (e.g. 5000)" style="flex: 1;">
          <button class="btn btn-primary btn-sm" onclick="addEscalationTrigger('${userId}')">Add</button>
        </div>
      </div>
    </details>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Phone access</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Access your dashboard from your phone on the same WiFi network.
        Click "Generate QR" then scan with your phone camera.
      </div>
      <div id="qr-container" style="text-align: center; margin-bottom: 1rem;"></div>
      <button class="btn btn-primary btn-sm" onclick="generateQR('${userId}')">Generate QR code</button>

      ${sessions.length > 0 ? `
        <div style="margin-top: 1.5rem;">
          <div style="font-weight: 600; font-size: 0.85rem; margin-bottom: 0.5rem;">Active sessions</div>
          ${sessions.map(s => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
              <div>
                <span style="font-weight: 600; font-size: 0.85rem;">${escapeHtml(s.deviceName)}</span>
                <span style="color: var(--text-muted); font-size: 0.75rem; margin-left: 0.5rem;">Last active: ${formatRelativeTime(s.lastActiveAt)}</span>
              </div>
              <button class="btn btn-outline btn-sm" onclick="revokeSessionHandler('${escapeHtml(s.id)}', '${userId}')">Revoke</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>

    <div class="card" style="margin-top: 2rem; text-align: center;">
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">Signed in as <strong>${escapeHtml(userId)}</strong></div>
      <button class="btn btn-outline" onclick="signOut()">Sign out</button>
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
    // Remove any previous error banner before showing a new one
    btn.parentElement?.querySelector('.error-banner')?.remove();
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

window.saveSpendLimits = async function(userId) {
  try {
    await updateAutonomySettings(userId, {
      maxSpendPerActionCents: parseInt(document.getElementById('max-per-action').value, 10),
      maxDailySpendCents: parseInt(document.getElementById('max-daily').value, 10),
      requireApprovalForIrreversible: document.getElementById('irreversible-approval').checked,
    });
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">${escapeHtml(err.message)}</div>`,
    );
  }
};

window.addDomainPolicy = async function(userId) {
  const domain = document.getElementById('new-domain').value.trim();
  const tier = document.getElementById('new-domain-tier').value;
  if (!domain) return;
  try {
    await upsertDomainPolicy(userId, domain, tier);
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">${escapeHtml(err.message)}</div>`,
    );
  }
};

window.removeDomainPolicy = async function(userId, domain) {
  try {
    await deleteDomainPolicy(userId, domain);
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">${escapeHtml(err.message)}</div>`,
    );
  }
};

window.addEscalationTrigger = async function(userId) {
  const triggerType = document.getElementById('new-trigger-type').value;
  const rawValue = document.getElementById('new-trigger-value').value.trim();
  const conditionMap = {
    amount_threshold: { thresholdCents: parseInt(rawValue, 10) || 5000 },
    risk_tier_threshold: { minRiskTier: rawValue || 'high' },
    low_confidence: { minConfidence: rawValue || 'moderate' },
    novel_situation: {},
    consecutive_rejections: { count: parseInt(rawValue, 10) || 3 },
  };
  try {
    await createEscalationTrigger(userId, triggerType, conditionMap[triggerType] ?? {});
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">${escapeHtml(err.message)}</div>`,
    );
  }
};

window.removeEscalationTrigger = async function(userId, triggerId) {
  try {
    await deleteEscalationTrigger(userId, triggerId);
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">${escapeHtml(err.message)}</div>`,
    );
  }
};

window.generateQR = async function(userId) {
  const container = document.getElementById('qr-container');
  try {
    container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">Generating...</div>';
    const data = await createSession(userId, 'Phone');
    // Render a text-based QR representation (URL)
    container.innerHTML = `
      <div style="background: white; display: inline-block; padding: 1rem; border-radius: 8px; margin-bottom: 0.5rem;">
        <div style="color: #000; font-size: 0.75rem; word-break: break-all; max-width: 300px;">${escapeHtml(data.qrUrl)}</div>
      </div>
      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem;">
        Open this URL on your phone, or copy and paste it.<br>
        Expires: ${new Date(data.expiresAt).toLocaleDateString()}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
};

window.revokeSessionHandler = async function(sessionId, userId) {
  try {
    await revokeSession(sessionId, userId);
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">${escapeHtml(err.message)}</div>`,
    );
  }
};

function formatRelativeTime(dateStr) {
  if (!dateStr) return 'unknown';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

window.signOut = function() {
  localStorage.removeItem('skytwin_userId');
  localStorage.removeItem('skytwin_onboarded');
  window.location.hash = '#/';
  window.location.reload();
};
