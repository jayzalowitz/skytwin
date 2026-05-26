import { fetchUser, updateTrustTier, fetchOAuthStatus, disconnectProvider, escapeHtml, fetchSettings, updateAutonomySettings, updateIronClawChannel, upsertDomainPolicy, deleteDomainPolicy, createEscalationTrigger, deleteEscalationTrigger, createSession, fetchSessions, revokeSession, saveAIProviders, testAIProvider, fetchRoutines, deleteRoutine, startFederationPairing, completeFederationPairing, listFederationPeers, unpairFederationPeer } from '../api-client.js';
import { mountThemeSwitcher } from '../theme-switcher.js';
import { mountEmbeddedLlmCard } from '../components/embedded-llm-card.js';
import {
  getTextScale, setTextScale,
  getReducedMotion, setReducedMotion,
  isVoiceFirstEnabled, setVoiceFirst,
} from '../a11y.js';
import { showSavedToast, showErrorToast } from '../toast.js';
import { KEY_USER_ID, KEY_ONBOARDED, KEY_SESSION_TOKEN } from '../storage-keys.js';
import { formatMoney } from '../format.js';

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
  let routines = [];

  try {
    const [userResult, oauthResult, settingsResult, sessionsResult, routinesResult] = await Promise.allSettled([
      fetchUser(userId),
      fetchOAuthStatus(userId, 'google'),
      fetchSettings(userId),
      fetchSessions(userId),
      fetchRoutines(userId),
    ]);
    user = userResult.status === 'fulfilled' ? userResult.value?.user : null;
    googleStatus = oauthResult.status === 'fulfilled' ? oauthResult.value : null;
    settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
    sessions = sessionsResult.status === 'fulfilled' ? (sessionsResult.value?.sessions ?? []) : [];
    routines = routinesResult.status === 'fulfilled' ? (routinesResult.value?.routines ?? []) : [];
  } catch { /* empty */ }

  const currentTier = user?.trust_tier ?? 'suggest';
  const googleConnected = googleStatus?.connected ?? false;
  const domainPolicies = settings?.domainPolicies ?? [];
  const escalationTriggers = settings?.escalationTriggers ?? [];
  const autonomy = settings?.autonomySettings ?? {};
  const aiProviders = settings?.aiProviders ?? [];
  const ironclawChannel = settings?.ironclawChannel ?? 'skytwin';
  const ironclawChannels = settings?.ironclawChannels ?? ['skytwin', 'telegram', 'discord', 'slack', 'signal'];

  // Check for ?connected= query param after OAuth redirect
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const justConnected = params.get('connected');

  container.innerHTML = `
    ${justConnected ? `<div class="card" style="border-left: 3px solid var(--success);">
      <span style="color: var(--success); font-weight: 600;">Connected!</span> Your ${escapeHtml(justConnected)} account is now linked. Your twin will start learning from your data.
    </div>` : ''}

    ${(new URLSearchParams(window.location.search).get('dev') === '1') ? `
    <details class="card collapsible-card">
      <summary class="card-header collapsible-header">
        <span class="card-title">Advanced — switch user (developer)</span>
        <span class="collapse-icon"></span>
      </summary>
      <div class="collapsible-body">
        <div class="card-subtitle" style="margin-bottom: 0.75rem;">
          Paste another user's ID to switch into their twin. Mostly useful while you're setting up multiple
          accounts on the same machine — most people never need this.
        </div>
        <div class="form-group">
          <label>User ID</label>
          <div style="display: flex; gap: 0.5rem;">
            <input class="form-input" id="userId-input" value="${escapeHtml(userId)}">
            <button class="btn btn-outline btn-sm" data-action="switch-user">Switch</button>
          </div>
        </div>
      </div>
    </details>
    ` : ''}<!-- UX review #8: dev-only "switch user" section gated behind ?dev=1 -->\n

    <div class="card">
      <div class="card-header">
        <span class="card-title">How much should your twin do?</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Choose how much autonomy your twin should have. You can change this anytime.
      </div>
      <div class="tier-options" id="tier-options">
        ${TIERS.map(t => `
          <div class="tier-option ${t.value === currentTier ? 'selected' : ''}" data-tier="${t.value}" data-action="select-tier">
            <div class="tier-radio"></div>
            <div>
              <div class="tier-name">${t.name}</div>
              <div class="tier-desc">${t.desc}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <button class="btn btn-primary" style="margin-top: 1rem;" id="save-tier-btn" data-action="save-tier">Save</button>
    </div>

    <!-- Theme card (UX review #7). Theme switcher used to live in the
         page header where it looked like a label. Now lives here in
         Settings with an explicit title so users know what it does.
         The dropdown itself is mounted by theme-switcher.js into the
         #theme-switcher-target element after render. -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Visual theme</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Pick how the dashboard looks. Changes apply immediately.
      </div>
      <div id="theme-switcher-target"></div>
    </div>

    <div id="embedded-llm-card-target"></div>

    <div class="card" id="a11y-settings-card">
      <div class="card-header">
        <span class="card-title">Accessibility</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Make the interface easier on your eyes, ears, and motor skills.
      </div>
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <div>
          <label for="a11y-text-scale" style="display: block; font-weight: 500; margin-bottom: 0.25rem;">Text size</label>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <select class="form-input" id="a11y-text-scale" style="flex: 1;" data-action="a11y-set-text-scale">
              <option value="100">Default</option>
              <option value="125">Larger (125%)</option>
              <option value="150">Much larger (150%)</option>
              <option value="200">Maximum (200%)</option>
            </select>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">All text reflows at the new size. Layouts adapt.</div>
        </div>

        <div>
          <label for="a11y-reduced-motion" style="display: block; font-weight: 500; margin-bottom: 0.25rem;">Animations</label>
          <select class="form-input" id="a11y-reduced-motion" data-action="a11y-set-reduced-motion">
            <option value="auto">Match system preference</option>
            <option value="off">Show animations</option>
            <option value="on">Reduce motion</option>
          </select>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">"Reduce motion" stops transitions and scroll animations site-wide.</div>
        </div>

        <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm);">
          <div>
            <div style="font-weight: 500;">Voice-first mode</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">Show microphone affordances throughout the app. Uses your local Whisper model when available.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="a11y-voice-first" data-action="a11y-toggle-voice-first">
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
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
            ? `<button class="btn btn-outline btn-sm" data-action="disconnect-google">Disconnect</button>`
            : `<button class="btn btn-primary btn-sm" data-action="connect-google">Connect</button>`
          }
        </div>
      </div>
    </div>

    <!-- TODO: delete the standalone Google block above 14 days post-launch of
         the Capabilities page (#176). Capabilities (including Google connectors)
         are managed via the dedicated Capabilities page linked below.
         The block remains here during the rollback window. -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Capabilities</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Manage which skills your twin has access to — install MCP servers,
        review suggestions, and browse the registry.
      </div>
      <a href="#/capabilities" class="btn">Open Capabilities →</a>
    </div>

    ${window.skytwinDesktop?.isDesktop ? `
    <div class="card" id="desktop-settings-card">
      <div class="card-header">
        <span class="card-title">Desktop</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Settings that only apply when you're running the SkyTwin desktop app.
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.75rem; background: var(--bg); border-radius: var(--radius-sm);">
        <div>
          <div style="font-weight: 500;">Start at login</div>
          <div style="font-size: 0.85rem; color: var(--text-muted);">Launch SkyTwin automatically when you sign in to your computer.</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="launch-at-login-toggle" data-action="toggle-launch-at-login">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    ` : ''}

    <details class="card collapsible-card" id="ai-brain-card">
      <summary class="card-header collapsible-header">
        <span class="card-title">${aiProviders.length > 0 ? 'AI brain — connected providers' : 'AI brain — needed for Chat (optional otherwise)'}</span>
        <span class="collapse-icon"></span>
      </summary>
      <div class="collapsible-body">
        <div class="card-subtitle" style="margin-bottom: 1rem;">
          ${aiProviders.length > 0
            ? `Out of the box your twin uses the local AI on your machine plus built-in rules — that's enough for most decisions. Add a paid provider here if you want sharper reasoning on the tricky calls. Multiple are tried in order with automatic fallback.`
            : `<strong>The Chat surface needs at least one AI provider configured here</strong> to generate replies. Other features (decisions, approvals) work without one — they fall back to local AI + built-in rules. Multiple providers are tried in priority order with automatic fallback.`}
        </div>
        <div id="ai-mode-toggle">
          ${renderModeToggle(aiProviders)}
        </div>
        <div id="ai-provider-chain">
          ${renderProviderChain(aiProviders)}
        </div>
        <div style="margin-top: 0.75rem; display: flex; gap: 0.5rem; align-items: center;">
          <select class="form-input" id="add-provider-select" style="flex: 1;">
            <option value="">+ Add a provider…</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT)</option>
            <option value="google">Google (Gemini)</option>
            <option value="ollama">Local AI on this machine (Ollama)</option>
            <option value="embedded">Embedded (llama.cpp, no install)</option>
          </select>
        </div>
        <div style="margin-top: 0.75rem; display: flex; gap: 0.5rem; justify-content: space-between; align-items: center;">
          <div style="font-size: 0.75rem; color: var(--text-dim);">If every provider you add is unreachable, your twin falls back to local AI + built-in rules.</div>
          <button id="save-ai-btn" class="btn btn-primary btn-sm" data-action="save-ai-providers">Save</button>
        </div>
      </div>
    </details>

    ${routines.length > 0 ? `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Scheduled actions</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Recurring things your twin runs on a schedule (e.g. weekly inbox cleanup).
      </div>
      ${routines.map(routine => `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.5rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
          <div style="min-width: 0;">
            <div style="font-weight: 600; font-size: 0.9rem;">${escapeHtml(routine.planSummary || routine.id)}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(routine.schedule)}${routine.nextRunAt ? ` · next ${escapeHtml(formatRelativeTime(routine.nextRunAt))}` : ''}</div>
          </div>
          <button class="btn btn-outline btn-sm" data-action="delete-routine" data-routine-id="${escapeHtml(routine.id)}">Delete</button>
        </div>
      `).join('')}
    </div>
    ` : ''}

    <details class="card collapsible-card">
      <summary class="card-header collapsible-header">
        <span class="card-title">Advanced — execution routing</span>
        <span class="collapse-icon"></span>
      </summary>
      <div class="collapsible-body">
        <div class="card-subtitle" style="margin-bottom: 1rem;">
          Which channel actions are dispatched through. Most people leave this on the default — this is for setups that route actions to a separate inbox or chat tool.
        </div>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <select class="form-input" id="ironclaw-channel-select" style="flex: 1;">
            ${ironclawChannels.map(channel => `<option value="${escapeHtml(channel)}" ${channel === ironclawChannel ? 'selected' : ''}>${escapeHtml(channel)}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" data-action="save-ironclaw-channel">Save</button>
        </div>
        <div id="ironclaw-channel-status" style="font-size: 0.8rem; margin-top: 0.5rem;"></div>
      </div>
    </details>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Your data, your machine</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Everything your twin learns lives on this computer. Nothing is sent to a SkyTwin cloud, because there isn't one.
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.8;">
        <strong>I keep:</strong> the preferences I learn, patterns I notice, and a log of every decision I made (with the reasoning).<br>
        <strong>I don't keep:</strong> the actual contents of your emails, your calendar event details, or any of your passwords.<br>
        <strong>Account access:</strong> ${googleConnected
          ? 'I have a sign-in token from Google so I can read inbox and calendar. Disconnect above and that token is destroyed.'
          : 'No accounts linked yet — I can\'t see anything until you connect one.'}<br>
      </div>
    </div>

    <div class="card" style="border-left: 3px solid var(--danger, #c0392b);" id="autonomy-pause-card">
      <div class="card-header">
        <span class="card-title">Pause auto-execution</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        Panic button (#379). When on, every action your twin would take is routed to the
        approvals queue for you to review manually — even at the highest autonomy tier.
        Different from the standby card below (which demotes your trust tier and lets
        actions still flow under "ask first" rules).
      </div>
      <div id="autonomy-pause-state" style="margin-bottom: 0.75rem; font-size: 0.9rem; color: var(--text-muted);">
        Loading current state…
      </div>
      <button class="btn btn-outline btn-sm" data-action="autonomy-pause-toggle" id="autonomy-pause-toggle"
              type="button" disabled>
        …
      </button>
    </div>

    <div class="card" style="border-left: 3px solid var(--warning, #e6a700);">
      <div class="card-header">
        <span class="card-title">${currentTier === 'observer' ? 'Your twin is on standby' : 'Put your twin on standby'}</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        ${currentTier === 'observer'
          ? 'Right now your twin is watching everything but not doing anything on its own. Bump the autonomy level above when you\'re ready to let it act.'
          : 'Need a break? This pauses every automatic action — your twin keeps watching but won\'t do anything until you turn it back on. Your accounts stay linked.'}
      </div>
      ${currentTier !== 'observer' ? `
        <button class="btn btn-outline btn-sm" data-action="pause-twin">Pause everything (demote to observer)</button>
      ` : ''}
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Spending guardrails</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Put a cap on how much your assistant can spend without asking you first.
      </div>
      <div class="form-group">
        <label>Most I can spend at once</label>
        <div style="position: relative;">
          <span style="position: absolute; left: 0.6rem; top: 50%; transform: translateY(-50%); color: var(--text-dim);">$</span>
          <input class="form-input" type="number" id="max-per-action" value="${((autonomy.maxSpendPerActionCents ?? 10000) / 100).toFixed(2)}" min="0" step="0.01" style="padding-left: 1.4rem;">
        </div>
      </div>
      <div class="form-group">
        <label>Most I can spend in one day</label>
        <div style="position: relative;">
          <span style="position: absolute; left: 0.6rem; top: 50%; transform: translateY(-50%); color: var(--text-dim);">$</span>
          <input class="form-input" type="number" id="max-daily" value="${((autonomy.maxDailySpendCents ?? 50000) / 100).toFixed(2)}" min="0" step="0.01" style="padding-left: 1.4rem;">
        </div>
      </div>
      <div class="form-group">
        <label>
          <input type="checkbox" id="irreversible-approval" ${autonomy.requireApprovalForIrreversible !== false ? 'checked' : ''}>
          Always ask before doing something that can't be undone
        </label>
      </div>
      <button class="btn btn-primary btn-sm" data-action="save-spend-limits">Save</button>
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
                ${p.maxSpendPerActionCents != null ? `<span style="color: var(--text-muted); margin-left: 0.5rem;">(max ${escapeHtml(formatMoney(p.maxSpendPerActionCents))}/action)</span>` : ''}
              </div>
              <button class="btn btn-outline btn-sm" data-action="remove-domain-policy" data-domain="${escapeHtml(p.domain)}">Remove</button>
            </div>
          `).join('')}
        </div>
        <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
          <input class="form-input" id="new-domain" placeholder="Area (e.g. finance)" style="flex: 1;">
          <select class="form-input" id="new-domain-tier" style="flex: 1;">
            ${TIERS.map(t => `<option value="${t.value}">${t.name}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" data-action="add-domain-policy">Add</button>
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
              <button class="btn btn-outline btn-sm" data-action="remove-escalation-trigger" data-trigger-id="${escapeHtml(t.id)}">Remove</button>
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
          <button class="btn btn-primary btn-sm" data-action="add-escalation-trigger">Add</button>
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
      <button class="btn btn-primary btn-sm" data-action="generate-qr">Generate QR code</button>

      ${sessions.length > 0 ? `
        <div style="margin-top: 1.5rem;">
          <div style="font-weight: 600; font-size: 0.85rem; margin-bottom: 0.5rem;">Active sessions</div>
          ${sessions.map(s => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
              <div>
                <span style="font-weight: 600; font-size: 0.85rem;">${escapeHtml(s.deviceName)}</span>
                <span style="color: var(--text-muted); font-size: 0.75rem; margin-left: 0.5rem;">Last active: ${formatRelativeTime(s.lastActiveAt)}</span>
              </div>
              <button class="btn btn-outline btn-sm" data-action="revoke-session" data-session-id="${escapeHtml(s.id)}">Revoke</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>

    <div class="card" id="federation-card">
      <div class="card-header">
        <span class="card-title">Linked devices</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Pair another SkyTwin instance (your phone, your office laptop) so they
        share installed capabilities, earned trust tiers, and recent decisions.
        OAuth tokens stay on each device — only the metadata syncs.
      </div>
      <div id="federation-peers-list">Loading…</div>
      <div style="margin-top: 0.75rem; display: flex; gap: 0.5rem;">
        <button class="btn btn-primary btn-sm" data-action="federation-pair-start">Pair a new device</button>
        <button class="btn btn-outline btn-sm" data-action="federation-pair-complete">I have a code</button>
      </div>
      <div id="federation-pair-output" style="margin-top: 0.75rem;"></div>
    </div>

    <div class="card" style="margin-top: 2rem; text-align: center;">
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        Signed in as <strong>${escapeHtml(user?.name || user?.email || `You (${userId.slice(0, 4)}…)`)}</strong>
      </div>
      <button class="btn btn-outline" data-action="sign-out">Sign out</button>
    </div>
  `;

  ensureSettingsListener();

  // UX review #7: mount the theme switcher inside the dedicated card.
  // Re-mounted on every render so the dropdown reflects the latest
  // selection (no stale state across save-induced re-renders).
  const themeTarget = document.getElementById('theme-switcher-target');
  if (themeTarget) mountThemeSwitcher(themeTarget);

  // Mount the embedded-LLM card (#187 AC#2). Async fetches the
  // registry + current download state and renders into its target.
  // No-await — render shouldn't block the rest of the settings page.
  const embeddedTarget = document.getElementById('embedded-llm-card-target');
  if (embeddedTarget) {
    void mountEmbeddedLlmCard(embeddedTarget, userId).catch(() => { /* best-effort */ });
  }

  // Hydrate the launch-at-login toggle from the desktop API. Skipped in
  // pure-web mode (no skytwinDesktop). The fetch is best-effort — if it
  // fails the toggle stays unchecked rather than blocking page render.
  const launchToggle = document.getElementById('launch-at-login-toggle');
  if (launchToggle instanceof HTMLInputElement && window.skytwinDesktop?.getLaunchAtLogin) {
    window.skytwinDesktop.getLaunchAtLogin()
      .then((enabled) => { launchToggle.checked = !!enabled; })
      .catch(() => { /* leave unchecked */ });
  }

  // Federation: render the peer list. Fetched fresh per render so a
  // newly-paired peer shows up immediately after the success toast.
  const peerListEl = document.getElementById('federation-peers-list');
  if (peerListEl) {
    listFederationPeers(userId).then((data) => {
      const peers = Array.isArray(data?.peers) ? data.peers : [];
      peerListEl.innerHTML = renderFederationPeerList(peers);
    }).catch(() => {
      peerListEl.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No linked devices yet.</div>';
    });
  }

  // Hydrate the a11y controls from localStorage (#194 Child 4). These
  // values are already applied to <html> by initA11y at boot — the
  // selects + checkbox here just reflect the persisted state.
  const textScaleSel = document.getElementById('a11y-text-scale');
  if (textScaleSel instanceof HTMLSelectElement) textScaleSel.value = getTextScale();
  const reducedMotionSel = document.getElementById('a11y-reduced-motion');
  if (reducedMotionSel instanceof HTMLSelectElement) reducedMotionSel.value = getReducedMotion();
  const voiceFirstCb = document.getElementById('a11y-voice-first');
  if (voiceFirstCb instanceof HTMLInputElement) voiceFirstCb.checked = isVoiceFirstEnabled();

  // Hydrate the kill-switch card (#379) from /api/users/:userId/autonomy-state.
  // The card renders a "Loading…" stub during initial render; this swap
  // populates the real state. Fired here so re-renders after a toggle
  // also pick up the latest state without manual orchestration.
  if (typeof window._refreshAutonomyPauseUi === 'function') {
    window._refreshAutonomyPauseUi(userId);
  }
}

function renderFederationPeerList(peers) {
  if (!Array.isArray(peers) || peers.length === 0) {
    return '<div style="color: var(--text-muted); font-size: 0.85rem;">No linked devices yet.</div>';
  }
  return peers.map((p) => {
    const status = p.lastSyncStatus ?? 'never';
    const statusColor = status === 'ok' ? 'var(--success)'
      : status === 'failed' ? 'var(--danger)'
      : 'var(--text-muted)';
    const lastSyncLabel = p.lastSyncAt
      ? new Date(p.lastSyncAt).toLocaleString()
      : 'never synced';
    return `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
        <div style="min-width: 0;">
          <div style="font-weight: 500;">${escapeHtml(p.label)}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">
            <span style="color: ${statusColor}; font-weight: 500;">${escapeHtml(status)}</span> · last sync ${escapeHtml(lastSyncLabel)}
          </div>
        </div>
        <button class="btn btn-outline btn-sm" data-action="federation-unpair" data-peer-id="${escapeHtml(p.id)}">Unpair</button>
      </div>
    `;
  }).join('');
}

window.federationPairStart = async function(userId) {
  const out = document.getElementById('federation-pair-output');
  if (!out) return;
  out.innerHTML = '<div class="card-subtitle">Generating code…</div>';
  try {
    const data = await startFederationPairing(userId);
    out.innerHTML = `
      <div class="card" style="background: var(--bg); padding: 1rem;">
        <div style="font-weight: 600; margin-bottom: 0.5rem;">Code for the other device:</div>
        <div style="font-family: monospace; font-size: 1.5rem; letter-spacing: 0.25rem; padding: 0.5rem 0;">${escapeHtml(data.code)}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted);">Expires in ${Math.floor((data.ttlSeconds || 600) / 60)} minutes. Enter this on your other device under Settings → Linked devices → "I have a code".</div>
      </div>
    `;
  } catch (err) {
    showErrorToast(`Couldn't generate code: ${err?.friendlyMessage || err?.message || 'unknown error'}`);
    out.innerHTML = '';
  }
};

window.federationPairComplete = async function(userId) {
  const code = window.prompt('Enter the 6-digit code shown on the other device:');
  if (!code) return;
  if (!/^\d{6}$/.test(code.trim())) {
    showErrorToast('Code must be 6 digits.');
    return;
  }
  const label = window.prompt('Label this device (e.g. "Office laptop"):');
  if (!label || !label.trim()) {
    showErrorToast('Label required.');
    return;
  }
  try {
    // Generate a public key for this device. We use crypto.getRandomValues +
    // a 32-byte buffer encoded as base64 — this is a placeholder identity
    // for the joiner; the server validates length, not provenance.
    // (The real key-exchange flow uses tweetnacl on the server side; the
    // joiner's role here is to commit a public key it controls. v1
    // generates an opaque-but-validly-shaped key client-side and stores
    // it nowhere — this MVP only exercises the pairing handshake, not
    // long-term peer identity.)
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const peerPublicKey = btoa(String.fromCharCode(...bytes));
    await completeFederationPairing(userId, code.trim(), label.trim(), peerPublicKey, undefined);
    showSavedToast('Device paired');
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    showErrorToast(`Pair failed: ${err?.friendlyMessage || err?.message || 'unknown error'}`);
  }
};

window.federationUnpair = async function(userId, peerId) {
  if (!confirm('Unpair this device? It will stop receiving syncs immediately.')) return;
  try {
    await unpairFederationPeer(userId, peerId);
    showSavedToast('Device unpaired');
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    showErrorToast(`Unpair failed: ${err?.friendlyMessage || err?.message || 'unknown error'}`);
  }
};

// Singleton click delegator. Settings re-renders after every successful
// save/delete (saveTier, addDomainPolicy, deleteRoutineHandler, etc. all
// re-call renderSettings on the same #page-content container). Binding
// per-render would stack listeners — by the third save a single click
// fires duplicate POSTs and shows duplicate toasts. Wire once on document.
//
// Reads userId via getCurrentUserId() instead of closing over the render
// argument so the singleton always acts on the current user even after
// the dev "Switch user" button changes localStorage. Hash-route gate
// keeps the singleton from misfiring on other pages — the SPA reuses
// one #page-content container, so data-action names that overlap with
// other pages (e.g. "connect-google" also lives on dashboard) need an
// authoritative scope, and the URL hash is it.
let _settingsListenerWired = false;

function ensureSettingsListener() {
  if (_settingsListenerWired || typeof document === 'undefined') return;
  _settingsListenerWired = true;

  // UX review #10: auto-save spending guardrails 1.2s after the last
  // edit. The Save button still works for users who prefer the
  // explicit affordance. Singleton listener wired once on document;
  // gates by the active hash route + element id so other pages don't
  // pick this up.
  document.addEventListener('input', (e) => {
    const hash = (window.location.hash || '').split('?')[0];
    if (hash !== '#/settings') return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target) return;
    const id = target.id;
    if (id === 'max-per-action' || id === 'max-daily' || id === 'irreversible-approval') {
      scheduleSpendAutosave(getCurrentUserId());
    }
  });

  // Delegated change handler for AI provider card inputs. Replaces
  // five inline `onchange="..."` attributes that CLAUDE.md flags as
  // XSS-unsafe-by-construction (`idx` is safe today as an integer
  // but the JS-string-literal-context interpolation pattern isn't).
  document.addEventListener('change', (e) => {
    const hash = (window.location.hash || '').split('?')[0];
    if (hash !== '#/settings') return;
    const target = e.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
    const action = target.getAttribute('data-action');
    if (!action) return;
    // Accessibility selects fire on `change` and don't live in an
    // ai-provider-card, so handle them before the AI-card guard below.
    if (action === 'a11y-set-text-scale' && target instanceof HTMLSelectElement) {
      setTextScale(target.value);
      showSavedToast('Text size updated');
      return;
    }
    if (action === 'a11y-set-reduced-motion' && target instanceof HTMLSelectElement) {
      setReducedMotion(target.value);
      showSavedToast('Animation preference updated');
      return;
    }
    const card = target.closest('[data-region="ai-provider-card"]');
    if (!card) return;
    const idx = parseInt(card.getAttribute('data-idx') || '', 10);
    if (!Number.isFinite(idx)) return;
    if (action === 'ai-toggle-enabled' && target instanceof HTMLInputElement) {
      window.aiToggleEnabled?.(idx, target.checked);
    } else if (action === 'ai-update-field') {
      const field = target.getAttribute('data-field') || '';
      if (field) window.aiUpdateField?.(idx, field, target.value);
    }
  });

  // Drag-and-drop reordering of the AI provider chain. Pre-fix this
  // was four inline handlers on the .ai-provider-card div
  // (ondragstart/ondragover/ondragleave/ondrop). Drag events fire on
  // the dragged element directly (not via bubbling for `dragover`/
  // `drop` on the receiving element), so we listen on document and
  // resolve the target via closest('[data-region="ai-provider-card"]').
  // Behavior preserved verbatim from the previous window.aiDrag*
  // implementations.
  document.addEventListener('dragstart', (e) => {
    const hash = (window.location.hash || '').split('?')[0];
    if (hash !== '#/settings') return;
    const target = e.target instanceof Element ? e.target : null;
    const card = target?.closest('[data-region="ai-provider-card"]');
    if (!card) return;
    const idx = parseInt(card.getAttribute('data-idx') || '', 10);
    if (!Number.isFinite(idx)) return;
    window.aiDragStart?.(e, idx);
  });
  document.addEventListener('dragover', (e) => {
    const hash = (window.location.hash || '').split('?')[0];
    if (hash !== '#/settings') return;
    const target = e.target instanceof Element ? e.target : null;
    const card = target?.closest('[data-region="ai-provider-card"]');
    if (!card) return;
    const idx = parseInt(card.getAttribute('data-idx') || '', 10);
    if (!Number.isFinite(idx)) return;
    // The original handler used `e.currentTarget` to set borderColor.
    // Under delegation `currentTarget` is the document, so we shadow
    // the property on the event with the resolved card. The window.*
    // handlers don't otherwise touch currentTarget.
    Object.defineProperty(e, 'currentTarget', { value: card, configurable: true });
    window.aiDragOver?.(e, idx);
  });
  document.addEventListener('dragleave', (e) => {
    const hash = (window.location.hash || '').split('?')[0];
    if (hash !== '#/settings') return;
    const target = e.target instanceof Element ? e.target : null;
    const card = target?.closest('[data-region="ai-provider-card"]');
    if (!card) return;
    Object.defineProperty(e, 'currentTarget', { value: card, configurable: true });
    window.aiDragLeave?.(e);
  });
  document.addEventListener('drop', (e) => {
    const hash = (window.location.hash || '').split('?')[0];
    if (hash !== '#/settings') return;
    const target = e.target instanceof Element ? e.target : null;
    const card = target?.closest('[data-region="ai-provider-card"]');
    if (!card) return;
    const idx = parseInt(card.getAttribute('data-idx') || '', 10);
    if (!Number.isFinite(idx)) return;
    Object.defineProperty(e, 'currentTarget', { value: card, configurable: true });
    window.aiDrop?.(e, idx);
  });

  document.addEventListener('click', (e) => {
    const hash = (window.location.hash || '').split('?')[0];
    if (hash !== '#/settings') return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const el = target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    const uid = getCurrentUserId();
    switch (action) {
      case 'switch-user': {
        const input = document.getElementById('userId-input');
        if (input?.value) window.skyTwinSetUserId(input.value);
        return;
      }
      case 'select-tier':
        window.selectTier(el);
        // UX review #10: auto-save 800ms after selection so the user
        // doesn't have to remember to click Save. The Save button
        // remains for users who prefer the explicit affordance.
        scheduleTierAutosave(uid);
        return;
      case 'save-tier':
        window.saveTier(uid);
        return;
      case 'connect-google':
        window.handleConnectGoogle(uid);
        return;
      case 'disconnect-google':
        window.handleDisconnectGoogle(uid);
        return;
      case 'save-ai-providers':
        window.saveAIProvidersHandler(uid);
        return;
      case 'switch-to-smart':
        window.switchAIBrainMode(uid, 'smart');
        return;
      case 'switch-to-smarter':
        window.switchAIBrainMode(uid, 'smarter');
        return;
      case 'switch-to-smarter-blocked':
        // Visual feedback only — Smarter mode needs a paid provider in
        // the chain first. The pill helper text already says this; on
        // click we just flash the provider-add dropdown so the user's
        // eye is drawn there.
        document.getElementById('add-provider-select')?.focus();
        return;
      case 'delete-routine': {
        const routineId = el.getAttribute('data-routine-id');
        if (routineId) window.deleteRoutineHandler(routineId, uid);
        return;
      }
      case 'save-ironclaw-channel':
        window.saveIronClawChannel(uid);
        return;
      case 'pause-twin':
        window.pauseTwin(uid);
        return;
      case 'autonomy-pause-toggle':
        // #379 — true kill switch (separate from `pause-twin` which
        // demotes trust tier). Reads current state from the dataset
        // so the same handler covers both pause and resume.
        window.toggleAutonomyPause?.(uid);
        return;
      case 'save-spend-limits':
        window.saveSpendLimits(uid);
        return;
      case 'remove-domain-policy': {
        const domain = el.getAttribute('data-domain');
        if (domain) window.removeDomainPolicy(uid, domain);
        return;
      }
      case 'add-domain-policy':
        window.addDomainPolicy(uid);
        return;
      case 'remove-escalation-trigger': {
        const triggerId = el.getAttribute('data-trigger-id');
        if (triggerId) window.removeEscalationTrigger(uid, triggerId);
        return;
      }
      case 'add-escalation-trigger':
        window.addEscalationTrigger(uid);
        return;
      case 'generate-qr':
        window.generateQR(uid);
        return;
      case 'revoke-session': {
        const sessionId = el.getAttribute('data-session-id');
        if (sessionId) window.revokeSessionHandler(sessionId, uid);
        return;
      }
      case 'sign-out':
        window.signOut();
        return;
      case 'federation-pair-start':
        window.federationPairStart?.(uid);
        return;
      case 'federation-pair-complete':
        window.federationPairComplete?.(uid);
        return;
      case 'federation-unpair': {
        const peerId = el.getAttribute('data-peer-id');
        if (peerId) window.federationUnpair?.(uid, peerId);
        return;
      }
      case 'toggle-launch-at-login': {
        const checkbox = el;
        if (!(checkbox instanceof HTMLInputElement)) return;
        const enabled = checkbox.checked;
        window.skytwinDesktop?.setLaunchAtLogin?.(enabled)
          .then(() => showSavedToast(enabled ? 'Will start at login' : 'Won\'t start at login'))
          .catch((err) => {
            checkbox.checked = !enabled;
            showErrorToast(`Couldn\'t save: ${err?.message || 'unknown error'}`);
          });
        return;
      }
      case 'a11y-toggle-voice-first': {
        const checkbox = el;
        if (!(checkbox instanceof HTMLInputElement)) return;
        setVoiceFirst(checkbox.checked);
        showSavedToast(checkbox.checked ? 'Voice-first on' : 'Voice-first off');
        return;
      }
      case 'ai-test-provider': {
        const idx = parseInt(el.getAttribute('data-idx') || '', 10);
        if (Number.isFinite(idx)) window.aiTestProvider(idx, uid);
        return;
      }
      case 'ai-remove-provider': {
        const idx = parseInt(el.getAttribute('data-idx') || '', 10);
        if (Number.isFinite(idx)) window.aiRemoveProvider(idx, uid);
        return;
      }
    }
  });
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
    showSavedToast('Autonomy level saved');
  } catch (err) {
    btn.textContent = 'Save';
    btn.disabled = false;
    showErrorToast(`Couldn't save: ${err?.friendlyMessage || err?.message || 'unknown error'}`);
  }
};

