/**
 * Connect-Gmail wizard.
 *
 * Why this exists as a wizard separate from setup.js:
 *   Gmail features in SkyTwin (content-aware triage, body summarisation,
 *   draft replies) live behind Google's *restricted* OAuth scope tier.
 *   The bundled SkyTwin-team OAuth client doesn't have those scopes
 *   verified (annual ~$15k–$50k CASA assessment we won't pay for at
 *   launch — see docs/google-verification.md and issue #351), so every
 *   user who wants Gmail in SkyTwin walks this five-step flow once,
 *   pasting their own Google Cloud OAuth credentials at the end. Their
 *   own client is private to them; Google's verification rules don't
 *   apply to a developer using their own client.
 *
 *   This is NOT a fallback or a degraded mode. It's the launch Gmail
 *   experience. Five minutes to set up, then SkyTwin gets full body
 *   access and the inbox-triage marquee features work as designed.
 *
 * Singleton delegator: like every other page in this dashboard, the
 * click handler is wired ONCE with a module-level `_listenerWired`
 * guard and gated on `window.location.hash` so cross-page navigation
 * never fires the wrong page's handler. See CLAUDE.md's "Frontend Event
 * Handling" section.
 */

import { escapeHtml, fetchJSON } from '../api-client.js';

const KEY_USER_ID = 'skytwin_userId';
const KEY_WIZARD_STEP = 'skytwin_connect_gmail_step';

const STEPS = [
  {
    n: 1,
    title: 'Create a Google Cloud project',
    blurb: 'A free Google account is all you need. Name the project anything — "my-skytwin" works.',
    url: 'https://console.cloud.google.com/projectcreate',
    cta: 'Open Google Cloud',
    detail: [
      'Click <strong>Create Project</strong>.',
      'Project name: <code>my-skytwin</code> (or anything you\'ll recognise).',
      'Leave organisation as "No organisation."',
      'Click <strong>Create</strong>. Wait ~10 seconds for the project to provision.',
    ],
  },
  {
    n: 2,
    title: 'Enable the Gmail API',
    blurb: 'Tell Google your project is allowed to read Gmail.',
    url: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
    cta: 'Open Gmail API page',
    detail: [
      'Make sure your new project is selected at the top of the page.',
      'Click the blue <strong>Enable</strong> button.',
    ],
  },
  {
    n: 3,
    title: 'Configure the consent screen',
    blurb: 'This is the screen Google shows when SkyTwin asks for access. You\'re the only user, but Google still needs the form filled out.',
    url: 'https://console.cloud.google.com/auth/branding',
    cta: 'Open consent screen',
    detail: [
      'User type: <strong>External</strong>. Click <strong>Create</strong>.',
      'App name: <code>my-skytwin</code>. Support email: your Gmail. Developer email: your Gmail.',
      'Click <strong>Save and Continue</strong> through every step. Skip the scopes screen. Skip the test-users screen for now (you\'ll add yourself in a second).',
      'When the wizard finishes, click <strong>Audience</strong> in the left sidebar. Under "Test users" click <strong>Add users</strong> and add your own Gmail address. Save.',
    ],
  },
  {
    n: 4,
    title: 'Create the OAuth client',
    blurb: 'This generates the Client ID and Client Secret you\'ll paste into SkyTwin.',
    url: 'https://console.cloud.google.com/apis/credentials',
    cta: 'Open Credentials',
    detail: [
      'Click <strong>Create credentials → OAuth client ID</strong>.',
      'Application type: <strong>Web application</strong>. (Despite the name — SkyTwin\'s OAuth redirect lands on <code>http://localhost</code>, which Google\'s "Web application" type permits. Don\'t pick "Desktop app" — that type uses an out-of-band redirect SkyTwin doesn\'t speak.)',
      'Name: <code>SkyTwin client</code>.',
      'Under <strong>Authorized redirect URIs</strong> click <strong>Add URI</strong> and paste:<br><code style="user-select:all;background:var(--bg);padding:0.15rem 0.4rem;border-radius:3px;display:inline-block;margin-top:0.25rem;">http://localhost:3100/api/oauth/google/callback</code><br>Then add a second URI for the 127.0.0.1 spelling:<br><code style="user-select:all;background:var(--bg);padding:0.15rem 0.4rem;border-radius:3px;display:inline-block;margin-top:0.25rem;">http://127.0.0.1:3100/api/oauth/google/callback</code>',
      'Click <strong>Create</strong>. Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> from the dialog — you\'ll paste them in the next step.',
    ],
  },
  {
    n: 5,
    title: 'Paste your credentials and connect',
    blurb: 'Last step. The credentials are saved encrypted in SkyTwin\'s local database — they never leave your machine.',
    cta: null,
    detail: [],
  },
];

