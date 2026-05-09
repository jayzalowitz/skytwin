import { KEY_SESSION_TOKEN } from './storage-keys.js';

const API = '/api';

/**
 * Escape HTML special characters to prevent XSS when inserting into innerHTML.
 */
export function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Build the Authorization header from the stored session token (if any).
 */
function authHeaders() {
  const token = localStorage.getItem(KEY_SESSION_TOKEN);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Rich error class returned from `fetchJSON` failures. UX review #4 (P0):
 * pages used to render the raw `error` body verbatim, which leaked
 * developer-jargon strings like "API proxy error" or "Failed to load
 * resource: 502 Bad Gateway" directly to users.
 *
 * `kind` lets pages branch on the failure mode without parsing strings:
 *   - `offline`    — network unreachable OR our proxy can't reach upstream
 *                    (HTTP 502 from /api/* in dev). Show "we'll retry"
 *                    rather than a scary error card.
 *   - `auth`       — HTTP 401/403. Surface "your session expired" prompts.
 *   - `not-found`  — HTTP 404.
 *   - `bad-request`— HTTP 400/409 with a server-supplied message that's
 *                    safe to show (validation / conflicts).
 *   - `server`     — HTTP 5xx that isn't a proxy-down case.
 *   - `unknown`    — anything else.
 *
 * `friendlyMessage` is a non-technical sentence the page can render
 * unmodified. `serverMessage` is the raw server-supplied string for
 * developers / log analysis (do NOT render to users by default).
 */
export class ApiError extends Error {
  constructor({ kind, friendlyMessage, serverMessage, status }) {
    super(friendlyMessage);
    this.name = 'ApiError';
    this.kind = kind;
    this.friendlyMessage = friendlyMessage;
    this.serverMessage = serverMessage ?? '';
    this.status = status ?? 0;
  }
}

/**
 * Translate a non-OK fetch Response into an `ApiError`. Pure: pages can
 * import + test without touching network. Issue UX#4.
 */
async function classifyHttpError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch { /* body wasn't JSON */ }
  const serverMessage = body?.error || body?.message || `HTTP ${res.status}`;

  // Web dev server proxies /api/* to the API server. When the API is
  // down it returns 502 with body { error: 'API proxy error', details }.
  // Treat this as offline rather than as a generic 5xx.
  if (res.status === 502 && /API proxy error/i.test(serverMessage)) {
    return new ApiError({
      kind: 'offline',
      friendlyMessage: "Can't reach SkyTwin right now. We'll keep trying.",
      serverMessage,
      status: res.status,
    });
  }

  if (res.status === 401 || res.status === 403) {
    return new ApiError({
      kind: 'auth',
      friendlyMessage: 'Your session expired. Sign in again to continue.',
      serverMessage,
      status: res.status,
    });
  }

  if (res.status === 404) {
    return new ApiError({
      kind: 'not-found',
      friendlyMessage: "We couldn't find that.",
      serverMessage,
      status: res.status,
    });
  }

  if (res.status === 409 || res.status === 400) {
    // 4xx validation/conflict messages from our own API are written to
    // be user-readable (e.g. "No AI provider configured"). Pass through.
    return new ApiError({
      kind: 'bad-request',
      friendlyMessage: serverMessage,
      serverMessage,
      status: res.status,
    });
  }

  if (res.status >= 500) {
    return new ApiError({
      kind: 'server',
      friendlyMessage: "Something went wrong on our end. Please try again.",
      serverMessage,
      status: res.status,
    });
  }

  return new ApiError({
    kind: 'unknown',
    friendlyMessage: 'Something went wrong. Please try again.',
    serverMessage,
    status: res.status,
  });
}

/**
 * Fetch JSON from the API with user-friendly error handling.
 * Automatically attaches the session token if one is stored.
 *
 * Throws `ApiError` (subclass of Error) on failure — pages should
 * branch on `err.kind` rather than parsing `err.message`. Use
 * `renderApiError(err, retry)` for a consistent visual treatment.
 */
export async function fetchJSON(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options.headers },
      ...options,
    });
  } catch (cause) {
    // Network unreachable (no DNS, no route, browser offline, etc.)
    markApiOffline();
    throw new ApiError({
      kind: 'offline',
      friendlyMessage: "You appear to be offline. Check your connection — we'll retry automatically.",
      serverMessage: cause instanceof Error ? cause.message : String(cause),
      status: 0,
    });
  }

  if (!res.ok) {
    const apiErr = await classifyHttpError(res);
    if (apiErr.kind === 'offline') markApiOffline();
    throw apiErr;
  }
  markApiSucceeded();
  return res.json();
}

