import { fetchDecisions, fetchDecisionExplanation, submitFeedback, escapeHtml } from '../api-client.js';

let currentUserId = '';

export async function renderDecisions(container, userId) {
  currentUserId = userId;

  container.innerHTML = `
    <div class="decisions-page">
      <div class="card" style="border-left: 3px solid var(--primary);">
        <div class="card-header">
          <span class="card-title">What I've been doing for you</span>
        </div>
        <div class="card-subtitle">
          A running log of every call your twin has made on your behalf — what it saw, what it
          decided, and why. Click any row to read the full reasoning.
        </div>
      </div>

      <details class="card collapsible-card" style="margin-bottom: 1rem;">
        <summary class="card-header collapsible-header">
          <span class="card-title" style="font-size: 0.9rem;">Filter or search</span>
          <span class="collapse-icon"></span>
        </summary>
        <div class="collapsible-body">
          <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: end;">
            <div>
              <label style="font-size: 0.75rem; display: block;">Area</label>
              <select id="filter-domain">
                <option value="">All</option>
                <option value="email">Email</option>
                <option value="calendar">Calendar</option>
                <option value="subscriptions">Subscriptions</option>
                <option value="shopping">Shopping</option>
                <option value="travel">Travel</option>
                <option value="communication">Communication</option>
                <option value="finance">Finance</option>
                <option value="health">Health</option>
                <option value="home">Home</option>
                <option value="food">Food</option>
              </select>
            </div>
            <div>
              <label style="font-size: 0.75rem; display: block;">From</label>
              <input type="date" id="filter-from">
            </div>
            <div>
              <label style="font-size: 0.75rem; display: block;">To</label>
              <input type="date" id="filter-to">
            </div>
            <div>
              <label style="font-size: 0.75rem; display: block;">Search</label>
              <input type="text" id="filter-search" placeholder="Search…" style="width: 160px;">
            </div>
            <button id="filter-apply" class="btn btn-sm">Apply</button>
            <button id="filter-clear" class="btn btn-sm btn-ghost">Clear</button>
          </div>
          <div id="filter-count" style="font-size: 0.75rem; margin-top: 0.5rem; color: var(--text-muted);"></div>
        </div>
      </details>

      <div id="decisions-list">
        <div class="loading">Loading…</div>
      </div>
    </div>
  `;

  async function loadDecisions() {
    const domain = container.querySelector('#filter-domain').value;
    const from = container.querySelector('#filter-from').value;
    const to = container.querySelector('#filter-to').value;
    const search = container.querySelector('#filter-search').value;

    const listEl = container.querySelector('#decisions-list');
    listEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      const params = { limit: '50' };
      if (domain) params.domain = domain;
      if (from) params.from = from;
      if (to) params.to = to;
      if (search) params.search = search;

      const result = await fetchDecisions(userId, params);
      const decisions = result.decisions ?? [];

      container.querySelector('#filter-count').textContent =
        `${result.total} decision${result.total !== 1 ? 's' : ''} found`;

      if (decisions.length === 0) {
        const hasFilters = !!(domain || from || to || search);
        listEl.innerHTML = hasFilters
          ? `
            <div class="empty-state">
              <div class="empty-state-title">Nothing matches those filters</div>
              <div class="empty-state-desc">Try widening the date range or clearing the search.</div>
            </div>
          `
          : `
            <div class="card">
              <div class="card-header">
                <span class="card-title">Nothing yet — but here's what I'll handle</span>
              </div>
              <div class="card-subtitle" style="margin-bottom: 1rem;">
                Once your accounts are connected and a signal comes in, every call I make will land here. A few of the kinds of things I'll be deciding on:
              </div>
              <div class="insight-card">
                <div class="insight-icon" style="background: var(--accent-soft); color: var(--accent);">E</div>
                <div class="insight-content">
                  <div class="insight-title">Newsletter you usually archive</div>
                  <div class="insight-desc">"You've archived the last 11 of these without reading. Want me to start handling them?"</div>
                </div>
              </div>
              <div class="insight-card">
                <div class="insight-icon" style="background: var(--accent-soft); color: var(--accent);">C</div>
                <div class="insight-content">
                  <div class="insight-title">Calendar conflict</div>
                  <div class="insight-desc">"This new invite overlaps with your skip-level — based on your past behavior I'd suggest declining and asking for a reschedule."</div>
                </div>
              </div>
              <div class="insight-card">
                <div class="insight-icon" style="background: var(--accent-soft); color: var(--accent);">$</div>
                <div class="insight-content">
                  <div class="insight-title">Subscription renewal</div>
                  <div class="insight-desc">"Streaming service, $15.99/mo. You used it 3× this month — within your auto-renew rules, so I'll let it through."</div>
                </div>
              </div>
            </div>
          `;
        return;
      }

      listEl.innerHTML = `
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Area</th>
                  <th>What happened</th>
                  <th>Urgency</th>
                  <th>How</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${decisions.map(d => `
                  <tr style="cursor: pointer;" onclick="toggleExplanation('${escapeHtml(d.id)}', this)">
                    <td>${formatTime(d.createdAt || d.created_at)}</td>
                    <td><span class="badge badge-info">${escapeHtml(domainLabel(d.domain))}</span></td>
                    <td>${escapeHtml(situationLabel(d.situationType || d.situation_type))}</td>
                    <td><span class="badge badge-${urgencyBadge(d.urgency)}">${escapeHtml(d.urgency || '--')}</span></td>
                    <td>${d.autoExecuted === true
                      ? '<span class="badge badge-accent" title="Your twin handled this automatically">Auto</span>'
                      : d.autoExecuted === false
                        ? '<span class="badge badge-success" title="You approved this action">You OK\'d</span>'
                        : '<span class="badge badge-muted" title="Decision pending">Pending</span>'
                    }</td>
                    <td>
                      <button class="btn btn-sm btn-outline undo-btn" data-decision-id="${escapeHtml(d.id)}"
                              onclick="event.stopPropagation(); showUndoModal('${escapeHtml(d.id)}')">
                        Undo
                      </button>
                    </td>
                  </tr>
                  <tr class="explanation-row" id="explain-${escapeHtml(d.id)}" style="display: none;">
                    <td colspan="6" style="background: var(--bg); padding: 1rem;">
                      <div class="loading" style="padding: 0.5rem;">Loading explanation...</div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    } catch (err) {
      listEl.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }

  container.querySelector('#filter-apply').addEventListener('click', loadDecisions);
  container.querySelector('#filter-clear').addEventListener('click', () => {
    container.querySelector('#filter-domain').value = '';
    container.querySelector('#filter-from').value = '';
    container.querySelector('#filter-to').value = '';
    container.querySelector('#filter-search').value = '';
    loadDecisions();
  });

  // Enter key in search triggers filter
  container.querySelector('#filter-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadDecisions();
  });

  await loadDecisions();
}