const TOTAL_STEPS = STEPS.length;

function getCurrentStep() {
  const stored = parseInt(localStorage.getItem(KEY_WIZARD_STEP) ?? '1', 10);
  if (!Number.isFinite(stored) || stored < 1 || stored > TOTAL_STEPS) return 1;
  return stored;
}

function setCurrentStep(n) {
  localStorage.setItem(KEY_WIZARD_STEP, String(n));
}

function clearWizardState() {
  localStorage.removeItem(KEY_WIZARD_STEP);
}

function renderProgressDots(current) {
  let html = '<div class="cgm-progress" aria-label="Progress">';
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const cls = i < current ? 'done' : i === current ? 'current' : 'todo';
    html += `<span class="cgm-dot ${cls}" aria-current="${i === current ? 'step' : 'false'}">${i}</span>`;
    if (i < TOTAL_STEPS) html += '<span class="cgm-line ' + (i < current ? 'done' : 'todo') + '"></span>';
  }
  html += '</div>';
  return html;
}

function renderStep(step, opts) {
  const detailItems = step.detail.length
    ? `<ol class="cgm-detail">${step.detail.map((d) => `<li>${d}</li>`).join('')}</ol>`
    : '';
  const ctaButton = step.cta && step.url
    ? `<a class="btn btn-primary" href="${step.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(step.cta)} ↗</a>`
    : '';

  // Step 5 is the paste-and-submit form. Render it inline rather than a CTA link.
  const formBlock = step.n === 5 ? `
    <form id="cgm-cred-form" autocomplete="off" novalidate>
      <div class="form-group">
        <label for="cgm-client-id"><strong>Client ID</strong></label>
        <input
          id="cgm-client-id"
          class="form-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="123456789-abc.apps.googleusercontent.com"
          value="${escapeHtml(opts.savedClientId ?? '')}"
          required
        >
      </div>
      <div class="form-group" style="margin-top: 0.75rem;">
        <label for="cgm-client-secret"><strong>Client Secret</strong></label>
        <input
          id="cgm-client-secret"
          class="form-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="GOCSPX-xxxxxxxxxxxxxxxxxxxxxx"
          value="${escapeHtml(opts.savedClientSecret ?? '')}"
          required
        >
        <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.25rem;">
          Saved encrypted in your local SkyTwin database. The string never leaves your machine.
        </div>
      </div>
      <div id="cgm-cred-error" style="display:none;color:var(--danger,#d04646);font-size:0.85rem;margin-top:0.75rem;" role="alert"></div>
      <div style="display:flex;gap:0.5rem;margin-top:1rem;">
        <button type="button" class="btn btn-outline" data-action="cgm-prev">← Back</button>
        <button type="submit" class="btn btn-primary" data-action="cgm-submit">Save &amp; connect Gmail</button>
      </div>
    </form>
  ` : '';

  const navBlock = step.n < 5 ? `
    <div style="display:flex;gap:0.5rem;margin-top:1.25rem;">
      ${step.n > 1 ? '<button class="btn btn-outline" data-action="cgm-prev">← Back</button>' : ''}
      <button class="btn btn-primary" data-action="cgm-next">I did this — next step</button>
    </div>
  ` : '';

  return `
    <div class="cgm-step">
      <div class="cgm-step-header">
        <span class="cgm-step-n">Step ${step.n} of ${TOTAL_STEPS}</span>
        <h2>${escapeHtml(step.title)}</h2>
      </div>
      <p class="cgm-blurb">${escapeHtml(step.blurb)}</p>
      ${ctaButton ? `<div style="margin: 0.5rem 0 1rem;">${ctaButton}</div>` : ''}
      ${detailItems}
      ${formBlock}
      ${navBlock}
    </div>
  `;
}

