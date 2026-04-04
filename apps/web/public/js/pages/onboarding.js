import { createUser, getGoogleAuthUrl, updateTrustTier, fetchJSON, fetchTwinProfile } from '../api-client.js';

// ── Domain definitions ──────────────────────────────────────────────

const DOMAINS = [
  { id: 'email', icon: '📧', name: 'Email Management', desc: 'Organize inbox, filter spam, draft replies', preSelected: true },
  { id: 'calendar', icon: '📅', name: 'Calendar', desc: 'Handle scheduling conflicts, manage invites', preSelected: true },
  { id: 'finance', icon: '💰', name: 'Finance', desc: 'Track expenses, pay bills, flag suspicious charges', preSelected: false },
  { id: 'shopping', icon: '🛒', name: 'Shopping', desc: 'Reorder staples, track prices, manage subscriptions', preSelected: false },
  { id: 'travel', icon: '✈️', name: 'Travel', desc: 'Find deals, set alerts, manage bookings', preSelected: false },
  { id: 'tasks', icon: '✅', name: 'Tasks', desc: 'Create to-dos, set reminders, track projects', preSelected: false },
  { id: 'smart_home', icon: '🏠', name: 'Smart Home', desc: 'Adjust thermostat, manage lights, run routines', preSelected: false },
  { id: 'social', icon: '💬', name: 'Social Media', desc: 'Draft posts, respond to mentions, manage notifications', preSelected: false },
  { id: 'documents', icon: '📄', name: 'Documents', desc: 'Organize files, share docs, generate summaries', preSelected: false },
  { id: 'health', icon: '❤️', name: 'Health', desc: 'Track medications, book appointments, log health data', preSelected: false },
];

// ── Preference questions per domain ─────────────────────────────────

const DOMAIN_QUESTIONS = {
  email: [
    { key: 'auto_archive_promo', label: 'Auto-archive promotional emails?' },
    { key: 'draft_work_replies', label: 'Draft replies to work emails?' },
  ],
  calendar: [
    { key: 'protect_morning_focus', label: 'Protect morning focus time?' },
    { key: 'auto_accept_recurring', label: 'Auto-accept recurring meetings?' },
  ],
  finance: [
    { key: 'alert_large_charges', label: 'Alert me on charges over $50?' },
    { key: 'auto_categorize_transactions', label: 'Auto-categorize transactions?' },
  ],
  shopping: [
    { key: 'track_price_drops', label: 'Track price drops?' },
    { key: 'auto_reorder_low_stock', label: 'Auto-reorder when items run low?' },
  ],
  travel: [
    { key: 'find_travel_deals', label: 'Find and alert on travel deals?' },
    { key: 'manage_bookings', label: 'Auto-manage booking confirmations?' },
  ],
  tasks: [
    { key: 'create_tasks_from_emails', label: 'Create tasks from emails?' },
    { key: 'daily_reminders', label: 'Set daily reminders?' },
  ],
  smart_home: [
    { key: 'auto_thermostat_bedtime', label: 'Auto-adjust thermostat at bedtime?' },
    { key: 'lights_off_when_away', label: 'Turn off lights when away?' },
  ],
  social: [
    { key: 'auto_mute_spam', label: 'Auto-mute spam conversations?' },
    { key: 'draft_mention_responses', label: 'Draft responses to mentions?' },
  ],
  documents: [
    { key: 'auto_organize_downloads', label: 'Auto-organize downloaded files?' },
    { key: 'summarize_long_docs', label: 'Summarize long documents?' },
  ],
  health: [
    { key: 'medication_reminders', label: 'Medication reminders?' },
    { key: 'track_daily_metrics', label: 'Track daily health metrics?' },
  ],
};

// ── Steps ───────────────────────────────────────────────────────────

