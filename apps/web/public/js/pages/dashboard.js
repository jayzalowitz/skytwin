import { fetchHealth, fetchDecisions, fetchAccuracy, fetchConfidence, fetchLearning, fetchPendingApprovals, fetchSkillGaps, fetchTrustProgress, fetchLearned, fetchUnmetCredentials, fetchOAuthStatus, fetchCredentialsStatus, fetchBriefing, askTwin, escapeHtml } from '../api-client.js';
import { renderTrustProgress } from '../components/progress-bar.js';
import {
  KEY_USER_ID,
  KEY_ONBOARDED,
  KEY_TOUR_MODE,
  KEY_NOTIF_DISMISSED,
  KEY_NOTIF_ASKED,
  lastVisitKey,
  firstDecisionSeenKey,
  tierCelebratedKey,
  clearKeysForSuffix,
} from '../storage-keys.js';

// ── Time / behavior constants ──────────────────────────────────────────
// Centralized so the policy is visible at a glance and not scattered.

/** A briefing older than this is considered stale and the card hides. */
const BRIEFING_FRESH_MS = 36 * 60 * 60 * 1000;

/** Don't show "while you were away" if the gap is shorter than this — it'd be noise. */
const SINCE_LAST_VISIT_MIN_MS = 5 * 60 * 1000;

/** Auto-refresh cadence during the post-OAuth first-scan window. */
const FIRST_SCAN_POLL_MS = 4000;

/** After this much time we stop the first-scan auto-refresh; first decisions
 *  always show up on next normal render anyway. */
const FIRST_SCAN_MAX_MS = 5 * 60 * 1000;

/** Display labels for "Bump to ..." copy. The thresholds themselves come
 *  from the server (`/api/twin/:userId/progress`) which now reads them
 *  from `@skytwin/shared-types` PROMOTION_THRESHOLDS — the single source
 *  of truth shared with the policy engine.
 *
 *  We deliberately do NOT define a moderate_autonomy entry: promotion to
 *  HIGH_AUTONOMY is explicit user opt-in (not threshold-driven), so the
 *  celebration toast must never fire from moderate. The progress-bar
 *  component already handles "Maximum trust" rendering for that case. */
const TIER_LABEL = {
  observer: 'Ask me first',
  suggest: 'Handle small stuff',
  low_autonomy: 'Handle most things',
};

/** TTL for slow-changing dashboard data — 30s is short enough that the
 *  next paint after a meaningful state change still picks it up via a
 *  bypass of `slowFetch` (e.g. SSE sse:credential:needed re-renders), and
 *  long enough that the 13-fetch fan-out doesn't hammer the API on every
 *  re-render during the first-scan window. */
const SLOW_CACHE_TTL_MS = 30 * 1000;

// Module-level cache for slow-changing fetches: oauth status, creds
// status, skill gaps, learned, unmet creds. Each entry is keyed by a
// short string and stores `{ value, expiresAt, generation }`. Invalidated on:
//   - SSE 'twin:updated' (clears 'learned-…')
//   - SSE 'credential:needed' (clears 'creds-status')
//   - explicit invalidateDashboardCache() from app.js
//
// Generation counter prevents stale-resurrection: when invalidate runs
// during an in-flight fetch, we bump the generation. The fetch's
// then-handler will only write back if the entry's generation still
// matches the one captured at request time.
const _slowCache = new Map();
let _cacheGeneration = 0;

/**
 * Wrap a fetch function so its result is memoized for SLOW_CACHE_TTL_MS.
 * The cache key combines the supplied id with the function's name, so
 * `slowFetch('oauth-google', fetchOAuthStatus, [userId, 'google'])` and
 * `slowFetch('oauth-google', fetchOAuthStatus, [otherUid, 'google'])`
 * are distinct entries.
 */
