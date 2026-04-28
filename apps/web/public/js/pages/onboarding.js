import { createUser, updateTrustTier, fetchJSON, fetchTwinProfile, fetchDemoInfo, previewDemoDecision } from '../api-client.js';

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
  // Step 1: Welcome — show, don't tell
  {
    render: (container, next) => {
      container.innerHTML = `
        <div class="onboarding-step">Step 1 of 5</div>
        <div class="onboarding-title">A twin that learns what you'd want — and does it.</div>
        <div class="onboarding-desc">
          Most assistants have amnesia. You tell them you prefer aisle seats three times. They keep asking.
          Your twin builds a real model of how you make decisions, then handles routine ones on its own.
        </div>

        <div id="onb-preview-card" class="card" style="margin: 1rem 0; padding: 0.85rem 1rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg);">
          <div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 0.4rem;">Try one — see how it thinks</div>
          <div style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            Tap a situation and watch a real prediction come back. (We're using a sample profile to answer — no signup needed yet.)
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem;" id="onb-preview-chips">
            <button class="btn btn-outline btn-sm onb-preview-chip" data-prompt="A recruiter at a company I've never heard of just emailed me about a senior role." style="font-size: 0.78rem; text-align: left;">Recruiter email →</button>
            <button class="btn btn-outline btn-sm onb-preview-chip" data-prompt="My streaming subscription is up for renewal at $15.99/month — I used it 3 times this month." style="font-size: 0.78rem; text-align: left;">Subscription renewal →</button>
            <button class="btn btn-outline btn-sm onb-preview-chip" data-prompt="A friend just sent a calendar invite for dinner Friday at 7pm. What would you do?" style="font-size: 0.78rem; text-align: left;">Dinner invite →</button>
          </div>
          <div id="onb-preview-result" style="font-size: 0.85rem;"></div>
        </div>

        <ul class="feature-list" style="font-size: 0.85rem;">
          <li><strong>Earns trust gradually.</strong> Starts by watching, then suggesting, then handling — at the pace you set.</li>
          <li><strong>Every action is explained.</strong> What it did, why, and how to correct it.</li>
          <li><strong>You can stop or undo any of it.</strong> The twin works for you.</li>
        </ul>
        <div class="onboarding-actions">
          <button class="btn btn-primary btn-lg" id="onb-next-1">Let's get started</button>
        </div>
      `;
      document.getElementById('onb-next-1').addEventListener('click', next);

      // Wire the preview chips. They call the public /api/demo/preview
      // endpoint, which runs whatWouldIDo() against the seeded user.
      // Fail closed: if the demo isn't available (seed not run, server
      // down) we hide the whole panel rather than show a broken widget.
      const previewCard = document.getElementById('onb-preview-card');
      const resultEl = document.getElementById('onb-preview-result');
      const chips = container.querySelectorAll('.onb-preview-chip');

      fetchDemoInfo().then((info) => {
        if (!info?.available) {
          if (previewCard) previewCard.style.display = 'none';
        }
      }).catch(() => {
        if (previewCard) previewCard.style.display = 'none';
      });

      chips.forEach((chip) => {
        chip.addEventListener('click', async () => {
          const prompt = chip.getAttribute('data-prompt');
          if (!prompt || !resultEl) return;
          chips.forEach((c) => { c.disabled = true; });
          resultEl.innerHTML = `<div style="padding: 0.5rem 0.75rem; color: var(--text-muted);">Thinking it through…</div>`;
          try {
            const r = await previewDemoDecision(prompt);
            const action = r?.predictedAction;
            const conf = (r?.confidence || 'unknown').toString().replace(/_/g, ' ');
            const autoVerb = r?.wouldAutoExecute ? "I'd handle this on my own" : "I'd ask you first";
            const autoColor = r?.wouldAutoExecute ? 'var(--success)' : 'var(--warning, #e6a700)';
            resultEl.innerHTML = `
              <div style="padding: 0.75rem; border-left: 3px solid ${autoColor}; background: var(--bg-card); border-radius: var(--radius-sm);">
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.25rem;">"${escapeForDisplay(prompt)}"</div>
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem;">
                  <strong>${escapeForDisplay(action?.description || action?.actionType || "I'm not sure — I'd ask")}</strong>
                  <span style="font-size: 0.75rem; color: ${autoColor}; font-weight: 600;">${autoVerb}</span>
                </div>
                ${r?.reasoning ? `<div style="font-size: 0.82rem; line-height: 1.55;">${escapeForDisplay(r.reasoning)}</div>` : ''}
                <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.4rem;">Confidence: ${escapeForDisplay(conf)}</div>
              </div>
            `;
          } catch (err) {
            resultEl.innerHTML = `<div style="font-size: 0.82rem; color: var(--text-muted); padding: 0.5rem 0;">Couldn't reach the preview right now — let's keep going and you'll see this in real life on the next page.</div>`;
          } finally {
            chips.forEach((c) => { c.disabled = false; });
          }
        });
      });

      function escapeForDisplay(s) {
        const div = document.createElement('div');
        div.textContent = String(s ?? '');
        return div.innerHTML;
      }
    },
  },

  // Step 2: Sign in — Google is the front door, email is the fallback.
  {
    render: (container, next, back, setUserId) => {
      container.innerHTML = `
        <div class="onboarding-step">Step 2 of 5</div>
        <div class="onboarding-title">Sign in to get started</div>
        <div class="onboarding-desc">
          Connect with Google so your twin can see your email and calendar from day one. We use the verified email as your identity — no separate password.
        </div>
        <div id="onb-error" style="color: var(--danger); font-size: 0.85rem; margin: 0.5rem 0 1rem; display: none;"></div>

        <div style="margin: 1rem 0 1.5rem;">
          <button class="btn btn-primary btn-lg" id="onb-google-signin" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
            <span style="font-weight: 600;">G</span>
            <span>Continue with Google</span>
          </button>
        </div>

        <details style="margin: 0 0 1rem; font-size: 0.85rem;">
          <summary style="cursor: pointer; color: var(--text-muted);">Continue with an email address instead</summary>
          <div style="margin-top: 1rem; padding: 1rem; border: 1px solid var(--border); border-radius: var(--radius-sm);">
            <div class="onboarding-desc" style="font-size: 0.8rem; margin-bottom: 0.75rem;">
              No Google connection — your twin won't see your inbox/calendar until you link one in Settings.
            </div>
            <div class="form-group">
              <label>Your name</label>
              <input class="form-input" id="onb-name" type="text" placeholder="Jane">
            </div>
            <div class="form-group">
              <label>Your email address</label>
              <input class="form-input" id="onb-email" type="email" placeholder="you@example.com">
            </div>
            <button class="btn btn-outline" id="onb-email-continue" style="width: 100%; margin-top: 0.5rem;">Continue with email</button>
          </div>
        </details>

        <div class="onboarding-actions" style="margin-top: 1rem; display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
          <button class="btn btn-outline" id="onb-back-2">Back</button>
          <a href="#" id="onb-tour-link" style="font-size: 0.85rem; color: var(--text-muted); display: none;">Or explore with a sample profile first →</a>
        </div>
      `;

      document.getElementById('onb-back-2').addEventListener('click', back);

      // Surface the tour link only when the seeded demo user actually exists
      // (it's created by `pnpm db:seed`, which the installer runs by default).
      // We want to fail closed: if the API or seed isn't there, the tour
      // option just doesn't appear.
      fetchDemoInfo().then((info) => {
        if (info?.available && info?.userId) {
          const link = document.getElementById('onb-tour-link');
          if (!link) return;
          link.style.display = 'inline';
          link.addEventListener('click', (ev) => {
            ev.preventDefault();
            // Skip the rest of the wizard — the demo user already has
            // domains, preferences, and a trust tier from the seed. Mark
            // the session as touring so the dashboard banner can offer a
            // graceful exit back to real onboarding.
            try {
              localStorage.setItem('skytwin_tour_mode', '1');
              localStorage.setItem('skytwin_userId', info.userId);
              localStorage.setItem('skytwin_onboarded', 'true');
            } catch { /* private mode etc. */ }
            const overlay = document.getElementById('onboarding-overlay');
            if (overlay) overlay.style.display = 'none';
            window.skyTwinSetUserId(info.userId);
          });
        }
      }).catch(() => { /* tour link stays hidden */ });

      // ── Google sign-in: front door ──────────────────────────────────
      document.getElementById('onb-google-signin').addEventListener('click', async () => {
        hideError();
        const btn = document.getElementById('onb-google-signin');
        const original = btn.innerHTML;
        btn.innerHTML = '<span>Redirecting…</span>';
        btn.disabled = true;
        try {
          // Public newUser=true endpoint: no userId required. Callback will
          // auto-create a user keyed on the verified email and redirect us
          // back with ?userId=… which app.js picks up.
          const data = await fetchJSON('/api/oauth/google/authorize?newUser=true');
          if (data.url) {
            window.location.href = data.url;
            return;
          }
          throw new Error('No authorize URL returned');
        } catch (err) {
          btn.innerHTML = original;
          btn.disabled = false;
          // Most likely: Google client_id/secret not configured yet.
          showError(
            err.message?.includes('credentials')
              ? 'I need a Google API key before Sign in works — it\'s a 5-minute one-time setup. Continue with email below to get into the app, then I\'ll walk you through linking Google on the home page.'
              : (err.message || 'Could not start Google sign-in. Try the email option below, or try again.'),
          );
        }
      });

      // ── Email fallback ──────────────────────────────────────────────
      document.getElementById('onb-email-continue').addEventListener('click', async () => {
        const email = document.getElementById('onb-email').value.trim();
        const name = document.getElementById('onb-name').value.trim() || email.split('@')[0];
        if (!email || !email.includes('@')) {
          showError('Please enter a valid email address.');
          return;
        }
        hideError();
        const btn = document.getElementById('onb-email-continue');
        btn.textContent = 'Setting up...';
        btn.disabled = true;
        try {
          const result = await createUser(email, name, 'suggest');
          setUserId(result.user.id || email);
          next();
        } catch (err) {
          showError(err.message || 'Something went wrong. Please try again.');
          btn.textContent = 'Continue with email';
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

        // 5. Persist onboarding completion early so navigating away
        //    during the signal preview doesn't restart the wizard.
        localStorage.setItem('skytwin_userId', userId);
        localStorage.setItem('skytwin_onboarded', 'true');

        // 6. Show signal preview before navigating to dashboard
        await showSignalPreview(container, userId);

        // 7. Navigate to the dashboard
        onComplete(userId);
      },
      state,
    );
  }

  renderStep();
}
