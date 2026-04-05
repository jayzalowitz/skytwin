const API = '/api';

/**
 * Escape HTML special characters to prevent XSS when inserting into innerHTML.
 */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Fetch JSON from the API with user-friendly error handling.
 */
export async function fetchJSON(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
  } catch {
    throw new Error('Unable to reach the server. Please check your connection.');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    const message = err?.error || err?.message || `Something went wrong (HTTP ${res.status})`;
    throw new Error(message);
  }
  return res.json();
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