function slowFetch(key, fn, args) {
  const now = Date.now();
  const hit = _slowCache.get(key);
  if (hit && hit.expiresAt > now) {
    return Promise.resolve(hit.value);
  }
  // Capture the generation at request time. The then-handler will only
  // write its result back if the cache hasn't been invalidated since.
  const requestGeneration = _cacheGeneration;
  // Cache the in-flight promise too so concurrent renders don't
  // duplicate the fetch.
  const promise = Promise.resolve(fn(...args)).then(
    (value) => {
      // Only commit the resolved value if this entry hasn't been
      // invalidated (or replaced by a newer fetch) while in flight.
      const current = _slowCache.get(key);
      if (current && current.generation === requestGeneration) {
        _slowCache.set(key, { value, expiresAt: Date.now() + SLOW_CACHE_TTL_MS, generation: requestGeneration });
      }
      return value;
    },
    (err) => {
      // Don't cache failures — a transient error shouldn't suppress the
      // value for 30s. Only clear if WE are still the in-flight entry;
      // a more recent fetch's entry shouldn't be killed by our failure.
      const current = _slowCache.get(key);
      if (current && current.generation === requestGeneration) {
        _slowCache.delete(key);
      }
      throw err;
    },
  );
  _slowCache.set(key, { value: promise, expiresAt: now + SLOW_CACHE_TTL_MS, generation: requestGeneration });
  return promise;
}

/**
 * Invalidate the slow-fetch cache. `keyPrefix` lets callers drop only a
 * subset (e.g. 'creds-status' when an SSE credential:needed event arrives).
 * No arg = drop everything. Bumps the generation counter so any in-flight
 * fetch that resolves after this call can't write its old value back.
 */
export function invalidateDashboardCache(keyPrefix) {
  _cacheGeneration++;
  if (!keyPrefix) {
    _slowCache.clear();
    return;
  }
  for (const k of _slowCache.keys()) {
    if (k.startsWith(keyPrefix)) _slowCache.delete(k);
  }
}

