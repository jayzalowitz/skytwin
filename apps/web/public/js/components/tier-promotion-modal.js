/**
 * Tier Promotion Modal — issue #177
 *
 * Renders a modal asking the user whether to promote a capability server's
 * trust tier. The modal is mounted to document.body and uses a singleton
 * delegated event listener (CLAUDE.md "Frontend Event Handling").
 *
 * Usage:
 *   renderTierPromotionModal({
 *     serverName: 'Notion',
 *     serverId: '<uuid>',
 *     currentTier: 'observer',
 *     proposedTier: 'suggest',
 *     decisionsObservedCount: 23,
 *     approvedCount: 22,
 *     onApprove: () => { ... },
 *     onDecline: () => { ... },
 *   });
 *
 * Singleton delegator: one listener on document, gated by presence of
 * #tier-promotion-modal in the DOM (rather than a route hash, since the
 * modal is always rendered on top of whatever page is active).
 */
import { promoteTier, declinePromotion, escapeHtml } from '../api-client.js';
import { showToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

const MODAL_ID = 'tier-promotion-modal';

let _tierPromotionListenerWired = false;

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

function ensureTierPromotionListener() {
  if (_tierPromotionListenerWired || typeof document === 'undefined') return;
  _tierPromotionListenerWired = true;
  document.addEventListener('click', handleTierPromotionClick);
}

function handleTierPromotionClick(e) {
  // Gate on modal presence — only handle clicks when the modal is open.
  if (!document.getElementById(MODAL_ID)) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const btn = target.closest('[data-action]');
  if (!btn) return;

  const action = btn.getAttribute('data-action');

  if (action === 'tier-promotion-approve') {
    const serverId = btn.getAttribute('data-server-id');
    const toTier = btn.getAttribute('data-to-tier');
    const userId = getCurrentUserId();
    if (serverId && toTier && userId) {
      handleTierPromotionApprove(serverId, toTier, userId);
    }
  } else if (action === 'tier-promotion-decline') {
    const serverId = btn.getAttribute('data-server-id');
    const userId = getCurrentUserId();
    if (serverId && userId) {
      handleTierPromotionDecline(serverId, userId);
    }
  } else if (action === 'tier-promotion-close') {
    closeTierPromotionModal();
  }
}

async function handleTierPromotionApprove(serverId, toTier, userId) {
  const btn = document.querySelector(`#${MODAL_ID} [data-action="tier-promotion-approve"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Promoting…';
  }
  try {
    await promoteTier(serverId, toTier, userId);
    showToast(`Promoted to ${escapeHtml(toTier)} — trust ceremony complete.`, { kind: 'success' });
    closeTierPromotionModal();
  } catch (err) {
    showToast(`Couldn't promote tier: ${err?.message || 'unknown error'}`, { kind: 'error' });
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Yes, promote';
    }
  }
}

async function handleTierPromotionDecline(serverId, userId) {
  const btn = document.querySelector(`#${MODAL_ID} [data-action="tier-promotion-decline"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Declining…';
  }
  try {
    await declinePromotion(serverId, userId, 14);
    showToast("Got it — I'll ask again in 2 weeks.", { kind: 'info' });
    closeTierPromotionModal();
  } catch (err) {
    showToast(`Couldn't save your preference: ${err?.message || 'unknown error'}`, { kind: 'error' });
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Not yet';
    }
  }
}

function closeTierPromotionModal() {
  const modal = document.getElementById(MODAL_ID);
  if (modal) modal.remove();
}

const TIER_COPY = {
  observer: 'Watch only',
  suggest: 'Suggest to me',
  low_autonomy: 'Handle small stuff',
  moderate_autonomy: 'Handle most things',
  high_autonomy: 'Full autopilot',
};

/**
 * Render the tier promotion modal and mount it to document.body.
 *
 * @param {object} opts
 * @param {string} opts.serverName
 * @param {string} opts.serverId
 * @param {string} opts.currentTier
 * @param {string} opts.proposedTier
 * @param {number} opts.decisionsObservedCount
 * @param {number} opts.approvedCount
 * @param {() => void} [opts.onApprove]  — called after API success
 * @param {() => void} [opts.onDecline]  — called after API success
 */
export function renderTierPromotionModal({
  serverName,
  serverId,
  currentTier,
  proposedTier,
  decisionsObservedCount,
  approvedCount,
}) {
  ensureTierPromotionListener();

  // Remove any existing modal first
  closeTierPromotionModal();

  const correctCount = approvedCount;
  const fromLabel = TIER_COPY[currentTier] || currentTier;
  const toLabel = TIER_COPY[proposedTier] || proposedTier;

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" role="dialog" aria-modal="true"
         aria-labelledby="tier-promotion-title"
         style="max-width: 480px;">
      <div class="modal-header" style="display: flex; justify-content: space-between; align-items: flex-start;">
        <h3 id="tier-promotion-title" style="margin: 0;">Ready to trust me more?</h3>
        <button
          class="btn btn-sm"
          data-action="tier-promotion-close"
          aria-label="Close"
          style="background: none; border: none; font-size: 1.2rem; cursor: pointer; padding: 0; color: var(--text-dim);"
        >&times;</button>
      </div>
      <div class="modal-body" style="margin: 1rem 0;">
        <p style="font-size: 1.05rem; font-weight: 500; margin-bottom: 0.75rem;">
          ${escapeHtml(serverName)}: I've watched ${escapeHtml(String(decisionsObservedCount))} of your decisions
          and got ${escapeHtml(String(correctCount))} right.
          Promote me from <strong>${escapeHtml(fromLabel)}</strong> to <strong>${escapeHtml(toLabel)}</strong>?
        </p>
        <p class="muted" style="font-size: 0.85rem; line-height: 1.6;">
          At <strong>${escapeHtml(toLabel)}</strong>, ${escapeHtml(serverName)} will be able to
          ${proposedTier === 'suggest'
            ? 'suggest actions for your approval — nothing runs without your say-so.'
            : proposedTier === 'low_autonomy'
              ? 'handle small, low-risk actions without checking in each time.'
              : 'handle most tasks on your behalf — you can still review and undo.'
          }
        </p>
        <p class="muted" style="font-size: 0.82rem;">You can always adjust or reverse this from Capabilities settings.</p>
      </div>
      <div class="modal-actions" style="display: flex; gap: 0.75rem; justify-content: flex-end;">
        <button
          class="btn btn-outline btn-sm"
          data-action="tier-promotion-decline"
          data-server-id="${escapeHtml(serverId)}"
        >Not yet</button>
        <button
          class="btn btn-primary btn-sm"
          data-action="tier-promotion-approve"
          data-server-id="${escapeHtml(serverId)}"
          data-to-tier="${escapeHtml(proposedTier)}"
        >Yes, promote</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Focus the primary button for accessibility
  const approveBtn = modal.querySelector('[data-action="tier-promotion-approve"]');
  if (approveBtn) {
    setTimeout(() => approveBtn.focus(), 50);
  }
}
