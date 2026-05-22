/**
 * First-run wizard — issue #181.
 *
 * State machine:
 *   welcome → email_choice / computer_choice / about_me_choice
 *   about_me_choice → recipe_preview (via LLM or deterministic 3-question form)
 *   email_choice    → recipe_preview
 *   computer_choice → (idle-miner poll) → recipe_preview
 *   recipe_preview  → installing
 *   installing      → complete
 *
 * Singleton delegator: all click handling lives in handleOnboardingClick(),
 * wired ONCE with a _wizardListenerWired guard and gated on
 * window.location.hash === '' || '#/' (the overlay is always shown at root).
 *
 * No inline event handlers anywhere in this file — only data-action attributes.
 */

import {
  createUser,
  fetchJSON,
  fetchDemoInfo,
  previewDemoDecision,
  fetchOnboardingState,
  postOnboardingDialogue,
  postDeterministicPick,
  postOnboardingComplete,
  installCapabilityRecipe,
  fetchCapabilityDependencyGraph,
  escapeHtml,
} from '../api-client.js';
import { KEY_USER_ID, KEY_ONBOARDED, KEY_TOUR_MODE, KEY_SESSION_TOKEN } from '../storage-keys.js';

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state (singleton — one wizard per browser tab)
// ─────────────────────────────────────────────────────────────────────────────

let _wizardListenerWired = false;
let _onCompleteCallback = null;   // set by renderOnboarding
let _wizardState = null;          // { screen, userId, hasLlmProvider, history, recipeSlug, recommendedRegistryIds, firstRunChoice }

// The three real entry paths users can take from the welcome screen. We
// stash the chosen path on _wizardState.firstRunChoice so every
// finishWizard/postOnboardingComplete site below can record the correct
// value — previously every call hard-coded 'about-me', which mis-recorded
// telemetry for email and computer users.
function recordFirstRunChoice(choice) {
  if (_wizardState) _wizardState.firstRunChoice = choice;
}
function getFirstRunChoice() {
  return (_wizardState && _wizardState.firstRunChoice) || 'about-me';
}

function isOnWizard() {
  // The wizard overlay is shown at the root hash (empty or '#/').
  const h = (window.location.hash || '').split('?')[0];
  return h === '' || h === '#/' || h === '#';
}

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton listener — attached once
// ─────────────────────────────────────────────────────────────────────────────

function ensureWizardListener() {
  if (_wizardListenerWired || typeof document === 'undefined') return;
  _wizardListenerWired = true;
  document.addEventListener('click', handleOnboardingClick);
}

