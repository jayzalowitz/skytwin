const API = '/api';

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