/**
 * Render a consistent error card for a failed API call. UX review #4 + #5.
 *
 * Use this in every page's catch block instead of writing custom error
 * UI. Branches on `err.kind` so the same helper covers offline, auth,
 * server errors, and validation messages. The `retry` callback is shown
 * as a "Try again" button when provided — pages without a retry path
 * (e.g. one-shot operations) can omit it.
 *
 * The user NEVER sees `serverMessage` from this helper — only
 * `friendlyMessage`. Devs can inspect the error in the console (logged
 * by the api-client at warn level when offline).
 */
export function renderApiError(err, options = {}) {
  const { retry, context } = options;
  const isApi = err && typeof err === 'object' && 'kind' in err;
  const kind = isApi ? err.kind : 'unknown';
  const friendly = isApi ? err.friendlyMessage : 'Something went wrong. Please try again.';

  // Match severity to the failure mode. Offline is calm (it'll come back);
  // auth is informational (sign in); server is a warning (rare); unknown
  // is a danger (unexpected).
  const accentVar = kind === 'offline'
    ? 'var(--text-muted, var(--text))'
    : kind === 'auth'
    ? 'var(--accent, #6366f1)'
    : 'var(--danger, #ef4444)';
  const heading = kind === 'offline'
    ? "Can't reach SkyTwin right now"
    : kind === 'auth'
    ? 'Sign in again'
    : kind === 'not-found'
    ? "We couldn't find that"
    : 'Something went wrong';
  const contextLine = context ? `<div class="api-error-context">${escapeHtml(context)}</div>` : '';
  const retryBtn = retry ? `<button class="btn btn-outline btn-sm" data-action="api-retry" type="button">Try again</button>` : '';

  return `
    <div class="card api-error-card" data-error-kind="${escapeHtml(kind)}" style="border-left: 3px solid ${accentVar};">
      <div class="card-header"><span class="card-title">${escapeHtml(heading)}</span></div>
      <div class="card-subtitle">${escapeHtml(friendly)}</div>
      ${contextLine}
      ${retryBtn}
    </div>
  `;
}

/**
 * Tracks whether the most recent fetch came back as `kind: 'offline'`.
 * UX review #20 — when the API is down, polling loops were firing at
 * normal cadence (10s for approval badge, plus health checks, plus SSE
 * reconnects), producing 110+ console errors per minute. Caller polls
 * can read `isApiKnownOffline()` and back off without holding their
 * own state.
 *
 * Set true on any offline ApiError, set false on any successful
 * fetchJSON. Initial value is false (optimistic — first request
 * decides).
 */
let _apiKnownOffline = false;
export function isApiKnownOffline() { return _apiKnownOffline; }
function markApiSucceeded() { _apiKnownOffline = false; }
function markApiOffline() { _apiKnownOffline = true; }

/**
 * Wire up the "Try again" button rendered by `renderApiError(..., { retry })`.
 *
 * The page should call `wireApiRetry(container, retry)` after rendering.
 * Singleton-safe: only the most recent `retry` callback fires per
 * container. Pages re-binding on every render get fresh closures, which
 * is what we want for re-fetches that depend on current state.
 */
export function wireApiRetry(container, retry) {
  if (!container || typeof retry !== 'function') return;
  const btn = container.querySelector('[data-action="api-retry"]');
  if (!btn || btn.dataset.wired === 'true') return;
  btn.dataset.wired = 'true';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    Promise.resolve(retry()).finally(() => {
      btn.disabled = false;
      btn.textContent = 'Try again';
    });
  });
}

// ── Decisions ───────────────────────────────────────────

export function fetchDecisions(userId, options = {}) {
  const params = new URLSearchParams(options);
  return fetchJSON(`${API}/decisions/${userId}?${params}`);
}

export function fetchDecisionExplanation(decisionId) {
  return fetchJSON(`${API}/decisions/${decisionId}/explanation`);
}

// ── Approvals ───────────────────────────────────────────

export function fetchPendingApprovals(userId) {
  return fetchJSON(`${API}/approvals/${userId}/pending`);
}

export function fetchApprovalHistory(userId, limit = 50) {
  return fetchJSON(`${API}/approvals/${userId}/history?limit=${limit}`);
}