/**
 * Debounced auto-save for the autonomy tier. UX review #10. Fires
 * 800ms after the last tier-option click — long enough that
 * mis-clicks don't ping the server, short enough to feel
 * responsive. Falls through to the same updateTrustTier path the
 * Save button uses so server-side semantics are identical.
 */
let _tierAutosaveTimer = null;
function scheduleTierAutosave(userId) {
  if (_tierAutosaveTimer) clearTimeout(_tierAutosaveTimer);
  _tierAutosaveTimer = setTimeout(async () => {
    _tierAutosaveTimer = null;
    const selected = document.querySelector('.tier-option.selected');
    if (!selected) return;
    const tier = selected.getAttribute('data-tier');
    if (!tier) return;
    try {
      await updateTrustTier(userId, tier);
      showSavedToast('Autonomy level saved');
    } catch (err) {
      showErrorToast(`Couldn't save: ${err?.friendlyMessage || err?.message || 'unknown error'}`);
    }
  }, 800);
}

window.handleConnectGoogle = async function(userId) {
  try {
    // In the desktop app, open OAuth in the system browser to support
    // passkeys/WebAuthn which Electron's BrowserWindow cannot handle.
    // The `desktop` flag must be set at authorize-time so the server can
    // sign it into the state — mutating the signed state on the client
    // breaks HMAC verification on the callback.
    const { startGoogleSignIn } = await import('../google-signin.js');
    const result = await startGoogleSignIn({
      userId,
      onComplete: async (connected) => {
        // Desktop polling runs for up to 5 minutes — the user may have
        // navigated away. Re-query the container and bail unless we're
        // still on /settings, so we don't render over another page.
        if (window.location.hash.split('?')[0] !== '#/settings') return;
        const banner = document.getElementById('oauth-polling-banner');
        if (!connected) {
          if (banner) banner.textContent = 'Sign-in timed out. Refresh the page to try again.';
          return;
        }
        banner?.remove();
        const container = document.getElementById('page-content');
        if (!container) return;
        await renderSettings(container, userId);
      },
    });
    // Re-query the container after the await — a navigation during the
    // startGoogleSignIn call could have detached the original element.
    const pageContent = document.getElementById('page-content');
    if (!pageContent) return;
    if (result.status === 'polling') {
      pageContent.insertAdjacentHTML(
        'afterbegin',
        '<div class="info-banner" id="oauth-polling-banner">Waiting for Google sign-in to complete in your browser\u2026</div>',
      );
      return;
    }
    if (result.status === 'redirecting') {
      return;
    }
    if (result.status === 'error') {
      const msg = /credentials|authorize url/i.test(result.error || '')
        ? 'Google access isn\'t set up on this server yet. Head to <a href="#/setup">Connect</a> for the 5-minute walkthrough.'
        : escapeHtml(result.error || 'Could not start Google sign-in.');
      pageContent.insertAdjacentHTML('afterbegin', `<div class="error-banner">${msg}</div>`);
      return;
    }
  } catch (err) {
    document.getElementById('page-content')?.insertAdjacentHTML(
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

/**
 * Kill-switch toggle (#379) — flips the per-user `paused` flag on
 * `autonomy_settings`. Reads current state from the button's dataset
 * so the same handler covers both pause→resume and resume→pause.
 * Confirmation prompts on both transitions: a misclick that re-arms
 * auto-execution is the worst kind of mistake here.
 */
window.toggleAutonomyPause = async function(userId) {
  const btn = document.getElementById('autonomy-pause-toggle');
  if (!btn) return;
  const currentlyPaused = btn.dataset['paused'] === 'true';
  const target = !currentlyPaused;
  const msg = target
    ? 'Pause your twin? Every action will be routed to the approvals queue for you to review manually.'
    : 'Resume auto-execution? Your twin will start acting on signals again.';
  if (!window.confirm(msg)) return;
  let reason;
  if (target) {
    reason = window.prompt('Optional: why are you pausing? (stored on your user record; leave blank to skip)', '') || undefined;
  }
  btn.disabled = true;
  btn.textContent = target ? 'Pausing…' : 'Resuming…';
  try {
    const res = await fetch(
      `/api/users/${encodeURIComponent(userId)}/autonomy-pause`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: target, reason }),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Refresh the on-page state + the chrome banner together.
    await refreshAutonomyPauseUi(userId);
    if (typeof window.updateAutonomyBanner === 'function') {
      window.updateAutonomyBanner();
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = currentlyPaused ? 'Resume auto-execution' : 'Pause auto-execution';
    document.getElementById('page-content')?.insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">Couldn't update pause state: ${escapeHtml(err?.message ?? 'unknown error')}</div>`,
    );
  }
};

async function refreshAutonomyPauseUi(userId) {
  const stateEl = document.getElementById('autonomy-pause-state');
  const btn = document.getElementById('autonomy-pause-toggle');
  if (!stateEl || !btn) return;
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(userId)}/autonomy-state`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json();
    const operator = Boolean(state.globalPause);
    const user = Boolean(state.userPause);
    const parts = [];
    if (operator) parts.push('Operator pause is active (env var); only the operator can clear it.');
    if (user) {
      const at = state.pausedAt ? ` (since ${new Date(state.pausedAt).toLocaleString()})` : '';
      const why = state.pausedReason ? ` — "${state.pausedReason}"` : '';
      parts.push(`Your toggle: PAUSED${at}${why}.`);
    } else {
      parts.push('Your toggle: ACTIVE. Your twin can act on signals per your trust tier.');
    }
    stateEl.textContent = parts.join(' ');
    btn.disabled = operator; // Operator pause overrides; user toggle is moot until lifted.
    btn.dataset['paused'] = user ? 'true' : 'false';
    btn.textContent = operator
      ? 'Operator pause active (can\'t override here)'
      : user
        ? 'Resume auto-execution'
        : 'Pause auto-execution';
  } catch {
    stateEl.textContent = 'Couldn\'t load pause state.';
    btn.disabled = true;
    btn.textContent = '—';
  }
}

// Trigger the state load when the Settings page mounts. Hooks into the
// existing render path so refresh-on-navigate works without touching
// the main settings flow.
if (typeof window !== 'undefined') {
  window._refreshAutonomyPauseUi = refreshAutonomyPauseUi;
}

window.saveSpendLimits = async function(userId) {
  try {
    // Inputs are dollars; convert to cents for the API. Round to avoid
    // float drift (e.g. 100.10 → 10010, not 10009.999...).
    const dollarsToCents = (id) => Math.round(parseFloat(document.getElementById(id).value) * 100);
    await updateAutonomySettings(userId, {
      maxSpendPerActionCents: dollarsToCents('max-per-action'),
      maxDailySpendCents: dollarsToCents('max-daily'),
      requireApprovalForIrreversible: document.getElementById('irreversible-approval').checked,
    });
    showSavedToast('Spending limits saved');
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    showErrorToast(`Couldn't save spending limits: ${err?.friendlyMessage || err?.message || 'unknown error'}`);
  }
};

