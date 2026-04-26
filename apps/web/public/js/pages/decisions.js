import { fetchDecisions, fetchDecisionExplanation, submitFeedback, escapeHtml } from '../api-client.js';

let currentUserId = '';

export async function renderDecisions(container, userId) {
  currentUserId = userId;

  container.innerHTML = `
    <div class="decisions-page">
      <h2>Decision History</h2>
      <p class="subtitle">Every decision your twin has made, with the reasoning behind it.</p>

      <div class="decision-filters card" style="margin-bottom: 1rem; padding: 1rem;">
        <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: end;">
          <div>
            <label style="font-size: 0.75rem; display: block;">Domain</label>
            <select id="filter-domain">
              <option value="">All domains</option>
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
            <input type="text" id="filter-search" placeholder="Search decisions..." style="width: 160px;">
          </div>
          <button id="filter-apply" class="btn btn-sm">Filter</button>
          <button id="filter-clear" class="btn btn-sm btn-ghost">Clear</button>
        </div>
        <div id="filter-count" style="font-size: 0.75rem; margin-top: 0.5rem; color: var(--text-muted);"></div>
      </div>

      <div id="decisions-list">
        <div class="loading">Loading decisions...</div>
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
        listEl.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-title">No decisions found</div>
            <div class="empty-state-desc">Try adjusting your filters or wait for new signals.</div>
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
                    <td>${escapeHtml(d.situationType || d.situation_type || '--')}</td>
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

function urgencyBadge(urgency) {
  const map = { critical: 'danger', high: 'warning', medium: 'info', low: 'muted' };
  return map[urgency] || 'muted';
}

function formatTime(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffHr = Math.floor(diffMs / 3600000);
  if (diffHr < 24) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffHr < 168) return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString();
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
