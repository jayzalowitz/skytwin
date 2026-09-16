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
  startDemoSession,
  previewDemoDecision,
  fetchOnboardingState,
  postOnboardingDialogue,
  postDeterministicPick,
  postOnboardingComplete,
  installCapabilityRecipe,
  fetchCapabilityDependencyGraph,
  fetchLocalModelRecommendation,
  escapeHtml,
} from '../api-client.js';
import {
  KEY_USER_ID,
  KEY_ONBOARDED,
  KEY_ONBOARDING_STATE,
  ONBOARDING_STATE_VERSION,
} from '../storage-keys.js';
import { getEffectiveUserId, isSampleMode } from '../sample-session.js';

/**
 * Persist the in-flight wizard state to localStorage (#390). Called
 * on every `transitionTo` so a tab-close mid-wizard can resume from
 * the same screen on next load. Stores only what's needed to re-enter
 * — the screen name, the LLM-provider flag, and the picked recipe.
 * Conversational answers and the dependency graph are NOT persisted;
 * the resume drops the user back at the screen, not mid-question.
 */
function saveOnboardingState() {
  if (!_wizardState) return;
  try {
    localStorage.setItem(
      KEY_ONBOARDING_STATE,
      JSON.stringify({
        v: ONBOARDING_STATE_VERSION,
        screen: _wizardState.screen,
        hasLlmProvider: _wizardState.hasLlmProvider,
        recipeSlug: _wizardState.recipeSlug,
        savedAt: new Date().toISOString(),
      }),
    );
  } catch { /* private mode etc. */ }
}

function loadOnboardingState() {
  try {
    const raw = localStorage.getItem(KEY_ONBOARDING_STATE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== ONBOARDING_STATE_VERSION) return null;
    if (typeof parsed.screen !== 'string') return null;
    return parsed;
  } catch { return null; }
}