export function respondToApproval(requestId, action, userId, reason) {
  return fetchJSON(`${API}/approvals/${requestId}/respond`, {
    method: 'POST',
    body: JSON.stringify({ action, userId, reason }),
  });
}

// ── Feedback ────────────────────────────────────────────

export function submitFeedback(userId, decisionId, type, data = {}) {
  return fetchJSON(`${API}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ userId, decisionId, type, data }),
  });
}

// ── Twin Profile ────────────────────────────────────────

export function fetchTwinProfile(userId) {
  return fetchJSON(`${API}/twin/${userId}`);
}

export function updatePreference(userId, preference) {
  return fetchJSON(`${API}/twin/${userId}/preferences`, {
    method: 'PUT',
    body: JSON.stringify(preference),
  });
}

export function deleteInsight(userId, domain, key, newValue) {
  return fetchJSON(`${API}/twin/${userId}/insights`, {
    method: 'DELETE',
    body: JSON.stringify({ domain, key, newValue }),
  });
}

export function fetchTrustProgress(userId) {
  return fetchJSON(`${API}/twin/${userId}/progress`);
}

export function fetchLearned(userId) {
  return fetchJSON(`${API}/twin/${userId}/learned`);
}

// ── Users ───────────────────────────────────────────────

export function createUser(email, name, trustTier) {
  return fetchJSON(`${API}/users`, {
    method: 'POST',
    body: JSON.stringify({ email, name, trustTier }),
  });
}

export function fetchUser(userId) {
  return fetchJSON(`${API}/users/${userId}`).catch(() => null);
}

export function listUsers() {
  return fetchJSON(`${API}/users`).then((d) => d.users ?? []);
}

export function updateTrustTier(userId, trustTier) {
  return fetchJSON(`${API}/users/${userId}/trust-tier`, {
    method: 'PUT',
    body: JSON.stringify({ trustTier }),
  });
}

// ── Health ──────────────────────────────────────────────

export function fetchHealth() {
  return fetchJSON(`${API}/health`);
}

// ── Evals / Learning ────────────────────────────────────

export function fetchAccuracy(userId) {
  return fetchJSON(`${API}/evals/${userId}/accuracy`);
}

export function fetchLearning(userId) {
  return fetchJSON(`${API}/evals/${userId}/learning`);
}

export function fetchConfidence(userId) {
  return fetchJSON(`${API}/evals/${userId}/confidence`);
}

// ── OAuth ───────────────────────────────────────────────

export function fetchOAuthStatus(userId, provider = 'google') {
  return fetchJSON(`${API}/oauth/${provider}/status?userId=${encodeURIComponent(userId)}`);
}

export function fetchCredentialsStatus() {
  return fetchJSON(`${API}/credentials/status`);
}

export function fetchDemoInfo() {
  return fetchJSON(`${API}/v1/demo/info`);
}

export function previewDemoDecision(situation) {
  return fetchJSON(`${API}/v1/demo/preview`, {
    method: 'POST',
    body: JSON.stringify({ situation }),
  });
}

export function askTwin(userId, situation, opts = {}) {
  return fetchJSON(`${API}/v1/twin/ask/${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ situation, ...opts }),
  });
}

export function fetchBriefing(userId) {
  return fetchJSON(`${API}/v1/briefings/${encodeURIComponent(userId)}`);
}

export function getGoogleAuthUrl(userId) {
  return fetchJSON(`${API}/oauth/google/authorize?userId=${encodeURIComponent(userId)}`);
}

export function disconnectProvider(provider, userId) {
  return fetchJSON(`${API}/oauth/${provider}/disconnect`, {
    method: 'DELETE',
    body: JSON.stringify({ userId }),
  });
}

// ── Settings (M2) ──────────────────────────────────────

export function fetchSettings(userId) {
  return fetchJSON(`${API}/settings/${userId}`);
}