export async function renderDashboard(container, userId) {
  // Fast-changing data — refetched on every render because SSE updates
  // and user action move them around constantly.
  // Slow-changing data — wrapped in slowFetch so a 4s first-scan tick or
  // a debounced SSE re-render doesn't burn 13 round-trips per cycle.
  const [health, accuracy, confidence, learning, approvals, decisions, skillGaps, progress, learned, unmetCreds, googleOAuth, credsStatus, briefingData] = await Promise.allSettled([
    fetchHealth(),
    fetchAccuracy(userId),
    fetchConfidence(userId),
    fetchLearning(userId),
    fetchPendingApprovals(userId),
    fetchDecisions(userId, { limit: 10 }),
    slowFetch(`skill-gaps-${userId}`, fetchSkillGaps, [userId]),
    fetchTrustProgress(userId),
    slowFetch(`learned-${userId}`, fetchLearned, [userId]),
    slowFetch('unmet-creds', fetchUnmetCredentials, []),
    slowFetch(`oauth-google-${userId}`, fetchOAuthStatus, [userId, 'google']),
    slowFetch('creds-status', fetchCredentialsStatus, []),
    fetchBriefing(userId),
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

  // Briefing: only worth showing when there are items AND the briefing
  // is recent (< 36 hours old, so a briefing from yesterday morning still
  // surfaces but a stale one from last week doesn't).
  const briefing = briefingData.status === 'fulfilled' ? briefingData.value?.briefing : null;
  const briefingItems = Array.isArray(briefing?.items) ? briefing.items : [];
  const briefingFreshEnough = (() => {
    if (!briefing?.createdAt) return false;
    const t = Date.parse(briefing.createdAt);
    if (!Number.isFinite(t)) return false;
    return (Date.now() - t) < BRIEFING_FRESH_MS;
  })();
  const showBriefing = briefingItems.length > 0 && briefingFreshEnough;

  // Read post-OAuth query so we can celebrate the moment they connect.
  // App.js strips the query before routing; we re-parse it from the raw hash.
  const hashRaw = window.location.hash || '';
  const queryStart = hashRaw.indexOf('?');
  const hashParams = queryStart >= 0 ? new URLSearchParams(hashRaw.slice(queryStart + 1)) : new URLSearchParams();
  const justConnectedProvider = hashParams.get('connected');
  const justConnectedAccount = hashParams.get('account');

  // Strip the connected=…&account=… query from the hash after we've read it
  // so the celebration card doesn't reappear on tomorrow's reload, and the
  // (now consumed) account email stops persisting in browser history.
  if (justConnectedProvider && typeof history?.replaceState === 'function') {
    try { history.replaceState({}, '', window.location.pathname + '#/'); } catch { /* noop */ }
  }

  // After the first signals show up, the celebration card naturally falls
  // away. While we're still in the "first scan" window (just connected, no
  // decisions yet) we poll every 4s so the user sees the dashboard come
  // alive without needing to refresh.
  const inFirstScanWindow = !!justConnectedProvider && googleConnected && recentDecisions.length === 0;

  const overallConf = conf?.overallConfidence ?? 0;
  const confLabel = overallConf >= 75 ? 'Very confident' : overallConf >= 50 ? 'Getting there' : overallConf >= 25 ? 'Still learning' : 'Just started';
  const confClass = overallConf >= 75 ? 'high' : overallConf >= 50 ? 'moderate' : overallConf >= 25 ? 'low' : 'speculative';

  const tourMode = (() => { try { return localStorage.getItem(KEY_TOUR_MODE) === '1'; } catch { return false; } })();

  // "While you were away" — count anything new since the last visit so the
  // user feels like the twin has been working for them, not just sitting
  // there. The baseline is only updated when the user actually leaves
  // the tab (visibilitychange → hidden) so SSE re-renders don't clobber
  // it; otherwise the second render of any session would always set
  // (now - lastVisitMs) ~= 0 and the banner would never fire again.
  const sinceLastVisit = (() => {
    try {
      const key = lastVisitKey(userId);
      const lastVisitMs = parseInt(localStorage.getItem(key) || '0', 10);
      const now = Date.now();
      if (!lastVisitMs || (now - lastVisitMs) < SINCE_LAST_VISIT_MIN_MS) return null;
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

  // Wire the once-per-tab baseline updater. We register on every render
  // but the listener is idempotent (window-level event with a flag).
  if (typeof window !== 'undefined' && !window._skytwinLastVisitWired) {
    window._skytwinLastVisitWired = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      const uid = (() => { try { return localStorage.getItem(KEY_USER_ID); } catch { return null; } })();
      if (!uid) return;
      try { localStorage.setItem(lastVisitKey(uid), String(Date.now())); } catch { /* private mode */ }
    });
    window.addEventListener('beforeunload', () => {
      const uid = (() => { try { return localStorage.getItem(KEY_USER_ID); } catch { return null; } })();
      if (!uid) return;
      try { localStorage.setItem(lastVisitKey(uid), String(Date.now())); } catch { /* noop */ }
    });
  }

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
    ${showBriefing ? renderBriefingCard({ items: briefingItems, createdAt: briefing.createdAt }) : ''}
    ${pending > 0 ? `<div class="card" style="border-left: 3px solid var(--warning); cursor: pointer;" onclick="location.hash='#/approvals'">
      <span style="font-weight: 600;">You have ${pending} pending approval${pending > 1 ? 's' : ''}</span>
      <span style="color: var(--text-muted); font-size: 0.85rem;"> — your twin wants to do something and needs your OK.</span>
    </div>` : ''}
    ${pending > 0 ? renderNotificationOptIn() : ''}

    ${renderUnmetCredentials(unmetCreds)}

    ${prog ? renderTrustProgress(prog) : ''}

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
        ? recentDecisions.map(d => {
          const auto = d.autoExecuted === true;
          const pending = d.autoExecuted == null;
          const verb = auto ? 'I handled' : pending ? 'I noticed' : 'You OK\'d';
          const verbColor = auto ? 'var(--success)' : pending ? 'var(--text-muted)' : 'var(--accent, #1976d2)';
          const situation = situationLabel(d.situationType || d.situation_type);
          const dom = escapeHtml(domainLabel(d.domain));
          return `
            <div class="activity-item">
              <span class="activity-time">${formatTime(d.createdAt || d.created_at)}</span>
              <span class="activity-desc">
                <span style="color: ${verbColor}; font-weight: 600;">${verb}</span>
                <span style="color: var(--text-muted);">·</span>
                ${escapeHtml(situation)}
                <span style="color: var(--text-muted); font-size: 0.85em;">in ${dom}</span>
              </span>
            </div>
          `;
        }).join('')
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
    const seenKey = firstDecisionSeenKey(userId);
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

  // Trust-tier threshold celebration: fire a one-time toast only when
  // the policy engine would actually promote — i.e., consecutive
  // approvals AND approval ratio both meet the server-side gates. The
  // server returns these directly so we don't reimplement promotion
  // logic on the client (the source of the prior moderate_autonomy:100
  // drift bug). nextTierThreshold is null at the practical max
  // (MODERATE_AUTONOMY needs explicit opt-in for HIGH_AUTONOMY), so
  // moderate users will never see this toast — only the "Maximum
  // trust" panel from the progress bar.
  try {
    const tier = prog?.currentTier;
    const consecutive = prog?.consecutiveApprovals ?? prog?.approvalCount ?? 0;
    const threshold = prog?.nextTierThreshold ?? null;
    const ratio = prog?.approvalRatio ?? 0;
    const ratioGate = prog?.minApprovalRatio ?? 0;
    const nextTierName = prog?.nextTier;
    const eligible = tier
      && threshold
      && consecutive >= threshold
      && ratio >= ratioGate
      && nextTierName;
    if (
      !tourMode
      && eligible
      && typeof window !== 'undefined'
    ) {
      const tierKey = tierCelebratedKey(userId, tier);
      if (!localStorage.getItem(tierKey)) {
        localStorage.setItem(tierKey, '1');
        const label = TIER_LABEL[tier] ?? 'the next level';
        import('../sse-client.js').then(({ showToast }) => {
          showToast(
            'You\'ve unlocked the next trust level',
            `Bump to "${label}" in Settings whenever you're ready — I'll start handling more on my own.`,
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
    if (elapsed < FIRST_SCAN_MAX_MS) {
      window._skytwinFirstScanTimer = setTimeout(() => {
        // Only re-render if user is still on the dashboard.
        const currentHash = (window.location.hash || '').split('?')[0] || '#/';
        if (currentHash === '#/' || currentHash === '#') {
          renderDashboard(container, userId).catch(() => { /* swallow — next tick will retry */ });
        }
      }, FIRST_SCAN_POLL_MS);
    }
  } else if (window._skytwinFirstScanTimer) {
    clearTimeout(window._skytwinFirstScanTimer);
    window._skytwinFirstScanTimer = null;
    window._skytwinFirstScanStartedAt = null;
  }
}

function situationLabel(type) {
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

function renderNotificationOptIn() {
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
        <button class="btn btn-primary btn-sm" onclick="window.handleEnableNotifications()">Yes, ping me</button>
        <button class="btn btn-outline btn-sm" onclick="window.dismissNotifOptIn()">Maybe later</button>
      </div>
    </div>
  `;
}

async function handleEnableNotifications() {
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

function dismissNotifOptIn() {
  try { localStorage.setItem(KEY_NOTIF_DISMISSED, '1'); } catch { /* noop */ }
  document.getElementById('notif-opt-in')?.remove();
}

function renderBriefingCard({ items, createdAt }) {
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

function renderBriefingItem(it) {
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

async function handleAskTwin(userId) {
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

function skyTwinExitTour() {
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

async function handleConnectGoogleFromDashboard(userId) {
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

  window.handleEnableNotifications = handleEnableNotifications;
  window.dismissNotifOptIn = dismissNotifOptIn;
  window.handleAskTwin = handleAskTwin;
  window.skyTwinExitTour = skyTwinExitTour;
  window.handleConnectGoogleFromDashboard = handleConnectGoogleFromDashboard;

  // Delegated click on the Ask Your Twin example chips. Lives on
  // document so the dashboard can re-render without rebinding.
  document.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('.ask-twin-example');
    if (!btn) return;
    const wrap = btn.closest('#ask-twin-examples');
    const uid = wrap?.getAttribute('data-user-id');
    const prompt = btn.getAttribute('data-prompt');
    const input = document.getElementById('ask-twin-input');
    if (!input || !uid || !prompt) return;
    input.value = prompt;
    handleAskTwin(uid);
  });
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
