import { fetchPendingApprovals, fetchApprovalHistory, respondToApproval, escapeHtml, fetchTrustProgress } from '../api-client.js';
import { renderTrustProgress } from '../components/progress-bar.js';

export async function renderApprovals(container, userId) {
  const [pendingData, historyData, progressData] = await Promise.allSettled([
    fetchPendingApprovals(userId),
    fetchApprovalHistory(userId, 20),
    fetchTrustProgress(userId),
  ]);

  const pending = pendingData.status === 'fulfilled' ? (pendingData.value.approvals ?? []) : [];
  const rawHistory = historyData.status === 'fulfilled' ? (historyData.value.approvals ?? []) : [];
  const prog = progressData.status === 'fulfilled' ? progressData.value : null;

  // Filter out expired escalations from history — they're noise (twin didn't know what
  // to do and the user never responded, so there's nothing useful to show)
  const history = rawHistory.filter(a => {
    if (a.status === 'expired' && a.candidateAction?.actionType === 'escalate_to_user') return false;
    return true;
  });

  container.innerHTML = `
    ${prog ? renderTrustProgress({ approvalCount: prog.approvalCount, currentTier: prog.currentTier }) : ''}

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
          <div class="activity-item" style="flex-direction: column; align-items: stretch;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span class="activity-time">${formatTime(a.respondedAt || a.requestedAt)}</span>
              <span class="activity-desc">${describeAction(a.candidateAction)}</span>
              <span class="badge ${a.status === 'approved' ? 'badge-success' : a.status === 'rejected' ? 'badge-danger' : 'badge-warning'}">${a.status}</span>
            </div>
            ${renderHistoryDetails(a)}
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function renderApprovalCard(a) {
  const action = a.candidateAction || {};
  const urgencyClass = a.urgency === 'critical' ? 'urgent' : a.urgency === 'high' ? 'high' : '';
  const isEscalation = action.actionType === 'escalate_to_user';

  // For escalations, extract a cleaner title from the summary
  const title = isEscalation
    ? escapeHtml(extractEscalationSubject(action))
    : describeAction(action);

  return `
    <div class="card approval-card ${urgencyClass}" id="approval-${a.id}">
      <div class="card-header">
        <span class="card-title">${title}</span>
        <span class="badge badge-${urgencyBadge(a.urgency)}">${a.urgency || 'normal'}</span>
      </div>
      ${renderSignalContext(a.signalContext)}
      ${isEscalation
        ? renderEscalationCard(a, action)
        : renderStandardCard(a, action)
      }
    </div>
  `;
}

/**
 * Render the original signal context — the email body, sender, source, etc.
 * so the user has enough information to make a decision.
 */
function renderSignalContext(ctx) {
  if (!ctx) return '';

  const parts = [];

  // Source + sender line
  const meta = [];
  if (ctx.from) meta.push(`From: ${escapeHtml(ctx.from)}`);
  if (ctx.source) meta.push(escapeHtml(ctx.source));
  if (meta.length > 0) {
    parts.push(`<div class="signal-meta">${meta.join(' · ')}</div>`);
  }

  // Body / summary — show a preview, truncated
  const text = ctx.body || ctx.summary || '';
  if (text) {
    const preview = text.length > 280 ? text.slice(0, 280) + '…' : text;
    parts.push(`<div class="signal-body">${escapeHtml(preview)}</div>`);
  }

  if (parts.length === 0) return '';

  return `
    <div class="signal-context" style="margin: 0.4rem 0 0.5rem; padding: 0.5rem 0.65rem; background: var(--bg-input); border-radius: var(--radius-sm); font-size: 0.82rem; line-height: 1.5;">
      ${parts.join('')}
    </div>
  `;
}

function renderStandardCard(a, action) {
  return `
    <div class="approval-reason">
      ${explainReason(action, a.reason)}
    </div>
    ${renderActionDetails(action)}
    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; color: var(--text-dim);">
      <span>${a.requestedAt ? formatTime(a.requestedAt) : ''}</span>
      <span>${action.confidence ? `Confidence: ${action.confidence}` : ''}</span>
    </div>
    <div class="approval-actions">
      <button class="btn btn-success btn-sm" onclick="handleApproval('${a.id}', 'approve', '${a.userId || ''}')">Yes, go ahead</button>
      <button class="btn btn-danger btn-sm" onclick="handleApproval('${a.id}', 'reject', '${a.userId || ''}')">No, don't do this</button>
      <input class="form-input" id="reason-${a.id}" placeholder="Want to tell me why? (optional)" style="flex: 1; font-size: 0.8rem;">
    </div>
  `;
}

function renderEscalationCard(a, action) {
  // Determine the real domain from signal context (e.g. "gmail" → email)
  // rather than the action's domain which is often just "generic"
  const signalSource = (a.signalContext?.source || '').toLowerCase();
  const effectiveDomain = resolveSignalDomain(signalSource, action.domain || 'general');

  // Always start with domain-specific suggestions (archive, label, snooze for email, etc.)
  const domainSuggestions = getEscalationSuggestions(effectiveDomain, action);

  // Append any unique dynamic alternatives from the decision engine
  // that aren't already covered by the domain suggestions
  const alternatives = a.alternatives || [];
  const domainActions = new Set(domainSuggestions.map(s => s.action));
  const extraSuggestions = alternatives
    .filter(alt => !domainActions.has(alt.actionType))
    .map(alt => ({
      icon: actionIcon(alt.actionType),
      action: alt.actionType,
      label: cleanAltLabel(alt.description, alt.actionType),
    }));

  const suggestions = [...domainSuggestions, ...extraSuggestions];

  return `
    <div class="escalation-prompt" style="font-size: 0.85rem; color: var(--text-muted); margin: 0.5rem 0; line-height: 1.6;">
      I'm not sure what to do with this. What would you like?
    </div>
    <div class="escalation-suggestions" style="display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.5rem 0;">
      ${suggestions.map(s => `
        <button class="btn btn-sm suggestion-btn" style="font-size: 0.8rem;"
          onclick="handleEscalationChoice('${a.id}', '${a.userId || ''}', '${s.action}', '${escapeAttr(s.label)}')"
        >${s.icon} ${escapeHtml(s.label)}</button>
      `).join('')}
    </div>
    <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem; align-items: center;">
      <button class="btn btn-sm" style="background: var(--bg-hover); color: var(--text-dim); border: 1px solid var(--border); font-size: 0.78rem;"
        onclick="handleApproval('${a.id}', 'reject', '${a.userId || ''}')">Dismiss</button>
      <input class="form-input" id="reason-${a.id}" placeholder="Or tell me what to do instead…" style="flex: 1; font-size: 0.8rem;">
      <button class="btn btn-sm" style="background: var(--bg-hover); color: var(--text-muted); border: 1px solid var(--border); font-size: 0.78rem;"
        onclick="handleEscalationCustom('${a.id}', '${a.userId || ''}')">Send</button>
    </div>
    <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.4rem;">
      Your choice trains the twin — next time it'll know what to do.
    </div>
  `;
}

/**
 * Pull a readable subject from the escalation description/parameters.
 */
function extractEscalationSubject(action) {
  const desc = action.description || '';
  // Strip the "Escalate to user: Decision needed regarding: " prefix
  const cleaned = desc
    .replace(/^Escalate to user:\s*/i, '')
    .replace(/^Decision needed regarding:\s*/i, '');
  return cleaned || action.parameters?.summary || 'New item needs your attention';
}

/**
 * Domain-aware suggested actions for escalation cards.
 */
function getEscalationSuggestions(domain, action) {
  const emailSuggestions = [
    { icon: '📥', action: 'archive', label: 'Archive it' },
    { icon: '🏷️', action: 'label', label: 'Label & keep' },
    { icon: '⏰', action: 'snooze', label: 'Snooze for later' },
    { icon: '📖', action: 'read', label: 'I\'ll read it' },
    { icon: '🗑️', action: 'trash', label: 'Trash it' },
  ];

  const calendarSuggestions = [
    { icon: '✅', action: 'accept', label: 'Accept' },
    { icon: '❌', action: 'decline', label: 'Decline' },
    { icon: '🔄', action: 'reschedule', label: 'Suggest new time' },
    { icon: '📖', action: 'read', label: 'I\'ll decide later' },
  ];

  const shoppingSuggestions = [
    { icon: '🛒', action: 'order', label: 'Go ahead & order' },
    { icon: '📌', action: 'save', label: 'Save for later' },
    { icon: '🗑️', action: 'ignore', label: 'Not interested' },
  ];

  const slackSuggestions = [
    { icon: '👀', action: 'read', label: 'I\'ll check it' },
    { icon: '💬', action: 'reply', label: 'Reply' },
    { icon: '📌', action: 'save', label: 'Save for later' },
    { icon: '🔕', action: 'mute', label: 'Mute this' },
  ];

  const smartHomeSuggestions = [
    { icon: '👀', action: 'read', label: 'Noted, thanks' },
    { icon: '🔧', action: 'fix', label: 'Take action' },
    { icon: '🔕', action: 'mute', label: 'Mute these alerts' },
  ];

  const defaultSuggestions = [
    { icon: '👀', action: 'read', label: 'I\'ll handle it' },
    { icon: '📥', action: 'archive', label: 'Archive it' },
    { icon: '🗑️', action: 'ignore', label: 'Ignore' },
  ];

  const map = {
    email: emailSuggestions,
    gmail: emailSuggestions,
    calendar: calendarSuggestions,
    slack: slackSuggestions,
    shopping: shoppingSuggestions,
    smart_home: smartHomeSuggestions,
  };

  return map[domain] || defaultSuggestions;
}

function escapeAttr(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Map raw signal source names to normalized domain keys for suggestion lookup.
 */
function resolveSignalDomain(source, fallbackDomain) {
  const s = source.toLowerCase();
  if (['gmail', 'email', 'outlook', 'mail', 'mailchimp', 'sendgrid'].some(k => s.includes(k))) return 'email';
  if (['calendar', 'gcal', 'google_calendar', 'ical'].some(k => s.includes(k))) return 'calendar';
  if (['slack', 'discord', 'teams', 'chat'].some(k => s.includes(k))) return 'slack';
  if (['shopping', 'amazon', 'stripe', 'order'].some(k => s.includes(k))) return 'shopping';
  if (['smart_home', 'nest', 'homekit', 'iot'].some(k => s.includes(k))) return 'smart_home';
  // Check the action's domain too
  if (['email', 'gmail'].includes(fallbackDomain)) return 'email';
  if (['calendar'].includes(fallbackDomain)) return 'calendar';
  return fallbackDomain;
}

/**
 * Map action types to icons for dynamically generated suggestion buttons.
 */
function actionIcon(actionType) {
  const icons = {
    archive_email: '📥', label_email: '🏷️', send_reply: '✉️', delete_email: '🗑️',
    accept_invite: '✅', decline_invite: '❌', propose_alternative: '🔄',
    renew_subscription: '🔄', cancel_subscription: '🚫', snooze_reminder: '⏰',
    place_order: '🛒', add_to_list: '📌', book_travel: '✈️', save_option: '💾',
  };
  return icons[actionType] || '▸';
}

/**
 * Clean up a dynamic alternative's description for use as a button label.
 * Engine descriptions like "Create a note about: Decision needed regarding: [subject]"
 * are way too long and contain internal prefixes — simplify to just the action.
 */
function cleanAltLabel(description, actionType) {
  if (!description) return actionType;
  // Strip internal prefixes (can be nested, so no ^ anchors)
  let label = description
    .replace(/Escalate to user:\s*/i, '')
    .replace(/Decision needed regarding:\s*/i, '')
    .replace(/^Create a note about:\s*/i, 'Note: ');
  // Truncate to something reasonable for a button
  if (label.length > 40) label = label.substring(0, 37) + '…';
  return label;
}

/**
 * Render the "If you approve" detail section showing what the worker will do.
 */
function renderActionDetails(action) {
  if (!action || !action.actionType) return '';

  const lines = [];

  // Describe the concrete execution step
  const step = describeExecutionStep(action);
  if (step) lines.push(step);

  // Show key parameters (filter out internal/sensitive fields)
  const params = action.parameters || {};
  const safeParams = Object.entries(params).filter(
    ([k]) => !['accessToken', 'oauthToken', 'refreshToken', 'credentials'].includes(k),
  );
  if (safeParams.length > 0) {
    const paramLines = safeParams.map(([k, v]) => {
      const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `<span class="detail-param"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(val.length > 120 ? val.slice(0, 120) + '…' : val)}</span>`;
    });
    lines.push(...paramLines);
  }

  // Reversibility + cost
  const meta = [];
  if (action.reversible === true) meta.push('↩ Can be undone');
  if (action.reversible === false) meta.push('⚠ Cannot be undone');
  if (action.estimatedCostCents > 0) meta.push(`💲 $${(action.estimatedCostCents / 100).toFixed(2)}`);
  if (action.domain) meta.push(`📂 ${escapeHtml(action.domain)}`);

  // Twin's reasoning for choosing this action
  if (action.reasoning) lines.push(`<span class="detail-reasoning">${escapeHtml(action.reasoning)}</span>`);

  return `
    <details class="action-details" style="margin: 0.5rem 0; font-size: 0.82rem;">
      <summary style="cursor: pointer; color: var(--text-dim); font-weight: 500;">If you approve — what happens</summary>
      <div style="margin-top: 0.4rem; padding: 0.5rem 0.75rem; border-left: 2px solid var(--border); display: flex; flex-direction: column; gap: 0.25rem;">
        ${lines.join('\n')}
        ${meta.length > 0 ? `<div style="display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.25rem; font-size: 0.78rem; color: var(--text-dim);">${meta.join(' · ')}</div>` : ''}
      </div>
    </details>
  `;
}

/**
 * Map action types to a plain-English execution description.
 */
function describeExecutionStep(action) {
  const p = action.parameters || {};

  const e = (v) => escapeHtml(String(v ?? ''));

  const steps = {
    archive_email: () => `Move the email${p.subject ? ` "${e(p.subject)}"` : ''}${p.from ? ` from ${e(p.from)}` : ''} to archive via Gmail API.`,
    label_email: () => `Apply label${p.label ? ` "${e(p.label)}"` : ''}${p.labels ? ` [${e(p.labels)}]` : ''} to the email${p.subject ? ` "${e(p.subject)}"` : ''} via Gmail API.`,
    send_reply: () => `Send a reply${p.to ? ` to ${e(p.to)}` : ''}${p.subject ? ` re: "${e(p.subject)}"` : ''}. ${p.body ? 'Draft preview: "' + e(String(p.body).slice(0, 80)) + (String(p.body).length > 80 ? '…"' : '"') : ''}`,
    delete_email: () => `Move the email${p.subject ? ` "${e(p.subject)}"` : ''} to trash via Gmail API.`,
    accept_invite: () => `Accept the calendar invite${p.title ? ` "${e(p.title)}"` : ''}${p.date ? ` on ${e(p.date)}` : ''} via Google Calendar API.`,
    decline_invite: () => `Decline the calendar invite${p.title ? ` "${e(p.title)}"` : ''}${p.reason ? ` (reason: ${e(p.reason)})` : ''} via Google Calendar API.`,
    propose_alternative: () => `Suggest an alternative time${p.proposedTime ? ` (${e(p.proposedTime)})` : ''} for ${e(p.title || 'the meeting')} via Google Calendar API.`,
    renew_subscription: () => `Process renewal for ${e(p.service || 'subscription')}${p.amount ? ` at $${(p.amount / 100).toFixed(2)}` : ''}.`,
    cancel_subscription: () => `Cancel subscription for ${e(p.service || 'the service')}${p.effectiveDate ? ` effective ${e(p.effectiveDate)}` : ''}.`,
    snooze_reminder: () => `Snooze this reminder${p.until ? ` until ${e(p.until)}` : ` for ${e(p.duration || '1 hour')}`}.`,
    place_order: () => `Place order${p.item ? ` for "${e(p.item)}"` : ''}${p.quantity ? ` (qty: ${e(p.quantity)})` : ''}.`,
    add_to_list: () => `Add${p.item ? ` "${e(p.item)}"` : ''} to ${e(p.list || 'your list')}.`,
    book_travel: () => `Book ${e(p.type || 'travel')}${p.destination ? ` to ${e(p.destination)}` : ''}${p.date ? ` on ${e(p.date)}` : ''}.`,
    save_option: () => `Save this for later review${p.note ? `: "${e(p.note)}"` : ''}.`,
  };

  const fn = steps[action.actionType];
  if (fn) {
    return `<span class="detail-step"><strong>Action:</strong> ${fn()}</span>`;
  }

  // Fallback for unknown action types
  if (action.description) {
    return `<span class="detail-step"><strong>Action:</strong> ${escapeHtml(action.description)}</span>`;
  }
  return '';
}

function describeAction(action) {
  if (!action) return 'Action pending review';

  // For escalations, show a clean subject instead of the raw "Escalate to user:" prefix
  if (action.actionType === 'escalate_to_user') {
    return escapeHtml(extractEscalationSubject(action));
  }

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

  return descriptions[action.actionType] || escapeHtml(action.description || action.actionType || 'Take action');
}

/**
 * Render a collapsible detail row for history items showing what was (or would have been) executed.
 */
function renderHistoryDetails(a) {
  const action = a.candidateAction || {};
  if (!action.actionType) return '';

  const isEscalation = action.actionType === 'escalate_to_user';

  // For escalations, show what the user chose
  if (isEscalation) {
    const response = a.response;
    const userChoice = response?.reason || '';
    const choiceMatch = userChoice.match(/^User chose: (\w+) \((.+)\)$/);
    const instructionMatch = userChoice.match(/^User instruction: (.+)$/);

    let outcomeText = '';
    if (a.status === 'expired') {
      outcomeText = 'Expired — no response given';
    } else if (choiceMatch) {
      outcomeText = `You chose: ${choiceMatch[2]}`;
    } else if (instructionMatch) {
      outcomeText = `You said: "${instructionMatch[1]}"`;
    } else if (a.status === 'rejected') {
      outcomeText = 'Dismissed';
    } else {
      outcomeText = a.status || '';
    }

    return `
      <div style="font-size: 0.78rem; margin-top: 0.25rem; color: var(--text-dim); padding-left: 0.5rem; border-left: 2px solid var(--border);">
        ${outcomeText ? `<span style="font-style: italic;">${escapeHtml(outcomeText)}</span>` : ''}
        ${action.domain ? ` · ${escapeHtml(action.domain)}` : ''}
      </div>
    `;
  }

  const step = describeExecutionStep(action);
  const meta = [];
  if (action.reversible === true) meta.push('↩ Reversible');
  if (action.reversible === false) meta.push('⚠ Irreversible');
  if (action.estimatedCostCents > 0) meta.push(`$${(action.estimatedCostCents / 100).toFixed(2)}`);
  if (action.domain) meta.push(escapeHtml(action.domain));

  const statusNote = a.status === 'approved' ? 'Executed via worker' :
    a.status === 'rejected' ? 'Skipped — you said no' :
    a.status === 'expired' ? 'Expired — no action taken' : '';

  return `
    <details style="font-size: 0.78rem; margin-top: 0.25rem; color: var(--text-dim);">
      <summary style="cursor: pointer;">What ${a.status === 'approved' ? 'happened' : 'would have happened'}</summary>
      <div style="padding: 0.3rem 0.5rem 0.3rem 0.75rem; border-left: 2px solid var(--border); margin-top: 0.2rem;">
        ${step || ''}
        ${meta.length > 0 ? `<div style="margin-top: 0.2rem;">${meta.join(' · ')}</div>` : ''}
        ${statusNote ? `<div style="margin-top: 0.2rem; font-style: italic;">${statusNote}</div>` : ''}
      </div>
    </details>
  `;
}

function explainReason(action, reason) {
  if (reason) return escapeHtml(reason);

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

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

/**
 * Handle a suggested action choice on an escalation card.
 * Sends as a rejection with the chosen action as the reason,
 * so the twin learns the user's preference for this type of signal.
 */
window.handleEscalationChoice = async function(requestId, userId, chosenAction, label) {
  const reason = `User chose: ${chosenAction} (${label})`;
  try {
    await respondToApproval(requestId, 'reject', userId, reason);

    const el = document.getElementById(`approval-${requestId}`);
    if (el) {
      el.style.opacity = '0.5';
      el.style.pointerEvents = 'none';
      el.querySelector('.escalation-suggestions')?.remove();
      const actions = el.querySelector('.escalation-prompt');
      if (actions) actions.innerHTML = `<span class="badge badge-success">Got it — ${escapeHtml(label)}</span>`;
    }
    showToast(`Got it — I'll remember to "${label}" for things like this.`);
  } catch (err) {
    const el = document.getElementById(`approval-${requestId}`);
    if (el) {
      el.insertAdjacentHTML('beforeend', `<div class="error-banner" style="margin-top: 0.5rem;">${escapeHtml(err.message)}</div>`);
    }
  }
};

