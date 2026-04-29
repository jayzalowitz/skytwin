import { fetchAudit, escapeHtml } from '../api-client.js';

const TYPE_ICONS = {
  tier_change: '\u{1F6E1}',  // shield
  spend_event: '\u{1F4B0}',  // money bag
  preference_change: '\u{1F4A1}', // light bulb
};

const TYPE_LABELS = {
  tier_change: 'Trust earned',
  spend_event: 'Money moved',
  preference_change: 'Learned about you',
};

function formatTimestamp(ts) {
  return new Date(ts).toLocaleString();
}

export async function renderAudit(container, userId) {
  container.innerHTML = `
    <div class="audit-page">
      <div class="card" style="border-left: 3px solid var(--primary);">
        <div class="card-header">
          <span class="card-title">The full paper trail</span>
        </div>
        <div class="card-subtitle">
          Every time your twin earns trust, spends money, or learns something about you, it gets logged here.
          Filter by type or date if you're looking for something specific.
        </div>
      </div>

      <div class="audit-filters" style="margin: 0.5rem 0 1rem;">
        <label><input type="checkbox" data-type="tier_change" checked> Trust changes</label>
        <label><input type="checkbox" data-type="spend_event" checked> Spending</label>
        <label><input type="checkbox" data-type="preference_change" checked> Things learned</label>
        <input type="date" id="audit-from" placeholder="From">
        <input type="date" id="audit-to" placeholder="To">
        <button id="audit-refresh" class="btn btn-sm">Refresh</button>
      </div>

      <div id="audit-timeline" class="audit-timeline">
        <div class="loading">Loading…</div>
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
          <div class="empty-state-title">Nothing logged yet</div>
          <div class="empty-state-desc">As your twin earns trust, makes spending decisions, or learns something new about you, those moments land here with timestamps you can rely on. Nothing happens in the dark.</div>
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