const STEPS = [
  // Step 1: Welcome
  {
    render: (container, next) => {
      container.innerHTML = `
        <div class="onboarding-step">Step 1 of 5</div>
        <div class="onboarding-title">Meet your digital twin</div>
        <div class="onboarding-desc">
          SkyTwin learns how you like things done, then starts handling them for you — across every part of your life.
        </div>
        <div class="domain-showcase">
          <span class="domain-icon-preview">📧</span>
          <span class="domain-icon-preview">📅</span>
          <span class="domain-icon-preview">💰</span>
          <span class="domain-icon-preview">🛒</span>
          <span class="domain-icon-preview">✈️</span>
          <span class="domain-icon-preview">✅</span>
          <span class="domain-icon-preview">🏠</span>
          <span class="domain-icon-preview">💬</span>
          <span class="domain-icon-preview">📄</span>
          <span class="domain-icon-preview">❤️</span>
        </div>
        <ul class="feature-list">
          <li>Manages email, calendar, finances, shopping, and more</li>
          <li>Learns your preferences from every decision you make</li>
          <li>Handles routine tasks so you can focus on what matters</li>
          <li>Always explains what it did and why</li>
          <li>You stay in control — choose how much it does on its own</li>
        </ul>
        <div class="onboarding-actions">
          <button class="btn btn-primary btn-lg" id="onb-next-1">Let's get started</button>
        </div>
      `;
      document.getElementById('onb-next-1').addEventListener('click', next);
    },
  },

  // Step 2: Email + name + Google connect
  {
    render: (container, next, back, setUserId) => {
      container.innerHTML = `
        <div class="onboarding-step">Step 2 of 5</div>
        <div class="onboarding-title">What's your name and email?</div>
        <div class="onboarding-desc">
          We'll use this to identify you. Nothing will be sent to this address.
        </div>
        <div class="form-group">
          <label>Your name</label>
          <input class="form-input" id="onb-name" type="text" placeholder="Jane" autofocus>
        </div>
        <div class="form-group">
          <label>Your email address</label>
          <input class="form-input" id="onb-email" type="email" placeholder="you@example.com">
        </div>
        <div id="onb-error" style="color: var(--danger); font-size: 0.85rem; margin-top: 0.5rem; display: none;"></div>
        <div class="onboarding-desc" style="font-size: 0.85rem; margin-top: 1rem;">
          <strong>Optional:</strong> Connect your Google account so SkyTwin can see your inbox and calendar. You can do this later in Settings.
        </div>
        <div style="margin-bottom: 1.5rem;">
          <button class="btn btn-outline" id="onb-connect-google">Connect my email &amp; calendar</button>
        </div>
        <div class="onboarding-actions" style="display: flex; gap: 0.75rem;">
          <button class="btn btn-outline" id="onb-back-2">Back</button>
          <button class="btn btn-primary btn-lg" id="onb-next-2">Continue</button>
        </div>
      `;

      document.getElementById('onb-back-2').addEventListener('click', back);

      document.getElementById('onb-connect-google').addEventListener('click', async () => {
        const email = document.getElementById('onb-email').value.trim();
        if (!email || !email.includes('@')) {
          showError('Please enter your email address first.');
          return;
        }
        try {
          const data = await getGoogleAuthUrl(email);
          if (data.url) window.open(data.url, '_blank');
        } catch {
          showError('Could not connect to Google right now. You can try again later in Settings.');
        }
      });

      document.getElementById('onb-next-2').addEventListener('click', async () => {
        const email = document.getElementById('onb-email').value.trim();
        const name = document.getElementById('onb-name').value.trim() || email.split('@')[0];
        if (!email || !email.includes('@')) {
          showError('Please enter a valid email address.');
          return;
        }
        hideError();
        const btn = document.getElementById('onb-next-2');
        btn.textContent = 'Setting up...';
        btn.disabled = true;
        try {
          const result = await createUser(email, name, 'suggest');
          setUserId(result.user.id || email);
          next();
        } catch (err) {
          showError(err.message || 'Something went wrong. Please try again.');
          btn.textContent = 'Continue';
          btn.disabled = false;
        }
      });

      function showError(msg) {
        const el = document.getElementById('onb-error');
        el.textContent = msg;
        el.style.display = 'block';
      }
      function hideError() {
        document.getElementById('onb-error').style.display = 'none';
      }
    },
  },

  // Step 3: Domain selection
  {
    render: (container, next, back, _setUserId, _complete, state) => {
      container.innerHTML = `
        <div class="onboarding-step">Step 3 of 5</div>
        <div class="onboarding-title">What should I help with?</div>
        <div class="onboarding-desc">
          Pick the areas where you'd like your assistant to lend a hand. You can always add or remove these later.
        </div>
        <div class="domain-grid" id="domain-grid">
          ${DOMAINS.map(d => `
            <div class="domain-card ${state.selectedDomains.includes(d.id) ? 'selected' : ''}" data-domain="${d.id}">
              <div class="domain-card-icon">${d.icon}</div>
              <div class="domain-card-name">${d.name}</div>
              <div class="domain-card-desc">${d.desc}</div>
            </div>
          `).join('')}
        </div>
        <div class="onboarding-actions" style="margin-top: 1.5rem; display: flex; gap: 0.75rem;">
          <button class="btn btn-outline" id="onb-back-3">Back</button>
          <button class="btn btn-primary btn-lg" id="onb-next-3">Continue</button>
        </div>
      `;

      document.getElementById('onb-back-3').addEventListener('click', back);

      document.querySelectorAll('.domain-card').forEach(el => {
        el.addEventListener('click', () => {
          const domainId = el.getAttribute('data-domain');
          el.classList.toggle('selected');
          if (el.classList.contains('selected')) {
            if (!state.selectedDomains.includes(domainId)) {
              state.selectedDomains.push(domainId);
            }
          } else {
            state.selectedDomains = state.selectedDomains.filter(d => d !== domainId);
          }
        });
      });

      document.getElementById('onb-next-3').addEventListener('click', () => {
        if (state.selectedDomains.length === 0) {
          state.selectedDomains.push('email', 'calendar');
        }
        next();
      });
    },
  },

  // Step 4: Quick preferences
  {
    render: (container, next, back, _setUserId, _complete, state) => {
      const questions = [];
      for (const domainId of state.selectedDomains) {
        const domainDef = DOMAINS.find(d => d.id === domainId);
        const domainQs = DOMAIN_QUESTIONS[domainId] || [];
        if (domainQs.length > 0) {
          questions.push({ domain: domainDef, questions: domainQs });
        }
      }

      container.innerHTML = `
        <div class="onboarding-step">Step 4 of 5</div>
        <div class="onboarding-title">Set some starting preferences</div>
        <div class="onboarding-desc">
          Quick yes-or-no questions to get your assistant started. You can fine-tune everything later.
        </div>
        <div class="pref-sections" id="pref-sections">
          ${questions.map(q => `
            <div class="pref-section">
              <div class="pref-section-header">${q.domain.icon} ${q.domain.name}</div>
              ${q.questions.map(pq => `
                <label class="pref-question" data-domain="${q.domain.id}" data-key="${pq.key}">
                  <span class="pref-label">${pq.label}</span>
                  <input type="checkbox" class="pref-toggle" ${state.preferences[q.domain.id + ':' + pq.key] ? 'checked' : ''}>
                  <span class="pref-switch"></span>
                </label>
              `).join('')}
            </div>
          `).join('')}
        </div>
        ${questions.length === 0 ? '<div class="onboarding-desc" style="text-align: center; opacity: 0.7;">No questions for the selected domains. Click Continue to proceed.</div>' : ''}
        <div class="onboarding-actions" style="margin-top: 1.5rem; display: flex; gap: 0.75rem;">
          <button class="btn btn-outline" id="onb-back-4">Back</button>
          <button class="btn btn-primary btn-lg" id="onb-next-4">Continue</button>
        </div>
      `;

      document.getElementById('onb-back-4').addEventListener('click', back);

      // Sync checkbox state on toggle
      document.querySelectorAll('.pref-question').forEach(el => {
        const checkbox = el.querySelector('.pref-toggle');
        const domain = el.getAttribute('data-domain');
        const key = el.getAttribute('data-key');
        checkbox.addEventListener('change', () => {
          state.preferences[domain + ':' + key] = checkbox.checked;
        });
      });

      document.getElementById('onb-next-4').addEventListener('click', () => {
        // Capture final checkbox states
        document.querySelectorAll('.pref-question').forEach(el => {
          const checkbox = el.querySelector('.pref-toggle');
          const domain = el.getAttribute('data-domain');
          const key = el.getAttribute('data-key');
          state.preferences[domain + ':' + key] = checkbox.checked;
        });
        next();
      });
    },
  },

  // Step 5: Trust tier selection
  {
    render: (container, _next, back, _setUserId, complete) => {
      let selectedTier = 'suggest';

      const TIERS = [
        { value: 'observer', name: 'Just watching', desc: 'Your assistant watches but never does anything. Good for seeing what it would do.' },
        { value: 'suggest', name: 'Ask me first', desc: 'Your assistant suggests actions and waits for your OK. The safest way to start.' },
        { value: 'low_autonomy', name: 'Handle small stuff', desc: 'Automatically handles small, routine tasks (like archiving junk mail). Asks about everything else.' },
        { value: 'moderate_autonomy', name: 'Handle most things', desc: 'Handles most things on its own. Only asks about big or unusual decisions.' },
        { value: 'high_autonomy', name: 'Full autopilot', desc: 'Handles everything within your rules. Only stops for important decisions or spending limits.' },
      ];

      container.innerHTML = `
        <div class="onboarding-step">Step 5 of 5</div>
        <div class="onboarding-title">How much should I do on my own?</div>
        <div class="onboarding-desc">
          Choose how independent your assistant should be. You can change this anytime.
        </div>
        <div class="tier-options" id="tier-options">
          ${TIERS.map(t => `
            <div class="tier-option ${t.value === selectedTier ? 'selected' : ''}" data-tier="${t.value}">
              <div class="tier-radio"></div>
              <div>
                <div class="tier-name">${t.name}${t.value === 'suggest' ? ' <span style="color: var(--accent); font-size: 0.75rem;">(recommended)</span>' : ''}</div>
                <div class="tier-desc">${t.desc}</div>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="onboarding-actions" style="margin-top: 1.5rem; display: flex; gap: 0.75rem;">
          <button class="btn btn-outline" id="onb-back-5">Back</button>
          <button class="btn btn-primary btn-lg" id="onb-complete">Get Started</button>
        </div>
      `;

      document.getElementById('onb-back-5').addEventListener('click', back);

      document.querySelectorAll('.tier-option').forEach(el => {
        el.addEventListener('click', () => {
          document.querySelectorAll('.tier-option').forEach(o => o.classList.remove('selected'));
          el.classList.add('selected');
          selectedTier = el.getAttribute('data-tier');
        });
      });

      document.getElementById('onb-complete').addEventListener('click', async () => {
        const btn = document.getElementById('onb-complete');
        btn.textContent = 'Getting ready...';
        btn.disabled = true;
        try {
          await complete(selectedTier);
        } catch {
          btn.textContent = 'Get Started';
          btn.disabled = false;
        }
      });
    },
  },
];

/**
 * Show a "connecting to your accounts" screen after onboarding completes.
 * Polls for signals/decisions and shows the first few as they arrive.
 */
async function showSignalPreview(container, userId) {
  container.innerHTML = `
    <div class="onboarding-step">Almost ready</div>
    <div class="onboarding-title">Connecting to your accounts...</div>
    <div class="onboarding-desc">
      I'm checking your email and calendar for things I can help with.
    </div>
    <div id="signal-preview-list" style="min-height: 100px;">
      <div class="loading" style="text-align: center; padding: 1.5rem; color: var(--text-muted);">
        Looking for signals...
      </div>
    </div>
    <div class="onboarding-actions" style="margin-top: 1.5rem;">
      <button class="btn btn-primary btn-lg" id="onb-continue-to-dashboard" style="display: none;">Continue to dashboard</button>
    </div>
  `;

  const listEl = document.getElementById('signal-preview-list');
  const btnEl = document.getElementById('onb-continue-to-dashboard');
  let found = false;

  // Poll for decisions up to 6 times (30 seconds total)
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const data = await fetchJSON(`/api/decisions/${encodeURIComponent(userId)}?limit=5`);
      const decisions = data.decisions ?? [];
      if (decisions.length > 0) {
        found = true;
        listEl.innerHTML = decisions.slice(0, 3).map((d) => `
          <div class="insight-card" style="margin-bottom: 0.5rem;">
            <div class="insight-icon" style="background: var(--accent-soft, #e3f2fd); color: var(--accent, #1976d2);">
              ${d.domain === 'email' ? 'E' : d.domain === 'calendar' ? 'C' : '?'}
            </div>
            <div class="insight-content">
              <div class="insight-title">${d.domain ? d.domain.charAt(0).toUpperCase() + d.domain.slice(1) : 'Signal'}</div>
              <div class="insight-desc">${d.situation_type || d.situationType || 'Processing...'}</div>
            </div>
          </div>
        `).join('');
        break;
      }
    } catch {
      // API not ready yet, keep polling
    }
  }

  if (!found) {
    listEl.innerHTML = `
      <div style="text-align: center; padding: 1rem; color: var(--text-muted);">
        No signals yet — I'll check again shortly. You can start exploring the dashboard now.
      </div>
    `;
  }

  // Show the continue button and wait for click
  btnEl.style.display = 'inline-block';
  return new Promise((resolve) => {
    btnEl.addEventListener('click', resolve);
  });
}

/**
 * Render the onboarding flow.
 */
export function renderOnboarding(container, onComplete) {
  let step = 0;
  let userId = '';

  // Shared state for domain and preference selections
  const state = {
    selectedDomains: DOMAINS.filter(d => d.preSelected).map(d => d.id),
    preferences: {},
  };

  function renderStep() {
    const stepDef = STEPS[step];
    stepDef.render(
      container,
      () => { step++; renderStep(); },                          // next
      () => { if (step > 0) { step--; renderStep(); } },       // back
      (id) => { userId = id; },                                  // setUserId
      async (trustTier) => {                                     // complete
        try {
          // 1. Update trust tier
          await updateTrustTier(userId, trustTier);
        } catch {
          // User might not exist in DB yet — that's OK
        }

        try {
          // 2. Save enabled domains
          await fetchJSON(`/api/users/${encodeURIComponent(userId)}/domains`, {
            method: 'PUT',
            body: JSON.stringify({ domains: state.selectedDomains }),
          });
        } catch {
          // Non-fatal — domains can be configured later in settings
        }

        try {
          // 3. Seed preferences from the quick-pref answers
          const prefPayload = [];
          for (const [compositeKey, value] of Object.entries(state.preferences)) {
            const [domain, ...keyParts] = compositeKey.split(':');
            const key = keyParts.join(':');
            prefPayload.push({ domain, key, value });
          }
          if (prefPayload.length > 0) {
            await fetchJSON(`/api/users/${encodeURIComponent(userId)}/seed-preferences`, {
              method: 'POST',
              body: JSON.stringify({ preferences: prefPayload }),
            });
          }
        } catch {
          // Non-fatal — preferences can be set later
        }

        try {
          // 4. Ensure the twin profile is created
          await fetchTwinProfile(userId);
        } catch {
          // Non-fatal
        }

        // 5. Show signal preview before navigating to dashboard
        await showSignalPreview(container, userId);

        // 6. Navigate to the dashboard
        onComplete(userId);
      },
      state,
    );
  }

  renderStep();
}
