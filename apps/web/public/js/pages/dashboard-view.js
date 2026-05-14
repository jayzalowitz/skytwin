/**
 * Dashboard view layer — pure render functions and the global event
 * handlers they wire up via inline `onclick`. Split out of dashboard.js
 * to lower the cognitive load of the entry point file.
 *
 * Three groups in this file:
 *   1. Label helpers — situationLabel, domainIcon, domainLabel,
 *      traitLabel, traitIcon, formatTime. Pure functions.
 *   2. Render helpers — render*Card / render*Hero / render*Banner /
 *      render*Widget. All return HTML strings, no side effects.
 *   3. Handlers + initDashboardGlobals — the functions that the inline
 *      onclick attributes in (2) reference via window.X. Wired into
 *      window once at app.js bootstrap.
 *
 * dashboard.js owns the lifecycle (data fetching, model derivation,
 * post-render side effects); this file owns presentation.
 */

import { askTwin, escapeHtml } from '../api-client.js';
import {
  KEY_USER_ID,
  KEY_ONBOARDED,
  KEY_TOUR_MODE,
  KEY_NOTIF_DISMISSED,
  KEY_NOTIF_ASKED,
  clearKeysForSuffix,
} from '../storage-keys.js';

export function situationLabel(type) {
  if (!type) return 'something';
  const labels = {
    email_triage: 'an email',
    calendar_invite: 'a calendar invite',
    calendar_conflict: 'a calendar conflict',
    calendar_update: 'a calendar update',
    subscription_renewal: 'a subscription renewal',
    grocery_reorder: 'a grocery reorder',
    travel_decision: 'a travel decision',
    finance_operation: 'something financial',
    smart_home: 'a smart-home thing',
    task_management: 'a task',
    social_media: 'a social-media thing',
    document_management: 'a document',
    health_wellness: 'something health-related',
    newsletter_archive: 'a newsletter',
    generic: 'something',
  };
  return labels[type] || type.replace(/_/g, ' ');
}

export function domainIcon(domain) {
  const icons = { email: 'E', calendar: 'C', finance: '$', shopping: 'S', travel: 'T', subscriptions: 'R', general: 'G' };
  return icons[domain] || '?';
}

export function domainLabel(domain) {
  const labels = {
    email: 'Email',
    calendar: 'Calendar',
    subscriptions: 'Subscriptions',
    shopping: 'Shopping',
    travel: 'Travel',
    general: 'General',
    correction: 'Corrections',
  };
  return labels[domain] || (domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : 'General');
}

export function traitLabel(name) {
  const labels = {
    cautious_spender: 'You\'re careful with spending',
    quick_responder: 'You respond quickly',
    privacy_conscious: 'You value privacy',
    routine_driven: 'You like routines',
    delegation_averse: 'You prefer doing things yourself',
  };
  return labels[name] || name.replace(/_/g, ' ');
}

export function traitIcon(name) {
  const icons = {
    cautious_spender: '$',
    quick_responder: '!',
    privacy_conscious: '?',
    routine_driven: '~',
    delegation_averse: '*',
  };
  return icons[name] || '?';
}

export function renderNotificationOptIn() {
  // Only render in the "we should ask" state: notifications supported,
  // permission still 'default' (not asked or already granted), and the
  // user hasn't said "maybe later" already.
  if (typeof window === 'undefined') return '';
  let state = 'unsupported';
  let dismissed = false;
  try {
    state = window.skyTwinNotificationsState ? window.skyTwinNotificationsState() : 'unsupported';
    dismissed = localStorage.getItem(KEY_NOTIF_DISMISSED) === '1';
  } catch { /* noop */ }
  if (state !== 'default' || dismissed) return '';

  return `
    <div class="card" id="notif-opt-in" style="border-left: 3px solid var(--primary);">
      <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
        <span class="card-title">Want a heads-up when I need you?</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        I can ping your computer with a quick notification when something needs your OK, so you don't have to keep this tab open.
        Click below and your browser will ask for permission.
      </div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button class="btn btn-primary btn-sm" data-action="enable-notif">Yes, ping me</button>
        <button class="btn btn-outline btn-sm" data-action="dismiss-notif">Maybe later</button>
      </div>
    </div>
  `;
}