export function updateAutonomySettings(userId, settings) {
  return fetchJSON(`${API}/settings/${userId}/autonomy`, {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

export function updateIronClawChannel(userId, ironclawChannel) {
  return fetchJSON(`${API}/settings/${userId}/ironclaw-channel`, {
    method: 'PUT',
    body: JSON.stringify({ ironclawChannel }),
  });
}

export function upsertDomainPolicy(userId, domain, trustTier, maxSpendPerActionCents) {
  return fetchJSON(`${API}/settings/${userId}/domains/${encodeURIComponent(domain)}`, {
    method: 'PUT',
    body: JSON.stringify({ trustTier, maxSpendPerActionCents }),
  });
}

export function deleteDomainPolicy(userId, domain) {
  return fetchJSON(`${API}/settings/${userId}/domains/${encodeURIComponent(domain)}`, {
    method: 'DELETE',
  });
}

export function createEscalationTrigger(userId, triggerType, conditions, enabled = true) {
  return fetchJSON(`${API}/settings/${userId}/escalation-triggers`, {
    method: 'POST',
    body: JSON.stringify({ triggerType, conditions, enabled }),
  });
}

export function deleteEscalationTrigger(userId, triggerId) {
  return fetchJSON(`${API}/settings/${userId}/escalation-triggers/${triggerId}`, {
    method: 'DELETE',
  });
}

// ── Sessions ──────────────────────────────────────────

export function createSession(userId, deviceName) {
  return fetchJSON(`${API}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ userId, deviceName }),
  });
}

export function fetchSessions(userId) {
  return fetchJSON(`${API}/sessions/${userId}`);
}

export function revokeSession(sessionId, userId) {
  return fetchJSON(`${API}/sessions/${sessionId}`, {
    method: 'DELETE',
    body: JSON.stringify({ userId }),
  });
}

// ── AI Provider Settings ──────────────────────────────

export function fetchAISettings(userId) {
  return fetchSettings(userId).then(s => s?.aiProviders ?? []);
}

export function saveAIProviders(userId, providers) {
  return fetchJSON(`${API}/settings/${userId}/ai`, {
    method: 'PUT',
    body: JSON.stringify({ providers }),
  });
}

export function testAIProvider(userId, providerConfig) {
  return fetchJSON(`${API}/settings/${userId}/ai/test`, {
    method: 'POST',
    body: JSON.stringify(providerConfig),
  });
}

// ── Audit ──────────────────────────────────────────────

export function fetchAudit(userId, options = {}) {
  const params = new URLSearchParams(options);
  return fetchJSON(`${API}/audit/${userId}?${params}`);
}

// ── Skill Gaps ─────────────────────────────────────────

export function fetchSkillGaps(userId) {
  return fetchJSON(`${API}/v1/skill-gaps/${userId}`);
}

// ── Credentials / Setup ───────────────────────────────

export function fetchUnmetCredentials() {
  return fetchJSON(`${API}/credentials/unmet`);
}

// ── IronClaw Routines ─────────────────────────────────

export function fetchRoutines(userId) {
  return fetchJSON(`${API}/routines/${encodeURIComponent(userId)}`);
}

export function createRoutine(userId, schedule, plan) {
  return fetchJSON(`${API}/routines`, {
    method: 'POST',
    body: JSON.stringify({ userId, schedule, plan }),
  });
}

export function deleteRoutine(routineId, userId) {
  return fetchJSON(`${API}/routines/${encodeURIComponent(routineId)}?userId=${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

// ── Assistant (issue #135 phase 1) ────────────────────

export function fetchAssistantThreads(userId) {
  return fetchJSON(`${API}/assistant/threads?userId=${encodeURIComponent(userId)}`);
}

export function fetchAssistantThread(threadId, userId) {
  return fetchJSON(`${API}/assistant/threads/${encodeURIComponent(threadId)}?userId=${encodeURIComponent(userId)}`);
}

export function deleteAssistantThread(threadId, userId) {
  return fetchJSON(`${API}/assistant/threads/${encodeURIComponent(threadId)}?userId=${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

export function sendAssistantMessage(userId, content, threadId = null) {
  return fetchJSON(`${API}/assistant/messages`, {
    method: 'POST',
    body: JSON.stringify({ userId, content, threadId }),
  });
}

/**
 * Streaming variant of `sendAssistantMessage`. Issue #146 (phase 2a).
 *
 * Posts to the same endpoint with `Accept: text/event-stream` and parses
 * the SSE response into per-event callbacks. Uses `fetch` + a manual SSE
 * parser instead of `EventSource` because EventSource only supports GET
 * requests — and the assistant endpoint is POST (with the message body).
 *
 * Callbacks (all optional):
 *   - onThread({ id, isNew })             — thread metadata, fires first
 *   - onUserMessage(message)              — persisted user-message row
 *   - onChunk(text)                       — partial reply text, fires N times
 *   - onDone(assistantMessage)            — persisted assistant-message row
 *   - onError({ message, partialContent }) — terminal error event
 *
 * Returns a Promise that resolves when the stream closes (after `done`
 * or `error`). The promise rejects only on transport-level failures
 * (network down, 5xx before SSE handshake) — server-emitted error events
 * resolve normally and surface via `onError`.
 */
export async function sendAssistantMessageStream(userId, content, threadId, callbacks = {}, options = {}) {
  const { onThread, onUserMessage, onChunk, onDone, onError } = callbacks;
  // Optional AbortSignal lets the caller cancel mid-stream — used by the
  // assistant chat's Stop button. fetch() rejects with AbortError when
  // aborted; the read loop exits cleanly because reader.read() also
  // rejects. We rethrow AbortError so the caller's catch can distinguish
  // "user-initiated stop" from real network failures.
  const { signal } = options;

  let res;
  try {
    res = await fetch(`${API}/assistant/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...authHeaders(),
      },
      body: JSON.stringify({ userId, content, threadId }),
      signal,
    });
  } catch (err) {
    // AbortError is "the user clicked Stop" — surface it verbatim so the
    // caller can branch on err.name; everything else is a real transport
    // failure that gets the friendly fallback.
    if (err?.name === 'AbortError') throw err;
    throw new Error('Unable to reach the server. Please check your connection.');
  }

  if (!res.ok) {
    // Server rejected before opening the stream (e.g. 400 validation,
    // 409 no provider, 502 all providers down on pre-stream check).
    // Echo the error shape callers already handle from fetchJSON.
    const err = await res.json().catch(() => null);
    const message = err?.error || err?.message || `Request failed (HTTP ${res.status})`;
    throw new Error(message);
  }

  if (!res.body) {
    throw new Error('Server returned no stream body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const dispatch = (event, data) => {
    if (event === 'thread') onThread?.(data);
    else if (event === 'user') onUserMessage?.(data);
    else if (event === 'chunk') onChunk?.(data?.content ?? '');
    else if (event === 'done') onDone?.(data);
    else if (event === 'error') onError?.(data);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE event boundary is a blank line. Process complete events
      // and keep the trailing fragment for the next read.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseEvent(rawEvent);
        if (parsed) dispatch(parsed.event, parsed.data);
        boundary = buffer.indexOf('\n\n');
      }
    }
    // Flush any final fragment (defensive; well-behaved servers always
    // end with `\n\n` after the terminal event).
    const tail = buffer.trim();
    if (tail.length > 0) {
      const parsed = parseSseEvent(tail);
      if (parsed) dispatch(parsed.event, parsed.data);
    }
  } catch (err) {
    // Aborted by caller (Stop button) — surface to caller via the same
    // path as the initial fetch abort so the catch can branch on .name.
    if (err?.name === 'AbortError') throw err;
    throw err;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse one SSE event block (the slice between two blank lines) into
 * `{ event, data }`. Returns null for blocks that don't look like SSE
 * events (heartbeats, comments, malformed data). Tolerant by design —
 * one bad event must not kill the stream.
 */
function parseSseEvent(raw) {
  let event = 'message';
  let dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(payload) };
  } catch {
    return { event, data: payload };
  }
}

// ── Capabilities (issue #176) ────────────────────────────

export function fetchCapabilities(userId) {
  return fetchJSON(`${API}/capabilities?userId=${encodeURIComponent(userId)}`);
}

export function fetchCapabilitySuggestions(userId) {
  return fetchJSON(`${API}/capabilities/suggestions?userId=${encodeURIComponent(userId)}`);
}

export function dismissCapabilitySuggestion(id, userId) {
  return fetchJSON(`${API}/capabilities/suggestions/${encodeURIComponent(id)}/dismiss?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
  });
}

export function snoozeCapabilitySuggestion(id, userId, untilDays = 7) {
  return fetchJSON(`${API}/capabilities/suggestions/${encodeURIComponent(id)}/snooze?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ untilDays }),
  });
}