/**
 * Handle a free-text instruction on an escalation card.
 */
window.handleEscalationCustom = async function(requestId, userId) {
  const input = document.getElementById(`reason-${requestId}`);
  const text = input?.value?.trim();
  if (!text) {
    input?.focus();
    return;
  }
  const reason = `User instruction: ${text}`;
  try {
    await respondToApproval(requestId, 'reject', userId, reason);

    const el = document.getElementById(`approval-${requestId}`);
    if (el) {
      el.style.opacity = '0.5';
      el.style.pointerEvents = 'none';
      el.querySelector('.escalation-suggestions')?.remove();
      const prompt = el.querySelector('.escalation-prompt');
      if (prompt) prompt.innerHTML = `<span class="badge badge-success">Got it — noted your preference</span>`;
    }
    showToast('Thanks — I\'ll learn from that.');
  } catch (err) {
    const el = document.getElementById(`approval-${requestId}`);
    if (el) {
      el.insertAdjacentHTML('beforeend', `<div class="error-banner" style="margin-top: 0.5rem;">${escapeHtml(err.message)}</div>`);
    }
  }
};

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

    const toastMsg = action === 'approve' ? 'Got it — I\'ll handle this for you.' : 'Noted — I won\'t do that.';
    showToast(toastMsg);
  } catch (err) {
    const el = document.getElementById(`approval-${requestId}`);
    if (el) {
      el.insertAdjacentHTML('beforeend', `<div class="error-banner" style="margin-top: 0.5rem;">${escapeHtml(err.message)}</div>`);
    }
  }
};