export async function handleEnableNotifications() {
  try {
    const res = await window.skyTwinRequestNotifications();
    if (res === 'granted') {
      const card = document.getElementById('notif-opt-in');
      if (card) card.remove();
      const { showToast } = await import('../sse-client.js');
      showToast('Notifications on', 'I\'ll ping you when something needs your OK.', 'success');
    } else if (res === 'denied') {
      const card = document.getElementById('notif-opt-in');
      if (card) card.remove();
      try { localStorage.setItem(KEY_NOTIF_DISMISSED, '1'); } catch { /* noop */ }
    }
  } catch { /* user dismissed the OS prompt */ }
}

export function dismissNotifOptIn() {
  try { localStorage.setItem(KEY_NOTIF_DISMISSED, '1'); } catch { /* noop */ }
  document.getElementById('notif-opt-in')?.remove();
}

export function renderBriefingCard({ items, createdAt }) {
  // Headline copy adapts to time-of-day so the card doesn't say
  // "morning briefing" when a user opens the dashboard at 9pm.
  const created = new Date(createdAt);
  const hours = (Date.now() - created.getTime()) / (60 * 60 * 1000);
  const sameDay = (new Date()).toDateString() === created.toDateString();
  const ofDay = sameDay
    ? (created.getHours() < 11 ? 'this morning' : created.getHours() < 17 ? 'earlier today' : 'this evening')
    : (hours < 24 ? 'yesterday' : created.toLocaleDateString(undefined, { weekday: 'long' }));

  const handled = items.filter((it) => it?.wouldAutoExecute).length;
  const wantingApproval = items.length - handled;

  // Headline summary built from counts so the user sees the shape of the
  // last scan at a glance before reading the items below.
  const summaryParts = [];
  if (handled > 0) summaryParts.push(`<strong>${handled}</strong> handled on my own`);
  if (wantingApproval > 0) summaryParts.push(`<strong>${wantingApproval}</strong> waiting on you`);
  const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : `${items.length} ${items.length === 1 ? 'thing' : 'things'} to share`;

  // Show up to 5 items; collapse the rest into "+ N more on the Decisions page"
  const SHOWN_ITEMS = 5;
  const visible = items.slice(0, SHOWN_ITEMS);
  const remaining = items.length - visible.length;

  return `
    <div class="card" style="border-left: 3px solid var(--primary);">
      <div class="card-header">
        <span class="card-title">Briefing from ${escapeHtml(ofDay)}</span>
        <span style="font-size: 0.75rem; color: var(--text-muted);">${summary}</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        Here's the round-up of what your twin saw on its last scan — what it acted on, and what it's holding for you.
      </div>
      ${visible.map((it) => renderBriefingItem(it)).join('')}
      ${remaining > 0 ? `
        <div style="margin-top: 0.5rem; text-align: center;">
          <a class="btn btn-outline btn-sm" href="#/decisions">+ ${remaining} more on the Decisions page</a>
        </div>
      ` : ''}
    </div>
  `;
}

export function renderBriefingItem(it) {
  if (!it) return '';
  const auto = !!it.wouldAutoExecute;
  const accent = auto ? 'var(--success)' : 'var(--warning, #e6a700)';
  const verb = auto ? "I'd handle this on my own" : "I'd ask you first";
  const conf = (it.confidence || '').toString().replace(/_/g, ' ');
  const urgent = it.urgency === 'critical' || it.urgency === 'high';

  return `
    <div style="display: grid; grid-template-columns: auto 1fr auto; gap: 0.6rem 0.75rem; align-items: start; padding: 0.65rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm); margin-bottom: 0.4rem;">
      <div style="width: 6px; align-self: stretch; background: ${accent}; border-radius: 3px;"></div>
      <div style="min-width: 0;">
        <div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 0.15rem;">${escapeHtml(it.actionDescription || 'Something to consider')}</div>
        ${it.reasoning ? `<div style="font-size: 0.82rem; color: var(--text-muted); line-height: 1.5;">${escapeHtml(it.reasoning)}</div>` : ''}
        <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.25rem;">
          ${escapeHtml(it.domain || 'general')}${conf ? ` · confidence ${escapeHtml(conf)}` : ''}${urgent ? ' · urgent' : ''}
        </div>
      </div>
      <div style="font-size: 0.72rem; color: ${accent}; font-weight: 600; white-space: nowrap;">${verb}</div>
    </div>
  `;
}