export function searchCapabilityRegistry(userId, q = '', category = '') {
  const params = new URLSearchParams({ userId });
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  return fetchJSON(`${API}/capabilities/registry?${params}`);
}

export function fetchCapabilityRecipes(userId) {
  return fetchJSON(`${API}/capabilities/recipes?userId=${encodeURIComponent(userId)}`);
}

export function installCapabilityRecipe(userId, slug) {
  return fetchJSON(`${API}/capabilities/recipes/${encodeURIComponent(slug)}/install?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
  });
}

export function fetchCapabilityDependencyGraph(userId) {
  return fetchJSON(`${API}/capabilities/dependency-graph?userId=${encodeURIComponent(userId)}`);
}

export function uninstallCapability(id, userId, opts = {}) {
  return fetchJSON(`${API}/capabilities/${encodeURIComponent(id)}/uninstall?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export function rehearseCapability(id, userId, daysBack = 30) {
  return fetchJSON(`${API}/capabilities/${encodeURIComponent(id)}/rehearse?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ daysBack }),
  });
}

export function regretCapability(id, userId, withinHours = 24) {
  return fetchJSON(`${API}/capabilities/${encodeURIComponent(id)}/regret?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ withinHours }),
  });
}

// ── Pause / Resume all capabilities (#190) ───────────────────────────────────