function domainLabel(domain) {
  const labels = {
    email: 'Email', calendar: 'Calendar', subscriptions: 'Subscriptions',
    shopping: 'Shopping', travel: 'Travel', communication: 'Communication',
    finance: 'Finance', health: 'Health', home: 'Home', food: 'Food',
  };
  return labels[domain] || domain;
}

function situationLabel(type) {
  if (!type) return '--';
  const labels = {
    email_triage: 'Email triage',
    calendar_invite: 'Calendar invite',
    calendar_conflict: 'Calendar conflict',
    calendar_update: 'Calendar update',
    subscription_renewal: 'Subscription renewal',
    grocery_reorder: 'Grocery reorder',
    travel_decision: 'Travel decision',
    finance_operation: 'Finance',
    smart_home: 'Smart home',
    task_management: 'Task',
    social_media: 'Social media',
    document_management: 'Document',
    health_wellness: 'Health',
    generic: 'General',
  };
  // Fallback: snake_case → "Title case" so even unknown types read cleanly.
  return labels[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function urgencyBadge(urgency) {
  const map = { critical: 'danger', high: 'warning', medium: 'info', low: 'muted' };
  return map[urgency] || 'muted';
}

function formatTime(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);

  // Recent: relative time so the user knows it just happened.
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;

  // Older: always include the date so identical times don't blur together.
  // Within the same year: "Apr 7, 9:44 PM". Otherwise include the year.
  const sameYear = d.getFullYear() === now.getFullYear();
  const datePart = d.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
  const timePart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}

window.toggleExplanation = async function(decisionId, row) {
  const explainRow = document.getElementById(`explain-${decisionId}`);
  if (!explainRow) return;

  if (explainRow.style.display !== 'none') {
    explainRow.style.display = 'none';
    return;
  }

  explainRow.style.display = '';

  try {
    const data = await fetchDecisionExplanation(decisionId);
    const e = data.explanation;
    explainRow.querySelector('td').innerHTML = `
      <div style="font-size: 0.85rem; line-height: 1.6;">
        <strong>What happened:</strong> ${escapeHtml(e.whatHappened || 'No details available')}<br>
        <strong>Reasoning:</strong> ${escapeHtml(e.actionRationale || e.confidenceReasoning || '--')}<br>
        ${e.correctionGuidance ? `<strong>To correct:</strong> ${escapeHtml(e.correctionGuidance)}` : ''}
      </div>
    `;
  } catch {
    explainRow.querySelector('td').innerHTML = `
      <div style="font-size: 0.85rem; color: var(--text-muted);">Explanation not available for this decision.</div>
    `;
  }
};

window.showUndoModal = function(decisionId) {
  // Remove existing modal if any
  document.getElementById('undo-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'undo-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width: 480px;">
      <h3>Undo This Action</h3>
      <p style="font-size: 0.85rem; color: var(--text-muted);">
        Help your twin learn by explaining what went wrong.
      </p>
      <div style="display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1rem;">
        <div>
          <label style="font-size: 0.75rem; font-weight: 600;">What went wrong? *</label>
          <textarea id="undo-what-went-wrong" rows="3" required style="width: 100%;"></textarea>
        </div>
        <div>
          <label style="font-size: 0.75rem; font-weight: 600;">Severity</label>
          <select id="undo-severity" style="width: 100%;">
            <option value="minor">Minor</option>
            <option value="moderate" selected>Moderate</option>
            <option value="severe">Severe</option>
          </select>
        </div>
        <div>
          <label style="font-size: 0.75rem; font-weight: 600;">What would have been better?</label>
          <input type="text" id="undo-preferred" style="width: 100%;">
        </div>
      </div>
      <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem;">
        <button class="btn btn-sm btn-ghost" id="undo-cancel">Cancel</button>
        <button class="btn btn-sm btn-danger" id="undo-submit">Undo Action</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#undo-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#undo-submit').addEventListener('click', async () => {
    const whatWentWrong = modal.querySelector('#undo-what-went-wrong').value.trim();
    if (!whatWentWrong) {
      modal.querySelector('#undo-what-went-wrong').focus();
      return;
    }

    const severity = modal.querySelector('#undo-severity').value;
    const preferred = modal.querySelector('#undo-preferred').value.trim();

    try {
      await submitFeedback(currentUserId, decisionId, 'undo', {
        undoReasoning: {
          whatWentWrong,
          severity,
          preferredAlternative: preferred || null,
        },
      });

      modal.remove();

      // Show success toast
      const toast = document.createElement('div');
      toast.className = 'toast toast-success';
      toast.textContent = "Action reversed. I'll remember this for next time.";
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 4000);

      // Update the undo button
      const btn = document.querySelector(`[data-decision-id="${decisionId}"]`);
      if (btn) {
        btn.textContent = 'Undone';
        btn.disabled = true;
      }
    } catch (err) {
      const toast = document.createElement('div');
      toast.className = 'toast toast-error';
      toast.textContent = `Undo failed: ${err.message}`;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 4000);
    }
  });
};