export function renderSinceLastVisit({ newDecisions, ago }) {
  return `
    <div class="card" style="border-left: 3px solid var(--success); cursor: pointer;" data-action="goto" data-hash="#/decisions">
      <span style="font-weight: 600;">While you were away —</span>
      <span style="color: var(--text-muted); font-size: 0.9rem;">
        I handled or weighed in on <strong>${newDecisions}</strong> new ${newDecisions === 1 ? 'thing' : 'things'} since you last checked in (${escapeHtml(ago)}). Click to see what.
      </span>
    </div>
  `;
}

export function renderEmptyDashboardPreview({ googleConnected }) {
  // Sells the value before any data has flowed in. Used when there are no
  // decisions, learnings, or patterns yet — replaces the wall of "0%" stat
  // cards which read as failure for a brand-new user.
  const subtitle = googleConnected
    ? 'I\'m connected and listening. The first time something interesting happens, you\'ll see what I made of it. Here\'s the kind of thing I\'ll be deciding on:'
    : 'Once your accounts are connected, here\'s the kind of thing I\'ll be deciding on for you:';

  return `
    <div class="card" style="border-left: 3px solid var(--primary);">
      <div class="card-header">
        <span class="card-title">What I'll handle for you</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">${subtitle}</div>
      <div class="insight-card">
        <div class="insight-icon" style="background: var(--accent-soft); color: var(--accent);">E</div>
        <div class="insight-content">
          <div class="insight-title">Newsletter you usually skim</div>
          <div class="insight-desc">"You've archived the last 11 of these without opening. Want me to start handling them automatically?"</div>
        </div>
      </div>
      <div class="insight-card">
        <div class="insight-icon" style="background: var(--accent-soft); color: var(--accent);">C</div>
        <div class="insight-content">
          <div class="insight-title">Calendar conflict</div>
          <div class="insight-desc">"This invite overlaps with your skip-level — based on past behavior I'd suggest declining and proposing Thursday."</div>
        </div>
      </div>
      <div class="insight-card">
        <div class="insight-icon" style="background: var(--accent-soft); color: var(--accent);">$</div>
        <div class="insight-content">
          <div class="insight-title">Subscription about to renew</div>
          <div class="insight-desc">"Streaming, $15.99/mo. You used it 3× this month — within your auto-renew rules, so I'll let it through."</div>
        </div>
      </div>
      <div style="margin-top: 0.5rem; font-size: 0.8rem; color: var(--text-muted);">
        ${googleConnected
          ? 'You can preview my judgement on any situation right now using "Ask your twin" above — I\'ll explain what I\'d do and why.'
          : 'Want to feel how this works before connecting? Try the "Ask your twin" box above with any situation.'}
      </div>
    </div>
  `;
}

export function renderAskTwinWidget({ userId, tourMode }) {
  // Different example prompts based on tour mode (Alex Thompson) vs real user.
  // Tour mode has rich seeded preferences so the example questions land.
  const examples = tourMode
    ? [
        'I just got an email from a recruiter at a company I\'ve never heard of. What would you do?',
        'My streaming subscription is up for renewal at $15/month — used it 3 times this month.',
        'A friend invited me to dinner Friday at 7pm. What would you do?',
      ]
    : [
        'A recruiter just emailed me about a job. What would you do?',
        'My streaming service is up for renewal — should we let it through?',
        'A meeting invite just landed for tomorrow at 3pm. What would you do?',
      ];

  return `
    <div class="card" style="border-left: 3px solid var(--primary);">
      <div class="card-header">
        <span class="card-title">Ask your twin</span>
        <span class="badge badge-info" style="font-size: 0.7rem;">no signals required</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        Curious how I'd handle something? Describe a situation in plain words and I'll tell you what I'd do, why,
        and how confident I am — without actually doing anything.
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: stretch; margin-bottom: 0.5rem;">
        <textarea
          class="form-input"
          id="ask-twin-input"
          placeholder="e.g. What would you do if my mom emails asking me to call her tonight, but I have a meeting at 8?"
          rows="2"
          style="flex: 1; resize: vertical; font-family: inherit; line-height: 1.4;"
          data-action="ask-twin-input"
          data-user-id="${escapeHtml(userId)}"
        ></textarea>
        <button class="btn btn-primary" data-action="ask-twin" data-user-id="${escapeHtml(userId)}" id="ask-twin-btn" style="align-self: stretch;">
          Ask
        </button>
      </div>
      <div style="font-size: 0.7rem; color: var(--text-muted); margin: -0.25rem 0 0.4rem;">
        Press <kbd style="font-family: inherit; padding: 0 0.3rem; background: var(--bg); border-radius: 3px; border: 1px solid var(--border); font-size: 0.7rem;">Enter</kbd> to ask · <kbd style="font-family: inherit; padding: 0 0.3rem; background: var(--bg); border-radius: 3px; border: 1px solid var(--border); font-size: 0.7rem;">Shift+Enter</kbd> for a new line
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem;" id="ask-twin-examples" data-user-id="${escapeHtml(userId)}">
        ${examples.map(ex => `
          <button
            class="btn btn-outline btn-sm ask-twin-example"
            style="font-size: 0.78rem; line-height: 1.3; text-align: left;"
            data-prompt="${escapeHtml(ex)}"
          >${escapeHtml(ex.length > 60 ? ex.slice(0, 57) + '…' : ex)}</button>
        `).join('')}
      </div>
      <div id="ask-twin-result" style="margin-top: 0.5rem;"></div>
    </div>
  `;
}