function clearOnboardingState() {
  try { localStorage.removeItem(KEY_ONBOARDING_STATE); } catch { /* noop */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state (singleton — one wizard per browser tab)
// ─────────────────────────────────────────────────────────────────────────────

let _wizardListenerWired = false;
let _onCompleteCallback = null;   // set by renderOnboarding
let _wizardState = null;          // { screen, userId, hasLlmProvider, history, recipeSlug, recommendedRegistryIds, firstRunChoice }
let _renderGeneration = 0;
let _wizardRunGeneration = 0;

function isCurrentWizardRun(runGeneration) {
  return runGeneration === _wizardRunGeneration;
}

export function invalidateOnboardingRun() {
  _wizardRunGeneration += 1;
}

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
  return getEffectiveUserId();
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
  if (!isOnWizard()) return;
  // The route is authoritative; the overlay check handles a dismissed wizard
  // that remains mounted at the root route.
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay || overlay.style.display === 'none') return;

  const target = e.target instanceof HTMLElement ? e.target.closest('[data-action]') : null;
  if (!target) return;

  const action = target.dataset.action;
  const userId = getCurrentUserId();

  switch (action) {
    // ── Resume gate (#390) ──────────────────────────────────────────────────
    case 'onboarding-resume': {
      const screen = target.dataset.screen;
      if (screen && _wizardState) {
        await transitionTo(screen);
      } else {
        // Lost state somehow — fall back to a clean start.
        clearOnboardingState();
        await transitionTo('welcome');
      }
      break;
    }
    case 'onboarding-restart':
      clearOnboardingState();
      if (_wizardState) {
        // Reset every wizard-accumulated field so the welcome screen
        // doesn't render under stale state. Mirror the shape of the
        // initial allocation in `renderOnboarding` — adding a field
        // there means adding a reset here.
        _wizardState.recipeSlug = null;
        _wizardState.history = [];
        _wizardState.recommendedRegistryIds = [];
        _wizardState.rationale = '';
        _wizardState.firstRunChoice = undefined;
      }
      // Also drop the deterministic-path scratch state held in module
      // scope so a "Start over" from anywhere in the about-me flow
      // doesn't replay prior answers.
      _detAnswers = {};
      _detStep = 0;
      await transitionTo('welcome');
      break;

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
    case 'onb-email-submit': {
      const runGeneration = _wizardRunGeneration;
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
        if (!isCurrentWizardRun(runGeneration)) return;
        const newUserId = result.user.id || email;
        localStorage.setItem(KEY_USER_ID, newUserId);
        if (_wizardState) _wizardState.userId = newUserId;
        // Email path goes straight to recipe preview via about-me LLM/deterministic
        transitionTo('about_me_choice');
      } catch (err) {
        if (!isCurrentWizardRun(runGeneration)) return;
        showWizardError(err.message || 'Something went wrong. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Continue';
      }
      break;
    }

    // ── Computer / idle-miner choice ────────────────────────────────────────
    case 'onb-enable-idle-miner': {
      const runGeneration = _wizardRunGeneration;
      const btn = target;
      btn.disabled = true;
      btn.textContent = 'Enabling…';
      try {
        await postOnboardingComplete(userId || getCurrentUserId(), 'computer');
        if (!isCurrentWizardRun(runGeneration)) return;
        transitionTo('idle_miner_poll');
      } catch (err) {
        if (!isCurrentWizardRun(runGeneration)) return;
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

    // ── Modal dismiss (Esc / X / Skip) ──────────────────────────────────────
    case 'onb-dismiss-modal':
      if (typeof window.skyTwinDismissOnboarding === 'function') {
        window.skyTwinDismissOnboarding();
      }
      break;

    // ── "Change" the auto-picked private AI → Settings (AI + local brain) ────
    case 'onb-open-ai-settings':
      if (typeof window.skyTwinDismissOnboarding === 'function') {
        window.skyTwinDismissOnboarding();
      }
      window.location.hash = '#/settings';
      break;

    // ── Tour mode ───────────────────────────────────────────────────────────
    case 'onb-start-tour': {
      const runGeneration = _wizardRunGeneration;
      try {
        const info = await fetchDemoInfo();
        if (!isCurrentWizardRun(runGeneration)) return;
        if (info?.available && info?.userId) {
          const session = await startDemoSession();
          if (!isCurrentWizardRun(runGeneration)) return;
          if (!session?.token || session.userId !== info.userId) {
            throw new Error('Sample session could not be verified.');
          }
          hideWizard();
          if (typeof window.skyTwinSetUserId === 'function') {
            window.skyTwinSetUserId(info.userId);
          }
          // Start with the isolated interactive loop. The rest of the
          // fictional profile stays available through normal navigation.
          window.location.hash = '#/sample';
        } else {
          showWizardError(
            'Sample profile is not loaded on this server. Run pnpm db:seed to enable it.',
          );
        }
      } catch {
        if (!isCurrentWizardRun(runGeneration)) return;
        showWizardError('Sample profile not available.');
      }
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen renderers
// ─────────────────────────────────────────────────────────────────────────────

function setWizardBusy(busy, message = '', generation = _renderGeneration) {
  if (generation !== _renderGeneration) return;
  const content = document.getElementById('onboarding-content');
  if (content) content.setAttribute('aria-busy', String(busy));
  const status = document.getElementById('onb-wizard-status');
  if (status && message) status.textContent = message;
}

function renderContent(html, { busy = false, status = '' } = {}) {
  const el = document.getElementById('onboarding-content');
  if (!el) return;
  const generation = ++_renderGeneration;
  el.setAttribute('aria-busy', String(busy));
  el.innerHTML = html;
  const title = el.querySelector('.onboarding-title');
  if (title) {
    title.id = 'onb-dialog-title';
    title.setAttribute('tabindex', '-1');
    document.getElementById('onboarding-overlay')?.setAttribute('aria-labelledby', 'onb-dialog-title');
    document.getElementById('onboarding-overlay')?.removeAttribute('aria-label');
  } else {
    document.getElementById('onboarding-overlay')?.removeAttribute('aria-labelledby');
    document.getElementById('onboarding-overlay')?.setAttribute('aria-label', 'Onboarding');
  }
  const focusTarget = title || el.querySelector('input, button, [tabindex]');
  if (focusTarget instanceof HTMLElement) requestAnimationFrame(() => focusTarget.focus());
  if (status) setWizardBusy(busy, status, generation);
  return generation;
}

function showWizardError(msg) {
  const el = document.getElementById('onb-wizard-error');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
    el.setAttribute('role', 'alert');
    const status = document.getElementById('onb-wizard-status');
    if (status) status.textContent = msg;
  }
}

function hideWizardError() {
  const el = document.getElementById('onb-wizard-error');
  if (el) el.style.display = 'none';
}

// ── Welcome ──────────────────────────────────────────────────────────────────

function renderWelcome() {
  const runGeneration = _wizardRunGeneration;
  const generation = renderContent(`
    <button class="onb-close-x" data-action="onb-dismiss-modal" type="button"
            aria-label="Dismiss onboarding">×</button>

    <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:none;"></div>

    <div class="onboarding-title" style="font-size:1.4rem;font-weight:700;margin-bottom:0.5rem;">
      Meet your digital twin
    </div>
    <div class="onboarding-desc" style="margin-bottom:1.25rem;">
      SkyTwin learns how you make decisions and handles routine ones on your behalf.
      How would you like to start?
    </div>

    <!-- The isolated sample is the preview's primary path. Google account
         connections stay visible as an unavailable neutral state, never as
         an action affordance. -->
    <div style="display:flex;flex-direction:column;gap:0.6rem;margin-bottom:1rem;">
      <button type="button" id="onb-tour-button" class="btn btn-primary btn-lg" disabled
              style="text-align:left;display:flex;align-items:center;gap:0.75rem;width:100%;"
              data-action="onb-start-tour"
              title="Sample profile not seeded — run pnpm db:seed">
        <span style="font-size:1.2rem;" aria-hidden="true">🧭</span>
        <div>
          <div style="font-weight:600;">Just show me around</div>
          <div id="onb-tour-subtext" style="font-size:0.78rem;opacity:0.7;">Checking sample profile…</div>
        </div>
      </button>

      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text-muted);">
        <span style="font-size:1.2rem;" aria-hidden="true">✉</span>
        <div>
          <div style="font-weight:600;color:var(--text);">Gmail and Google Calendar</div>
          <div style="font-size:0.78rem;">Unavailable in this preview. No account or credentials are needed for the sample.</div>
        </div>
      </div>
    </div>

    <!-- Local-model recommendation: this endpoint can establish artifact fit,
         but it cannot prove that the separate llama.cpp runtime is installed.
         Keep this state distinct from runtime readiness. -->
    <div id="onb-ai-line" style="font-size:0.76rem;color:var(--text-muted);background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.55rem 0.7rem;margin-bottom:0.85rem;display:flex;align-items:center;gap:0.5rem;">
      <span aria-hidden="true">🔒</span>
      <span id="onb-ai-text">Checking which maintained local model fits this computer…</span>
    </div>

    <details style="margin-bottom:0.5rem;">
      <summary style="cursor:pointer;font-size:0.82rem;color:var(--text-muted);">More ways to start</summary>
      <div style="display:flex;flex-direction:column;gap:0.6rem;margin-top:0.6rem;">
        <div style="text-align:left;display:flex;align-items:center;gap:0.75rem;padding:0.75rem;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-muted);">
          <span style="font-size:1.1rem;">💬</span>
          <div>
            <div style="font-weight:600;color:var(--text);">Personal setup</div>
            <div style="font-size:0.76rem;opacity:0.8;">Coming after the isolated sample preview.</div>
          </div>
        </div>
        <div style="font-size:0.74rem;color:var(--text-muted);padding:0 0.25rem;">
          💻 Learning from the apps on your computer is coming soon —
          track it on <a href="https://github.com/jayzalowitz/skytwin/issues/389" target="_blank" rel="noopener">issue #389</a>.
        </div>
      </div>
    </details>

    <div style="margin-top:0.75rem;text-align:center;">
      <button class="btn-link" data-action="onb-dismiss-modal" type="button"
              style="font-size:0.82rem;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:0;">
        Skip for now
      </button>
    </div>
  `, { busy: true, status: 'Loading onboarding options…' });

  // Recommend an artifact without claiming the separate llama.cpp runtime is
  // ready. Best-effort: if the probe fails, keep the generic checking line.
  const modelCheck = fetchLocalModelRecommendation()
    .then((rec) => {
      if (!isCurrentWizardRun(runGeneration)) return;
      const el = document.getElementById('onb-ai-text');
      if (!el) return;
      if (rec?.model) {
        const size = Number.isFinite(rec.downloadGB)
          ? ` (~${escapeHtml(String(rec.downloadGB))} GB)`
          : '';
        el.innerHTML =
          `Recommended local model: <strong>${escapeHtml(rec.model.displayName)}</strong>${size}. ` +
          `Download it in Settings → AI; local inference also requires a compatible llama.cpp runtime. ` +
          `<button class="btn-link" data-action="onb-open-ai-settings" type="button" ` +
          `style="font-size:0.76rem;color:var(--iris);background:none;border:none;cursor:pointer;padding:0;">Change</button>`;
      } else if (rec?.reason) {
        el.textContent = rec.reason;
      }
    })
    .catch(() => { /* keep the generic availability-check line */ });

  // Tour CTA is rendered disabled with "Checking…" copy; resolved state
  // depends on the demo seed being present. When available: enable +
  // promo copy. When absent or the request fails: keep disabled with a
  // helpful "not loaded" message so the user knows the button exists
  // and what to do about it (#363 Fix 1).
  const updateTourButton = (available) => {
    if (!isCurrentWizardRun(runGeneration)) return;
    const btn = document.getElementById('onb-tour-button');
    const sub = document.getElementById('onb-tour-subtext');
    if (!btn || !sub) return;
    if (available) {
      btn.disabled = false;
      btn.removeAttribute('title');
      sub.textContent = 'See a fully populated twin in action — no sign-in needed.';
      sub.style.opacity = '0.8';
    } else {
      btn.disabled = true;
      btn.setAttribute('title', 'Sample profile not seeded — run pnpm db:seed');
      sub.textContent = 'Demo profile not loaded on this server.';
      sub.style.opacity = '0.6';
    }
  };

  const demoCheck = fetchDemoInfo()
    .then((info) => updateTourButton(!!info?.available))
    .catch(() => updateTourButton(false));
  Promise.allSettled([modelCheck, demoCheck]).then(() => {
    setWizardBusy(false, 'Onboarding options ready.', generation);
  });
}

// ── Email choice ──────────────────────────────────────────────────────────────

function renderEmailChoice() {
  renderContent(`
    <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:none;"></div>
    <div class="onboarding-title" style="font-size:1.2rem;font-weight:700;margin-bottom:0.5rem;">Gmail and Google Calendar are unavailable</div>
    <div class="onboarding-desc" style="margin-bottom:1rem;">
      This preview does not connect to Gmail or Google Calendar. Return to the sample for the supported first-run experience, or continue with an email address without linking an account.
    </div>

    <details style="margin-bottom:1rem;">
      <summary style="cursor:pointer;color:var(--text-muted);font-size:0.85rem;">Continue with an email address</summary>
      <div style="margin-top:0.75rem;padding:0.75rem;border:1px solid var(--border);border-radius:var(--radius-sm);">
        <div class="form-group">
          <label for="onb-name-input" style="font-size:0.85rem;">Your name</label>
          <input class="form-input" id="onb-name-input" type="text" placeholder="Jane">
        </div>
        <div class="form-group">
          <label for="onb-email-input" style="font-size:0.85rem;">Your email</label>
          <input class="form-input" id="onb-email-input" type="email" placeholder="you@example.com">
        </div>
        <button type="button" class="btn btn-outline" style="width:100%;margin-top:0.5rem;" data-action="onb-email-submit">
          Continue with email
        </button>
      </div>
    </details>

    <button type="button" class="btn-link" data-action="onb-back-welcome"
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
      Let SkyTwin learn what you work on
    </div>
    <div class="onboarding-desc" style="margin-bottom:1rem;">
      During idle time, SkyTwin can scan the code projects on this machine to learn which tools and
      technologies you work with — so it can suggest capabilities that fit your work. Scanning happens
      locally and reads project metadata rather than source-file contents. If you configure a hosted model,
      later capability inference may send selected metadata to that provider.
    </div>

    <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.75rem;margin-bottom:1rem;font-size:0.85rem;">
      <div style="font-weight:600;margin-bottom:0.4rem;">What it reads (project metadata only)</div>
      <ul style="margin:0;padding-left:1.2rem;line-height:1.7;">
        <li>Project names and the technologies they use — from manifest files like package.json, pyproject.toml, Cargo.toml, and go.mod</li>
        <li>Dependency names only — never versions, descriptions, or your source code</li>
        <li>Your git remote URL and the name and email in your git config</li>
      </ul>
      <div style="margin-top:0.6rem;font-size:0.78rem;color:var(--text-muted);">
        It never watches your screen, open apps, window titles, or browsing. Choose “Not now” to skip this step.
      </div>
    </div>

    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button type="button" class="btn btn-primary" data-action="onb-enable-idle-miner">
        Enable and continue
      </button>
      <button type="button" class="btn btn-outline" data-action="onb-skip-idle-miner" style="color:var(--text-muted);">
        Not now
      </button>
    </div>

    <div style="margin-top:0.75rem;">
      <button type="button" class="btn-link" data-action="onb-back-welcome"
              style="font-size:0.82rem;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:0;">
        ← Back
      </button>
    </div>
  `);
}

// ── Idle-miner KPI poll (stretch goal D) ─────────────────────────────────────

async function renderIdleMinerPoll() {
  const runGeneration = _wizardRunGeneration;
  const generation = renderContent(`
    <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:none;"></div>
    <div class="onboarding-title" style="font-size:1.2rem;font-weight:700;margin-bottom:0.5rem;">
      Learning what you work on…
    </div>
    <div class="onboarding-desc" style="margin-bottom:1rem;">
      SkyTwin is scanning your code projects for the tools you use. This usually takes under 60 seconds.
    </div>
    <div id="onb-poll-status" style="text-align:center;padding:1.5rem 0;color:var(--text-muted);">
      <div class="loading" style="margin-bottom:0.5rem;"></div>
      Looking for your first project signal…
    </div>
    <div id="onb-poll-result" style="display:none;"></div>
    <div id="onb-poll-actions" style="margin-top:1rem;display:none;">
      <button type="button" class="btn btn-primary" data-action="onb-install-recipe" data-slug="">Install suggested recipe</button>
      <button type="button" class="btn btn-outline" data-action="onb-skip-recipe" style="margin-left:0.5rem;">Skip for now</button>
    </div>
    <div id="onb-poll-timeout" style="display:none;margin-top:1rem;">
      <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem;">
        Still scanning — I'll keep looking in the background. Let's continue to the dashboard.
      </div>
      <button type="button" class="btn btn-primary" data-action="onb-go-dashboard">Continue to dashboard</button>
    </div>
  `, { busy: true, status: 'Scanning for project signals…' });

  const userId = getCurrentUserId();
  if (!userId) {
    setWizardBusy(false, 'Scanning skipped.', generation);
    transitionTo('complete');
    return;
  }

  // Poll for suggestions every 5s, up to 60s
  const MAX_POLLS = 12;
  const INTERVAL_MS = 5000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    if (!isCurrentWizardRun(runGeneration)) return;

    try {
      const data = await fetchJSON(`/api/capabilities/suggestions?userId=${encodeURIComponent(userId)}`);
      if (!isCurrentWizardRun(runGeneration)) return;
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
        setWizardBusy(false, 'Project signal found.', generation);
        return;
      }
    } catch {
      // keep polling
    }
  }

  // Timeout
  if (!isCurrentWizardRun(runGeneration)) return;
  const statusEl = document.getElementById('onb-poll-status');
  const timeoutEl = document.getElementById('onb-poll-timeout');
  if (statusEl) statusEl.style.display = 'none';
  if (timeoutEl) timeoutEl.style.display = 'block';
  setWizardBusy(false, 'Scanning is continuing in the background.', generation);
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
      <label class="sr-only" for="onb-chat-input">Your answer</label>
      <input class="form-input" id="onb-chat-input" type="text" placeholder="Type your answer…" style="flex:1;">
      <button type="button" class="btn btn-primary" data-action="onb-send-chat">Send</button>
    </div>
    <div style="margin-top:0.75rem;">
      <button type="button" class="btn-link" data-action="onb-back-welcome"
              style="font-size:0.82rem;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:0;">
        ← Back
      </button>
    </div>
  `);
  // Kick off the first question
  setWizardBusy(true, 'Loading your first question…');
  kickConversation();
}

async function kickConversation() {
  const runGeneration = _wizardRunGeneration;
  const userId = getCurrentUserId();
  if (!userId || !_wizardState) return;

  addChatBubble('assistant', '…');
  try {
    const resp = await postOnboardingDialogue(userId, [], {});
    if (!isCurrentWizardRun(runGeneration)) return;
    removeTypingBubble();
    if (resp.kind === 'question') {
      addChatBubble('assistant', resp.question);
      _wizardState.history.push({ role: 'assistant', content: resp.question });
    } else if (resp.kind === 'final') {
      handleFinalRecommendation(resp);
    }
    setWizardBusy(false, 'Your first question is ready.');
  } catch {
    if (!isCurrentWizardRun(runGeneration)) return;
    removeTypingBubble();
    addChatBubble('assistant', 'What do you do for work?');
    if (_wizardState) {
      _wizardState.history.push({ role: 'assistant', content: 'What do you do for work?' });
    }
    setWizardBusy(false, 'Your first question is ready.');
  }
}

async function handleChatSend(text) {
  const runGeneration = _wizardRunGeneration;
  if (!_wizardState) return;
  const userId = getCurrentUserId();
  if (!userId) return;

  addChatBubble('user', text);
  _wizardState.history.push({ role: 'user', content: text });

  addChatBubble('assistant', '…');
  setWizardBusy(true, 'Thinking about your answer…');

  try {
    const resp = await postOnboardingDialogue(userId, _wizardState.history, {});
    if (!isCurrentWizardRun(runGeneration)) return;
    removeTypingBubble();

    if (resp.kind === 'question') {
      addChatBubble('assistant', resp.question);
      _wizardState.history.push({ role: 'assistant', content: resp.question });
    } else if (resp.kind === 'final') {
      handleFinalRecommendation(resp);
    }
    setWizardBusy(false, 'Next question is ready.');
  } catch {
    if (!isCurrentWizardRun(runGeneration)) return;
    removeTypingBubble();
    addChatBubble('assistant', 'Got it — let me figure out a good setup for you.');
    setWizardBusy(false, 'Continuing with a starter setup.');
    setTimeout(() => {
      if (isCurrentWizardRun(runGeneration)) handleFinalFromHistory();
    }, 500);
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
        <button type="button" class="btn btn-outline" style="text-align:left;"
                data-action="onb-deterministic-answer"
                data-question-key="${escapeHtml(q.key)}"
                data-answer="${escapeHtml(opt.value)}">
          ${escapeHtml(opt.label)}
        </button>
      `).join('')}
    </div>
    <div style="margin-top:0.75rem;">
      <button type="button" class="btn-link" data-action="onb-back-welcome"
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
  const runGeneration = _wizardRunGeneration;
  if (!_wizardState) return;
  const userId = getCurrentUserId();
  if (!userId) {
    transitionTo('welcome');
    return;
  }
  setWizardBusy(true, 'Finding the right setup…');
  try {
    const result = await postDeterministicPick(userId, _detAnswers);
    if (!isCurrentWizardRun(runGeneration)) return;
    _wizardState.recipeSlug = result.recipeSlug;
    _wizardState.recommendedRegistryIds = result.recommendedRegistryIds ?? [];
    transitionTo('recipe_preview');
    setWizardBusy(false, 'Your setup suggestion is ready.');
  } catch {
    if (!isCurrentWizardRun(runGeneration)) return;
    _wizardState.recipeSlug = 'productivity-pack';
    _wizardState.recommendedRegistryIds = [];
    transitionTo('recipe_preview');
    setWizardBusy(false, 'Your setup suggestion is ready.');
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
    description: 'Notion and Slack capabilities available in this preview.',
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

  const generation = renderContent(`
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
      <button type="button" class="btn btn-primary" data-action="onb-install-recipe" data-slug="${escapeHtml(slug)}">
        Install this bundle
      </button>
      <button type="button" class="btn btn-outline" data-action="onb-skip-recipe" style="color:var(--text-muted);">
        Skip for now
      </button>
    </div>
  `, { busy: true, status: 'Loading capability suggestions…' });

  // Load the D3 dependency graph async — non-blocking
  loadDependencyGraph(getCurrentUserId(), generation);
}

// ─────────────────────────────────────────────────────────────────────────────
// D3 dependency graph (deliverable E)
// ─────────────────────────────────────────────────────────────────────────────

async function loadDependencyGraph(userId, generation = _renderGeneration) {
  const runGeneration = _wizardRunGeneration;
  const container = document.getElementById('onb-dep-graph');
  if (!container) return;

  // Load D3 from CDN if not already present
  if (!window.d3) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js');
      if (!isCurrentWizardRun(runGeneration)) return;
    } catch {
      if (!isCurrentWizardRun(runGeneration)) return;
      container.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);text-align:center;">Dependency graph unavailable offline.</div>`;
      setWizardBusy(false, 'Capability graph unavailable offline.', generation);
      return;
    }
  }

  let graphData;
  try {
    graphData = await fetchCapabilityDependencyGraph(userId);
    if (!isCurrentWizardRun(runGeneration)) return;
  } catch {
    if (!isCurrentWizardRun(runGeneration)) return;
    container.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);text-align:center;">Could not load graph.</div>`;
    setWizardBusy(false, 'Capability graph could not be loaded.', generation);
    return;
  }

  const nodes = graphData.nodes ?? [];
  const edges = graphData.edges ?? [];
  if (nodes.length === 0) {
    container.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);text-align:center;">No capability data yet.</div>`;
    setWizardBusy(false, 'Capability graph is ready.', generation);
    return;
  }

  renderD3Graph(container, nodes, edges);
  setWizardBusy(false, 'Capability graph is ready.', generation);
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
  const runGeneration = _wizardRunGeneration;
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  transitionTo('installing');
  setWizardBusy(true, 'Installing your starter capabilities…');

  const userId = getCurrentUserId();

  try {
    const { jobs } = await installCapabilityRecipe(userId, slug);
    if (!isCurrentWizardRun(runGeneration)) return;
    const count = jobs?.length ?? 0;
    await postOnboardingComplete(userId, getFirstRunChoice(), slug);
    if (!isCurrentWizardRun(runGeneration)) return;
    renderInstallComplete(slug, count);
    setWizardBusy(false, 'Installation queued.');
  } catch (err) {
    if (!isCurrentWizardRun(runGeneration)) return;
    renderContent(`
      <div id="onb-wizard-error" style="color:var(--danger);font-size:0.85rem;margin-bottom:0.75rem;display:block;">
        Install failed: ${escapeHtml(err?.message || 'unknown error')}
      </div>
      <button type="button" class="btn btn-primary" data-action="onb-go-dashboard">Continue to dashboard anyway</button>
    `);
    setWizardBusy(false, 'Installation failed.');
  }
}

