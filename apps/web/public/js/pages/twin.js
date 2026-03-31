import { fetchTwinProfile, fetchLearning, updatePreference } from '../api-client.js';

export async function renderTwin(container, userId) {
  let profile = null;
  let learning = null;

  try {
    const [profileResult, learningResult] = await Promise.allSettled([
      fetchTwinProfile(userId),
      fetchLearning(userId),
    ]);
    profile = profileResult.status === 'fulfilled' ? (profileResult.value.profile ?? profileResult.value) : null;
    learning = learningResult.status === 'fulfilled' ? learningResult.value : null;
  } catch { /* empty */ }

  if (!profile) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">Your twin hasn't learned anything yet</div>
        <div class="empty-state-desc">
          Once events start flowing in from your email and calendar, your twin will begin building a profile of your preferences here.
        </div>
      </div>
    `;
    return;
  }

  const preferences = profile.preferences ?? [];
  const inferences = profile.inferences ?? [];

  // Group by domain
  const domainGroups = new Map();
  for (const pref of preferences) {
    const group = domainGroups.get(pref.domain) ?? { preferences: [], inferences: [] };
    group.preferences.push(pref);
    domainGroups.set(pref.domain, group);
  }
  for (const inf of inferences) {
    const group = domainGroups.get(inf.domain) ?? { preferences: [], inferences: [] };
    group.inferences.push(inf);
    domainGroups.set(inf.domain, group);
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Your twin's understanding (v${profile.version ?? 1})</span>
        <span class="badge badge-info">${preferences.length} preferences, ${inferences.length} inferences</span>
      </div>
      <div class="card-subtitle">
        This is everything your twin has learned about how you like things done.
        You can correct anything that's wrong — just click "That's not right" to fix it.
      </div>
    </div>

    ${domainGroups.size > 0
      ? Array.from(domainGroups.entries()).map(([domain, group]) =>
          renderDomainGroup(domain, group, userId)
        ).join('')
      : `
        <div class="empty-state">
          <div class="empty-state-title">Still learning</div>
          <div class="empty-state-desc">No preferences or inferences yet. Your twin needs more data to start building your profile.</div>
        </div>
      `
    }

    ${learning?.patterns && learning.patterns.length > 0 ? `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Behavioral patterns</span>
        </div>
        <div class="card-subtitle">Habits your twin has noticed from repeated behavior.</div>
        ${learning.patterns.map(p => `
          <div class="insight-card">
            <div class="insight-content">
              <div class="insight-title">${p.description || p.action}</div>
              <div class="insight-desc">
                Seen ${p.frequency} times — confidence: <span class="badge badge-${confidenceBadge(p.confidence)}">${confidenceLabel(p.confidence)}</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div class="card">
      <div class="card-header">
        <span class="card-title">Tell your twin something</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">Explicitly set a preference so your twin knows right away.</div>
      <form id="add-pref-form" onsubmit="return handleAddPreference(event, '${userId}')">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-bottom: 0.5rem;">
          <div class="form-group">
            <label>Area</label>
            <select class="form-input" name="domain">
              <option value="email">Email</option>
              <option value="calendar">Calendar</option>
              <option value="subscriptions">Subscriptions</option>
              <option value="shopping">Shopping</option>
              <option value="travel">Travel</option>
              <option value="general">General</option>
            </select>
          </div>
          <div class="form-group">
            <label>What should I know?</label>
            <input class="form-input" name="key" placeholder="e.g. auto_archive_newsletters" required>
          </div>
        </div>
        <div class="form-group">
          <label>Value / instruction</label>
          <input class="form-input" name="value" placeholder="e.g. true, or: always archive newsletters from marketing" required>
        </div>
        <button type="submit" class="btn btn-primary">Save preference</button>
      </form>
    </div>
  `;
}

function renderDomainGroup(domain, group, userId) {
  const domainName = domainLabel(domain);
  const allItems = [
    ...group.preferences.map(p => ({ ...p, source: p.source || 'explicit', isPreference: true })),
    ...group.inferences.map(i => ({ ...i, source: 'inferred', isPreference: false })),
  ];

  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">${domainName}</span>
        <span class="badge badge-accent">${group.preferences.length} prefs, ${group.inferences.length} inferences</span>
      </div>
      ${allItems.map(item => renderInsightItem(item, userId)).join('')}
    </div>
  `;
}

function renderInsightItem(item, userId) {
  const confBadge = confidenceBadge(item.confidence);
  const confLbl = confidenceLabel(item.confidence);
  const description = describePreference(item.domain, item.key, item.value, item.source);
  const sourceLabel = item.source === 'explicit' ? 'You told me'
    : item.source === 'corrected' ? 'You corrected this'
    : item.source === 'inferred' ? 'I figured this out'
    : 'Learned from defaults';

  return `
    <div class="insight-card">
      <div class="insight-content">
        <div class="insight-title">${description}</div>
        <div class="insight-desc">
          <span class="badge badge-${confBadge}">${confLbl}</span>
          <span style="margin-left: 0.5rem;">${sourceLabel}</span>
          ${item.reasoning ? `<br><span style="font-size: 0.75rem; color: var(--text-dim);">${item.reasoning}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function describePreference(domain, key, value, source) {
  // Try to generate a human-readable description
  const v = String(value);

  // Common patterns
  if (key.startsWith('auto_') || key.startsWith('preferred_action_')) {
    const action = key.replace('auto_', '').replace('preferred_action_', '').replace(/_/g, ' ');
    if (v === 'true') return `Auto-${action} is enabled`;
    if (v === 'false') return `Auto-${action} is disabled`;
    return `For ${action}: ${v}`;
  }

  if (key.startsWith('behavior_')) {
    return `Behavior pattern: ${v}`;
  }

  if (key.startsWith('observation_')) {
    return `Observation: ${typeof value === 'object' ? JSON.stringify(value) : v}`;
  }

  // Fallback: make it readable
  const readableKey = key.replace(/_/g, ' ');
  return `${readableKey}: ${typeof value === 'object' ? JSON.stringify(value) : v}`;
}

function domainLabel(domain) {
  const labels = {
    email: 'Email habits',
    calendar: 'Calendar style',
    subscriptions: 'Subscription preferences',
    shopping: 'Shopping tendencies',
    travel: 'Travel preferences',
    general: 'General preferences',
    correction: 'Your corrections',
  };
  return labels[domain] || domain.charAt(0).toUpperCase() + domain.slice(1);
}

function confidenceBadge(level) {
  const map = { confirmed: 'success', high: 'success', moderate: 'warning', low: 'info', speculative: 'muted' };
  return map[(level ?? '').toLowerCase()] ?? 'muted';
}

function confidenceLabel(level) {
  const map = { confirmed: 'Confirmed', high: 'Very confident', moderate: 'Fairly sure', low: 'Still learning', speculative: 'Just a guess' };
  return map[(level ?? '').toLowerCase()] ?? level;
}

window.handleAddPreference = async function(event, userId) {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);

  try {
    await updatePreference(userId, {
      domain: data.get('domain'),
      key: data.get('key'),
      value: data.get('value'),
      confidence: 'confirmed',
      source: 'explicit',
    });
    form.reset();
    // Re-render
    const { renderTwin } = await import('./twin.js');
    await renderTwin(document.getElementById('page-content'), userId);
  } catch (err) {
    form.insertAdjacentHTML('afterend', `<div class="error-banner" style="margin-top: 0.5rem;">${err.message}</div>`);
  }
  return false;
};
