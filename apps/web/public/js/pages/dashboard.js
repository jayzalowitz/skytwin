import { fetchHealth, fetchDecisions, fetchAccuracy, fetchConfidence, fetchLearning, fetchPendingApprovals, fetchSkillGaps, fetchTrustProgress, fetchLearned, fetchUnmetCredentials, fetchOAuthStatus, fetchCredentialsStatus, fetchBriefing, fetchLatestTwinBriefing, fetchLifebooks, fetchSettings, escapeHtml } from '../api-client.js';
import { renderTrustProgress } from '../components/progress-bar.js';
import { renderTierLadderIntro } from '../components/tier-ladder-intro.js';
import {
  KEY_USER_ID,
  KEY_TOUR_MODE,
  lastVisitKey,
  firstDecisionSeenKey,
  tierCelebratedKey,
} from '../storage-keys.js';

// View layer — pure render helpers + global handlers (handleAskTwin etc).
// Split out so this file can stay focused on data flow and lifecycle.
// `initDashboardGlobals` is re-exported below so app.js's existing import
// `import { ... initDashboardGlobals ... } from './pages/dashboard.js'`
// keeps working without a churn-PR through the bootstrap.
import {
  // Renderers used inside renderDashboard's HTML template.
  renderNotificationOptIn,
  renderBriefingCard,
  renderSinceLastVisit,
  renderEmptyDashboardPreview,
  renderAskTwinWidget,
  renderTourBanner,
  renderJustConnectedCelebration,
  renderConnectGoogleHero,
  renderConnectGmailHero,
  renderUnmetCredentials,
  renderSkillGaps,
  // Label helpers used inside the recent-activity / learnings templates.
  situationLabel,
  domainLabel,
  domainIcon,
  traitLabel,
  traitIcon,
  formatTime,
} from './dashboard-view.js';

export { initDashboardGlobals } from './dashboard-view.js';

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

// Short-TTL cache for the first-run brain-prompt settings lookup.
// Separate from _slowCache because we want a much shorter TTL (the
// user enabling a provider should make the prompt vanish near-instant)
// without changing the 30s default that other consumers rely on.
const BRAIN_PROMPT_TTL_MS = 5000;
let _settingsCache = null;
async function getCachedSettings(userId) {
  const now = Date.now();
  if (_settingsCache
      && _settingsCache.userId === userId
      && _settingsCache.expiresAt > now) {
    return _settingsCache.value;
  }
  const value = await fetchSettings(userId);
  _settingsCache = { userId, value, expiresAt: now + BRAIN_PROMPT_TTL_MS };
  return value;
}

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

// Source-type → short label (mirror of the briefing page's SOURCE_LABELS).
const DASH_SOURCE_LABELS = {
  email: 'email', gmail: 'email', calendar: 'calendar', google_calendar: 'calendar',
  filesystem: 'file', file: 'file', voice: 'voice', app: 'app',
};

/**
 * Home digest hero (spec 01/08) — the to-do/FYI parity surface, the most
 * important thing on the page (DESIGN.md: action zone first). This is a
 * READ-ONLY, compact render: the fully interactive digest (snooze, power view,
 * citations) lives on #/briefing, whose click handlers are hash-gated to that
 * route, so Home links out to it rather than duplicating dead buttons.
 *
 * @param {object} s - the `structured` digest payload { todos, topics, handledCount }
 * @param {object} briefing - the briefing envelope (for read state)
 */
function renderDashboardDigest(s, briefing) {
  const todos = Array.isArray(s.todos) ? s.todos : [];
  const topicCount = (Array.isArray(s.topics) ? s.topics : [])
    .reduce((n, g) => n + (Array.isArray(g.items) ? g.items.length : 0), 0);
  const handled = typeof s.handledCount === 'number' ? s.handledCount : null;
  const need = todos.length;
  const isUnread = !briefing.read_at;

  const provDot = (detail) => {
    const you = detail && /from you/i.test(detail.provenanceLabel || '');
    return `<span class="digest-prov ${you ? 'you' : 'inbound'}" title="${you ? 'from you' : 'inbound'}"></span>`;
  };
  const sourceChip = (st) => {
    const label = DASH_SOURCE_LABELS[st];
    return label ? `<span class="digest-source">${escapeHtml(label)}</span>` : '';
  };

  const todoRows = todos.map((t) => `
    <li class="digest-todo">
      ${provDot(t.detail)}
      <div class="digest-todo-body">
        <div>
          <span class="digest-todo-text">${escapeHtml(t.text || '')}</span>
          ${t.deadline ? `<span class="digest-deadline">${escapeHtml(String(t.deadline))}</span>` : ''}
          ${sourceChip(t.sourceType)}
        </div>
        ${t.body ? `<div class="digest-body">${escapeHtml(t.body)}</div>` : ''}
        ${t.detail?.suggestedAction ? `<div class="digest-suggested">→ ${escapeHtml(t.detail.suggestedAction)}</div>` : ''}
      </div>
    </li>`).join('');

  const voice = need === 0
    ? "You're all caught up."
    : need === 1 ? 'One thing needs you.' : `${need} things need you.`;

  return `
    <div class="card" style="border-left: 3px solid var(--accent);">
      <div class="card-header">
        <span class="card-title">
          Your briefing
          ${isUnread ? '<span class="badge badge-info" style="margin-left:0.35rem; font-size:0.7rem;">New</span>' : ''}
        </span>
        <a href="#/briefing" style="font-size: 0.78rem; color: var(--text-muted);">Open →</a>
      </div>
      <p class="digest-voice" style="font-size: 1.25rem; margin: 0.2rem 0 0.5rem;">${voice}</p>
      <p class="digest-value">
        ${handled !== null ? `<span class="done">✓ ${handled} handled on my own</span><span class="sep"></span>` : ''}
        <span><b>${need}</b> need you</span><span class="sep"></span>
        <span><b>${topicCount}</b> to catch up on</span>
      </p>
      ${need ? `<div class="digest-heading">To-dos <span class="count">· ${need}</span></div>
        <ul class="digest-todos">${todoRows}</ul>` : ''}
      <a href="#/briefing" class="btn btn-outline btn-sm" style="font-size: 0.8rem; margin-top: 0.75rem;">
        Read full briefing →
      </a>
    </div>`;
}

