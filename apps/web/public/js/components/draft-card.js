/**
 * Draft-email approval card (#303).
 *
 * Renders the `draft_email` actionType candidate with the value-add the
 * generic approval card misses: inline body preview, examplesUsed
 * subtitle, edit-before-approve textarea, optional prompt details.
 *
 * UX spec lives in the issue body (#303). Key choices:
 *   - The textarea value at click time is what executes. The user's
 *     edits override `parameters.draftBody`.
 *   - Confidence wording: HIGH → "high confidence", MODERATE →
 *     "moderate confidence", LOW → "review carefully — limited
 *     grounding".
 *   - Never use "AI-generated" or "LLM" in user-facing copy. It's
 *     "your draft" / "the draft".
 *   - Read mode (no textarea, just text) is reserved for the history
 *     view — pending approvals always edit-in-place.
 */
import { escapeHtml } from '../api-client.js';
import { formatMoney } from '../format.js';

function confidenceCopy(level) {
  const v = String(level || '').toLowerCase();
  if (v === 'high' || v === 'confirmed') return 'high confidence';
  if (v === 'moderate' || v === 'medium') return 'moderate confidence';
  return 'review carefully — limited grounding';
}

function groundingSubtitle(examplesUsed, replyToFrom) {
  const n = Number.isFinite(examplesUsed) ? Number(examplesUsed) : 0;
  if (n === 0) {
    return (
      'Drafted without authored-context grounding. Voice match may ' +
      'be weak — review carefully.'
    );
  }
  // "your prior emails" reads more honestly than "AI-trained on N" —
  // the user gets that the system has seen their writing without the
  // mechanical phrasing.
  const base = `Drafted from ${n} of your prior emails`;
  if (replyToFrom) {
    return `${base} to ${replyToFrom} and similar senders.`;
  }
  return `${base}.`;
}

/**
 * Build the draft-email card markup. Drop-in replacement for
 * `renderStandardCard(a, action)` when `action.actionType === 'draft_email'`.
 * Returns the inner-card HTML; the outer `.card.approval-card` wrapper
 * is provided by `renderApprovalCard`.
 */
