import { fetchDecisions, fetchDecisionExplanation } from '../api-client.js';

export async function renderDecisions(container, userId) {
  let decisions = [];
  try {
    const result = await fetchDecisions(userId, { limit: 50 });
    decisions = result.decisions ?? [];
  } catch { /* empty */ }

  if (decisions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">No decisions yet</div>
        <div class="empty-state-desc">
          Once your twin starts processing events from your email and calendar, you'll see a history of every decision here — what happened, what it did, and why.
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-subtitle" style="margin-bottom: 1rem;">
        Every decision your twin has made, with the reasoning behind it. Click any row to see the full explanation.
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Area</th>
              <th>What happened</th>
              <th>Urgency</th>
            </tr>
          </thead>
          <tbody>
            ${decisions.map(d => `
              <tr style="cursor: pointer;" onclick="toggleExplanation('${d.id}', this)">
                <td>${formatTime(d.createdAt || d.created_at)}</td>
                <td><span class="badge badge-info">${domainLabel(d.domain)}</span></td>
                <td>${d.situationType || d.situation_type || '--'}</td>
                <td><span class="badge badge-${urgencyBadge(d.urgency)}">${d.urgency || '--'}</span></td>
              </tr>
              <tr class="explanation-row" id="explain-${d.id}" style="display: none;">
                <td colspan="4" style="background: var(--bg); padding: 1rem;">
                  <div class="loading" style="padding: 0.5rem;">Loading explanation...</div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function domainLabel(domain) {
  const labels = { email: 'Email', calendar: 'Calendar', subscriptions: 'Subscriptions', shopping: 'Shopping', travel: 'Travel' };
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
        <strong>What happened:</strong> ${e.whatHappened || 'No details available'}<br>
        <strong>Reasoning:</strong> ${e.actionRationale || e.confidenceReasoning || '--'}<br>
        ${e.correctionGuidance ? `<strong>To correct:</strong> ${e.correctionGuidance}` : ''}
      </div>
    `;
  } catch {
    explainRow.querySelector('td').innerHTML = `
      <div style="font-size: 0.85rem; color: var(--text-muted);">Explanation not available for this decision.</div>
    `;
  }
};