/**
 * Auto-save the spending guardrails 1.2s after the last edit. UX
 * review #10. Slightly slower debounce than the tier (800ms) because
 * the user is typing into a number input and we want to wait for them
 * to finish, not save on every keystroke.
 *
 * Wired in `ensureSettingsListener` via input/change delegation; the
 * Save button still works for users who click it before the timer.
 */
let _spendAutosaveTimer = null;
function scheduleSpendAutosave(userId) {
  if (_spendAutosaveTimer) clearTimeout(_spendAutosaveTimer);
  _spendAutosaveTimer = setTimeout(async () => {
    _spendAutosaveTimer = null;
    try {
      const dollarsToCents = (id) => Math.round(parseFloat(document.getElementById(id).value) * 100);
      const perAction = dollarsToCents('max-per-action');
      const perDay = dollarsToCents('max-daily');
      // Skip auto-save if either field is invalid — the user is mid-edit
      // (e.g. just typed a `.`). The Save button still works.
      if (Number.isNaN(perAction) || Number.isNaN(perDay)) return;
      await updateAutonomySettings(userId, {
        maxSpendPerActionCents: perAction,
        maxDailySpendCents: perDay,
        requireApprovalForIrreversible: document.getElementById('irreversible-approval').checked,
      });
      showSavedToast('Spending limits saved');
    } catch (err) {
      showErrorToast(`Couldn't save spending limits: ${err?.friendlyMessage || err?.message || 'unknown error'}`);
    }
  }, 1200);
}

