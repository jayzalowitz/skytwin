import { fetchPendingApprovals, fetchApprovalHistory, respondToApproval, escapeHtml } from '../api-client.js';

export async function renderApprovals(container, userId) {
  const [pendingData, historyData] = await Promise.allSettled([
    fetchPendingApprovals(userId),
    fetchApprovalHistory(userId, 20),
  ]);

  const pending = pendingData.status === 'fulfilled' ? (pendingData.value.approvals ?? []) : [];
  const history = historyData.status === 'fulfilled' ? (historyData.value.approvals ?? []) : [];

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Pending approvals</span>
        <span class="badge ${pending.length > 0 ? 'badge-warning' : 'badge-success'}">${pending.length} pending</span>
      </div>
      <div class="card-subtitle">Your twin wants to take these actions and needs your OK.</div>
    </div>

    <div id="pending-list">
      ${pending.length > 0 ? pending.map(renderApprovalCard).join('') : `
        <div class="empty-state">
          <div class="empty-state-title">All clear</div>
          <div class="empty-state-desc">Your twin doesn't need any approvals right now. It's either handling things automatically or waiting for new events.</div>
        </div>
      `}
    </div>

    ${history.length > 0 ? `
      <div class="card" style="margin-top: 2rem;">
        <div class="card-header">
          <span class="card-title">Recent decisions</span>
        </div>
        ${history.map(a => `
          <div class="activity-item">
            <span class="activity-time">${formatTime(a.respondedAt || a.requestedAt)}</span>
            <span class="activity-desc">${describeAction(a.candidateAction)}</span>
            <span class="badge ${a.status === 'approved' ? 'badge-success' : a.status === 'rejected' ? 'badge-danger' : 'badge-warning'}">${a.status}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function renderApprovalCard(a) {
  const action = a.candidateAction || {};
  const urgencyClass = a.urgency === 'critical' ? 'urgent' : a.urgency === 'high' ? 'high' : '';

  return `
    <div class="card approval-card ${urgencyClass}" id="approval-${a.id}">
      <div class="card-header">
        <span class="card-title">${describeAction(action)}</span>
        <span class="badge badge-${urgencyBadge(a.urgency)}">${a.urgency || 'normal'}</span>
      </div>
      <div class="approval-reason">
        ${explainReason(action, a.reason)}
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; color: var(--text-dim);">
        <span>${a.requestedAt ? formatTime(a.requestedAt) : ''}</span>
        <span>${action.confidence ? `Confidence: ${action.confidence}` : ''}</span>
      </div>
      <div class="approval-actions">
        <button class="btn btn-success btn-sm" onclick="handleApproval('${a.id}', 'approve', '${a.userId || ''}')">Approve</button>
        <button class="btn btn-danger btn-sm" onclick="handleApproval('${a.id}', 'reject', '${a.userId || ''}')">Reject</button>
        <input class="form-input" id="reason-${a.id}" placeholder="Tell me why (optional)" style="flex: 1; font-size: 0.8rem;">
      </div>
    </div>
  `;
}

function describeAction(action) {
  if (!action) return 'Action pending review';

  const descriptions = {
    archive_email: 'Archive this email',
    label_email: 'Label and organize this email',
    send_reply: 'Send an auto-reply',
    delete_email: 'Move this email to trash',
    accept_invite: 'Accept this calendar invite',
    decline_invite: 'Decline this calendar invite',
    propose_alternative: 'Suggest a different time',
    renew_subscription: `Renew subscription ($${((action.estimatedCostCents || 0) / 100).toFixed(2)})`,
    cancel_subscription: 'Cancel this subscription',
    snooze_reminder: 'Snooze this reminder',
    place_order: 'Place this order',
    add_to_list: 'Add to shopping list',
    book_travel: 'Book this trip',
    save_option: 'Save for later review',
  };

  return descriptions[action.actionType] || action.description || action.actionType || 'Take action';
}

function explainReason(action, reason) {
  if (reason) return reason;

  const explanations = {
    archive_email: 'I noticed you usually archive emails like this. Want me to handle it?',
    label_email: 'Based on the content, I think this should be categorized.',
    send_reply: 'This looks like it needs a response. I drafted a quick acknowledgment.',
    accept_invite: 'This meeting fits your schedule. Should I accept?',
    decline_invite: 'This conflicts with your existing plans or you\'ve declined similar ones before.',
    renew_subscription: 'This subscription is coming up for renewal. Should I go ahead?',
  };

  return explanations[action?.actionType] || 'This requires your approval before I can proceed.';
}

function urgencyBadge(urgency) {
  const map = { critical: 'danger', high: 'warning', medium: 'info', low: 'muted' };
  return map[urgency] || 'muted';
}

function formatTime(dateStr) {
  if (!dateStr) return '';
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

window.handleApproval = async function(requestId, action, userId) {
  const reasonInput = document.getElementById(`reason-${requestId}`);
  const reason = reasonInput?.value?.trim() || undefined;

  try {
    await respondToApproval(requestId, action, userId, reason);

    const el = document.getElementById(`approval-${requestId}`);
    if (el) {
      el.style.opacity = '0.5';
      el.style.pointerEvents = 'none';
      const badge = action === 'approve' ? 'badge-success' : 'badge-danger';
      const label = action === 'approve' ? 'Approved' : 'Rejected';
      el.querySelector('.approval-actions').innerHTML = `<span class="badge ${badge}">${label}</span>`;
    }
  } catch (err) {
    const el = document.getElementById(`approval-${requestId}`);
    if (el) {
      el.insertAdjacentHTML('beforeend', `<div class="error-banner" style="margin-top: 0.5rem;">${escapeHtml(err.message)}</div>`);
    }
  }
};