/**
 * Twin Briefing widget for the dashboard (issue #177).
 *
 * Prefers the structured digest (spec 01/08) — the to-do/FYI parity surface —
 * and falls back to the prose headline for legacy briefings that only carry
 * prose. Returns '' when there is neither (new user; connect heroes show).
 *
 * @param {object|null} briefing - TwinBriefingRow from /api/twin-briefings/latest
 */
function renderTwinBriefingWidget(briefing) {
  if (!briefing) return '';

  // Structured digest takes priority — it is the product's primary surface.
  const s = briefing.structured;
  if (s && ((Array.isArray(s.todos) && s.todos.length) || (Array.isArray(s.topics) && s.topics.length))) {
    return renderDashboardDigest(s, briefing);
  }

  if (!briefing.prose_markdown) return '';

  // Extract the first non-empty, non-heading paragraph as the headline.
  const lines = briefing.prose_markdown.split('\n');
  let headline = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      headline = trimmed;
      break;
    }
  }
  if (!headline) return '';

  // Truncate to avoid a wall-of-text on the dashboard
  const headlineDisplay = headline.length > 180
    ? headline.slice(0, 177) + '…'
    : headline;

  const generated = briefing.generated_at ? new Date(briefing.generated_at) : null;
  const ageStr = generated ? formatDashboardTime(generated) : '';
  const isUnread = !briefing.read_at;

  return `
    <div class="card" style="border-left: 3px solid var(--accent);">
      <div class="card-header">
        <span class="card-title">
          Twin Briefing
          ${isUnread ? '<span class="badge badge-info" style="margin-left: 0.35rem; font-size: 0.7rem;">New</span>' : ''}
        </span>
        ${ageStr ? `<span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(ageStr)}</span>` : ''}
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.5rem; line-height: 1.6;">
        ${escapeHtml(headlineDisplay)}
      </div>
      <a href="#/briefing" class="btn btn-outline btn-sm" style="font-size: 0.8rem;">
        Read full briefing →
      </a>
    </div>
  `;
}

/**
 * "Your Lifebooks" card (#193 Child 1). Surfaces up to 5 detected
 * domains with importance badges. Empty list → no card (silent — most
 * users won't have run extraction yet, and a "no lifebooks detected"
 * placeholder would confuse rather than inform).
 */