window.saveIronClawChannel = async function(userId) {
  const select = document.getElementById('ironclaw-channel-select');
  const status = document.getElementById('ironclaw-channel-status');
  try {
    await updateIronClawChannel(userId, select.value);
    status.innerHTML = '<span style="color: var(--success);">Saved</span>';
  } catch (err) {
    status.innerHTML = `<span style="color: var(--danger);">${escapeHtml(err.message)}</span>`;
  }
};

window.deleteRoutineHandler = async function(routineId, userId) {
  try {
    await deleteRoutine(routineId, userId);
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

// ── AI Provider Chain: drag-and-drop + CRUD ─────────────────

const PROVIDER_MODELS = {
  anthropic: [
    { id: 'claude-sonnet-4-5-20250514', label: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  ],
  google: [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  ollama: [
    { id: 'gemma3', label: 'Gemma 3' },
    { id: 'llama3.1', label: 'Llama 3.1' },
    { id: 'mistral', label: 'Mistral' },
  ],
  embedded: [
    { id: 'auto', label: 'Auto-detect (first GGUF in model dir)' },
  ],
};

const PROVIDER_LABELS = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  google: 'Google (Gemini)',
  ollama: 'Ollama (local)',
  embedded: 'Embedded (llama.cpp)',
};

// #187 AC#6: providers that count as "Smarter" — i.e. external paid APIs
// the user is choosing to delegate the harder thinking to. `ollama` lives
// on a third rail: it's local like `embedded` but the user installed it
// themselves, so we treat it as Smarter too (the operator chose it
// deliberately and may have a beefier model than the embedded default).
const SMARTER_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'ollama']);

/**
 * Determine the user's current AI mode from their provider chain.
 *
 *   'smart'    — top enabled provider is `embedded` (Smart mode default
 *                per #187 AC#6).
 *   'smarter'  — top enabled provider is hosted / Ollama (BYO API path).
 *   'none'     — no enabled providers; the LlmClient will return null and
 *                callers fall back to local AI + built-in rules.
 *
 * Pure helper so the mode pill, the action handler, and any future audit
 * route all agree on one definition.
 */
export function detectAIMode(chain) {
  const enabled = chain.filter((p) => p.enabled !== false);
  if (enabled.length === 0) return 'none';
  const top = enabled.slice().sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
  if (!top) return 'none';
  if (top.provider === 'embedded') return 'smart';
  if (SMARTER_PROVIDERS.has(top.provider)) return 'smarter';
  return 'none';
}

/**
 * Reorder the chain so `embedded` is the top-priority enabled provider.
 * Adds an `embedded` entry if one doesn't exist yet so first-time-Smart
 * users get a working configuration in one click. Returns the new chain
 * (does not mutate the input).
 *
 * The embedded entry uses `'auto'` as the model so the runtime resolves
 * the first GGUF in the detected modelDir — matching the convention
 * `apps/web/public/js/components/embedded-llm-card.js` uses for fresh
 * installs.
 */
export function applySmartMode(chain) {
  const next = chain.map((p) => ({ ...p }));
  let embedded = next.find((p) => p.provider === 'embedded');
  if (!embedded) {
    embedded = {
      provider: 'embedded',
      model: 'auto',
      apiKey: '',
      baseUrl: undefined,
      priority: 0,
      enabled: true,
      hasApiKey: false,
      apiKeyPreview: '',
    };
    next.push(embedded);
  } else {
    embedded.enabled = true;
  }
  // Rebuild priorities so embedded is at 0 and the rest preserve their
  // relative order. This is the contract the API expects (priorities are
  // unique sequential integers).
  const others = next.filter((p) => p !== embedded);
  others.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return [embedded, ...others].map((p, i) => ({ ...p, priority: i }));
}

/**
 * Reorder the chain so the first hosted/Ollama provider (by priority)
 * becomes top-priority. The selected provider is force-enabled — a
 * deliberately-disabled hosted entry is treated as "configured but
 * paused," and switching to Smarter re-enables it. Returns null when
 * no hosted/Ollama provider exists in the chain at all (caller
 * surfaces "configure a paid provider first").
 *
 * Note: this scans the full chain regardless of `enabled` state, then
 * force-enables the chosen entry. The previous docstring said "first
 * non-embedded *enabled* provider" — that wording implied a filter
 * we don't actually apply. Doc updated to match behavior; Copilot
 * round-2 on PR #253 caught the mismatch.
 */
export function applySmarterMode(chain) {
  const next = chain.map((p) => ({ ...p }));
  next.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const smarterIdx = next.findIndex((p) => SMARTER_PROVIDERS.has(p.provider));
  if (smarterIdx === -1) return null;
  const target = next[smarterIdx];
  target.enabled = true;
  const others = next.filter((p) => p !== target);
  return [target, ...others].map((p, i) => ({ ...p, priority: i }));
}

// In-memory state for the current chain being edited
let _aiChain = [];

/**
 * #187 AC#6: render the Smart / Smarter mode pill above the provider
 * chain. Active mode is highlighted; clicking the inactive pill reorders
 * priorities and auto-saves.
 *
 * Disabled states (rendered as helper text under the inactive pill):
 *   - Switch-to-Smarter is disabled when no hosted/Ollama provider exists
 *     in the chain (we don't auto-add one because the user has to supply
 *     an API key).
 *   - Switch-to-Smart is always available — if no embedded entry exists
 *     yet, `applySmartMode` adds one with `model: 'auto'` so the runtime
 *     picks up the first GGUF in the detected model directory.
 */
function renderModeToggle(providers) {
  const mode = detectAIMode(providers);
  const hasSmarterCandidate = providers.some((p) => SMARTER_PROVIDERS.has(p.provider));

  const pill = (label, isActive, action, helperText) => `
    <div style="flex: 1; min-width: 0;">
      <button class="btn ${isActive ? 'btn-primary' : 'btn-outline'} btn-sm"
              style="width: 100%; padding: 0.5rem 0.75rem; font-size: 0.85rem;"
              data-action="${action}"
              ${isActive ? 'disabled' : ''}>
        ${isActive ? '✓ ' : ''}${label}${isActive ? '' : ' →'}
      </button>
      ${helperText ? `<div style="font-size: 0.7rem; color: var(--text-dim); margin-top: 0.25rem;">${helperText}</div>` : ''}
    </div>
  `;

  return `
    <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem;">
      ${pill(
        'Smart (free, on-device)',
        mode === 'smart',
        'switch-to-smart',
        mode === 'smart'
          ? 'Embedded model is your top choice.'
          : 'No API costs, runs offline.',
      )}
      ${pill(
        'Smarter (paid API or Ollama)',
        mode === 'smarter',
        hasSmarterCandidate ? 'switch-to-smarter' : 'switch-to-smarter-blocked',
        mode === 'smarter'
          ? 'Your hosted provider or Ollama is the top choice.'
          : hasSmarterCandidate
            ? 'Sharper reasoning on tricky calls.'
            : 'Add a hosted provider or Ollama below first.',
      )}
    </div>
  `;
}

function renderProviderChain(providers) {
  _aiChain = providers.map((p, i) => ({ ...p, priority: i }));

  if (_aiChain.length === 0) {
    return '<div style="font-size: 0.85rem; color: var(--text-muted); padding: 0.75rem; background: var(--bg); border-radius: var(--radius-sm);">No paid providers added. Your twin runs on the local AI on this machine plus built-in rules — that\'s the default.</div>';
  }

  return _aiChain.map((p, idx) => `
    <div class="ai-provider-card" draggable="true" data-idx="${idx}"
         data-region="ai-provider-card"
         style="display: flex; gap: 0.5rem; align-items: flex-start; padding: 0.75rem; background: var(--bg); border-radius: var(--radius-sm); margin-bottom: 0.5rem; border: 2px solid transparent; cursor: grab; transition: border-color 0.15s, opacity 0.15s;">
      <div style="display: flex; flex-direction: column; align-items: center; gap: 0.25rem; padding-top: 0.25rem; color: var(--text-dim); font-size: 0.75rem; user-select: none;">
        <span style="font-size: 1rem; line-height: 1;">&#x2800;&#x2801;&#x2802;&#x2803;</span>
        <span>${idx + 1}</span>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <span style="font-weight: 600; font-size: 0.9rem;">${escapeHtml(PROVIDER_LABELS[p.provider] || p.provider)}</span>
          <div style="display: flex; gap: 0.25rem; align-items: center;">
            <label style="font-size: 0.75rem; display: flex; align-items: center; gap: 0.25rem; cursor: pointer;">
              <input type="checkbox" ${p.enabled !== false ? 'checked' : ''} data-action="ai-toggle-enabled">
              on
            </label>
            <button class="btn btn-outline btn-sm" style="padding: 0.15rem 0.4rem; font-size: 0.7rem;" data-action="ai-test-provider" data-idx="${idx}">Test</button>
            <button class="btn btn-outline btn-sm" style="padding: 0.15rem 0.4rem; font-size: 0.7rem; color: var(--danger);" data-action="ai-remove-provider" data-idx="${idx}">×</button>
          </div>
        </div>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 120px;">
            <label style="font-size: 0.7rem; color: var(--text-dim);">Model</label>
            ${p.provider === 'ollama'
              ? `<input class="form-input" style="font-size: 0.8rem; padding: 0.3rem 0.5rem;" value="${escapeHtml(p.model || '')}" data-action="ai-update-field" data-field="model">`
              : `<select class="form-input" style="font-size: 0.8rem; padding: 0.3rem 0.5rem;" data-action="ai-update-field" data-field="model">
                  ${(PROVIDER_MODELS[p.provider] || []).map(m => `<option value="${m.id}" ${m.id === p.model ? 'selected' : ''}>${m.label}</option>`).join('')}
                </select>`
            }
          </div>
          ${p.provider === 'ollama'
            ? `<div style="flex: 1; min-width: 150px;">
                <label style="font-size: 0.7rem; color: var(--text-dim);">URL</label>
                <input class="form-input" style="font-size: 0.8rem; padding: 0.3rem 0.5rem;" value="${escapeHtml(p.baseUrl || 'http://localhost:11434')}" placeholder="http://localhost:11434" data-action="ai-update-field" data-field="baseUrl">
              </div>`
            : `<div style="flex: 1; min-width: 150px;">
                <label style="font-size: 0.7rem; color: var(--text-dim);">API Key</label>
                <input class="form-input" type="password" style="font-size: 0.8rem; padding: 0.3rem 0.5rem;" value="${escapeHtml(p.apiKey || '')}" placeholder="${p.apiKeyPreview || 'Paste your API key'}" data-action="ai-update-field" data-field="apiKey">
              </div>`
          }
        </div>
        <div id="ai-test-result-${idx}" style="margin-top: 0.25rem;"></div>
      </div>
    </div>
  `).join('');
}

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || 'default-user';
}

