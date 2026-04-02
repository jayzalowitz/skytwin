import { fetchTwinProfile, fetchLearning, updatePreference, submitFeedback, escapeHtml } from '../api-client.js';

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
    const d = pref.domain || 'general';
    const group = domainGroups.get(d) ?? { preferences: [], inferences: [] };
    group.preferences.push(pref);
    domainGroups.set(d, group);
  }
  for (const inf of inferences) {
    const d = inf.domain || 'general';
    const group = domainGroups.get(d) ?? { preferences: [], inferences: [] };
    group.inferences.push(inf);
    domainGroups.set(d, group);
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">What I've learned about you</span>
        <span class="badge badge-info">${preferences.length + inferences.length} things</span>
      </div>
      <div class="card-subtitle">
        Here's everything I think I know about how you like things done.
        If something's wrong, click "That's not right" and I'll learn from the correction.
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
        <span class="card-title">Tell me something about yourself</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 1rem;">Want me to know something right away instead of waiting for me to figure it out? Tell me here.</div>
      <form id="add-pref-form" onsubmit="return handleAddPreference(event, '${userId}')">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-bottom: 0.5rem;">
          <div class="form-group">
            <label>What area is this about?</label>
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
            <label>What's the rule?</label>
            <input class="form-input" name="key" placeholder="e.g. archive_newsletters" required>
          </div>
        </div>
        <div class="form-group">
          <label>How should I handle it?</label>
          <input class="form-input" name="value" placeholder="e.g. Always archive newsletters from marketing" required>
        </div>
        <button type="submit" class="btn btn-primary">Teach me this</button>
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

  const itemId = `insight-${item.domain}-${item.key || ''}`.replace(/[^a-zA-Z0-9-]/g, '_');
  return `
    <div class="insight-card" id="${itemId}">
      <div class="insight-content">
        <div class="insight-title">${description}</div>
        <div class="insight-desc">
          <span class="badge badge-${confBadge}">${confLbl}</span>
          <span style="margin-left: 0.5rem;">${sourceLabel}</span>
          ${item.reasoning ? `<br><span style="font-size: 0.75rem; color: var(--text-dim);">${item.reasoning}</span>` : ''}
        </div>
      </div>
      <button class="btn btn-outline btn-sm" style="flex-shrink: 0; align-self: center;" onclick="correctInsight('${userId}', '${escapeHtml(item.domain)}', '${escapeHtml(item.key || '')}', this)">That's not right</button>
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
  return labels[domain] || (domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : 'General');
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
    form.insertAdjacentHTML('afterend', `<div class="error-banner" style="margin-top: 0.5rem;">${escapeHtml(err.message)}</div>`);
  }
  return false;
};

window.correctInsight = async function(userId, domain, key, btnEl) {
  const correction = prompt('What should I know instead? (Leave blank to just remove this.)');
  if (correction === null) return; // cancelled

  btnEl.disabled = true;
  btnEl.textContent = 'Updating...';

  try {
    if (correction.trim()) {
      await updatePreference(userId, {
        domain,
        key,
        value: correction.trim(),
        confidence: 'confirmed',
        source: 'corrected',
      });
    } else {
      // Submit feedback that this was wrong
      await submitFeedback(userId, null, 'correction', { domain, key, note: 'User marked as incorrect' });
    }
    const { renderTwin } = await import('./twin.js');
    await renderTwin(document.getElementById('page-content'), userId);
  } catch (err) {
    btnEl.textContent = 'That\'s not right';
    btnEl.disabled = false;
    btnEl.closest('.insight-card')?.insertAdjacentHTML('afterend',
      `<div class="error-banner" style="margin-top: 0.5rem;">${escapeHtml(err.message)}</div>`);
  }
};