function renderLifebooksCard(lifebooks) {
  if (!Array.isArray(lifebooks) || lifebooks.length === 0) return '';

  const importanceColor = (imp) => {
    if (imp === 'core') return 'var(--success)';
    if (imp === 'secondary') return 'var(--text)';
    return 'var(--text-muted)';
  };
  const importanceLabel = (imp) => {
    if (imp === 'core') return 'Core';
    if (imp === 'secondary') return 'Secondary';
    return 'Emerging';
  };

  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Your Lifebooks</span>
        <span style="font-size: 0.75rem; color: var(--text-muted);">${lifebooks.length} detected</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        Life domains your twin noticed in your memory. Each is a wing in your memory palace.
      </div>
      <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        ${lifebooks.map((lb) => `
          <a href="#/lifebook/${encodeURIComponent(lb.domainName)}"
             style="display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.75rem; background: var(--bg); border-radius: var(--radius-sm); text-decoration: none; color: inherit;">
            <span style="font-weight: 500;">${escapeHtml(lb.domainName)}</span>
            <span style="display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; color: ${importanceColor(lb.importance)}; border: 1px solid ${importanceColor(lb.importance)};">${escapeHtml(importanceLabel(lb.importance))}</span>
          </a>
        `).join('')}
      </div>
    </div>
  `;
}

function renderBrainPrompt() {
  return `
    <div class="card" style="border-left: 3px solid var(--accent);">
      <div class="card-header">
        <span class="card-title">Your twin needs a brain to start</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem; line-height: 1.5;">
        Pick how your twin thinks. Either path takes about 5 minutes from Settings.
      </div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem;">
        <a href="#/settings" class="btn btn-primary btn-sm">Set up the local brain</a>
        <a href="#/settings" class="btn btn-outline btn-sm">Or bring your own API key</a>
      </div>
      <div style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.5;">
        <strong>Local brain</strong> — runs on your machine, no API keys, no per-message cost, your data never leaves the device.<br>
        <strong>API key</strong> — uses Anthropic / OpenAI / Google. Faster on a small laptop, but each message goes to that provider.
      </div>
    </div>
  `;
}

function formatDashboardTime(d) {
  if (!d) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

export async function renderDashboard(container, userId) {
  // Fast-changing data — refetched on every render because SSE updates
  // and user action move them around constantly.
  // Slow-changing data — wrapped in slowFetch so a 4s first-scan tick or
  // a debounced SSE re-render doesn't burn 13 round-trips per cycle.
  const [health, accuracy, confidence, learning, approvals, decisions, skillGaps, progress, learned, unmetCreds, googleOAuth, credsStatus, briefingData, twinBriefingData, lifebooksData] = await Promise.allSettled([
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
    fetchLatestTwinBriefing(userId, 'daily').catch(() => null),
    slowFetch(`lifebooks-${userId}`, fetchLifebooks, [userId]),
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

  // Twin Briefing widget (issue #177): the latest daily briefing prose.
  const _twinBriefing = twinBriefingData?.status === 'fulfilled' ? twinBriefingData.value?.briefing : null;

  // Your Lifebooks (#193 Child 1): top 5 detected life domains.
  const lifebooks = (lifebooksData?.status === 'fulfilled' && Array.isArray(lifebooksData.value?.lifebooks))
    ? lifebooksData.value.lifebooks.slice(0, 5)
    : [];

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

  // First-run "needs a brain" prompt. Two prerequisites are cheap and
  // already known here: tour mode (always-off) and recentDecisions
  // (zero only on first-run-ish accounts). Only when both clear do we
  // pay for a settings fetch — keeps SSE-driven re-renders from hitting
  // /api/settings on every tick once the user has any history.
  // Provider enablement matches settings.js: a provider is "enabled"
  // unless `enabled === false`, so existing rows without an explicit
  // field are treated as on (same convention the Settings UI uses).
  // The result is memoized for 5s so the post-OAuth first-scan window
  // (4s polling) doesn't fire /api/settings on every tick. Short
  // enough that "user enables a provider in Settings, comes back" is
  // perceived as instant; long enough to avoid the 4s storm.
  const decisionsFulfilled = decisions?.status === 'fulfilled';
  let showBrainPrompt = false;
  if (!tourMode && decisionsFulfilled && recentDecisions.length === 0) {
    try {
      const settings = await getCachedSettings(userId);
      const aiProviders = Array.isArray(settings?.aiProviders) ? settings.aiProviders : [];
      const enabledProviderCount = aiProviders.filter((p) => p?.enabled !== false).length;
      showBrainPrompt = enabledProviderCount === 0;
    } catch {
      // Settings fetch failed — don't surface the banner on a transient
      // error. The next render will retry.
      showBrainPrompt = false;
    }
  }

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
    ${showBrainPrompt ? renderBrainPrompt() : ''}
    ${renderTwinBriefingWidget(_twinBriefing)}
    ${tourMode ? '' : renderConnectGoogleHero({ googleConnected, googleSystemConfigured, userId })}
    ${tourMode ? '' : renderConnectGmailHero({ googleConnected, googleScopes: googleOAuth.status === 'fulfilled' ? (googleOAuth.value?.scopes ?? []) : [] })}
    ${renderAskTwinWidget({ userId, tourMode })}
    ${showBriefing ? renderBriefingCard({ items: briefingItems, createdAt: briefing.createdAt }) : ''}
    ${renderLifebooksCard(lifebooks)}
    ${pending > 0 ? `<div class="card" style="border-left: 3px solid var(--warning); cursor: pointer;" data-action="goto" data-hash="#/approvals">
      <span style="font-weight: 600;">You have ${pending} pending approval${pending > 1 ? 's' : ''}</span>
      <span style="color: var(--text-muted); font-size: 0.85rem;"> — your twin wants to do something and needs your OK.</span>
    </div>` : ''}
    ${pending > 0 ? renderNotificationOptIn() : ''}

    ${renderUnmetCredentials(unmetCreds)}

    ${prog && !tourMode ? renderTierLadderIntro({ userId, currentTier: prog.currentTier }) : ''}

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