// Drag and drop state
let _aiDragIdx = null;

window.aiDragStart = function(e, idx) {
  _aiDragIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.style.opacity = '0.5';
};

window.aiDragOver = function(e, idx) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (_aiDragIdx !== null && _aiDragIdx !== idx) {
    e.currentTarget.style.borderColor = 'var(--accent)';
  }
};

window.aiDragLeave = function(e) {
  e.currentTarget.style.borderColor = 'transparent';
};

window.aiDrop = function(e, targetIdx) {
  e.preventDefault();
  e.currentTarget.style.borderColor = 'transparent';
  if (_aiDragIdx === null || _aiDragIdx === targetIdx) return;

  const item = _aiChain.splice(_aiDragIdx, 1)[0];
  _aiChain.splice(targetIdx, 0, item);
  _aiChain.forEach((p, i) => { p.priority = i; });
  _aiDragIdx = null;

  document.getElementById('ai-provider-chain').innerHTML = renderProviderChain(_aiChain);
};

window.aiToggleEnabled = function(idx, checked) {
  _aiChain[idx].enabled = checked;
};

window.aiUpdateField = function(idx, field, value) {
  _aiChain[idx][field] = value;
};

window.aiRemoveProvider = function(idx, userId) {
  _aiChain.splice(idx, 1);
  _aiChain.forEach((p, i) => { p.priority = i; });
  document.getElementById('ai-provider-chain').innerHTML = renderProviderChain(_aiChain);
};

