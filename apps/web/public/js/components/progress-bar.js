/**
 * Reusable trust tier progress bar component.
 *
 * Usage:
 *   renderTrustProgress({ approvalCount, currentTier })
 *
 * Returns an HTML string.
 */

const TIER_INFO = {
  observer:          { label: 'Watch & Suggest', next: 'Ask me first',         threshold: 10, order: 0 },
  suggest:           { label: 'Ask me first',    next: 'Handle small stuff',   threshold: 20, order: 1 },
  low_autonomy:      { label: 'Handle small stuff', next: 'Handle most things', threshold: 50, order: 2 },
  moderate_autonomy: { label: 'Handle most things', next: 'Full autopilot',    threshold: 100, order: 3 },
  high_autonomy:     { label: 'Full autopilot',  next: null,                    threshold: null, order: 4 },
};

export function renderTrustProgress({ approvalCount = 0, currentTier = 'observer' }) {
  const info = TIER_INFO[currentTier] || TIER_INFO.observer;

  // Already at max tier
  if (!info.threshold) {
    return `
      <div class="trust-progress card">
        <div class="trust-progress-header">
          <span class="trust-progress-tier">${info.label}</span>
          <span class="trust-progress-status" style="color: var(--success);">Maximum trust</span>
        </div>
        <div class="trust-progress-desc">I handle everything within your rules. You're fully in control.</div>
      </div>
    `;
  }

  const progress = Math.min(approvalCount, info.threshold);
  const pct = Math.round((progress / info.threshold) * 100);
  const remaining = info.threshold - progress;
  const isComplete = remaining <= 0;

  if (isComplete) {
    return `
      <div class="trust-progress card" style="border-left: 3px solid var(--success);">
        <div class="trust-progress-header">
          <span class="trust-progress-tier">${info.label}</span>
          <span class="trust-progress-status" style="color: var(--success);">Ready to level up!</span>
        </div>
        <div class="confidence-bar" style="margin: 0.5rem 0;">
          <div class="confidence-fill high" style="width: 100%;"></div>
        </div>
        <div class="trust-progress-desc">
          I can now handle routine tasks automatically.
          <a href="#/settings" style="color: var(--accent);">Update your settings</a> to unlock "${info.next}".
        </div>
      </div>
    `;
  }

  const confClass = pct >= 75 ? 'moderate' : pct >= 50 ? 'low' : 'speculative';

  return `
    <div class="trust-progress card">
      <div class="trust-progress-header">
        <span class="trust-progress-tier">Trust level: ${info.label}</span>
        <span class="trust-progress-count">${progress} of ${info.threshold}</span>
      </div>
      <div class="confidence-bar" style="margin: 0.5rem 0;">
        <div class="confidence-fill ${confClass}" style="width: ${pct}%;"></div>
      </div>
      <div class="trust-progress-desc">
        ${remaining} more approval${remaining !== 1 ? 's' : ''} to unlock "${info.next}"
      </div>
    </div>
  `;
}
