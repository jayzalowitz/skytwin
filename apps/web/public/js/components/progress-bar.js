/**
 * Reusable trust tier progress bar component.
 *
 * Reads server-authoritative fields from /api/twin/:userId/progress:
 *   - currentTier: enum string
 *   - consecutiveApprovals: the metric the policy engine actually gates on
 *   - approvalCount: cumulative approvals (display-only)
 *   - nextTierThreshold: target consecutive approvals (null at max)
 *   - approvalRatio + minApprovalRatio: also required for promotion
 *
 * MODERATE_AUTONOMY is the practical "max" — promotion to HIGH_AUTONOMY
 * is explicit opt-in, not threshold-driven, so when nextTierThreshold
 * is null we render "Maximum trust" without claiming a fake target.
 *
 * Usage:
 *   renderTrustProgress({ currentTier, consecutiveApprovals, approvalCount,
 *                         nextTierThreshold, approvalRatio, minApprovalRatio })
 *
 * Backwards-compat: if `consecutiveApprovals` is absent, falls back to
 * `approvalCount` and ignores the ratio gate (older response shapes).
 *
 * Returns an HTML string.
 */

// Display labels per tier. We keep these in the UI rather than pulling
// from shared-types because they're copy decisions, not contract.
const TIER_LABEL = {
  observer:          'Watch & Suggest',
  suggest:           'Ask me first',
  low_autonomy:      'Handle small stuff',
  moderate_autonomy: 'Handle most things',
  high_autonomy:     'Full autopilot',
};

// Display label for the *next* tier, given the current tier. Server's
// /progress response also includes `nextTier`; we use this map only as
// a fallback when the field is absent (older API responses).
const NEXT_TIER_LABEL_FALLBACK = {
  observer:          'Ask me first',
  suggest:           'Handle small stuff',
  low_autonomy:      'Handle most things',
};

export function renderTrustProgress({
  approvalCount = 0,
  consecutiveApprovals,
  currentTier = 'observer',
  nextTierThreshold,
  nextTier,
  approvalRatio = 0,
  minApprovalRatio,
} = {}) {
  const tierLabel = TIER_LABEL[currentTier] ?? currentTier;
  // Use the server's authoritative metric when available; fall back to
  // cumulative count for older /progress responses (pre-shared-types).
  const progressMetric = typeof consecutiveApprovals === 'number'
    ? consecutiveApprovals
    : approvalCount;

  // No threshold = no automatic promotion from this tier (moderate or
  // high). Render the max-trust state instead of inventing a target.
  if (!nextTierThreshold) {
    return `
      <div class="trust-progress card">
        <div class="trust-progress-header">
          <span class="trust-progress-tier">${tierLabel}</span>
          <span class="trust-progress-status" style="color: var(--success);">Maximum trust</span>
        </div>
        <div class="trust-progress-desc">I handle everything within your rules. You're fully in control.</div>
      </div>
    `;
  }

  const nextLabel = nextTier
    ? (TIER_LABEL[nextTier] ?? NEXT_TIER_LABEL_FALLBACK[currentTier] ?? 'next level')
    : (NEXT_TIER_LABEL_FALLBACK[currentTier] ?? 'next level');

  const progress = Math.min(progressMetric, nextTierThreshold);
  const pct = Math.round((progress / nextTierThreshold) * 100);
  const remaining = nextTierThreshold - progress;
  const isCountReady = remaining <= 0;
  const isRatioReady = typeof minApprovalRatio === 'number'
    ? approvalRatio >= minApprovalRatio
    : true;
  const isComplete = isCountReady && isRatioReady;

  if (isComplete) {
    return `
      <div class="trust-progress card" style="border-left: 3px solid var(--success);">
        <div class="trust-progress-header">
          <span class="trust-progress-tier">${tierLabel}</span>
          <span class="trust-progress-status" style="color: var(--success);">Ready to level up!</span>
        </div>
        <div class="confidence-bar" style="margin: 0.5rem 0;">
          <div class="confidence-fill high" style="width: 100%;"></div>
        </div>
        <div class="trust-progress-desc">
          I can now handle routine tasks automatically.
          <a href="#/settings" style="color: var(--accent);">Update your settings</a> to unlock "${nextLabel}".
        </div>
      </div>
    `;
  }

  // Ratio gate not yet met. Surface this honestly so the user
  // understands why hitting the consecutive count alone won't promote.
  if (isCountReady && !isRatioReady && typeof minApprovalRatio === 'number') {
    const pctRatio = Math.round(approvalRatio * 100);
    const targetPct = Math.round(minApprovalRatio * 100);
    return `
      <div class="trust-progress card">
        <div class="trust-progress-header">
          <span class="trust-progress-tier">Trust level: ${tierLabel}</span>
          <span class="trust-progress-count">${progress} of ${nextTierThreshold}</span>
        </div>
        <div class="confidence-bar" style="margin: 0.5rem 0;">
          <div class="confidence-fill moderate" style="width: 100%;"></div>
        </div>
        <div class="trust-progress-desc">
          You've hit the approval count, but I need a higher approval rate (${pctRatio}% vs. ${targetPct}% target) before unlocking "${nextLabel}".
        </div>
      </div>
    `;
  }

  const confClass = pct >= 75 ? 'moderate' : pct >= 50 ? 'low' : 'speculative';

  return `
    <div class="trust-progress card">
      <div class="trust-progress-header">
        <span class="trust-progress-tier">Trust level: ${tierLabel}</span>
        <span class="trust-progress-count">${progress} of ${nextTierThreshold}</span>
      </div>
      <div class="confidence-bar" style="margin: 0.5rem 0;">
        <div class="confidence-fill ${confClass}" style="width: ${pct}%;"></div>
      </div>
      <div class="trust-progress-desc">
        ${remaining} more approval${remaining !== 1 ? 's' : ''} in a row to unlock "${nextLabel}"
      </div>
    </div>
  `;
}