function renderDone() {
  return `
    <div class="cgm-step">
      <div class="cgm-step-header"><h2>Gmail connected ✓</h2></div>
      <p>SkyTwin is now reading your inbox. The first few signals should show up in the Approvals queue within a minute or so. The setup is one-time — credentials live encrypted in your local database; you won't see this wizard again unless you revoke access.</p>
      <div style="display:flex;gap:0.5rem;margin-top:1rem;">
        <a class="btn btn-primary" href="#/">Open dashboard</a>
        <a class="btn btn-outline" href="#/approvals">See approvals queue</a>
      </div>
    </div>
  `;
}

function renderError(msg) {
  return `
    <div class="cgm-step">
      <div class="cgm-step-header"><h2>Setup hit a snag</h2></div>
      <p>${escapeHtml(msg)}</p>
      <div style="margin-top:1rem;">
        <button class="btn btn-primary" data-action="cgm-retry">Try again</button>
      </div>
    </div>
  `;
}

let _listenerWired = false;

function wireDelegator() {
  if (_listenerWired) return;
  _listenerWired = true;
  document.addEventListener('click', async (event) => {
    // Singleton delegator gate — see CLAUDE.md "Frontend Event Handling".
    if (window.location.hash.split('?')[0] !== '#/connect-gmail') return;
    const t = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!t) return;
    const action = t.getAttribute('data-action');
    if (action === 'cgm-next') {
      event.preventDefault();
      const next = Math.min(TOTAL_STEPS, getCurrentStep() + 1);
      setCurrentStep(next);
      await rerender();
    } else if (action === 'cgm-prev') {
      event.preventDefault();
      const prev = Math.max(1, getCurrentStep() - 1);
      setCurrentStep(prev);
      await rerender();
    } else if (action === 'cgm-retry') {
      event.preventDefault();
      setCurrentStep(1);
      await rerender();
    }
  });

  document.addEventListener('submit', async (event) => {
    if (window.location.hash.split('?')[0] !== '#/connect-gmail') return;
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || form.id !== 'cgm-cred-form') return;
    event.preventDefault();
    await submitCredentials();
  });
}

