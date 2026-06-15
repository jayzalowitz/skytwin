/**
 * Tier-ladder INTRODUCTION card — issue #483 (Part C, AC 3c).
 *
 * A brand-new user defaults to the most conservative trust tier, `observer`
 * (LOCKED 2026-06-06 — see issue #483 "Resolved Decision"; the default lives
 * in `apps/api/src/routes/users.ts` and `packages/db/src/schemas/schema.sql`,
 * the ladder + promotion criteria in `packages/shared-types/src/enums.ts` and
 * `packages/shared-types/src/policy.ts`). The dashboard already shows trust
 * *progress* via `progress-bar.js`, but a cold-start observer lands on that
 * progress bar with no introduction to what the ladder even is.
 *
 * This card closes that gap: a one-time, dismissable explanation of what
 * `observer` means and how the climb works. It is shown exactly once per
 * browser to a cold-start `observer` user and never re-shown once dismissed
 * (localStorage flag) — and never shown to a user who has already climbed
 * past `observer`.
 *
 * Copy reuses the existing tier labels (`tier-promotion-modal.js` TIER_COPY,
 * `progress-bar.js` TIER_LABEL) rather than inventing new prose — the issue
 * explicitly asks to reuse existing labels/copy.
 *
 * Design split for testability (no jsdom in the web app's test env):
 *   - `shouldShowTierLadderIntro({ currentTier, dismissed })` — pure decision.
 *   - `renderTierLadderIntroCard(key)` — pure HTML-string builder.
 *   - `renderTierLadderIntro({ userId, currentTier, storage })` — thin wrapper
 *     that reads the localStorage flag and composes the two above.
 *   - `dismissTierLadderIntro(key)` — DOM + storage side effect.
 */
import { tierLadderIntroSeenKey } from '../storage-keys.js';

const CARD_ID = 'tier-ladder-intro';

// Pure attribute escaper. We deliberately do NOT reuse api-client's
// `escapeHtml`, which builds a DOM node (`document.createElement`) and so
// can't run in the web app's DOM-less vitest env — and would be overkill
// for a controlled attribute value. The only untrusted segment is the
// userId baked into the localStorage key; this hardens it regardless.
function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Card is only meaningful for the cold-start tier. Once the user has accepted
// a promotion to `suggest` or beyond, the tier-promotion ceremony already
// explained what the next tier does — re-introducing the ladder would be noise.
const INTRO_TIER = 'observer';

/**
 * Pure decision: should the introduction card render?
 *
 * @param {object} opts
 * @param {string} [opts.currentTier] — server-authoritative current tier.
 * @param {boolean} [opts.dismissed]  — whether the user already dismissed it.
 * @returns {boolean}
 */
export function shouldShowTierLadderIntro({ currentTier, dismissed } = {}) {
  if (dismissed) return false;
  return currentTier === INTRO_TIER;
}

/**
 * Pure HTML-string builder for the card body. Exported for unit testing.
 * `key` is embedded as the dismiss target; it is escaped because it contains
 * a userId segment.
 *
 * @param {string} key — the localStorage flag key (passed to the dismiss btn).
 * @returns {string} HTML
 */
export function renderTierLadderIntroCard(key) {
  const safeKey = escapeAttr(key);
  return `
    <div class="card" id="${CARD_ID}" style="border-left: 3px solid var(--border-strong, var(--border)); background: linear-gradient(135deg, var(--bg-card) 0%, var(--bg) 100%);">
      <div class="card-header">
        <span class="card-title">You're in the driver's seat — here's how trust grows</span>
        <button class="btn btn-outline btn-sm" data-action="dismiss-tier-ladder-intro" data-key="${safeKey}" aria-label="Dismiss tier introduction" style="padding: 0.15rem 0.5rem; font-size: 0.7rem;">Got it</button>
      </div>
      <div class="card-subtitle" style="line-height: 1.65;">
        Right now I'm at <strong>Watch &amp; Suggest</strong> — I observe what comes in and explain what I'd do,
        but I never act without your OK. That's the safe starting line for everyone.
        <br><br>
        As you approve my calls, I earn your trust step by step:
        <strong>Watch &amp; Suggest</strong> &rarr; <strong>Ask me first</strong> &rarr;
        <strong>Handle small stuff</strong> &rarr; <strong>Handle most things</strong>.
        Each level lets me do a little more on my own — but only after a run of approvals,
        and only once <em>you</em> accept the bump. I never promote myself.
        Your spend limits and safety rules hold at every level.
      </div>
    </div>
  `;
}

/**
 * Compose the card for the dashboard. Returns an HTML string, or '' when the
 * card should not render (not observer, already dismissed, or storage
 * unavailable). Safe to call on every render — it's a no-op once dismissed.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.currentTier]
 * @param {Storage} [opts.storage] — injectable for tests; defaults to
 *   `localStorage` in the browser, `null` when no DOM (returns '').
 * @returns {string} HTML or ''
 */
export function renderTierLadderIntro({
  userId,
  currentTier,
  storage = typeof localStorage !== 'undefined' ? localStorage : null,
} = {}) {
  if (!userId) return '';
  const key = tierLadderIntroSeenKey(userId);
  let dismissed = false;
  try {
    dismissed = storage ? storage.getItem(key) === '1' : false;
  } catch {
    // Private mode / storage disabled: fail safe to "already seen" so a
    // user who can't persist the dismissal isn't nagged on every render.
    return '';
  }
  if (!shouldShowTierLadderIntro({ currentTier, dismissed })) return '';
  return renderTierLadderIntroCard(key);
}

/**
 * Persist the dismissal and remove the card from the DOM. Wired from the
 * dashboard's hash-gated singleton click delegator (see dashboard-view.js).
 *
 * @param {string} key — the localStorage flag key from the dismiss button.
 */
export function dismissTierLadderIntro(key) {
  if (key) {
    try { localStorage.setItem(key, '1'); } catch { /* private mode */ }
  }
  if (typeof document !== 'undefined') {
    document.getElementById(CARD_ID)?.remove();
  }
}