export function pauseAllCapabilities(userId) {
  return fetchJSON(`${API}/capabilities/pause-all?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
  });
}

export function resumeAllCapabilities(userId) {
  return fetchJSON(`${API}/capabilities/resume-all?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
  });
}

// ── Risk profile (#190) ───────────────────────────────────────────────────────

export function fetchRiskProfile(userId) {
  return fetchJSON(`${API}/risk-profile?userId=${encodeURIComponent(userId)}`);
}

export function saveRiskProfile(userId, profileText) {
  return fetchJSON(`${API}/risk-profile?userId=${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: JSON.stringify({ profileText }),
  });
}

export function reinterpretRiskProfile(userId) {
  return fetchJSON(`${API}/risk-profile/reinterpret?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
  });
}

// ── About Me / self-portrait (#190) ──────────────────────────────────────────

export function fetchAboutMe(userId) {
  return fetchJSON(`${API}/about-me?userId=${encodeURIComponent(userId)}`);
}

export function submitSelfPortraitCorrection(userId, paragraphIndex, sentenceIndex, correction) {
  return fetchJSON(`${API}/about-me/correct?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ paragraphIndex, sentenceIndex, correction }),
  });
}

// ── Tier promotion ceremony (issue #177) ──────────────────────────────────

export function promoteTier(serverId, toTier, userId) {
  return fetchJSON(`${API}/capabilities/${encodeURIComponent(serverId)}/promote-tier?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ toTier }),
  });
}

export function declinePromotion(serverId, userId, disableForDays = 14) {
  return fetchJSON(`${API}/capabilities/${encodeURIComponent(serverId)}/decline-promotion?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ disableForDays }),
  });
}

// ── Provenance lineage (issue #177) ───────────────────────────────────────

export function fetchCapabilityProvenance(serverId, userId) {
  return fetchJSON(`${API}/capabilities/${encodeURIComponent(serverId)}/provenance?userId=${encodeURIComponent(userId)}`);
}

// ── Capability install from reverse flow (issue #177) ─────────────────────

export function installCapability(registryId, userId) {
  return fetchJSON(`${API}/capabilities/install?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ registryId }),
  });
}

// ── Twin Briefings (issue #177) ───────────────────────────────────────────

export function fetchLatestTwinBriefing(userId, cadence) {
  const q = new URLSearchParams({ userId });
  if (cadence) q.set('cadence', cadence);
  return fetchJSON(`${API}/twin-briefings/latest?${q}`);
}

export function listTwinBriefings(userId, opts = {}) {
  const q = new URLSearchParams({ userId });
  if (opts.cadence) q.set('cadence', opts.cadence);
  if (opts.limit) q.set('limit', String(opts.limit));
  return fetchJSON(`${API}/twin-briefings?${q}`);
}

