import { fetchAudit, escapeHtml } from '../api-client.js';

const TYPE_ICONS = {
  tier_change: '\u{1F6E1}',  // shield
  spend_event: '\u{1F4B0}',  // money bag
  preference_change: '\u{1F4A1}', // light bulb
};

const TYPE_LABELS = {
  tier_change: 'Trust Tier Change',
  spend_event: 'Spend Event',
  preference_change: 'Preference Learned',
};

function formatTimestamp(ts) {
  return new Date(ts).toLocaleString();
}

export async function renderAudit(container, userId) {
  container.innerHTML = `
    <div class="audit-page">
      <h2>Audit Timeline</h2>
      <p class="subtitle">Track trust tier changes, spending, and preference evolution.</p>

      <div class="audit-filters">
        <label><input type="checkbox" data-type="tier_change" checked> Trust Tier</label>
        <label><input type="checkbox" data-type="spend_event" checked> Spend</label>
        <label><input type="checkbox" data-type="preference_change" checked> Preferences</label>
        <input type="date" id="audit-from" placeholder="From">
        <input type="date" id="audit-to" placeholder="To">
        <button id="audit-refresh" class="btn btn-sm">Refresh</button>
      </div>

      <div id="audit-timeline" class="audit-timeline">
        <div class="loading">Loading audit trail...</div>
      </div>
    </div>
  `;

  async function loadAudit() {
    const types = Array.from(container.querySelectorAll('.audit-filters input[type="checkbox"]:checked'))
      .map(cb => cb.dataset.type);
    const from = container.querySelector('#audit-from').value;
    const to = container.querySelector('#audit-to').value;

    const timeline = container.querySelector('#audit-timeline');
    timeline.innerHTML = '<div class="loading">Loading...</div>';

    try {
      // If all types are checked, don't filter — otherwise fetch each type
      let allEntries = [];
      if (types.length === 3 || types.length === 0) {
        const data = await fetchAudit(userId, { limit: '100', ...(from && { from }), ...(to && { to }) });
        allEntries = data.entries;
      } else {
        for (const type of types) {
          const data = await fetchAudit(userId, { type, limit: '50', ...(from && { from }), ...(to && { to }) });
          allEntries.push(...data.entries);
        }
        allEntries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      }

      if (allEntries.length === 0) {
        timeline.innerHTML = `<div class="empty-state">
          <div class="empty-state-title">No audit events yet</div>
          <div class="empty-state-desc">Once your twin starts making decisions, every action will be logged here — trust tier changes, spending, and what it learns about you. This is your full paper trail.</div>
        </div>`;
        return;
      }

      timeline.innerHTML = allEntries.map(entry => `
        <div class="audit-entry audit-${escapeHtml(entry.type)}">
          <div class="audit-icon">${TYPE_ICONS[entry.type] || '?'}</div>
          <div class="audit-body">
            <div class="audit-header">
              <span class="audit-type-badge">${escapeHtml(TYPE_LABELS[entry.type] || entry.type)}</span>
              <time class="audit-time">${formatTimestamp(entry.timestamp)}</time>
            </div>
            <div class="audit-description">${escapeHtml(entry.description)}</div>
            ${entry.detail?.decisionId ? `<a href="#/decisions" class="audit-link">View decision</a>` : ''}
          </div>
        </div>
      `).join('');
    } catch (err) {
      timeline.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }

  container.querySelector('#audit-refresh').addEventListener('click', loadAudit);
  container.querySelectorAll('.audit-filters input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', loadAudit);
  });

  await loadAudit();
}