async function handleOnboardingClick(e) {
  // Guard: only fire when the wizard overlay is visible
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay || overlay.style.display === 'none') return;

  const target = e.target instanceof HTMLElement ? e.target.closest('[data-action]') : null;
  if (!target) return;

  const action = target.dataset.action;
  const userId = getCurrentUserId();

  switch (action) {
    // ── Welcome screen ──────────────────────────────────────────────────────
    case 'onb-choose-email':
      recordFirstRunChoice('email');
      transitionTo('email_choice');
      break;
    case 'onb-choose-computer':
      recordFirstRunChoice('computer');
      transitionTo('computer_choice');
      break;
    case 'onb-choose-about-me':
      recordFirstRunChoice('about-me');
      transitionTo('about_me_choice');
      break;

    // ── Shared "back to welcome" ────────────────────────────────────────────
    case 'onb-back-welcome':
      transitionTo('welcome');
      break;

    // ── Email choice ────────────────────────────────────────────────────────
    case 'onb-email-google': {
      const btn = target;
      btn.disabled = true;
      btn.textContent = 'Redirecting…';
      try {
        const { startGoogleSignIn } = await import('../google-signin.js');
        // After Google consent, deep-link straight into the Gmail
        // walkthrough. The bundled OAuth client only carries Calendar +
        // identity scopes today; Gmail is gated behind the BYO setup at
        // /#/connect-gmail and the user shouldn't have to discover the
        // follow-up CTA on the dashboard themselves. The connect-gmail
        // page no-ops gracefully if Gmail is already wired up.
        //
        // Desktop newUser flow: startGoogleSignIn generates a UUIDv4
        // pendingKey, threads it through state, and polls for the
        // resulting userId once /callback writes the handoff row.
        // onComplete fires when the poll resolves — we set the userId
        // in localStorage and drop the user on the deep-link route
        // exactly as the web redirect would have.
        const result = await startGoogleSignIn({
          newUser: true,
          next: 'connect-gmail',
          onComplete: (completion) => {
            if (completion.connected && completion.userId) {
              // The pending endpoint mints the session — store the
              // token first so subsequent API calls authenticate.
              // Without it, the dashboard would 401 the moment the
              // wizard lands on the deep-link route.
              if (completion.sessionToken) {
                localStorage.setItem(KEY_SESSION_TOKEN, completion.sessionToken);
              }
              localStorage.setItem(KEY_USER_ID, completion.userId);
              if (_wizardState) _wizardState.userId = completion.userId;
              window.location.hash = completion.nextHash || '#/connect-gmail';
              return;
            }
            // Timeout (5 min) — let the user retry rather than sitting
            // on a frozen button. The pending row has either expired
            // or the user closed the browser tab without consenting.
            const retryBtn = document.querySelector('[data-action="onb-email-google"]');
            if (retryBtn instanceof HTMLButtonElement) {
              retryBtn.disabled = false;
              retryBtn.textContent = 'Continue with Google';
            }
            showWizardError("We didn't see your Google sign-in come through. Try again, or use email below.");
          },
        });
        if (result.status === 'redirecting') return;
        if (result.status === 'polling') {
          // Desktop: OAuth opened in the system browser; pendingKey
          // poll is running in the background and will fire
          // onComplete above when /callback writes the handoff row.
          // The button stays disabled with "Waiting for Google…" as
          // the active status — the wizard auto-advances when the
          // poll resolves.
          btn.textContent = 'Waiting for Google…';
          hideWizardError();
          return;
        }
        // status === 'error'. If the server tagged the failure as a
        // missing-config code (NO_GOOGLE_CLIENT_CONFIGURED — this
        // SkyTwin build has no bundled OAuth client), bounce the user
        // straight into the connect-gmail wizard. That same five-step
        // walkthrough sets up their OAuth client, which then lets the
        // bundled flow work on retry.
        if (result.code === 'NO_GOOGLE_CLIENT_CONFIGURED') {
          // Re-enable the button before the hashchange so a router that
          // synchronously re-renders the wizard doesn't leave it stuck
          // on "Redirecting…".
          btn.disabled = false;
          btn.textContent = 'Continue with Google';
          window.location.hash = result.help || '#/connect-gmail';
          return;
        }
        throw new Error(result.error || 'No authorize URL returned');
      } catch (err) {
        showWizardError(
          err.message?.includes('credentials')
            ? 'Google API key not configured — use email below or set it up in Settings.'
            : (err.message || 'Could not start Google sign-in.'),
        );
        btn.disabled = false;
        btn.textContent = 'Continue with Google';
      }
      break;
    }
    case 'onb-email-submit': {
      const emailInput = document.getElementById('onb-email-input');
      const nameInput = document.getElementById('onb-name-input');
      if (!emailInput) break;
      const email = emailInput.value.trim();
      const name = (nameInput ? nameInput.value.trim() : '') || email.split('@')[0];
      if (!email || !email.includes('@')) {
        showWizardError('Please enter a valid email address.');
        break;
      }
      hideWizardError();
      const btn = target;
      btn.disabled = true;
      btn.textContent = 'Setting up…';
      try {
        const result = await createUser(email, name, 'suggest');
        const newUserId = result.user.id || email;
        localStorage.setItem(KEY_USER_ID, newUserId);
        if (_wizardState) _wizardState.userId = newUserId;
        // Email path goes straight to recipe preview via about-me LLM/deterministic
        transitionTo('about_me_choice');
      } catch (err) {
        showWizardError(err.message || 'Something went wrong. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Continue';
      }
      break;
    }

    // ── Computer / idle-miner choice ────────────────────────────────────────
    case 'onb-enable-idle-miner': {
      const btn = target;
      btn.disabled = true;
      btn.textContent = 'Enabling…';
      try {
        await postOnboardingComplete(userId || getCurrentUserId(), 'computer');
        transitionTo('idle_miner_poll');
      } catch (err) {
        showWizardError(err.message || 'Could not enable idle miner.');
        btn.disabled = false;
        btn.textContent = 'Enable and continue';
      }
      break;
    }
    case 'onb-skip-idle-miner':
      transitionTo('welcome');
      break;

    // ── About-me conversational ─────────────────────────────────────────────
    case 'onb-send-chat': {
      const input = document.getElementById('onb-chat-input');
      if (!input) break;
      const text = input.value.trim();
      if (!text) break;
      input.value = '';
      await handleChatSend(text);
      break;
    }
    case 'onb-deterministic-answer': {
      const answer = target.dataset.answer;
      const questionKey = target.dataset.questionKey;
      if (answer && questionKey) {
        await handleDeterministicAnswer(questionKey, answer);
      }
      break;
    }

    // ── Recipe preview ──────────────────────────────────────────────────────
    case 'onb-install-recipe': {
      const slug = target.dataset.slug;
      if (slug) {
        await handleInstallRecipe(slug, target);
      }
      break;
    }
    case 'onb-skip-recipe':
      await finishWizard(userId || getCurrentUserId(), getFirstRunChoice(), undefined);
      break;

    // ── Complete ────────────────────────────────────────────────────────────
    case 'onb-go-dashboard':
      hideWizard();
      break;

    // ── Tour mode ───────────────────────────────────────────────────────────
    case 'onb-start-tour': {
      try {
        const info = await fetchDemoInfo();
        if (info?.available && info?.userId) {
          localStorage.setItem(KEY_TOUR_MODE, '1');
          localStorage.setItem(KEY_USER_ID, info.userId);
          localStorage.setItem(KEY_ONBOARDED, 'true');
          hideWizard();
          if (typeof window.skyTwinSetUserId === 'function') {
            window.skyTwinSetUserId(info.userId);
          }
        }
      } catch {
        showWizardError('Tour profile not available.');
      }
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderContent(html) {
  const el = document.getElementById('onboarding-content');
  if (el) el.innerHTML = html;
}

function showWizardError(msg) {
  const el = document.getElementById('onb-wizard-error');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

function hideWizardError() {
  const el = document.getElementById('onb-wizard-error');
  if (el) el.style.display = 'none';
}

// ── Welcome ──────────────────────────────────────────────────────────────────

function renderWelcome() {
  renderContent(`
    <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:none;"></div>

    <div class="onboarding-title" style="font-size:1.4rem;font-weight:700;margin-bottom:0.5rem;">
      Meet your digital twin
    </div>
    <div class="onboarding-desc" style="margin-bottom:1.25rem;">
      SkyTwin learns how you make decisions and handles routine ones on your behalf.
      How would you like to start?
    </div>

    <div style="display:flex;flex-direction:column;gap:0.6rem;margin-bottom:1.25rem;">
      <button class="btn btn-primary btn-lg" style="text-align:left;display:flex;align-items:center;gap:0.75rem;"
              data-action="onb-choose-email">
        <span style="font-size:1.2rem;">✉</span>
        <div>
          <div style="font-weight:600;">Connect your email</div>
          <div style="font-size:0.78rem;opacity:0.8;">Link Gmail so your twin can see your inbox from day one.</div>
        </div>
      </button>
      <button class="btn btn-outline btn-lg" style="text-align:left;display:flex;align-items:center;gap:0.75rem;"
              data-action="onb-choose-computer">
        <span style="font-size:1.2rem;">💻</span>
        <div>
          <div style="font-weight:600;">Let SkyTwin learn from your computer</div>
          <div style="font-size:0.78rem;opacity:0.8;">Run a background observer to discover which apps you use.</div>
        </div>
      </button>
      <button class="btn btn-outline btn-lg" style="text-align:left;display:flex;align-items:center;gap:0.75rem;"
              data-action="onb-choose-about-me">
        <span style="font-size:1.2rem;">💬</span>
        <div>
          <div style="font-weight:600;">Tell SkyTwin about yourself</div>
          <div style="font-size:0.78rem;opacity:0.8;">Answer a few quick questions so your twin knows where to start.</div>
        </div>
      </button>
    </div>

    <div id="onb-tour-row" style="display:none;">
      <div role="separator" aria-label="or" style="display:flex;align-items:center;gap:0.5rem;margin:0.25rem 0 0.75rem;color:var(--text-muted);font-size:0.78rem;">
        <span aria-hidden="true" style="flex:1;height:1px;background:var(--border);"></span>
        <span aria-hidden="true" style="text-transform:uppercase;letter-spacing:0.08em;">or</span>
        <span aria-hidden="true" style="flex:1;height:1px;background:var(--border);"></span>
      </div>
      <button class="btn btn-outline btn-lg" style="text-align:left;display:flex;align-items:center;gap:0.75rem;width:100%;"
              data-action="onb-start-tour">
        <span style="font-size:1.2rem;" aria-hidden="true">🧭</span>
        <div>
          <div style="font-weight:600;">Try with a sample profile</div>
          <div style="font-size:0.78rem;opacity:0.8;">See a fully populated twin in action — no sign-in needed.</div>
        </div>
      </button>
    </div>
  `);

  // Show the tour CTA only when the demo seed is available.
  // The CTA + its divider sit inside #onb-tour-row so they appear/hide together.
  fetchDemoInfo().then((info) => {
    if (info?.available) {
      const row = document.getElementById('onb-tour-row');
      if (row) row.style.display = 'block';
    }
  }).catch(() => { /* tour CTA stays hidden */ });
}

// ── Email choice ──────────────────────────────────────────────────────────────

function renderEmailChoice() {
  renderContent(`
    <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:none;"></div>
    <div class="onboarding-title" style="font-size:1.2rem;font-weight:700;margin-bottom:0.5rem;">Sign in to get started</div>
    <div class="onboarding-desc" style="margin-bottom:1rem;">
      Connect with Google so your twin can see your email and calendar from day one.
    </div>

    <button class="btn btn-primary btn-lg" style="width:100%;display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-bottom:1rem;"
            data-action="onb-email-google">
      <span style="font-weight:700;">G</span>
      <span>Continue with Google</span>
    </button>

    <details style="margin-bottom:1rem;">
      <summary style="cursor:pointer;color:var(--text-muted);font-size:0.85rem;">Use an email address instead</summary>
      <div style="margin-top:0.75rem;padding:0.75rem;border:1px solid var(--border);border-radius:var(--radius-sm);">
        <div class="form-group">
          <label style="font-size:0.85rem;">Your name</label>
          <input class="form-input" id="onb-name-input" type="text" placeholder="Jane">
        </div>
        <div class="form-group">
          <label style="font-size:0.85rem;">Your email</label>
          <input class="form-input" id="onb-email-input" type="email" placeholder="you@example.com">
        </div>
        <button class="btn btn-outline" style="width:100%;margin-top:0.5rem;" data-action="onb-email-submit">
          Continue with email
        </button>
      </div>
    </details>

    <button class="btn-link" data-action="onb-back-welcome"
            style="font-size:0.82rem;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:0;">
      ← Back
    </button>
  `);
}

// ── Computer / idle-miner choice ──────────────────────────────────────────────

function renderComputerChoice() {
  renderContent(`
    <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:none;"></div>
    <div class="onboarding-title" style="font-size:1.2rem;font-weight:700;margin-bottom:0.5rem;">
      Let SkyTwin observe your workflow
    </div>
    <div class="onboarding-desc" style="margin-bottom:1rem;">
      The background observer watches which apps and files you use — privately, on your machine.
      It never uploads your data; it only notifies SkyTwin of the app names it sees.
    </div>

    <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.75rem;margin-bottom:1rem;font-size:0.85rem;">
      <div style="font-weight:600;margin-bottom:0.4rem;">What it can observe (you control this list)</div>
      <ul style="margin:0;padding-left:1.2rem;line-height:1.7;">
        <li>Active application names</li>
        <li>Window titles (optional)</li>
        <li>Browser domain names (optional, no URLs or content)</li>
      </ul>
      <div style="margin-top:0.6rem;font-size:0.78rem;color:var(--text-muted);">
        You can adjust or turn this off at any time in Settings.
      </div>
    </div>

    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button class="btn btn-primary" data-action="onb-enable-idle-miner">
        Enable and continue
      </button>
      <button class="btn btn-outline" data-action="onb-skip-idle-miner" style="color:var(--text-muted);">
        Not now
      </button>
    </div>

    <div style="margin-top:0.75rem;">
      <button class="btn-link" data-action="onb-back-welcome"
              style="font-size:0.82rem;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:0;">
        ← Back
      </button>
    </div>
  `);
}

// ── Idle-miner KPI poll (stretch goal D) ─────────────────────────────────────

async function renderIdleMinerPoll() {
  renderContent(`
    <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:none;"></div>
    <div class="onboarding-title" style="font-size:1.2rem;font-weight:700;margin-bottom:0.5rem;">
      Learning your workflow…
    </div>
    <div class="onboarding-desc" style="margin-bottom:1rem;">
      SkyTwin is watching which apps you use. This usually takes under 60 seconds.
    </div>
    <div id="onb-poll-status" style="text-align:center;padding:1.5rem 0;color:var(--text-muted);">
      <div class="loading" style="margin-bottom:0.5rem;"></div>
      Looking for your first app signal…
    </div>
    <div id="onb-poll-result" style="display:none;"></div>
    <div id="onb-poll-actions" style="margin-top:1rem;display:none;">
      <button class="btn btn-primary" data-action="onb-install-recipe" data-slug="">Install suggested recipe</button>
      <button class="btn btn-outline" data-action="onb-skip-recipe" style="margin-left:0.5rem;">Skip for now</button>
    </div>
    <div id="onb-poll-timeout" style="display:none;margin-top:1rem;">
      <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem;">
        Still learning — I'll keep watching in the background. Let's continue to the dashboard.
      </div>
      <button class="btn btn-primary" data-action="onb-go-dashboard">Continue to dashboard</button>
    </div>
  `);

  const userId = getCurrentUserId();
  if (!userId) {
    transitionTo('complete');
    return;
  }

  // Poll for suggestions every 5s, up to 60s
  const MAX_POLLS = 12;
  const INTERVAL_MS = 5000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));

    try {
      const data = await fetchJSON(`/api/capabilities/suggestions?userId=${encodeURIComponent(userId)}`);
      const suggestions = data.suggestions ?? [];
      if (suggestions.length > 0) {
        const first = suggestions[0];
        const statusEl = document.getElementById('onb-poll-status');
        const resultEl = document.getElementById('onb-poll-result');
        const actionsEl = document.getElementById('onb-poll-actions');
        if (statusEl) statusEl.style.display = 'none';
        if (resultEl) {
          resultEl.innerHTML = `
            <div style="padding:0.75rem;border-left:3px solid var(--accent);background:var(--bg-card);border-radius:var(--radius-sm);">
              <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.25rem;">I noticed you use</div>
              <div style="font-weight:600;font-size:1rem;">${escapeHtml(first.display_name || first.registry_id || 'an app')}</div>
              <div style="font-size:0.82rem;margin-top:0.25rem;">${escapeHtml(first.reason_summary || '')}</div>
            </div>
          `;
          resultEl.style.display = 'block';
        }
        // Set the recipe slug on the install button
        if (actionsEl) {
          const installBtn = actionsEl.querySelector('[data-action="onb-install-recipe"]');
          if (installBtn) {
            installBtn.dataset.slug = 'productivity-pack'; // best default for idle-miner path
          }
          actionsEl.style.display = 'flex';
          actionsEl.style.gap = '0.5rem';
          actionsEl.style.flexWrap = 'wrap';
        }
        if (_wizardState) {
          _wizardState.recipeSlug = 'productivity-pack';
          _wizardState.recommendedRegistryIds = [];
        }
        return;
      }
    } catch {
      // keep polling
    }
  }

  // Timeout
  const statusEl = document.getElementById('onb-poll-status');
  const timeoutEl = document.getElementById('onb-poll-timeout');
  if (statusEl) statusEl.style.display = 'none';
  if (timeoutEl) timeoutEl.style.display = 'block';
}

// ── About-me (conversational or deterministic) ────────────────────────────────

function renderAboutMeConversational() {
  if (!_wizardState) return;
  _wizardState.history = [];

  renderContent(`
    <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:none;"></div>
    <div class="onboarding-title" style="font-size:1.2rem;font-weight:700;margin-bottom:0.5rem;">
      Tell me about yourself
    </div>
    <div class="onboarding-desc" style="margin-bottom:0.75rem;font-size:0.85rem;">
      I'll ask a few questions to figure out which capabilities will help you most.
    </div>
    <div id="onb-chat-history" style="min-height:120px;max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:0.5rem;margin-bottom:0.75rem;padding:0.5rem;background:var(--bg);border-radius:var(--radius-sm);border:1px solid var(--border);">
    </div>
    <div style="display:flex;gap:0.4rem;">
      <input class="form-input" id="onb-chat-input" type="text" placeholder="Type your answer…" style="flex:1;">
      <button class="btn btn-primary" data-action="onb-send-chat">Send</button>
    </div>
    <div style="margin-top:0.75rem;">
      <button class="btn-link" data-action="onb-back-welcome"
              style="font-size:0.82rem;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:0;">
        ← Back
      </button>
    </div>
  `);

  // Kick off the first question
  kickConversation();
}

async function kickConversation() {
  const userId = getCurrentUserId();
  if (!userId || !_wizardState) return;

  addChatBubble('assistant', '…');
  try {
    const resp = await postOnboardingDialogue(userId, [], {});
    removeTypingBubble();
    if (resp.kind === 'question') {
      addChatBubble('assistant', resp.question);
      _wizardState.history.push({ role: 'assistant', content: resp.question });
    } else if (resp.kind === 'final') {
      handleFinalRecommendation(resp);
    }
  } catch {
    removeTypingBubble();
    addChatBubble('assistant', 'What do you do for work?');
    if (_wizardState) {
      _wizardState.history.push({ role: 'assistant', content: 'What do you do for work?' });
    }
  }
}

async function handleChatSend(text) {
  if (!_wizardState) return;
  const userId = getCurrentUserId();
  if (!userId) return;

  addChatBubble('user', text);
  _wizardState.history.push({ role: 'user', content: text });

  addChatBubble('assistant', '…');

  try {
    const resp = await postOnboardingDialogue(userId, _wizardState.history, {});
    removeTypingBubble();

    if (resp.kind === 'question') {
      addChatBubble('assistant', resp.question);
      _wizardState.history.push({ role: 'assistant', content: resp.question });
    } else if (resp.kind === 'final') {
      handleFinalRecommendation(resp);
    }
  } catch {
    removeTypingBubble();
    addChatBubble('assistant', 'Got it — let me figure out a good setup for you.');
    setTimeout(() => handleFinalFromHistory(), 500);
  }
}

function handleFinalFromHistory() {
  if (!_wizardState) return;
  const slug = 'productivity-pack';
  _wizardState.recipeSlug = slug;
  _wizardState.recommendedRegistryIds = [];
  transitionTo('recipe_preview');
}

function handleFinalRecommendation(resp) {
  if (!_wizardState) return;
  _wizardState.recipeSlug = resp.recipeSlug;
  _wizardState.recommendedRegistryIds = resp.recommendedRegistryIds ?? [];
  _wizardState.rationale = resp.rationale ?? '';
  transitionTo('recipe_preview');
}

function addChatBubble(role, text) {
  const container = document.getElementById('onb-chat-history');
  if (!container) return;
  const isTyping = text === '…';
  const bubble = document.createElement('div');
  bubble.style.cssText = `
    max-width:80%;
    padding:0.5rem 0.75rem;
    border-radius:0.75rem;
    font-size:0.85rem;
    line-height:1.5;
    align-self:${role === 'user' ? 'flex-end' : 'flex-start'};
    background:${role === 'user' ? 'var(--accent)' : 'var(--bg-card)'};
    color:${role === 'user' ? '#fff' : 'var(--text)'};
    border:${role === 'assistant' ? '1px solid var(--border)' : 'none'};
  `;
  if (isTyping) {
    bubble.id = 'onb-typing-bubble';
    bubble.textContent = '…';
  } else {
    bubble.textContent = text;
  }
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function removeTypingBubble() {
  document.getElementById('onb-typing-bubble')?.remove();
}

// ── Deterministic 3-question form ─────────────────────────────────────────────

const DET_QUESTIONS = [
  {
    key: 'work',
    text: 'What do you do for work?',
    options: [
      { value: 'software_engineer', label: 'Software engineer' },
      { value: 'designer', label: 'Designer' },
      { value: 'journalist', label: 'Journalist / writer' },
      { value: 'parent', label: 'Parent / caregiver' },
      { value: 'student', label: 'Student' },
      { value: 'other', label: 'Something else' },
    ],
  },
  {
    key: 'notes_app',
    text: 'Which notes or docs app do you use most?',
    options: [
      { value: 'notion', label: 'Notion' },
      { value: 'obsidian', label: 'Obsidian' },
      { value: 'apple_notes', label: 'Apple Notes' },
      { value: 'paper', label: 'Paper / pen' },
      { value: 'none', label: 'None / not sure' },
    ],
  },
  {
    key: 'primary_tool',
    text: 'Which tool do you spend the most time in?',
    options: [
      { value: 'github', label: 'GitHub' },
      { value: 'linear', label: 'Linear' },
      { value: 'slack', label: 'Slack' },
      { value: 'notion', label: 'Notion' },
      { value: 'gmail', label: 'Gmail' },
      { value: 'calendar', label: 'Calendar' },
      { value: 'none', label: 'None of the above' },
    ],
  },
];

let _detAnswers = {};
let _detStep = 0;

function renderDeterministicStep() {
  if (!_wizardState) return;
  const q = DET_QUESTIONS[_detStep];
  if (!q) {
    // All answered — fetch pick
    submitDeterministicPick();
    return;
  }

  const progress = `${_detStep + 1} of ${DET_QUESTIONS.length}`;
  renderContent(`
    <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:none;"></div>
    <div class="onboarding-step" style="font-size:0.78rem;color:var(--text-muted);margin-bottom:0.5rem;">Question ${progress}</div>
    <div class="onboarding-title" style="font-size:1.2rem;font-weight:700;margin-bottom:0.75rem;">${escapeHtml(q.text)}</div>
    <div style="display:flex;flex-direction:column;gap:0.4rem;">
      ${q.options.map((opt) => `
        <button class="btn btn-outline" style="text-align:left;"
                data-action="onb-deterministic-answer"
                data-question-key="${escapeHtml(q.key)}"
                data-answer="${escapeHtml(opt.value)}">
          ${escapeHtml(opt.label)}
        </button>
      `).join('')}
    </div>
    <div style="margin-top:0.75rem;">
      <button class="btn-link" data-action="onb-back-welcome"
              style="font-size:0.82rem;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:0;">
        ← Back
      </button>
    </div>
  `);
}

async function handleDeterministicAnswer(questionKey, answer) {
  _detAnswers[questionKey] = answer;
  _detStep++;

  if (_detStep >= DET_QUESTIONS.length) {
    // Show a brief "working" message
    renderContent(`
      <div style="text-align:center;padding:2rem 0;color:var(--text-muted);">
        <div class="loading" style="margin-bottom:0.75rem;"></div>
        Finding the right setup…
      </div>
    `);
    await submitDeterministicPick();
  } else {
    renderDeterministicStep();
  }
}

async function submitDeterministicPick() {
  if (!_wizardState) return;
  const userId = getCurrentUserId();
  if (!userId) {
    transitionTo('welcome');
    return;
  }
  try {
    const result = await postDeterministicPick(userId, _detAnswers);
    _wizardState.recipeSlug = result.recipeSlug;
    _wizardState.recommendedRegistryIds = result.recommendedRegistryIds ?? [];
    transitionTo('recipe_preview');
  } catch {
    _wizardState.recipeSlug = 'productivity-pack';
    _wizardState.recommendedRegistryIds = [];
    transitionTo('recipe_preview');
  }
}

// ── Recipe preview (with D3 dependency graph) ─────────────────────────────────

const RECIPE_META = {
  'developer-pack': {
    displayName: 'Developer pack',
    description: 'GitHub, Linear, Notion, Slack, filesystem, Git, and SQLite.',
    category: 'developer',
  },
  'productivity-pack': {
    displayName: 'Productivity pack',
    description: 'Gmail, Google Calendar, Notion, and Slack.',
    category: 'productivity',
  },
  'travel-pack': {
    displayName: 'Travel pack',
    description: 'Booking, Expedia, and flight search — coming soon.',
    category: 'lifestyle',
  },
  'research-pack': {
    displayName: 'Research pack',
    description: 'Brave Search, Exa semantic search, and Fetch.',
    category: 'developer',
  },
};

async function renderRecipePreview() {
  if (!_wizardState) return;
  const slug = _wizardState.recipeSlug || 'productivity-pack';
  const meta = RECIPE_META[slug] || { displayName: slug, description: '', category: '' };

  renderContent(`
    <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:none;"></div>
    <div class="onboarding-title" style="font-size:1.2rem;font-weight:700;margin-bottom:0.25rem;">
      Here's what I'd suggest
    </div>
    <div class="onboarding-desc" style="margin-bottom:0.75rem;font-size:0.85rem;">
      ${escapeHtml(_wizardState.rationale || `The ${escapeHtml(meta.displayName)} covers the tools most people in your situation use.`)}
    </div>

    <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.75rem;margin-bottom:0.75rem;">
      <div style="font-weight:600;font-size:1rem;margin-bottom:0.2rem;">${escapeHtml(meta.displayName)}</div>
      <div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.6rem;">${escapeHtml(meta.description)}</div>
      <div style="font-size:0.75rem;color:var(--text-dim);">
        ${(_wizardState.recommendedRegistryIds ?? []).length} capabilities included
      </div>
    </div>

    <div id="onb-dep-graph" style="margin-bottom:0.75rem;">
      <div style="font-size:0.8rem;color:var(--text-muted);text-align:center;padding:0.5rem 0;">
        Loading capability graph…
      </div>
    </div>

    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button class="btn btn-primary" data-action="onb-install-recipe" data-slug="${escapeHtml(slug)}">
        Install this bundle
      </button>
      <button class="btn btn-outline" data-action="onb-skip-recipe" style="color:var(--text-muted);">
        Skip for now
      </button>
    </div>
  `);

  // Load the D3 dependency graph async — non-blocking
  loadDependencyGraph(getCurrentUserId());
}

// ─────────────────────────────────────────────────────────────────────────────
// D3 dependency graph (deliverable E)
// ─────────────────────────────────────────────────────────────────────────────

async function loadDependencyGraph(userId) {
  const container = document.getElementById('onb-dep-graph');
  if (!container) return;

  // Load D3 from CDN if not already present
  if (!window.d3) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js');
    } catch {
      container.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);text-align:center;">Dependency graph unavailable offline.</div>`;
      return;
    }
  }

  let graphData;
  try {
    graphData = await fetchCapabilityDependencyGraph(userId);
  } catch {
    container.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);text-align:center;">Could not load graph.</div>`;
    return;
  }

  const nodes = graphData.nodes ?? [];
  const edges = graphData.edges ?? [];
  if (nodes.length === 0) {
    container.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);text-align:center;">No capability data yet.</div>`;
    return;
  }

  renderD3Graph(container, nodes, edges);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function renderD3Graph(container, nodes, edges) {
  const d3 = window.d3;
  if (!d3) return;

  const W = Math.min(container.clientWidth || 320, 400);
  const H = 200;

  container.innerHTML = '';

  const svg = d3.select(container)
    .append('svg')
    .attr('width', W)
    .attr('height', H)
    .style('background', 'var(--bg)')
    .style('border-radius', 'var(--radius-sm)');

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id((d) => d.id).distance(50))
    .force('charge', d3.forceManyBody().strength(-80))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide(18));

  const link = svg.append('g')
    .selectAll('line')
    .data(edges)
    .join('line')
    .attr('stroke', 'var(--border)')
    .attr('stroke-width', 1.5);

  const node = svg.append('g')
    .selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('r', (d) => d.id.startsWith('server:') ? 10 : 6)
    .attr('fill', (d) => d.installed ? 'var(--accent)' : 'var(--border)')
    .attr('stroke', 'var(--bg-card)')
    .attr('stroke-width', 1.5);

  const label = svg.append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .text((d) => d.label)
    .attr('font-size', 9)
    .attr('fill', 'var(--text-muted)')
    .attr('text-anchor', 'middle')
    .attr('dy', (d) => d.id.startsWith('server:') ? 22 : 18);

  sim.on('tick', () => {
    link
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y);
    node
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y);
    label
      .attr('x', (d) => d.x)
      .attr('y', (d) => d.y);
  });
}