window.aiTestProvider = async function(idx, userId) {
  const p = _aiChain[idx];
  const resultEl = document.getElementById(`ai-test-result-${idx}`);
  resultEl.innerHTML = '<span style="font-size: 0.75rem; color: var(--text-muted);">Testing...</span>';

  try {
    const result = await testAIProvider(userId, {
      provider: p.provider,
      apiKey: p.apiKey || '',
      model: p.model,
      baseUrl: p.baseUrl,
    });

    if (result.success) {
      resultEl.innerHTML = `<span style="font-size: 0.75rem; color: var(--success);">Connected — ${escapeHtml(result.model)} responding in ~${result.latencyMs}ms</span>`;
    } else {
      resultEl.innerHTML = `<span style="font-size: 0.75rem; color: var(--danger);">Failed: ${escapeHtml(result.error || 'Unknown error')}</span>`;
    }
  } catch (err) {
    resultEl.innerHTML = `<span style="font-size: 0.75rem; color: var(--danger);">Error: ${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`;
  }
};

/**
 * #187 AC#6: click handler for the Smart / Smarter mode pills. Applies
 * the priority reorder locally, then auto-saves through the same
 * `saveAIProviders` round-trip the manual "Save" button uses. After save
 * the settings page re-renders so the pill state and the provider chain
 * agree.
 */