export async function handleAskTwin(userId) {
  const input = document.getElementById('ask-twin-input');
  const btn = document.getElementById('ask-twin-btn');
  const result = document.getElementById('ask-twin-result');
  if (!input || !result) return;
  const situation = input.value.trim();
  if (!situation) { input.focus(); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
  result.innerHTML = `<div style="padding: 0.75rem; color: var(--text-muted); font-size: 0.85rem;">Thinking it through…</div>`;

  try {
    const r = await askTwin(userId, situation);
    result.innerHTML = renderAskResult(r);
  } catch (err) {
    result.innerHTML = `<div class="error-banner">${escapeHtml(err.message || 'Couldn\'t reach the twin right now.')}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Ask'; }
  }
}

export function renderAskResult(r) {
  if (!r) return '';
  const conf = (r.confidence || 'unknown').toString();
  const confLabel = conf.replace(/_/g, ' ');
  const action = r.predictedAction;
  const autoVerb = r.wouldAutoExecute ? 'I\'d handle this on my own' : 'I\'d ask you first';
  const autoColor = r.wouldAutoExecute ? 'var(--success)' : 'var(--warning, #e6a700)';

  const alts = (r.alternativeActions || []).filter(a => a && a.actionType !== action?.actionType).slice(0, 3);

  return `
    <div style="margin-top: 0.75rem; padding: 0.85rem 1rem; background: var(--bg); border-radius: var(--radius-sm); border-left: 3px solid ${autoColor};">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
        <span style="font-weight: 600;">${action ? escapeHtml(action.description || action.actionType || 'Take an action') : 'Not sure yet — I\'d probably ask you'}</span>
        <span style="font-size: 0.75rem; color: ${autoColor}; font-weight: 600;">${autoVerb}</span>
      </div>
      ${r.reasoning ? `<div style="font-size: 0.85rem; line-height: 1.6; margin-bottom: 0.5rem;">${escapeHtml(r.reasoning)}</div>` : ''}
      <div style="font-size: 0.78rem; color: var(--text-muted);">
        Confidence: <strong>${escapeHtml(confLabel)}</strong>${r.policyNotes ? ' · ' + escapeHtml(r.policyNotes) : ''}
      </div>
      ${alts.length > 0 ? `
        <details style="margin-top: 0.6rem;">
          <summary style="cursor: pointer; font-size: 0.78rem; color: var(--text-muted);">${alts.length} other option${alts.length > 1 ? 's' : ''} I considered</summary>
          <div style="margin-top: 0.4rem; padding-left: 0.75rem; border-left: 2px solid var(--border); font-size: 0.8rem; line-height: 1.6;">
            ${alts.map(a => `<div>· ${escapeHtml(a.description || a.actionType)}</div>`).join('')}
          </div>
        </details>
      ` : ''}
    </div>
  `;
}

export function renderTourBanner() {
  return `
    <div class="card" style="border-left: 3px solid var(--warning, #e6a700); background: linear-gradient(135deg, var(--bg-card) 0%, var(--bg) 100%);">
      <div class="card-header">
        <span class="card-title">You're exploring with a sample profile</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        Everything you see — the decisions, the learnings, the approvals — belongs to a fictional user named Alex.
        Click around freely, then start your own when you're ready. Nothing you do here touches your real accounts.
      </div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button class="btn btn-primary btn-sm" data-action="exit-tour">Start my own setup</button>
        <a class="btn btn-outline btn-sm" href="#/decisions">See what Alex's twin has been doing</a>
        <a class="btn btn-outline btn-sm" href="#/twin">See what it learned about Alex</a>
      </div>
    </div>
  `;
}

export function skyTwinExitTour() {
  // Hard-cleanup everything the tour wrote so a future tour starts
  // fresh (no stale "first decision" toast, no stale tier celebration,
  // no stale notification dismissal). Sweeps both the fixed-name flags
  // and any per-user key whose suffix matches the demo uid.
  const demoUid = (() => { try { return localStorage.getItem(KEY_USER_ID) || ''; } catch { return ''; } })();
  clearKeysForSuffix(demoUid, [
    KEY_TOUR_MODE,
    KEY_USER_ID,
    KEY_ONBOARDED,
    KEY_NOTIF_DISMISSED,
    KEY_NOTIF_ASKED,
  ]);
  window.location.reload();
}

export function renderJustConnectedCelebration({ justConnectedProvider, justConnectedAccount, recentDecisionsCount, learnedCount }) {
  if (!justConnectedProvider) return '';
  const providerLabel = justConnectedProvider === 'google' ? 'Google' : justConnectedProvider;
  const accountLine = justConnectedAccount
    ? `<div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">Connected ${escapeHtml(justConnectedAccount)}</div>`
    : '';

  // Two states: still in first scan (live progress) vs. signals already arriving.
  if (recentDecisionsCount === 0 && learnedCount === 0) {
    return `
      <div class="card" style="border-left: 3px solid var(--success); background: linear-gradient(135deg, var(--bg-card) 0%, var(--bg) 100%);">
        <div class="card-header">
          <span class="card-title">Your twin just woke up</span>
        </div>
        <div class="card-subtitle" style="margin-bottom: 0.75rem;">
          ${escapeHtml(providerLabel)} is connected. I'm peeking at your most recent unread messages
          and your upcoming calendar — should take less than a minute. Anything I spot will land below as it comes in.
        </div>
        ${accountLine}
        <div style="margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; color: var(--text-muted);">
          <span class="skytwin-pulse-dot"></span>
          Watching your inbox and calendar…
        </div>
      </div>
    `;
  }

  return `
    <div class="card" style="border-left: 3px solid var(--success);">
      <div class="card-header">
        <span class="card-title">Your twin is live</span>
      </div>
      <div class="card-subtitle">
        ${escapeHtml(providerLabel)} is connected and your twin has already started learning.
        Scroll down to see what it's spotted so far.
      </div>
      ${accountLine}
    </div>
  `;
}

export function renderConnectGoogleHero({ googleConnected, googleSystemConfigured, userId }) {
  if (googleConnected) return '';

  const safeUserId = escapeHtml(userId);

  if (!googleSystemConfigured) {
    return `
      <div class="card" style="border-left: 3px solid var(--primary); background: linear-gradient(135deg, var(--bg-card) 0%, var(--bg) 100%);">
        <div class="card-header">
          <span class="card-title">Let's get you connected</span>
        </div>
        <div class="card-subtitle" style="margin-bottom: 1rem;">
          To start handling email and calendar for you, SkyTwin needs to be linked to your Google account.
          The one-time setup takes about 5 minutes — we'll walk you through every click.
        </div>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <a class="btn btn-primary" href="#/setup">Set up Google access →</a>
          <a class="btn btn-outline" href="#/decisions">See what it can do first</a>
        </div>
      </div>
    `;
  }

  return `
    <div class="card" style="border-left: 3px solid var(--primary); background: linear-gradient(135deg, var(--bg-card) 0%, var(--bg) 100%);">
      <div class="card-header">
        <span class="card-title">One last step — connect your Google account</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Your twin is ready, but it can't see anything yet. Connect Google so it can start learning from your inbox and calendar.
      </div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button class="btn btn-primary" data-action="connect-google" data-user-id="${safeUserId}">Connect Google</button>
        <a class="btn btn-outline" href="#/settings">Manage connections</a>
      </div>
    </div>
  `;
}

export async function handleConnectGoogleFromDashboard(userId) {
  try {
    const { startGoogleSignIn } = await import('../google-signin.js');
    const result = await startGoogleSignIn({ userId });
    if (result.status === 'error') {
      console.error('Could not start Google connect flow:', result.error);
      window.location.hash = '#/settings';
    }
  } catch (err) {
    console.error('Could not start Google connect flow:', err);
    window.location.hash = '#/settings';
  }
}

// ── Bootstrap (called once from app.js) ────────────────────────────────
//
// Pulls all dashboard handlers + the document-level click delegator
// behind a single init function. Idempotent — safe to call more than
// once if app.js ever bootstraps the dashboard route twice. Replaces
// five module-top-level `if (typeof window !== 'undefined') { ... }`
// blocks that ran at import time and made the lifecycle unclear.
let _dashboardGlobalsWired = false;

export function initDashboardGlobals() {
  if (typeof window === 'undefined' || _dashboardGlobalsWired) return;
  _dashboardGlobalsWired = true;

  // Document-level click delegator for dashboard interactions. Lives on
  // document so re-renders don't need to rebind. Keyed off `data-action`
  // attributes so the rendered HTML stays free of inline `onclick=` (no
  // JS-string injection vector even if values contain quotes).
  //
  // Hash-route gate: the SPA reuses one #page-content container across
  // routes, so without this check our data-action names would collide
  // with data-action="connect-google" on settings.js and similar.
  document.addEventListener('click', (ev) => {
    const hash = (window.location.hash || '').split('?')[0] || '#/';
    if (hash !== '#/' && hash !== '#') return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    const example = target.closest('.ask-twin-example');
    if (example) {
      const wrap = example.closest('#ask-twin-examples');
      const uid = wrap?.getAttribute('data-user-id');
      const prompt = example.getAttribute('data-prompt');
      const input = document.getElementById('ask-twin-input');
      if (input && uid && prompt) {
        input.value = prompt;
        handleAskTwin(uid);
      }
      return;
    }

    const el = target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    if (action === 'goto') {
      const hashTarget = el.getAttribute('data-hash');
      if (hashTarget) window.location.hash = hashTarget;
    } else if (action === 'enable-notif') {
      handleEnableNotifications();
    } else if (action === 'dismiss-notif') {
      dismissNotifOptIn();
    } else if (action === 'ask-twin') {
      const uid = el.getAttribute('data-user-id');
      if (uid) handleAskTwin(uid);
    } else if (action === 'exit-tour') {
      skyTwinExitTour();
    } else if (action === 'connect-google') {
      const uid = el.getAttribute('data-user-id');
      if (uid) handleConnectGoogleFromDashboard(uid);
    }
  });

  // Delegated keydown for the Ask Your Twin textarea: Enter submits,
  // Shift+Enter inserts a newline. Same hash-route gate.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    const hash = (window.location.hash || '').split('?')[0] || '#/';
    if (hash !== '#/' && hash !== '#') return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const input = target.closest('[data-action="ask-twin-input"]');
    if (!input) return;
    const uid = input.getAttribute('data-user-id');
    if (!uid) return;
    ev.preventDefault();
    handleAskTwin(uid);
  });
}

