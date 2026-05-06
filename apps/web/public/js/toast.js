/**
 * Lightweight toast notification component. UX review #10 follow-up.
 *
 * Reusable infrastructure: any place in the app that previously logged
 * to the console / silently changed state / required a button-click
 * confirmation can now `showToast(message, { kind })` and get
 * consistent visual feedback.
 *
 * Design choices:
 * - Bottom-right stack (industry-standard placement; doesn't overlap
 *   the bottom-nav on mobile because the stack is offset above
 *   safe-area + nav-height via CSS).
 * - Four kinds: success / info / warning / danger. Each has its own
 *   accent color sourced from theme variables so toasts inherit the
 *   user's current theme.
 * - Auto-dismiss after 3.5s (success/info) or 6s (warning/danger).
 *   Hovering pauses the dismiss timer — the user can read longer
 *   without the toast vanishing mid-sentence.
 * - Click-to-dismiss for impatient readers.
 * - Screen-reader live region (aria-live=polite) so assistive tech
 *   announces the message without stealing focus.
 * - Respects prefers-reduced-motion (the slide-in animation no-ops).
 *
 * Public API:
 *   showToast(message, { kind, durationMs }?) -> dismiss function
 *   showSavedToast() -> showToast('Saved ✓', { kind: 'success' })
 *
 * No queue cap — if the user triggers 50 toasts they all stack. We
 * limit aggressive auto-saves at the call site instead.
 */

const STACK_ID = 'skytwin-toast-stack';
const KINDS = new Set(['success', 'info', 'warning', 'danger']);

/**
 * Get or create the toast stack container. Inserted into <body> so it
 * floats above all page content + sidebars + the bottom-nav. The
 * `aria-live=polite` attribute makes screen readers announce children
 * as they're appended — crucial for "Saved" feedback that has no
 * visual focus change.
 */
function getStack() {
  let stack = document.getElementById(STACK_ID);
  if (stack) return stack;
  stack = document.createElement('div');
  stack.id = STACK_ID;
  stack.className = 'toast-stack';
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');
  stack.setAttribute('aria-atomic', 'false');
  document.body.appendChild(stack);
  return stack;
}

function escapeForToast(s) {
  // Toast messages are app-controlled but we still escape defensively
  // — a future caller passing user input wouldn't expect XSS through
  // the toast surface.
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Show a toast. Returns a function that dismisses it early; safe to
 * call after the toast has already auto-dismissed (no-op).
 *
 * Defaults:
 *   - kind: 'info'
 *   - durationMs: 3500 (success/info), 6000 (warning/danger)
 *
 * Pass `durationMs: 0` to make the toast sticky (manual dismiss only).
 */
export function showToast(message, options = {}) {
  const kind = KINDS.has(options.kind) ? options.kind : 'info';
  const defaultDuration = (kind === 'warning' || kind === 'danger') ? 6000 : 3500;
  const durationMs = typeof options.durationMs === 'number' ? options.durationMs : defaultDuration;
  // Optional action button (e.g. "Undo") rendered between the message
  // and the close X. `onClick` fires before the toast dismisses so the
  // caller can branch on whether the action ran or the toast timed out.
  const action = options.action && typeof options.action.label === 'string' && typeof options.action.onClick === 'function'
    ? options.action
    : null;

  const stack = getStack();
  const toast = document.createElement('div');
  toast.className = `skytoast skytoast-${kind}`;
  toast.setAttribute('role', kind === 'danger' || kind === 'warning' ? 'alert' : 'status');
  toast.innerHTML = `
    <div class="skytoast-content">${escapeForToast(message)}</div>
    ${action ? `<button class="skytoast-action" type="button">${escapeForToast(action.label)}</button>` : ''}
    <button class="skytoast-close" type="button" aria-label="Dismiss">×</button>
  `;
  stack.appendChild(toast);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.add('skytoast-leaving');
    // Wait for leave animation; fall back to immediate removal under
    // prefers-reduced-motion or if the transition doesn't fire.
    const cleanup = () => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    };
    toast.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 400);
  };

  toast.querySelector('.skytoast-close')?.addEventListener('click', dismiss);
  if (action) {
    toast.querySelector('.skytoast-action')?.addEventListener('click', (e) => {
      e.stopPropagation();
      try { action.onClick(); } catch { /* swallow — toast still dismisses */ }
      dismiss();
    });
  }
  toast.addEventListener('click', (e) => {
    // Click anywhere on the toast (not the action, not the X) dismisses.
    if (e.target instanceof HTMLButtonElement
      && (e.target.classList.contains('skytoast-close') || e.target.classList.contains('skytoast-action'))) {
      return;
    }
    dismiss();
  });

  if (durationMs > 0) {
    let timer = setTimeout(dismiss, durationMs);
    // Pause on hover — the user is reading.
    toast.addEventListener('mouseenter', () => {
      if (timer) { clearTimeout(timer); timer = null; }
    });
    toast.addEventListener('mouseleave', () => {
      if (!dismissed && !timer) timer = setTimeout(dismiss, durationMs);
    });
  }

  return dismiss;
}

/** Convenience wrapper for the most common case. */
export function showSavedToast(message = 'Saved') {
  return showToast(`${message} ✓`, { kind: 'success' });
}

/** Convenience wrapper for an error toast — friendlier than alert(). */
export function showErrorToast(message) {
  return showToast(message, { kind: 'danger' });
}
