import { fetchHealth, fetchDecisions, fetchAccuracy, fetchConfidence, fetchLearning, fetchPendingApprovals, fetchSkillGaps, fetchTrustProgress, fetchLearned, fetchUnmetCredentials, fetchOAuthStatus, fetchCredentialsStatus, askTwin, escapeHtml } from '../api-client.js';
import { renderTrustProgress } from '../components/progress-bar.js';

export async function renderDashboard(container, userId) {
  const [health, accuracy, confidence, learning, approvals, decisions, skillGaps, progress, learned, unmetCreds, googleOAuth, credsStatus] = await Promise.allSettled([
    fetchHealth(),
    fetchAccuracy(userId),
    fetchConfidence(userId),
    fetchLearning(userId),
    fetchPendingApprovals(userId),
    fetchDecisions(userId, { limit: 10 }),
    fetchSkillGaps(userId),
    fetchTrustProgress(userId),
    fetchLearned(userId),
    fetchUnmetCredentials(),
    fetchOAuthStatus(userId, 'google'),
    fetchCredentialsStatus(),
  ]);

  const healthOk = health.status === 'fulfilled';
  const acc = accuracy.status === 'fulfilled' ? accuracy.value : null;
  const conf = confidence.status === 'fulfilled' ? confidence.value : null;
  const learn = learning.status === 'fulfilled' ? learning.value : null;
  const pending = approvals.status === 'fulfilled' ? (approvals.value.approvals?.length ?? 0) : 0;
  const recentDecisions = decisions.status === 'fulfilled' ? (decisions.value.decisions ?? []) : [];

  const prog = progress.status === 'fulfilled' ? progress.value : null;
  const learnedData = learned.status === 'fulfilled' ? learned.value : null;

  const googleConnected = googleOAuth.status === 'fulfilled' && (googleOAuth.value?.connected ?? false);
  const googleSystemConfigured = credsStatus.status === 'fulfilled' && (credsStatus.value?.google?.configured ?? false);

  // Read post-OAuth query so we can celebrate the moment they connect.
  // App.js strips the query before routing; we re-parse it from the raw hash.
  const hashRaw = window.location.hash || '';
  const queryStart = hashRaw.indexOf('?');
  const hashParams = queryStart >= 0 ? new URLSearchParams(hashRaw.slice(queryStart + 1)) : new URLSearchParams();
  const justConnectedProvider = hashParams.get('connected');
  const justConnectedAccount = hashParams.get('account');

  // After the first signals show up, the celebration card naturally falls
  // away. While we're still in the "first scan" window (just connected, no
  // decisions yet) we poll every 4s so the user sees the dashboard come
  // alive without needing to refresh.
  const inFirstScanWindow = !!justConnectedProvider && googleConnected && recentDecisions.length === 0;

  const overallConf = conf?.overallConfidence ?? 0;
  const confLabel = overallConf >= 75 ? 'Very confident' : overallConf >= 50 ? 'Getting there' : overallConf >= 25 ? 'Still learning' : 'Just started';
  const confClass = overallConf >= 75 ? 'high' : overallConf >= 50 ? 'moderate' : overallConf >= 25 ? 'low' : 'speculative';

  const tourMode = (() => { try { return localStorage.getItem('skytwin_tour_mode') === '1'; } catch { return false; } })();

  // "While you were away" — count anything new since the last visit so the
  // user feels like the twin has been working for them, not just sitting
  // there. We don't show this for the very first load (no prior visit) or
  // for visits within the last 5 minutes (would just be noise).
  const sinceLastVisit = (() => {
    try {
      const key = `skytwin_last_visit_${userId}`;
      const lastVisitMs = parseInt(localStorage.getItem(key) || '0', 10);
      const now = Date.now();
      // Always update the timestamp so subsequent renders this session
      // measure against the freshest baseline.
      localStorage.setItem(key, String(now));
      if (!lastVisitMs || (now - lastVisitMs) < 5 * 60 * 1000) return null;
      const newDecisions = recentDecisions.filter((d) => {
        const t = Date.parse(d.createdAt || d.created_at || '');
        return Number.isFinite(t) && t > lastVisitMs;
      }).length;
      if (newDecisions === 0) return null;
      const hours = Math.round((now - lastVisitMs) / (60 * 60 * 1000));
      const ago = hours < 1 ? 'a few minutes ago'
        : hours < 24 ? `${hours}h ago`
        : `${Math.round(hours / 24)}d ago`;
      return { newDecisions, ago };
    } catch { return null; }
  })();

  // A new user (no decisions, no learnings, no patterns) gets an
  // intentionally-empty dashboard: hero CTAs + Ask + a "what's coming"
  // preview, instead of a wall of "0%" stat cards that read as failure.
  // Once anything lands, the full dashboard takes over naturally.
  const hasAnyData = (recentDecisions.length > 0)
    || ((learn?.totalPreferences ?? 0) > 0)
    || ((learn?.totalPatterns ?? 0) > 0);
  const showEmptyPreview = !tourMode && !hasAnyData;

  container.innerHTML = `
    ${!healthOk ? '<div class="error-banner">Unable to reach the API server. Your twin may not be processing events.</div>' : ''}
    ${tourMode ? renderTourBanner() : ''}
    ${renderJustConnectedCelebration({ justConnectedProvider, justConnectedAccount, recentDecisionsCount: recentDecisions.length, learnedCount: learn?.totalPreferences ?? 0 })}
    ${sinceLastVisit && !tourMode ? renderSinceLastVisit(sinceLastVisit) : ''}
    ${tourMode ? '' : renderConnectGoogleHero({ googleConnected, googleSystemConfigured, userId })}
    ${renderAskTwinWidget({ userId, tourMode })}
    ${pending > 0 ? `<div class="card" style="border-left: 3px solid var(--warning); cursor: pointer;" onclick="location.hash='#/approvals'">
      <span style="font-weight: 600;">You have ${pending} pending approval${pending > 1 ? 's' : ''}</span>
      <span style="color: var(--text-muted); font-size: 0.85rem;"> — your twin wants to do something and needs your OK.</span>
    </div>` : ''}

    ${renderUnmetCredentials(unmetCreds)}

    ${prog ? renderTrustProgress({ approvalCount: prog.approvalCount, currentTier: prog.currentTier }) : ''}

    ${learnedData && learnedData.summaries && learnedData.summaries.length >= 2 ? `
      <div class="card">
        <div class="card-header">
          <span class="card-title">What I've learned so far</span>
        </div>
        ${learnedData.summaries.slice(0, 5).map(s => `
          <div class="insight-card">
            <div class="insight-icon" style="background: var(--accent-soft, #e3f2fd); color: var(--accent, #1976d2);">
              ${domainIcon(s.domain)}
            </div>
            <div class="insight-content">
              <div class="insight-title">${domainLabel(s.domain)}</div>
              <div class="insight-desc">${s.description}</div>
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${showEmptyPreview ? renderEmptyDashboardPreview({ googleConnected }) : `
      <div class="stats-grid">
        <div class="card stat-card" title="How much of your routine, preferences, and style your twin understands. Grows as you use SkyTwin and give feedback.">
          <div class="stat-value">${overallConf}%</div>
          <div class="stat-label">How well I know you</div>
          <div class="stat-sublabel">${overallConf === 0 ? 'Just getting started' : confLabel}</div>
          <div class="confidence-bar"><div class="confidence-fill ${confClass}" style="width: ${overallConf}%"></div></div>
        </div>
        <div class="card stat-card" title="How often your twin picks the right action. Based on your approvals and rejections.">
          <div class="stat-value">${acc ? (acc.totalDecisions === 0 ? '--' : `${Math.round(acc.accuracyRate * 100)}%`) : '--'}</div>
          <div class="stat-label">Getting it right</div>
          <div class="stat-sublabel">${acc
            ? (acc.totalDecisions === 0 ? 'Approve or reject decisions to train me' : `You approved ${acc.approved} of ${acc.totalDecisions}`)
            : 'Approve or reject decisions to train me'}</div>
        </div>
        <div class="card stat-card" title="Preferences and facts your twin has learned about you, from your feedback and behavior patterns.">
          <div class="stat-value">${learn?.totalPreferences ?? 0}</div>
          <div class="stat-label">Things I've learned</div>
          <div class="stat-sublabel">${(learn?.totalPreferences ?? 0) === 0 ? 'Your preferences will appear here' : `${learn?.totalInferences ?? 0} figured out on my own`}</div>
        </div>
        <div class="card stat-card" title="Recurring patterns your twin has detected in your behavior, like when you check email or how you respond to invites.">
          <div class="stat-value">${learn?.totalPatterns ?? 0}</div>
          <div class="stat-label">Habits I've noticed</div>
          <div class="stat-sublabel">${(learn?.totalPatterns ?? 0) === 0 ? 'I\'ll spot your patterns over time' : `${learn?.totalTraits ?? 0} personality traits`}</div>
        </div>
      </div>
    `}

    ${conf?.domains && Object.keys(conf.domains).length > 0 ? `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Confidence by area</span>
        </div>
        ${Object.entries(conf.domains).map(([domain, pct]) => {
          const cls = pct >= 75 ? 'high' : pct >= 50 ? 'moderate' : pct >= 25 ? 'low' : 'speculative';
          return `
            <div style="margin-bottom: 0.75rem;">
              <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
                <span>${domainLabel(domain)}</span>
                <span style="color: var(--text-muted);">${pct}%</span>
              </div>
              <div class="confidence-bar"><div class="confidence-fill ${cls}" style="width: ${pct}%"></div></div>
            </div>
          `;
        }).join('')}
      </div>
    ` : ''}

    ${learn?.traits && learn.traits.length > 0 ? `
      <div class="card">
        <div class="card-header">
          <span class="card-title">What I've noticed about you</span>
        </div>
        ${learn.traits.map(t => `
          <div class="insight-card">
            <div class="insight-icon" style="background: var(--accent-soft); color: var(--accent);">
              ${traitIcon(t.name)}
            </div>
            <div class="insight-content">
              <div class="insight-title">${traitLabel(t.name)}</div>
              <div class="insight-desc">${t.description}</div>
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${renderSkillGaps(skillGaps)}

    ${showEmptyPreview ? '' : `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Recent activity</span>
      </div>
      ${recentDecisions.length > 0
        ? recentDecisions.map(d => `
          <div class="activity-item">
            <span class="activity-time">${formatTime(d.createdAt || d.created_at)}</span>
            <span class="activity-desc">${escapeHtml(domainLabel(d.domain))} — ${escapeHtml(d.situationType || d.situation_type || '')}</span>
            <span class="badge badge-info">${escapeHtml(d.domain)}</span>
          </div>
        `).join('')
        : `<div class="empty-state">
            <div class="empty-state-title">${googleConnected ? 'Watching for the first signal' : 'Nothing to act on yet'}</div>
            <div class="empty-state-desc">
              ${googleConnected
                ? 'I\'m connected and listening. As soon as a signal lands — a new email, an invite, a renewal — you\'ll see what I made of it right here.'
                : 'Once your accounts are connected and a signal comes in, I\'ll show you what I did and why, here.'}
            </div>
          </div>`
      }
    </div>
    `}
  `;

  // First-decision celebration: a one-time "look — your twin just acted!"
  // moment, fired the first time decisions transition from 0 to >0 for this
  // browser. Skipped in tour mode (Alex already has plenty of decisions
  // from the seed). Skipped if the user has dismissed via localStorage.
  try {
    const seenKey = `skytwin_first_decision_seen_${userId}`;
    if (
      !tourMode
      && recentDecisions.length > 0
      && !localStorage.getItem(seenKey)
      && typeof window !== 'undefined'
    ) {
      localStorage.setItem(seenKey, '1');
      // Lazy-import the toast helper from sse-client so we don't pull it
      // into the dashboard's hot path on every render.
      import('../sse-client.js').then(({ showToast }) => {
        showToast('Your twin just made its first call', 'Scroll down to see what it noticed and why.', 'success');
      }).catch(() => { /* noop */ });
    }
  } catch { /* localStorage unavailable */ }

  // Trust-tier threshold celebration: when the approval count just crossed
  // the threshold to unlock the next tier, fire a one-time toast so the
  // moment lands. The progress bar already shows "Ready to level up!" but
  // a returning user might miss that — the toast catches their eye.
  try {
    const TIER_THRESHOLDS = { observer: 10, suggest: 20, low_autonomy: 50, moderate_autonomy: 100 };
    const TIER_NEXT = { observer: 'Ask me first', suggest: 'Handle small stuff', low_autonomy: 'Handle most things', moderate_autonomy: 'Full autopilot' };
    const tier = prog?.currentTier;
    const count = prog?.approvalCount ?? 0;
    const threshold = tier ? TIER_THRESHOLDS[tier] : null;
    if (
      !tourMode
      && tier
      && threshold
      && count >= threshold
      && typeof window !== 'undefined'
    ) {
      const tierKey = `skytwin_tier_celebrated_${userId}_${tier}`;
      if (!localStorage.getItem(tierKey)) {
        localStorage.setItem(tierKey, '1');
        import('../sse-client.js').then(({ showToast }) => {
          showToast(
            'You\'ve unlocked the next trust level',
            `Bump to "${TIER_NEXT[tier]}" in Settings whenever you're ready — I'll start handling more on my own.`,
            'success',
          );
        }).catch(() => { /* noop */ });
      }
    }
  } catch { /* localStorage unavailable */ }

  // While we're in the post-OAuth first-scan window, gently auto-refresh
  // so the user sees their first decisions land without hitting reload.
  // We stop as soon as decisions show up (the celebration card flips state)
  // or after a few minutes, whichever comes first.
  if (inFirstScanWindow) {
    if (window._skytwinFirstScanTimer) clearTimeout(window._skytwinFirstScanTimer);
    if (!window._skytwinFirstScanStartedAt) window._skytwinFirstScanStartedAt = Date.now();
    const elapsed = Date.now() - window._skytwinFirstScanStartedAt;
    if (elapsed < 5 * 60 * 1000) {
      window._skytwinFirstScanTimer = setTimeout(() => {
        // Only re-render if user is still on the dashboard.
        const currentHash = (window.location.hash || '').split('?')[0] || '#/';
        if (currentHash === '#/' || currentHash === '#') {
          renderDashboard(container, userId).catch(() => { /* swallow — next tick will retry */ });
        }
      }, 4000);
    }
  } else if (window._skytwinFirstScanTimer) {
    clearTimeout(window._skytwinFirstScanTimer);
    window._skytwinFirstScanTimer = null;
    window._skytwinFirstScanStartedAt = null;
  }
}

function domainIcon(domain) {
  const icons = { email: 'E', calendar: 'C', finance: '$', shopping: 'S', travel: 'T', subscriptions: 'R', general: 'G' };
  return icons[domain] || '?';
}

function domainLabel(domain) {
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

function traitLabel(name) {
  const labels = {
    cautious_spender: 'You\'re careful with spending',
    quick_responder: 'You respond quickly',
    privacy_conscious: 'You value privacy',
    routine_driven: 'You like routines',
    delegation_averse: 'You prefer doing things yourself',
  };
  return labels[name] || name.replace(/_/g, ' ');
}

function traitIcon(name) {
  const icons = {
    cautious_spender: '$',
    quick_responder: '!',
    privacy_conscious: '?',
    routine_driven: '~',
    delegation_averse: '*',
  };
  return icons[name] || '?';
}

function renderSinceLastVisit({ newDecisions, ago }) {
  return `
    <div class="card" style="border-left: 3px solid var(--success); cursor: pointer;" onclick="location.hash='#/decisions'">
      <span style="font-weight: 600;">While you were away —</span>
      <span style="color: var(--text-muted); font-size: 0.9rem;">
        I handled or weighed in on <strong>${newDecisions}</strong> new ${newDecisions === 1 ? 'thing' : 'things'} since you last checked in (${escapeHtml(ago)}). Click to see what.
      </span>
    </div>
  `;
}

function renderEmptyDashboardPreview({ googleConnected }) {
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

function renderAskTwinWidget({ userId, tourMode }) {
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
          onkeydown="if(event.key==='Enter' && !event.shiftKey) { event.preventDefault(); window.handleAskTwin('${escapeHtml(userId)}'); }"
        ></textarea>
        <button class="btn btn-primary" onclick="window.handleAskTwin('${escapeHtml(userId)}')" id="ask-twin-btn" style="align-self: stretch;">
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

if (typeof window !== 'undefined') {
  // Wire example chips once per render; delegated so re-render rebinds.
  document.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('.ask-twin-example');
    if (!btn) return;
    const wrap = btn.closest('#ask-twin-examples');
    const uid = wrap?.getAttribute('data-user-id');
    const prompt = btn.getAttribute('data-prompt');
    const input = document.getElementById('ask-twin-input');
    if (!input || !uid || !prompt) return;
    input.value = prompt;
    window.handleAskTwin?.(uid);
  });
}

if (typeof window !== 'undefined') {
  window.handleAskTwin = async function(userId) {
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
  };
}

function renderAskResult(r) {
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

function renderTourBanner() {
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
        <button class="btn btn-primary btn-sm" onclick="window.skyTwinExitTour()">Start my own setup</button>
        <a class="btn btn-outline btn-sm" href="#/decisions">See what Alex's twin has been doing</a>
        <a class="btn btn-outline btn-sm" href="#/twin">See what it learned about Alex</a>
      </div>
    </div>
  `;
}

if (typeof window !== 'undefined') {
  window.skyTwinExitTour = function() {
    try {
      localStorage.removeItem('skytwin_tour_mode');
      localStorage.removeItem('skytwin_userId');
      localStorage.removeItem('skytwin_onboarded');
    } catch { /* noop */ }
    window.location.reload();
  };
}

function renderJustConnectedCelebration({ justConnectedProvider, justConnectedAccount, recentDecisionsCount, learnedCount }) {
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
          <span class="loading-dot" style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--success); animation: pulse 1.4s ease-in-out infinite;"></span>
          Watching your inbox and calendar…
        </div>
        <style>@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }</style>
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

function renderConnectGoogleHero({ googleConnected, googleSystemConfigured, userId }) {
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
        <button class="btn btn-primary" onclick="window.handleConnectGoogleFromDashboard('${safeUserId}')">Connect Google</button>
        <a class="btn btn-outline" href="#/settings">Manage connections</a>
      </div>
    </div>
  `;
}

if (typeof window !== 'undefined') {
  window.handleConnectGoogleFromDashboard = async function(userId) {
    try {
      const { getGoogleAuthUrl } = await import('../api-client.js');
      const data = await getGoogleAuthUrl(userId);
      if (data?.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      console.error('Could not start Google connect flow:', err);
      window.location.hash = '#/settings';
    }
  };
}

function renderUnmetCredentials(unmetCredsResult) {
  const unmet = unmetCredsResult.status === 'fulfilled' ? (unmetCredsResult.value.unmet ?? []) : [];
  if (unmet.length === 0) return '';

  return `
    <div class="card" style="border-left: 3px solid var(--warning, #e6a700); cursor: pointer;" onclick="location.hash='#/setup'">
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

function renderSkillGaps(skillGapsResult) {
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

function formatTime(dateStr) {
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