export function renderUnmetCredentials(unmetCredsResult) {
  const unmet = unmetCredsResult.status === 'fulfilled' ? (unmetCredsResult.value.unmet ?? []) : [];
  if (unmet.length === 0) return '';

  return `
    <div class="card" style="border-left: 3px solid var(--warning, #e6a700); cursor: pointer;" data-action="goto" data-hash="#/setup">
      <div class="card-header">
        <span class="card-title">Integrations needed</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        Some skills need external accounts to work. Head to <a href="#/setup">Setup</a> to add credentials.
      </div>
      ${unmet.map(u => `
        <div class="insight-card">
          <div class="insight-icon" style="background: var(--warning-soft, #fff3cd); color: var(--warning, #856404);">!</div>
          <div class="insight-content">
            <div class="insight-title">${escapeHtml(u.label)}</div>
            <div class="insight-desc">Missing: ${u.missingFields.map(f => escapeHtml(f)).join(', ')}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

export function renderSkillGaps(skillGapsResult) {
  const gaps = skillGapsResult.status === 'fulfilled' ? (skillGapsResult.value.gaps ?? []) : [];
  if (gaps.length === 0) return '';

  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Where I need your help</span>
      </div>
      ${gaps.map(g => `
        <div class="insight-card">
          <div class="insight-icon" style="background: var(--warning-soft, #fff3cd); color: var(--warning, #856404);">?</div>
          <div class="insight-content">
            <div class="insight-title">${g.domain ? domainLabel(g.domain) : 'General'}</div>
            <div class="insight-desc">${g.description || g.gap || 'I haven\'t learned enough about this area yet.'}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

export function formatTime(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString();
}
