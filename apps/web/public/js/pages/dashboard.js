import { fetchHealth, fetchDecisions, fetchAccuracy, fetchConfidence, fetchLearning, fetchPendingApprovals, fetchSkillGaps, fetchTrustProgress, fetchLearned, fetchUnmetCredentials, escapeHtml } from '../api-client.js';
import { renderTrustProgress } from '../components/progress-bar.js';

export async function renderDashboard(container, userId) {
  const [health, accuracy, confidence, learning, approvals, decisions, skillGaps, progress, learned, unmetCreds] = await Promise.allSettled([
    fetchHealth(),
    fetchAccuracy(userId),
    fetchConfidence(userId),
    fetchLearning(userId),
    fetchPendingApprovals(userId),
    fetchDecisions(userId, { limit: 10 }),
    fetchSkillGaps(userId),
    fetchTrustProgress(userId),
    fetchLearned(userId),
    fetchUnmetCredentials(),
  ]);

  const healthOk = health.status === 'fulfilled';
  const acc = accuracy.status === 'fulfilled' ? accuracy.value : null;
  const conf = confidence.status === 'fulfilled' ? confidence.value : null;
  const learn = learning.status === 'fulfilled' ? learning.value : null;
  const pending = approvals.status === 'fulfilled' ? (approvals.value.approvals?.length ?? 0) : 0;
  const recentDecisions = decisions.status === 'fulfilled' ? (decisions.value.decisions ?? []) : [];

  const prog = progress.status === 'fulfilled' ? progress.value : null;
  const learnedData = learned.status === 'fulfilled' ? learned.value : null;

  const overallConf = conf?.overallConfidence ?? 0;
  const confLabel = overallConf >= 75 ? 'Very confident' : overallConf >= 50 ? 'Getting there' : overallConf >= 25 ? 'Still learning' : 'Just started';
  const confClass = overallConf >= 75 ? 'high' : overallConf >= 50 ? 'moderate' : overallConf >= 25 ? 'low' : 'speculative';

  container.innerHTML = `
    ${!healthOk ? '<div class="error-banner">Unable to reach the API server. Your twin may not be processing events.</div>' : ''}
    ${pending > 0 ? `<div class="card" style="border-left: 3px solid var(--warning); cursor: pointer;" onclick="location.hash='#/approvals'">
      <span style="font-weight: 600;">You have ${pending} pending approval${pending > 1 ? 's' : ''}</span>
      <span style="color: var(--text-muted); font-size: 0.85rem;"> — your twin wants to do something and needs your OK.</span>
    </div>` : ''}

    ${renderUnmetCredentials(unmetCreds)}

    ${prog ? renderTrustProgress({ approvalCount: prog.approvalCount, currentTier: prog.currentTier }) : ''}

    ${learnedData && learnedData.summaries && learnedData.summaries.length >= 2 ? `
      <div class="card">
        <div class="card-header">
          <span class="card-title">What I've learned so far</span>
        </div>
        ${learnedData.summaries.slice(0, 5).map(s => `
          <div class="insight-card">
            <div class="insight-icon" style="background: var(--accent-soft, #e3f2fd); color: var(--accent, #1976d2);">
              ${domainIcon(s.domain)}
            </div>
            <div class="insight-content">
              <div class="insight-title">${domainLabel(s.domain)}</div>
              <div class="insight-desc">${s.description}</div>
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div class="stats-grid">
      <div class="card stat-card">
        <div class="stat-value">${overallConf}%</div>
        <div class="stat-label">How well I know you</div>
        <div class="stat-sublabel">${confLabel}</div>
        <div class="confidence-bar"><div class="confidence-fill ${confClass}" style="width: ${overallConf}%"></div></div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">${acc ? `${Math.round(acc.accuracyRate * 100)}%` : '--'}</div>
        <div class="stat-label">Getting it right</div>
        <div class="stat-sublabel">${acc ? `You approved ${acc.approved} of ${acc.totalDecisions}` : 'No feedback yet'}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">${learn?.totalPreferences ?? 0}</div>
        <div class="stat-label">Things I've learned</div>
        <div class="stat-sublabel">${learn?.totalInferences ?? 0} figured out on my own</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">${learn?.totalPatterns ?? 0}</div>
        <div class="stat-label">Habits I've noticed</div>
        <div class="stat-sublabel">${learn?.totalTraits ?? 0} personality traits</div>
      </div>
    </div>

    ${conf?.domains && Object.keys(conf.domains).length > 0 ? `
      <div class="card">
        <div class="card-header">
          <span class="card-title">Confidence by area</span>
        </div>
        ${Object.entries(conf.domains).map(([domain, pct]) => {
          const cls = pct >= 75 ? 'high' : pct >= 50 ? 'moderate' : pct >= 25 ? 'low' : 'speculative';
          return `
            <div style="margin-bottom: 0.75rem;">
              <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
                <span>${domainLabel(domain)}</span>
                <span style="color: var(--text-muted);">${pct}%</span>
              </div>
              <div class="confidence-bar"><div class="confidence-fill ${cls}" style="width: ${pct}%"></div></div>
            </div>
          `;
        }).join('')}
      </div>
    ` : ''}

    ${learn?.traits && learn.traits.length > 0 ? `
      <div class="card">
        <div class="card-header">
          <span class="card-title">What I've noticed about you</span>
        </div>
        ${learn.traits.map(t => `
          <div class="insight-card">
            <div class="insight-icon" style="background: var(--accent-soft); color: var(--accent);">
              ${traitIcon(t.name)}
            </div>
            <div class="insight-content">
              <div class="insight-title">${traitLabel(t.name)}</div>
              <div class="insight-desc">${t.description}</div>
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${renderSkillGaps(skillGaps)}

    <div class="card">
      <div class="card-header">
        <span class="card-title">Recent activity</span>
      </div>
      ${recentDecisions.length > 0
        ? recentDecisions.map(d => `
          <div class="activity-item">
            <span class="activity-time">${formatTime(d.createdAt || d.created_at)}</span>
            <span class="activity-desc">${domainLabel(d.domain)} — ${d.situationType || d.situation_type}</span>
            <span class="badge badge-info">${d.domain}</span>
          </div>
        `).join('')
        : '<div class="empty-state"><div class="empty-state-title">No activity yet</div><div class="empty-state-desc">Once your twin starts processing events, you\'ll see them here.</div></div>'
      }
    </div>
  `;
}

function domainIcon(domain) {
  const icons = { email: 'E', calendar: 'C', finance: '$', shopping: 'S', travel: 'T', subscriptions: 'R', general: 'G' };
  return icons[domain] || '?';
}

function domainLabel(domain) {
  const labels = {
    email: 'Email',
    calendar: 'Calendar',
    subscriptions: 'Subscriptions',
    shopping: 'Shopping',
    travel: 'Travel',
    general: 'General',
    correction: 'Corrections',
  };
  return labels[domain] || (domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : 'General');
}

function traitLabel(name) {
  const labels = {
    cautious_spender: 'You\'re careful with spending',
    quick_responder: 'You respond quickly',
    privacy_conscious: 'You value privacy',
    routine_driven: 'You like routines',
    delegation_averse: 'You prefer doing things yourself',
  };
  return labels[name] || name.replace(/_/g, ' ');
}

function traitIcon(name) {
  const icons = {
    cautious_spender: '$',
    quick_responder: '!',
    privacy_conscious: '?',
    routine_driven: '~',
    delegation_averse: '*',
  };
  return icons[name] || '?';
}

function renderUnmetCredentials(unmetCredsResult) {
  const unmet = unmetCredsResult.status === 'fulfilled' ? (unmetCredsResult.value.unmet ?? []) : [];
  if (unmet.length === 0) return '';

  return `
    <div class="card" style="border-left: 3px solid var(--warning, #e6a700); cursor: pointer;" onclick="location.hash='#/setup'">
      <div class="card-header">
        <span class="card-title">Integrations needed</span>
      </div>
      <div class="card-subtitle" style="margin-bottom: 0.75rem;">
        Some skills need external accounts to work. Head to <a href="#/setup">Setup</a> to add credentials.
      </div>
      ${unmet.map(u => `
        <div class="insight-card">
          <div class="insight-icon" style="background: var(--warning-soft, #fff3cd); color: var(--warning, #856404);">!</div>
          <div class="insight-content">
            <div class="insight-title">${escapeHtml(u.label)}</div>
            <div class="insight-desc">Missing: ${u.missingFields.map(f => escapeHtml(f)).join(', ')}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderSkillGaps(skillGapsResult) {
  const gaps = skillGapsResult.status === 'fulfilled' ? (skillGapsResult.value.gaps ?? []) : [];
  if (gaps.length === 0) return '';

  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Where I need your help</span>
      </div>
      ${gaps.map(g => `
        <div class="insight-card">
          <div class="insight-icon" style="background: var(--warning-soft, #fff3cd); color: var(--warning, #856404);">?</div>
          <div class="insight-content">
            <div class="insight-title">${g.domain ? domainLabel(g.domain) : 'General'}</div>
            <div class="insight-desc">${g.description || g.gap || 'I haven\'t learned enough about this area yet.'}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function formatTime(dateStr) {
  if (!dateStr) return '--';
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