// ── Installing ────────────────────────────────────────────────────────────────

async function handleInstallRecipe(slug, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  transitionTo('installing');

  const userId = getCurrentUserId();

  try {
    const { jobs } = await installCapabilityRecipe(userId, slug);
    const count = jobs?.length ?? 0;
    await postOnboardingComplete(userId, getFirstRunChoice(), slug);
    renderInstallComplete(slug, count);
  } catch (err) {
    renderContent(`
      <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:block;">
        Install failed: ${escapeHtml(err?.message || 'unknown error')}
      </div>
      <button class="btn btn-primary" data-action="onb-go-dashboard">Continue to dashboard anyway</button>
    `);
  }
}

function renderInstalling() {
  renderContent(`
    <div style="text-align:center;padding:2rem 0;color:var(--text-muted);">
      <div class="loading" style="margin-bottom:0.75rem;"></div>
      Setting up your capabilities…
    </div>
  `);
}

function renderInstallComplete(slug, count) {
  const meta = RECIPE_META[slug] || { displayName: slug };
  renderContent(`
    <div id="onb-wizard-error" style="display:none;"></div>
    <div style="text-align:center;padding:1rem 0 0.5rem;">
      <div style="font-size:2.5rem;margin-bottom:0.5rem;">&#10003;</div>
      <div class="onboarding-title" style="font-size:1.2rem;font-weight:700;margin-bottom:0.4rem;">
        ${escapeHtml(meta.displayName)} queued
      </div>
      <div class="onboarding-desc" style="font-size:0.85rem;margin-bottom:1.25rem;">
        ${count} capability${count !== 1 ? 's' : ''} ${count > 0 ? 'will be installed — some need OAuth authorisation which will happen when you first use them.' : 'queued.'}
      </div>
      <button class="btn btn-primary btn-lg" data-action="onb-go-dashboard">Go to dashboard</button>
    </div>
  `);
}