function renderInstalling() {
  renderContent(`
    <div style="text-align:center;padding:2rem 0;color:var(--text-muted);">
      <div class="loading" style="margin-bottom:0.75rem;"></div>
      Setting up your capabilities…
    </div>
  `, { busy: true, status: 'Installing your starter capabilities…' });
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
      <button type="button" class="btn btn-primary btn-lg" data-action="onb-go-dashboard">Go to dashboard</button>
    </div>
  `);
}

// ── Complete ──────────────────────────────────────────────────────────────────

async function finishWizard(userId, choice, recipeSlug) {
  const runGeneration = _wizardRunGeneration;
  try {
    await postOnboardingComplete(userId, choice, recipeSlug);
    if (!isCurrentWizardRun(runGeneration)) return;
  } catch {
    if (!isCurrentWizardRun(runGeneration)) return;
    // non-fatal — wizard still completes
  }
  localStorage.setItem(KEY_ONBOARDED, 'true');
  if (userId) localStorage.setItem(KEY_USER_ID, userId);
  // Wizard completed cleanly — drop the resume token (#390) so the
  // next first-run visit (e.g. after a delete-my-data flow) starts
  // at screen 1, not at whatever screen this user happened to end on.
  clearOnboardingState();
  hideWizard();
  if (typeof _onCompleteCallback === 'function') {
    _onCompleteCallback(userId);
  }
}

function hideWizard() {
  invalidateOnboardingRun();
  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) overlay.style.display = 'none';
  // Sample onboarding state is tab-scoped. Only promote the real account's
  // persistent marker when this tab is not showing the disposable sample.
  if (!isSampleMode() && !localStorage.getItem(KEY_ONBOARDED)) {
    localStorage.setItem(KEY_ONBOARDED, 'true');
  }
  // Drop the resume token whenever the wizard goes away (#390 Copilot).
  // hideWizard() is the chokepoint for every "wizard is done" path —
  // OAuth completion, tour-mode start, X/Skip dismiss, finishWizard
  // (which already clears explicitly but harmless to double-clear),
  // and the install-complete "Continue to dashboard" button. Without
  // this, a hideWizard() that didn't route through finishWizard()
  // left a stale resume token behind that would re-prompt on the next
  // first-run visit.
  clearOnboardingState();
  // Tear down the document-level Esc listener that showOnboarding()
  // installed (lives in app.js, exposed via window). Without this the
  // listener leaks past every wizard-complete path that doesn't go
  // through the X / Skip / Esc dismiss flow (e.g. the OAuth completion
  // and the "Continue to dashboard" button).
  if (typeof window.skyTwinTeardownOnboardingEsc === 'function') {
    window.skyTwinTeardownOnboardingEsc();
  }
  if (typeof _onCompleteCallback === 'function') {
    _onCompleteCallback(getCurrentUserId());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State machine transitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Screens that are safely resumable on next visit. `installing` is a
 * spinner-only screen mid-side-effect; `complete` is post-finish.
 * Persisting either would resume the user onto a meaningless render
 * with no source state behind it, so we skip the save (#390 Copilot).
 */
const NON_RESUMABLE_SCREENS = new Set(['installing', 'complete']);

async function transitionTo(screen) {
  if (!_wizardState) return;
  _wizardState.screen = screen;
  if (NON_RESUMABLE_SCREENS.has(screen)) {
    // We're past the point a resume can recover from; the saved state
    // for an earlier screen stays in place until finishWizard() or
    // hideWizard() clears it. Don't overwrite with a non-resumable
    // screen name.
  } else {
    saveOnboardingState();
  }

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
  const runGeneration = ++_wizardRunGeneration;
  window.skyTwinCancelOnboarding = invalidateOnboardingRun;
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
  setWizardBusy(true, 'Loading onboarding…');

  // Fetch onboarding state from the API to determine LLM availability
  const userId = getCurrentUserId();
  if (userId) {
    try {
      const state = await fetchOnboardingState(userId);
      if (!isCurrentWizardRun(runGeneration)) return;
      _wizardState.hasLlmProvider = state.hasLlmProvider ?? false;
      // If they've already completed onboarding, close the wizard
      if (!state.isFirstRun) {
        clearOnboardingState();
        hideWizard();
        return;
      }
    } catch {
      if (!isCurrentWizardRun(runGeneration)) return;
      // Non-fatal — proceed with defaults (deterministic path)
      _wizardState.hasLlmProvider = false;
    }
  }

  if (!isCurrentWizardRun(runGeneration)) return;

  // Resume path (#390). A tab-close mid-wizard leaves a
  // KEY_ONBOARDING_STATE payload behind; rather than dropping the
  // user back at screen 1 every time, show a "Resume where you left
  // off?" gate. Welcome screen is the only one we treat as
  // "not worth resuming" — if they only saw the welcome card, jump
  // straight back to it.
  const saved = loadOnboardingState();
  if (saved && saved.screen && saved.screen !== 'welcome') {
    if (typeof saved.hasLlmProvider === 'boolean') {
      _wizardState.hasLlmProvider = saved.hasLlmProvider;
    }
    if (typeof saved.recipeSlug === 'string') {
      _wizardState.recipeSlug = saved.recipeSlug;
    }
    renderResumePrompt(saved.screen, saved.savedAt);
    return;
  }

  transitionTo('welcome');
}

/**
 * Resume gate shown on next visit when a prior wizard run was
 * interrupted mid-flow (#390). Two paths: Resume → transitionTo the
 * saved screen; Start over → clear the saved state and go back to
 * the welcome screen. Click delegation lives in `ensureWizardListener`.
 */
function renderResumePrompt(savedScreen, savedAt) {
  const friendlyScreen = ({
    email_choice: 'Choose your email setup',
    computer_choice: 'Choose your sign-in path',
    idle_miner_poll: 'Scanning for apps',
    about_me_choice: 'About-you questions',
    recipe_preview: 'Confirm what to install',
    installing: 'Installing your starter kit',
  })[savedScreen] || 'Onboarding';
  const when = savedAt
    ? ` (last seen ${escapeHtml(new Date(savedAt).toLocaleString())})`
    : '';
  renderContent(`
    <div class="onboarding-title" style="font-size:1.3rem;font-weight:700;margin-bottom:0.5rem;">Pick up where you left off?</div>
    <div class="onboarding-desc" style="margin-bottom:1rem;">
      Looks like you stopped at <strong>${escapeHtml(friendlyScreen)}</strong>${when}. Want to resume, or start over?
    </div>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button type="button" class="btn btn-primary" data-action="onboarding-resume" data-screen="${escapeHtml(savedScreen)}">Resume</button>
      <button type="button" class="btn btn-outline" data-action="onboarding-restart">Start over</button>
    </div>
  `);
}