async function submitCredentials() {
  const clientIdEl = document.getElementById('cgm-client-id');
  const clientSecretEl = document.getElementById('cgm-client-secret');
  const errEl = document.getElementById('cgm-cred-error');
  if (!(clientIdEl instanceof HTMLInputElement) || !(clientSecretEl instanceof HTMLInputElement)) return;

  const clientId = clientIdEl.value.trim();
  const clientSecret = clientSecretEl.value.trim();
  // Quick client-side sanity. Real validation happens server-side; this
  // just catches the obvious paste-the-wrong-thing case so we don't burn
  // a roundtrip on a typo.
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    if (errEl) {
      errEl.textContent = 'That doesn\'t look like a Google OAuth Client ID — they end with ".apps.googleusercontent.com". Double-check the value from the Credentials page.';
      errEl.style.display = 'block';
    }
    return;
  }
  if (clientSecret.length < 8) {
    if (errEl) {
      errEl.textContent = 'Client Secret looks too short. Copy it from the OAuth client creation dialog (or the Credentials page → OAuth 2.0 Client IDs → your client → Reset secret).';
      errEl.style.display = 'block';
    }
    return;
  }
  if (errEl) errEl.style.display = 'none';

  try {
    await fetchJSON('/api/credentials/google', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentials: {
          client_id: clientId,
          client_secret: clientSecret,
        },
      }),
    });
  } catch (err) {
    if (errEl) {
      errEl.textContent = `Couldn't save credentials: ${err instanceof Error ? err.message : String(err)}`;
      errEl.style.display = 'block';
    }
    return;
  }

  // Trigger the OAuth flow with Gmail scopes. The /authorize endpoint
  // sees user-supplied credentials in the DB now (we just saved them)
  // so resolveRequestedScopes() includes gmail.readonly + gmail.modify.
  //
  // Two entry points land here:
  //   (a) Existing user adding Gmail to their twin — has a userId in
  //       localStorage; we associate the resulting tokens with that user.
  //   (b) Brand-new user during onboarding who landed here from the
  //       unset-client-id branch (NO_GOOGLE_CLIENT_CONFIGURED) — no
  //       userId yet; use ?newUser=true so /callback auto-creates the
  //       user from the verified Google email.
  const userId = localStorage.getItem(KEY_USER_ID);
  const params = userId
    ? `include=gmail&userId=${encodeURIComponent(userId)}`
    : `include=gmail&newUser=true`;
  try {
    const data = await fetchJSON(`/api/oauth/google/authorize?${params}`);
    if (data && typeof data.url === 'string') {
      clearWizardState();
      window.location.href = data.url;
      return;
    }
    throw new Error('OAuth endpoint did not return a redirect URL.');
  } catch (err) {
    if (errEl) {
      errEl.textContent = `Saved your credentials, but starting the OAuth flow failed: ${err instanceof Error ? err.message : String(err)}`;
      errEl.style.display = 'block';
    }
  }
}

async function loadSavedCreds() {
  // Pre-fill the paste form if the user partially completed the wizard
  // before (or revoked + re-installed) — saves them retyping the
  // client_id if they kept the secret. The API returns hasValue flags
  // and the actual values for read-back.
  try {
    const res = await fetchJSON('/api/credentials/google');
    const map = {};
    for (const row of (res?.credentials ?? [])) {
      if (row?.credentialKey) map[row.credentialKey] = row;
    }
    return {
      savedClientId: map['client_id']?.credentialValue ?? '',
      savedClientSecret: map['client_secret']?.credentialValue ?? '',
    };
  } catch {
    return { savedClientId: '', savedClientSecret: '' };
  }
}

async function rerender() {
  const container = document.getElementById('page-content');
  if (!container) return;
  await renderConnectGmail(container);
}

export async function renderConnectGmail(container) {
  wireDelegator();
  const current = getCurrentStep();
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');

  // ?done=1 — set by /api/oauth/google/callback after a successful
  // Gmail OAuth grant (or by the post-Save redirect once the consent
  // round-trip lands back on /#/). Show the celebration card.
  if (params.get('done') === '1') {
    clearWizardState();
    container.innerHTML = `<div class="cgm-wrap">${renderHeader()}${renderDone()}</div>`;
    injectStyles();
    return;
  }

  // ?connected=google — set by /api/oauth/google/callback when the user
  // is deep-linked into this page from the onboarding wizard (or any
  // /authorize call passing `next=connect-gmail`). Render an "OK, Google
  // is connected, here's the next step" banner above the wizard so the
  // user understands why they're seeing the five-step flow.
  const justConnectedGoogle = params.get('connected') === 'google';
  const justConnectedAccount = params.get('account') ?? '';

  const opts = current === 5 ? await loadSavedCreds() : {};
  const step = STEPS[current - 1];
  container.innerHTML = `
    <div class="cgm-wrap">
      ${renderHeader()}
      ${justConnectedGoogle ? renderGoogleConnectedBanner(justConnectedAccount) : ''}
      ${renderProgressDots(current)}
      ${renderStep(step, opts)}
    </div>
  `;
  injectStyles();
}