// ── Complete ──────────────────────────────────────────────────────────────────

async function finishWizard(userId, choice, recipeSlug) {
  try {
    await postOnboardingComplete(userId, choice, recipeSlug);
  } catch {
    // non-fatal — wizard still completes
  }
  localStorage.setItem(KEY_ONBOARDED, 'true');
  if (userId) localStorage.setItem(KEY_USER_ID, userId);
  hideWizard();
  if (typeof _onCompleteCallback === 'function') {
    _onCompleteCallback(userId);
  }
}

function hideWizard() {
  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) overlay.style.display = 'none';
  localStorage.setItem(KEY_ONBOARDED, 'true');
  if (typeof _onCompleteCallback === 'function') {
    _onCompleteCallback(getCurrentUserId());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State machine transitions
// ─────────────────────────────────────────────────────────────────────────────

async function transitionTo(screen) {
  if (!_wizardState) return;
  _wizardState.screen = screen;

  switch (screen) {
    case 'welcome':
      renderWelcome();
      break;
    case 'email_choice':
      renderEmailChoice();
      break;
    case 'computer_choice':
      renderComputerChoice();
      break;
    case 'idle_miner_poll':
      await renderIdleMinerPoll();
      break;
    case 'about_me_choice':
      if (_wizardState.hasLlmProvider) {
        renderAboutMeConversational();
      } else {
        _detAnswers = {};
        _detStep = 0;
        renderDeterministicStep();
      }
      break;
    case 'recipe_preview':
      await renderRecipePreview();
      break;
    case 'installing':
      renderInstalling();
      break;
    case 'complete':
      await finishWizard(getCurrentUserId(), getFirstRunChoice(), _wizardState.recipeSlug);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point — called from app.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the first-run wizard.
 *
 * @param {HTMLElement} container  - The #onboarding-content element
 * @param {Function}    onComplete - Called with (userId) when the wizard finishes
 */
export async function renderOnboarding(container, onComplete) {
  ensureWizardListener();
  _onCompleteCallback = onComplete;

  // Initialise wizard state
  _wizardState = {
    screen: 'welcome',
    userId: getCurrentUserId(),
    hasLlmProvider: false,
    history: [],
    recipeSlug: null,
    recommendedRegistryIds: [],
    rationale: '',
  };

  // Fetch onboarding state from the API to determine LLM availability
  const userId = getCurrentUserId();
  if (userId) {
    try {
      const state = await fetchOnboardingState(userId);
      _wizardState.hasLlmProvider = state.hasLlmProvider ?? false;
      // If they've already completed onboarding, close the wizard
      if (!state.isFirstRun) {
        hideWizard();
        return;
      }
    } catch {
      // Non-fatal — proceed with defaults (deterministic path)
      _wizardState.hasLlmProvider = false;
    }
  }

  transitionTo('welcome');
}