export function renderDraftEmailCard(a, action) {
  const params = action.parameters || {};
  const draftBody = typeof params.draftBody === 'string' ? params.draftBody : '';
  const examplesUsed = params.examplesUsed;
  const replyToFrom = typeof params.replyToFrom === 'string' ? params.replyToFrom : '';
  const replyToSubject =
    typeof params.replyToSubject === 'string' ? params.replyToSubject : '';
  const attributionEnabled = params.emailAttributionSignatureEnabled !== false;
  const attributionRepoUrl = typeof params.emailAttributionRepoUrl === 'string'
    ? params.emailAttributionRepoUrl
    : 'https://github.com/jayzalowitz/skytwin';
  const attributionText = typeof params.emailAttributionSignatureText === 'string'
    ? params.emailAttributionSignatureText
    : `Sent by SkyTwin - the open-source digital twin: ${attributionRepoUrl}`;
  const confidenceText = confidenceCopy(action.confidence);

  // Estimate display lines for the textarea: at least 4, at most 12;
  // matches the issue's "one to four short paragraphs" prompt budget.
  const linesCount = draftBody.split('\n').length;
  const rows = Math.min(12, Math.max(4, linesCount + 1));

  const userId = a.userId || '';
  const id = a.id;

  // `subtitle` is an HTML fragment composed from a hard-coded template
  // plus `replyToFrom` (inbound sender, UNTRUSTED — comes from raw email
  // From headers). Escape the dynamic piece BEFORE building the subtitle
  // so the only HTML in it comes from our own static strings. (Copilot
  // caught this: interpolating `replyToFrom` raw would have been an XSS
  // injection point via a crafted display name.)
  const subtitle = groundingSubtitle(examplesUsed, escapeHtml(replyToFrom));

  return `
    <div class="draft-email-card" data-card-type="draft_email">
      <div
        class="draft-email-meta"
        id="draft-meta-${escapeHtml(id)}"
        style="font-size: 0.82rem; color: var(--text-dim); margin: 0.25rem 0 0.5rem;"
      >
        ${subtitle} <span style="margin-left: 0.4rem;">— ${escapeHtml(confidenceText)}.</span>
      </div>
      ${replyToSubject || replyToFrom ? `
        <div class="draft-email-inbound" style="font-size: 0.78rem; color: var(--text-dim); margin: 0 0 0.4rem;">
          ${replyToSubject ? `<strong>Re:</strong> ${escapeHtml(replyToSubject)}` : ''}
          ${replyToFrom ? ` &nbsp;·&nbsp; <strong>To:</strong> ${escapeHtml(replyToFrom)}` : ''}
        </div>
      ` : ''}
      <textarea
        class="form-input draft-email-body"
        id="draft-body-${escapeHtml(id)}"
        rows="${rows}"
        aria-label="Draft body, editable"
        aria-describedby="draft-meta-${escapeHtml(id)}"
        style="width: 100%; min-height: 6.5rem; font-family: inherit; font-size: 0.92rem; line-height: 1.5; padding: 0.6rem 0.7rem; resize: vertical;"
      >${escapeHtml(draftBody)}</textarea>
      <div
        class="draft-email-attribution"
        style="margin-top: 0.45rem; padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-muted); font-size: 0.78rem; line-height: 1.45;"
      >
        ${attributionEnabled
          ? `SkyTwin footer will be added on send: <span style="color: var(--text);">${escapeHtml(attributionText)}</span> <a href="${escapeHtml(attributionRepoUrl)}" target="_blank" rel="noopener noreferrer" style="color: var(--accent);">repo</a>`
          : 'SkyTwin footer is off in Settings. This draft will send without it.'}
      </div>
      <details class="draft-email-details" style="margin: 0.4rem 0 0; font-size: 0.78rem;">
        <summary style="cursor: pointer; color: var(--text-dim);">Show prompt details</summary>
        <div style="margin-top: 0.4rem; padding: 0.5rem 0.7rem; border-left: 2px solid var(--border); display: flex; flex-direction: column; gap: 0.35rem; color: var(--text-dim);">
          <div><strong>Examples used:</strong> ${escapeHtml(String(examplesUsed ?? 0))}</div>
          ${action.reasoning ? `<div><strong>Why this draft:</strong> ${escapeHtml(action.reasoning)}</div>` : ''}
          ${action.estimatedCostCents != null ? `<div><strong>Estimated cost:</strong> ${escapeHtml(formatMoney(Number(action.estimatedCostCents)))}</div>` : ''}
        </div>
      </details>
      <div class="approval-actions" style="margin-top: 0.7rem; display: flex; gap: 0.5rem; align-items: center;">
        <button
          class="btn btn-success btn-sm"
          data-action="approval"
          data-decision="approve"
          data-request-id="${escapeHtml(id)}"
          data-user-id="${escapeHtml(userId)}"
          data-card-type="draft_email"
        >Send this draft</button>
        <button
          class="btn btn-outline btn-sm"
          data-action="approval"
          data-decision="reject"
          data-request-id="${escapeHtml(id)}"
          data-user-id="${escapeHtml(userId)}"
          data-card-type="draft_email"
        >Discard</button>
        <input
          class="form-input"
          id="reason-${escapeHtml(id)}"
          placeholder="Tell me why so I learn (optional)"
          style="flex: 1; font-size: 0.8rem;"
        >
      </div>
    </div>
  `;
}

/**
 * Read the current textarea value for a pending draft-email approval
 * card. Returns the (possibly edited) body or `null` if the textarea
 * doesn't exist (history view, non-draft card).
 *
 * Exported so the approvals page's click handler can pick up the
 * edited body without duplicating the DOM selector.
 */
export function readDraftEditedBody(requestId) {
  if (typeof document === 'undefined') return null;
  const ta = document.getElementById(`draft-body-${requestId}`);
  if (!ta) return null;
  return typeof ta.value === 'string' ? ta.value : null;
}