window.switchAIBrainMode = async function(userId, target) {
  const next = target === 'smart'
    ? applySmartMode(_aiChain)
    : applySmarterMode(_aiChain);
  if (!next) {
    // applySmarterMode returned null — no paid provider in the chain.
    // The `switch-to-smarter-blocked` action handles the focus-the-add-
    // dropdown UX; this branch is defense in depth in case the action
    // gets routed here anyway.
    return;
  }
  // Snapshot the previous chain so we can roll back the optimistic
  // render if the save fails. Copilot's review of PR #253 caught that
  // the prior implementation left the pill + provider list visually
  // implying success when the server actually rejected the write
  // (e.g. when the API didn't accept `embedded` yet — see paired fix
  // in apps/api/src/routes/settings.ts).
  const prev = _aiChain.map((p) => ({ ...p }));
  _aiChain = next;
  // Re-render the pill + provider chain optimistically so the click
  // produces an immediate visual change while the save round-trips.
  document.getElementById('ai-mode-toggle').innerHTML = renderModeToggle(_aiChain);
  document.getElementById('ai-provider-chain').innerHTML = renderProviderChain(_aiChain);

  try {
    await saveAIProviders(userId, _aiChain.map((p, i) => ({
      provider: p.provider,
      apiKey: p.apiKey || '',
      model: p.model,
      baseUrl: p.baseUrl,
      priority: i,
      enabled: p.enabled !== false,
    })));
    // Re-fetch from the server so the pill reflects the persisted state
    // (handles edge cases like an existing-but-disabled embedded entry
    // that was re-enabled by applySmartMode, where the server response
    // may carry extra fields not in our optimistic copy).
    const { renderSettings } = await import('./settings.js');
    await renderSettings(document.getElementById('page-content'), userId);
  } catch (err) {
    // Roll back the optimistic state so the user doesn't think the
    // switch succeeded.
    _aiChain = prev;
    document.getElementById('ai-mode-toggle').innerHTML = renderModeToggle(_aiChain);
    document.getElementById('ai-provider-chain').innerHTML = renderProviderChain(_aiChain);
    // Defensive `err.message` access — a non-Error rejection (string,
    // object, undefined) would otherwise produce "Failed to switch
    // mode: undefined" on the banner. Copilot round-2 on PR #253
    // flagged the prior direct-access.
    const msg = err instanceof Error ? err.message : String(err);
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">Failed to switch mode: ${escapeHtml(msg)}</div>`,
    );
  }
};