export function markBriefingRead(briefingId, userId) {
  return fetchJSON(`${API}/twin-briefings/${encodeURIComponent(briefingId)}/read?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
  });
}

// ── Lifebooks (#193 Child 1) ──────────────────────────────────────────────────

export function fetchLifebooks(userId) {
  return fetchJSON(`${API}/lifebooks/${encodeURIComponent(userId)}`);
}

export function fetchLifebook(userId, domainName) {
  return fetchJSON(
    `${API}/lifebooks/${encodeURIComponent(userId)}/${encodeURIComponent(domainName)}`,
  );
}

export function hideLifebook(userId, domainName) {
  return fetchJSON(
    `${API}/lifebooks/${encodeURIComponent(userId)}/${encodeURIComponent(domainName)}/hide`,
    { method: 'POST' },
  );
}

export function unhideLifebook(userId, domainName) {
  return fetchJSON(
    `${API}/lifebooks/${encodeURIComponent(userId)}/${encodeURIComponent(domainName)}/unhide`,
    { method: 'POST' },
  );
}

// ── Federation (#194 Child 1) ─────────────────────────────────────────────────

export function startFederationPairing(userId) {
  return fetchJSON(`${API}/federation/pair/start`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export function completeFederationPairing(userId, code, label, peerPublicKey, endpointUrl) {
  return fetchJSON(`${API}/federation/pair/complete`, {
    method: 'POST',
    body: JSON.stringify({ userId, code, label, peerPublicKey, endpointUrl }),
  });
}

export function listFederationPeers(userId) {
  return fetchJSON(`${API}/federation/peers/${encodeURIComponent(userId)}`);
}

export function unpairFederationPeer(userId, peerId) {
  return fetchJSON(
    `${API}/federation/peers/${encodeURIComponent(userId)}/${encodeURIComponent(peerId)}/unpair`,
    { method: 'POST' },
  );
}

// ── Embedded LLM downloads (#187 AC#2) ────────────────────────────────────────

export function fetchEmbeddedLlmRegistry() {
  return fetchJSON(`${API}/embedded-llm/registry`);
}

export function fetchEmbeddedLlmModelDir() {
  return fetchJSON(`${API}/embedded-llm/model-dir`);
}

export function recommendEmbeddedDefault(bracket) {
  return fetchJSON(`${API}/embedded-llm/recommend-default?bracket=${encodeURIComponent(bracket)}`);
}

export function startModelDownload(userId, modelId) {
  return fetchJSON(`${API}/embedded-llm/downloads/start`, {
    method: 'POST',
    body: JSON.stringify({ userId, modelId }),
  });
}

export function fetchModelDownload(downloadId) {
  return fetchJSON(`${API}/embedded-llm/downloads/${encodeURIComponent(downloadId)}`);
}

export function listUserModelDownloads(userId) {
  return fetchJSON(`${API}/embedded-llm/downloads/user/${encodeURIComponent(userId)}`);
}

export function pauseModelDownload(downloadId) {
  return fetchJSON(`${API}/embedded-llm/downloads/${encodeURIComponent(downloadId)}/pause`, {
    method: 'POST',
  });
}

export function resumeModelDownload(downloadId) {
  return fetchJSON(`${API}/embedded-llm/downloads/${encodeURIComponent(downloadId)}/resume`, {
    method: 'POST',
  });
}

export function cancelModelDownload(downloadId) {
  return fetchJSON(`${API}/embedded-llm/downloads/${encodeURIComponent(downloadId)}/cancel`, {
    method: 'POST',
  });
}

// ── Onboarding (issue #181) ───────────────────────────────────────────────────

export function fetchOnboardingState(userId) {
  return fetchJSON(`${API}/onboarding/state?userId=${encodeURIComponent(userId)}`);
}

export function postOnboardingDialogue(userId, history, context) {
  return fetchJSON(`${API}/onboarding/dialogue?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ history, context }),
  });
}

export function postDeterministicPick(userId, answers) {
  return fetchJSON(`${API}/onboarding/deterministic-pick?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ answers }),
  });
}

export function postOnboardingComplete(userId, choice, recipeSlug) {
  return fetchJSON(`${API}/onboarding/complete?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
    body: JSON.stringify({ choice, recipeSlug }),
  });
}

// ── Capability changelog + skill opt-ins (#184 AC#2) ─────────────────────────

export function fetchCapabilityChangelog(serverId, userId) {
  return fetchJSON(`${API}/capabilities/${encodeURIComponent(serverId)}/changelog?userId=${encodeURIComponent(userId)}`);
}

export function fetchPendingSkillOptIns(userId) {
  return fetchJSON(`${API}/capabilities/pending-opt-ins?userId=${encodeURIComponent(userId)}`);
}

export function acceptSkillOptIn(optInId, userId) {
  return fetchJSON(`${API}/capabilities/pending-opt-ins/${encodeURIComponent(optInId)}/accept?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
  });
}

export function rejectSkillOptIn(optInId, userId) {
  return fetchJSON(`${API}/capabilities/pending-opt-ins/${encodeURIComponent(optInId)}/reject?userId=${encodeURIComponent(userId)}`, {
    method: 'POST',
  });
}