function renderGoogleConnectedBanner(account) {
  const accountLine = account
    ? `<strong>${escapeHtml(account)}</strong> is now linked for Calendar.`
    : `Your Google account is now linked for Calendar.`;
  return `
    <div class="cgm-banner" role="status">
      <div class="cgm-banner-check">&#10003;</div>
      <div class="cgm-banner-body">
        <div class="cgm-banner-title">Calendar connected</div>
        <div class="cgm-banner-text">${accountLine} Now let&rsquo;s hook up Gmail so SkyTwin can read and triage your inbox — this part takes about five minutes, once.</div>
      </div>
    </div>
  `;
}

function renderHeader() {
  return `
    <div class="cgm-header">
      <h1>Connect Gmail to SkyTwin</h1>
      <p>Five-minute setup, one time. Calendar already works through the bundled SkyTwin app — this hooks Gmail up using your own free Google Cloud OAuth credentials so SkyTwin can read your inbox and act on what it finds. <a href="https://jayzalowitz.github.io/skytwin/connect-gmail.html" target="_blank" rel="noopener">Why is this step needed?</a></p>
    </div>
  `;
}

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .cgm-wrap { max-width: 720px; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
    .cgm-header h1 { margin: 0 0 0.5rem; font-size: 1.6rem; letter-spacing: -0.02em; }
    .cgm-header p { color: var(--text-muted); font-size: 0.95rem; margin: 0 0 1.5rem; }
    .cgm-progress { display: flex; align-items: center; margin: 1.5rem 0 2rem; gap: 0.4rem; }
    .cgm-dot {
      display: inline-flex; align-items: center; justify-content: center;
      width: 1.75rem; height: 1.75rem; border-radius: 50%;
      font-size: 0.85rem; font-weight: 600;
      background: var(--bg); border: 1px solid var(--border);
      color: var(--text-muted);
      flex-shrink: 0;
    }
    .cgm-dot.current { background: var(--primary); color: #fff; border-color: var(--primary); }
    .cgm-dot.done { background: var(--success); color: #fff; border-color: var(--success); }
    .cgm-line { flex: 1; height: 2px; background: var(--border); border-radius: 1px; }
    .cgm-line.done { background: var(--success); }
    .cgm-step {
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 1.5rem;
    }
    .cgm-step-header { margin-bottom: 0.5rem; }
    .cgm-step-header h2 { margin: 0; font-size: 1.25rem; }
    .cgm-step-n { display: block; color: var(--text-muted); font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
    .cgm-blurb { color: var(--text-secondary, var(--text-muted)); margin: 0.25rem 0 1rem; }
    .cgm-detail { padding-left: 1.5rem; line-height: 1.75; font-size: 0.95rem; }
    .cgm-detail li { margin-bottom: 0.5rem; }
    .cgm-detail code { background: var(--bg); padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.88em; }
    .cgm-banner {
      display: flex; align-items: flex-start; gap: 0.75rem;
      background: var(--success-bg, rgba(34,197,94,0.08));
      border: 1px solid var(--success, #16a34a);
      border-radius: var(--radius); padding: 0.85rem 1rem;
      margin: 0 0 1.5rem; color: var(--text);
    }
    .cgm-banner-check {
      width: 1.5rem; height: 1.5rem; border-radius: 50%;
      background: var(--success, #16a34a); color: #fff;
      display: inline-flex; align-items: center; justify-content: center;
      font-weight: 700; flex-shrink: 0;
    }
    .cgm-banner-title { font-weight: 600; font-size: 0.95rem; margin-bottom: 0.15rem; }
    .cgm-banner-text { font-size: 0.88rem; color: var(--text-muted); line-height: 1.5; }
  `;
  document.head.appendChild(style);
}