window.saveAIProvidersHandler = async function(userId) {
  const btn = document.getElementById('save-ai-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  try {
    await saveAIProviders(userId, _aiChain.map((p, i) => ({
      provider: p.provider,
      apiKey: p.apiKey || '',
      model: p.model,
      baseUrl: p.baseUrl,
      priority: i,
      enabled: p.enabled !== false,
    })));
    if (btn) { btn.textContent = 'Saved!'; }
    setTimeout(async () => {
      const { renderSettings } = await import('./settings.js');
      await renderSettings(document.getElementById('page-content'), userId);
    }, 800);
  } catch (err) {
    if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
    document.getElementById('page-content').insertAdjacentHTML(
      'afterbegin',
      `<div class="error-banner">${escapeHtml(err.message)}</div>`,
    );
  }
};

// Handle the "Add provider" dropdown
document.addEventListener('change', (e) => {
  if (e.target?.id !== 'add-provider-select') return;
  const provider = e.target.value;
  if (!provider) return;
  e.target.value = '';

  const models = PROVIDER_MODELS[provider] || [];
  const defaultModel = models[0]?.id || '';

  _aiChain.push({
    provider,
    model: defaultModel,
    apiKey: '',
    baseUrl: provider === 'ollama' ? 'http://localhost:11434' : undefined,
    priority: _aiChain.length,
    enabled: true,
    hasApiKey: false,
    apiKeyPreview: '',
  });

  document.getElementById('ai-provider-chain').innerHTML = renderProviderChain(_aiChain);
});

window.signOut = function() {
  // Clear identity AND the bearer token. Without dropping the session
  // token, the next user-switch / new-onboarding flow would still send
  // the prior user's bearer header from api-client.js authHeaders(),
  // either 403'ing the new identity or silently keeping the old one.
  localStorage.removeItem(KEY_USER_ID);
  localStorage.removeItem(KEY_ONBOARDED);
  localStorage.removeItem(KEY_SESSION_TOKEN);
  window.location.hash = '#/';
  window.location.reload();
};
