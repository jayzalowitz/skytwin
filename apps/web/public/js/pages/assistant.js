import {
  fetchAssistantThreads,
  fetchAssistantThread,
  deleteAssistantThread,
  sendAssistantMessageStream,
  searchCapabilityRegistry,
  installCapability,
  escapeHtml,
  renderApiError,
  wireApiRetry,
} from '../api-client.js';
import { assistantDraftKey, KEY_USER_ID } from '../storage-keys.js';
import { showToast } from '../toast.js';
import { renderTierPromotionModal } from '../components/tier-promotion-modal.js';

// State for the currently-rendered thread. Module-scope because the click
// delegator (singleton, document-level) needs to read the active thread to
// send follow-up messages — same pattern as approvals.js where the listener
// reads `_approvalsUserId` rather than closing over a render-time arg. The
// dev "Switch user" button updates localStorage and re-renders the page; we
// re-read the userId on every render to avoid stale closure.
let _state = {
  userId: '',
  activeThreadId: null,
  // Cached message list for the active thread, used so we can append the
  // user message optimistically and the assistant reply when it lands —
  // without re-fetching the whole thread on every send.
  messages: [],
  // Threads list, sorted most-recently-active first (server already does this).
  threads: [],
  // True while a `sendAssistantMessage` is in flight. Renders the composer
  // disabled and shows a typing indicator, so the user can't queue parallel
  // requests against the same thread (which would interleave message order
  // unpredictably).
  sending: false,
  // AbortController for the in-flight stream — set in handleSend, cleared
  // in the finally block. handleStop calls .abort() to interrupt a long
  // generation. The Send button swaps to a Stop button while non-null.
  streamController: null,
};

let _assistantListenerWired = false;

export async function renderAssistant(container, userId) {
  _state.userId = userId;
  ensureAssistantListener();
  wirePromotionSseListener();

  // Initial fetch — threads and (if any) the most recent thread's messages.
  let threads = [];
  try {
    const data = await fetchAssistantThreads(userId);
    threads = Array.isArray(data?.threads) ? data.threads : [];
  } catch (err) {
    container.innerHTML = renderApiError(err, {
      context: "Couldn't load the assistant.",
      retry: () => renderAssistant(container, userId),
    });
    wireApiRetry(container, () => renderAssistant(container, userId));
    return;
  }
  _state.threads = threads;

  // Default-select the most recent thread on first render of an existing
  // session. If there are no threads, leave the right pane on the empty
  // state and the composer ready to start a new conversation.
  if (!_state.activeThreadId && threads.length > 0) {
    _state.activeThreadId = threads[0].id;
  }

  if (_state.activeThreadId) {
    try {
      const data = await fetchAssistantThread(_state.activeThreadId, userId);
      _state.messages = Array.isArray(data?.messages) ? data.messages : [];
    } catch {
      // Thread might've been deleted in another tab — clear and continue
      // rendering the empty state so the user isn't stuck.
      _state.activeThreadId = null;
      _state.messages = [];
    }
  } else {
    _state.messages = [];
  }

  paint(container);
}

function paint(container) {
  container.innerHTML = `
    <div class="assistant-shell" data-region="assistant">
      <aside class="assistant-threads">
        <div class="assistant-threads-header">
          <span class="assistant-threads-title">Conversations</span>
          <button class="btn btn-outline btn-sm" data-action="new-thread" type="button">New</button>
        </div>
        <ul class="assistant-thread-list">
          ${renderThreadList(_state.threads, _state.activeThreadId)}
        </ul>
      </aside>
      <section class="assistant-chat">
        <div class="assistant-messages" data-region="messages">
          ${renderMessages(_state.messages, _state.sending)}
        </div>
        <button
          class="assistant-jump-latest"
          type="button"
          data-action="jump-latest"
          data-region="jump-button"
          aria-label="Jump to latest message"
          hidden
        >↓ Jump to latest</button>
        <form class="assistant-composer" data-action="composer-form">
          <textarea
            class="assistant-composer-input"
            data-region="composer-input"
            rows="2"
            placeholder="Ask your twin anything…"
            ${_state.sending ? 'disabled' : ''}
            aria-label="Message"
          ></textarea>
          ${_state.sending
            ? `<button
                class="assistant-composer-send assistant-composer-stop"
                type="button"
                data-action="stop-stream"
                aria-label="Stop generating"
              >Stop</button>`
            : `<button
                class="assistant-composer-send"
                type="submit"
                aria-label="Send"
              >Send</button>`}
        </form>
        <div class="assistant-composer-hint">
          Press <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for a new line
        </div>
      </section>
    </div>
  `;

  scrollMessagesToBottom(container);
  // Auto-focus the composer when entering the page or after a send finishes,
  // not while sending (textarea is disabled then anyway). Also restore any
  // saved draft for the active thread so navigating away and coming back
  // doesn't lose what the user typed.
  if (!_state.sending) {
    const input = container.querySelector('[data-region="composer-input"]');
    if (input) {
      const draft = readDraft(_state.activeThreadId);
      if (draft) {
        input.value = draft;
        // Cursor at end so a quick edit ("…and tell me why") flows.
        try { input.setSelectionRange(draft.length, draft.length); } catch { /* old browsers */ }
      }
      input.focus();
    }
  }
}

// ── Draft persistence ──────────────────────────────────────────────────
// Per-thread composer state survives page navigation within the tab so a
// user who pops to /approvals to look something up doesn't lose their
// half-typed prompt. sessionStorage means it doesn't leak across browser
// sessions — drafts are inherently transient.

function readDraft(threadId) {
  try {
    return sessionStorage.getItem(assistantDraftKey(threadId)) || '';
  } catch { return ''; }
}
function writeDraft(threadId, value) {
  try {
    if (value) sessionStorage.setItem(assistantDraftKey(threadId), value);
    else sessionStorage.removeItem(assistantDraftKey(threadId));
  } catch { /* private mode etc. */ }
}
function clearDraft(threadId) {
  try { sessionStorage.removeItem(assistantDraftKey(threadId)); } catch { /* noop */ }
}

function renderThreadList(threads, activeId) {
  if (threads.length === 0) {
    return `
      <li class="assistant-thread-empty">
        No conversations yet. Send a message to start one.
      </li>
    `;
  }
  return threads
    .map((t) => {
      const isActive = t.id === activeId;
      const stamp = formatThreadStamp(t.updatedAt);
      return `
        <li class="assistant-thread-item${isActive ? ' is-active' : ''}">
          <button
            class="assistant-thread-select"
            type="button"
            data-action="select-thread"
            data-thread-id="${escapeHtml(t.id)}"
            title="${escapeHtml(t.title)}"
          >
            <span class="assistant-thread-title">${escapeHtml(t.title)}</span>
            <span class="assistant-thread-stamp">${escapeHtml(stamp)}</span>
          </button>
          <button
            class="assistant-thread-delete"
            type="button"
            data-action="delete-thread"
            data-thread-id="${escapeHtml(t.id)}"
            aria-label="Delete conversation"
            title="Delete"
          >×</button>
        </li>
      `;
    })
    .join('');
}

function renderMessages(messages, sending) {
  if (messages.length === 0 && !sending) {
    // Suggested prompts: a non-technical user lands here with no model
    // of what their twin can do. The empty hint copy ("Ask anything")
    // is paralyzingly open. Four concrete prompts give them an obvious
    // starting move — click one to fill the composer (not auto-send,
    // so they can edit before committing).
    const suggestions = [
      "What did you handle today?",
      "What's waiting for my OK?",
      "What have you learned about me so far?",
      "Archive promotional emails from last week",
    ];
    return `
      <div class="assistant-empty">
        <div class="assistant-empty-title">Start a conversation</div>
        <div class="assistant-empty-desc">
          Ask anything. I can also queue actions for your approval — try one
          of these or write your own.
        </div>
        <div class="assistant-suggestions" role="list">
          ${suggestions.map((s) => `
            <button
              type="button"
              class="assistant-suggestion-chip"
              data-action="suggest"
              data-prompt="${escapeHtml(s)}"
              role="listitem"
            >${escapeHtml(s)}</button>
          `).join('')}
        </div>
      </div>
    `;
  }
  // Last assistant message gets `data-streaming-id` when its id starts with
  // `streaming-` so the chunk handler can target it for in-place text
  // updates without re-painting the whole page on every token. Issue #146.
  const bubbles = messages
    .map((m) => {
      const role = m.role === 'user' ? 'user' : 'assistant';
      const streamingAttr = typeof m.id === 'string' && m.id.startsWith('streaming-')
        ? ` data-streaming-id="${escapeHtml(m.id)}"`
        : '';
      // Issue #148 v1: when the assistant message is the result of a
      // chat-driven action intent, the metadata carries an `intentRoute`
      // record. Render a small footer card under the bubble — link to
      // approvals for `requires-approval`, plain notice for `blocked`.
      const intentRoute = m?.metadata?.intentRoute;
      const footer = intentRoute ? renderActionFooter(intentRoute) : '';
      return `
        <div class="assistant-bubble assistant-bubble-${role}">
          <div class="assistant-bubble-content"${streamingAttr}>${escapeHtml(m.content)}</div>
          ${footer}
        </div>
      `;
    })
    .join('');
  // Typing dots fire only while we're sending AND before the first chunk
  // has landed (i.e. no streaming bubble exists yet). Once chunks arrive
  // the streaming bubble itself shows the live text — no need for both.
  const hasStreamingBubble = messages.some((m) => typeof m.id === 'string' && m.id.startsWith('streaming-'));
  const typing = sending && !hasStreamingBubble
    ? `
      <div class="assistant-bubble assistant-bubble-assistant assistant-bubble-typing">
        <div class="assistant-bubble-content">
          <span class="assistant-typing-dot"></span>
          <span class="assistant-typing-dot"></span>
          <span class="assistant-typing-dot"></span>
        </div>
      </div>
    `
    : '';
  return bubbles + typing;
}

/**
 * Render the action-card footer attached under an assistant bubble when
 * the message is the result of a chat-driven action intent. Issue #148 v1.
 *
 * Two variants:
 *   - requires-approval → "Open approval" link to the approvals page
 *   - blocked → muted notice that the action couldn't run
 *
 * Phase 2 of #148 will add inline approve/reject buttons here. For v1
 * we lean on the existing approvals page so the chat surface doesn't
 * grow its own action-execution UI ahead of the safety review.
 */
function renderActionFooter(intentRoute) {
  if (intentRoute?.kind === 'requires-approval') {
    // Hash route — same SPA, no full reload. The approvals page picks
    // up the new request from the existing fetch on render + the
    // `approval:new` SSE the action router emits.
    return `
      <div class="assistant-action-footer assistant-action-footer-approval">
        <a class="assistant-action-link" href="#/approvals">Open approval →</a>
      </div>
    `;
  }
  if (intentRoute?.kind === 'blocked') {
    return `
      <div class="assistant-action-footer assistant-action-footer-blocked">
        <span>Action blocked by your safety policy.</span>
      </div>
    `;
  }
  if (intentRoute?.kind === 'needs-setup') {
    // UX review #9: deep-link to Settings AI brain section. Hash route
    // keeps it inside the SPA. Friendlier than telling the user
    // "configure a provider" with no path forward.
    const target = intentRoute.target || '#/settings';
    return `
      <div class="assistant-action-footer assistant-action-footer-approval">
        <a class="assistant-action-link" href="${escapeHtml(target)}">Open Settings → AI brain →</a>
      </div>
    `;
  }
  return '';
}

function renderError(err) {
  // UX review #4 (P0): centralized friendly-error helper. Pre-fix this
  // rendered `err.message` verbatim, which surfaced strings like
  // "API proxy error" to users when the API was down.
  return renderApiError(err, {
    context: "Couldn't load the assistant.",
  });
}

// ── Reverse capability flow (issue #177) ─────────────────────────────────────
//
// v1 heuristic-based detector: after the assistant responds, scan the reply
// for unfulfillable-intent phrases. If found, search the registry for matching
// capabilities and surface an inline "Connect X to enable this" affordance.
//
// TODO(#189): Replace the heuristic with `runPrompt('reverse-capability-intent', context)`.
// The one-line swap-in: `const intent = await runPrompt('reverse-capability-intent', { userMessage, reply });`
// then use intent.registryId directly instead of the keyword scan below.
//
// Demo flows that work with the heuristic:
//   1. "create a Linear issue"   → no Linear installed → "Connect Linear"
//   2. "search Notion for X"     → no Notion          → "Connect Notion"
//   3. "check my GitHub PRs"     → no GitHub          → "Connect GitHub"
// ─────────────────────────────────────────────────────────────────────────────

/** Phrases that indicate the assistant couldn't fulfill the request. */
const UNFULFILLABLE_PHRASES = [
  "i don't have access to",
  "i can't",
  "i'm not connected to",
  "you'd need to connect",
  "not connected",
  "no access to",
  "i'm unable to",
  "i cannot",
  "don't have the ability to",
  "i lack access",
];

/** Service-name → registry-id hints for the heuristic detector. */
const SERVICE_HINTS = [
  { keywords: ['linear', 'linear issue', 'linear ticket'], registryId: 'linear-mcp', displayName: 'Linear' },
  { keywords: ['notion', 'notion page', 'notion doc'], registryId: '@notionhq/notion-mcp-server', displayName: 'Notion' },
  { keywords: ['github', 'github pr', 'github issue', 'pull request'], registryId: '@modelcontextprotocol/server-github', displayName: 'GitHub' },
  { keywords: ['gmail', 'google mail', 'email'], registryId: 'gmail-mcp', displayName: 'Gmail' },
  { keywords: ['google calendar', 'calendar', 'gcal'], registryId: 'google-calendar-mcp', displayName: 'Google Calendar' },
  { keywords: ['slack'], registryId: '@modelcontextprotocol/server-slack', displayName: 'Slack' },
  { keywords: ['google drive', 'gdrive', 'drive'], registryId: '@modelcontextprotocol/server-google-drive', displayName: 'Google Drive' },
  { keywords: ['sqlite', 'database', 'db'], registryId: '@modelcontextprotocol/server-sqlite', displayName: 'SQLite' },
  { keywords: ['filesystem', 'files', 'file system'], registryId: '@modelcontextprotocol/server-filesystem', displayName: 'Filesystem' },
];

/**
 * Detect if a reply from the assistant indicates an unfulfillable intent.
 * Returns true if any of the UNFULFILLABLE_PHRASES appear in the (lowercased) reply.
 */
function detectUnfulfillableReply(replyText) {
  if (!replyText) return false;
  const lower = replyText.toLowerCase();
  return UNFULFILLABLE_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Scan the user's message for known service names.
 * Returns an array of { registryId, displayName } matches.
 */
function detectServiceHints(userMessage) {
  if (!userMessage) return [];
  const lower = userMessage.toLowerCase();
  const matches = [];
  for (const hint of SERVICE_HINTS) {
    if (hint.keywords.some((kw) => lower.includes(kw))) {
      matches.push({ registryId: hint.registryId, displayName: hint.displayName });
    }
  }
  return matches;
}

/**
 * After the assistant responds, check for reverse-capability opportunities.
 * If found, render an inline "Connect X" affordance appended after the last
 * assistant bubble.
 *
 * Falls back gracefully if registry-client throws.
 *
 * @param {string} userMessage  - the user's original message
 * @param {string} replyText    - the assistant's full reply text
 * @param {HTMLElement} container
 */
async function checkReverseCapabilityFlow(userMessage, replyText, container) {
  try {
    if (!detectUnfulfillableReply(replyText)) return;

    const hints = detectServiceHints(userMessage);
    if (hints.length === 0) {
      // Fall back to registry search with the user's message as query
      // TODO(#189): replace with runPrompt('reverse-capability-intent', ...)
      return;
    }

    const affordances = hints.map((h) => `
      <button class="btn btn-sm btn-outline"
              data-action="reverse-capability-install"
              data-registry-id="${escapeHtml(h.registryId)}"
              data-display-name="${escapeHtml(h.displayName)}"
              style="font-size: 0.82rem;">
        Connect ${escapeHtml(h.displayName)}
      </button>
    `).join('');

    // Append the inline suggestion below the last assistant bubble
    const msgRegion = container.querySelector('[data-region="messages"]');
    if (!msgRegion) return;

    const existing = msgRegion.querySelector('.reverse-capability-affordance');
    if (existing) existing.remove();

    const affordanceEl = document.createElement('div');
    affordanceEl.className = 'reverse-capability-affordance assistant-bubble assistant-bubble-assistant';
    affordanceEl.style.cssText = 'display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; padding: 0.6rem 1rem;';
    affordanceEl.innerHTML = `
      <span style="font-size: 0.82rem; color: var(--text-dim); flex-basis: 100%; margin-bottom: 0.25rem;">
        I can do this if you connect:
      </span>
      ${affordances}
    `;
    msgRegion.appendChild(affordanceEl);
    msgRegion.scrollTop = msgRegion.scrollHeight;
  } catch {
    // Reverse flow is best-effort — never surface errors from this path
  }
}

/**
 * Handle the "Connect X" install button from the reverse capability affordance.
 * Calls POST /api/capabilities/install and shows a toast.
 */
async function handleReverseCapabilityInstall(registryId, displayName) {
  const userId = localStorage.getItem(KEY_USER_ID) || _state.userId || '';
  if (!userId) {
    showToast('Log in to connect capabilities.', { kind: 'warning' });
    return;
  }

  showToast(`Connecting ${displayName}…`, { kind: 'info', durationMs: 2000 });

  try {
    await installCapability(registryId, userId);
    showToast(`${displayName} connection started — complete OAuth to finish.`, { kind: 'success' });
    // Remove the affordance once install is initiated
    const affordanceEl = document.querySelector('.reverse-capability-affordance');
    if (affordanceEl) affordanceEl.remove();
  } catch (err) {
    showToast(
      `Couldn't connect ${displayName}: ${err?.message || 'unknown error'}`,
      { kind: 'error' },
    );
  }
}

// Wire the tier-promotion-offered SSE event to the modal (issue #177).
// This runs once when the assistant page first loads.
// We subscribe on the global EventSource that app.js maintains.
let _promotionSseWired = false;
const PROMOTION_SSE_RETRY_MS = 500;
const PROMOTION_SSE_MAX_ATTEMPTS = 20; // ~10s total
function wirePromotionSseListener() {
  if (_promotionSseWired || typeof window === 'undefined') return;
  // Set the flag ONLY after a successful wire — previously we set it
  // up-front, so a single missed-then-retried attempt would mark the
  // listener as wired and the second renderAssistant() call would no-op
  // even if app.js created the EventSource later.
  let attempts = 0;
  const wireIt = () => {
    attempts += 1;
    const src = window['__sseSource'];
    if (!src) {
      if (attempts < PROMOTION_SSE_MAX_ATTEMPTS) {
        setTimeout(wireIt, PROMOTION_SSE_RETRY_MS);
      }
      return;
    }
    src.addEventListener('capability:promotion-offered', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        renderTierPromotionModal({
          serverName: data.serverName,
          serverId: data.serverId,
          currentTier: data.currentTier,
          proposedTier: data.proposedTier,
          decisionsObservedCount: data.decisionsObservedCount,
          approvedCount: data.approvedCount,
        });
      } catch { /* ignore malformed events */ }
    });
    _promotionSseWired = true;
  };
  wireIt();
}

function formatThreadStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function scrollMessagesToBottom(container) {
  const region = container.querySelector('[data-region="messages"]');
  if (region) region.scrollTop = region.scrollHeight;
}

// Threshold (px) within which we consider the user "at the bottom".
// Generous enough to cover scroll inertia and sub-pixel rounding;
// tight enough that scrolling up to read history reads as "not bottom".
const NEAR_BOTTOM_THRESHOLD_PX = 80;

function isNearBottom(container) {
  const region = container?.querySelector('[data-region="messages"]');
  if (!region) return true;
  const distance = region.scrollHeight - region.scrollTop - region.clientHeight;
  return distance <= NEAR_BOTTOM_THRESHOLD_PX;
}

/**
 * Scroll-to-bottom only if the user was already near the bottom. Used
 * by the chunk-by-chunk streaming path so we don't yank the user back
 * down when they've scrolled up to re-read an earlier message
 * mid-stream. Also drives the visibility of the "↓ jump to latest"
 * button — `_state.scrolledUp` flips when the user pulls away.
 */
function maybeAutoScroll(container) {
  if (isNearBottom(container)) {
    scrollMessagesToBottom(container);
  }
}

function refreshJumpButton(container) {
  const btn = container?.querySelector('[data-region="jump-button"]');
  if (!btn) return;
  const show = !isNearBottom(container);
  btn.hidden = !show;
}

// ── Event delegation ─────────────────────────────────────────────────

function ensureAssistantListener() {
  if (_assistantListenerWired || typeof document === 'undefined') return;
  _assistantListenerWired = true;

  // Click delegator. Gated by the hash route because the SPA reuses one
  // #page-content container across all routes — DOM containment can't
  // scope the listener.
  document.addEventListener('click', (e) => {
    if (!isOnAssistantRoute()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const btn = target.closest('[data-action]');
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    if (action === 'new-thread') {
      handleNewThread();
    } else if (action === 'select-thread') {
      const id = btn.getAttribute('data-thread-id');
      if (id) handleSelectThread(id);
    } else if (action === 'delete-thread') {
      const id = btn.getAttribute('data-thread-id');
      // Stop the click from also triggering `select-thread` on the
      // surrounding button (the X is a sibling, not a child, but
      // belt-and-suspenders for any future restructure).
      e.stopPropagation();
      if (id) handleDeleteThread(id);
    } else if (action === 'suggest') {
      const prompt = btn.getAttribute('data-prompt');
      if (prompt) handleSuggestion(prompt);
    } else if (action === 'stop-stream') {
      handleStop();
    } else if (action === 'reverse-capability-install') {
      const registryId = btn.getAttribute('data-registry-id');
      const displayName = btn.getAttribute('data-display-name') || registryId || '';
      if (registryId) handleReverseCapabilityInstall(registryId, displayName);
    } else if (action === 'jump-latest') {
      const c = document.getElementById('page-content');
      if (c) {
        scrollMessagesToBottom(c);
        refreshJumpButton(c);
      }
    }
  });

  // Drive the jump-button visibility from scroll on the messages region.
  // Delegated on document with capture so we catch the bubbling
  // `scroll` event from the inner pane (scroll doesn't bubble by default,
  // so capture phase is required).
  document.addEventListener('scroll', (e) => {
    if (!isOnAssistantRoute()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.getAttribute?.('data-region') !== 'messages') return;
    const c = document.getElementById('page-content');
    if (c) refreshJumpButton(c);
  }, true);

  // Form submit (composer) and Enter-to-send (Shift+Enter for newline).
  document.addEventListener('submit', (e) => {
    if (!isOnAssistantRoute()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.getAttribute('data-action') !== 'composer-form') return;
    e.preventDefault();
    handleSend();
  });
  document.addEventListener('keydown', (e) => {
    if (!isOnAssistantRoute()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.getAttribute('data-region') !== 'composer-input') return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  // Persist composer text per active thread on every keystroke. Cheap
  // (sessionStorage write of <few KB on a synthetic input event), and
  // reading happens only on paint() so the read path is unaffected.
  document.addEventListener('input', (e) => {
    if (!isOnAssistantRoute()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.getAttribute('data-region') !== 'composer-input') return;
    writeDraft(_state.activeThreadId, /** @type {HTMLTextAreaElement} */ (target).value);
  });
}

function isOnAssistantRoute() {
  return (window.location.hash || '').split('?')[0] === '#/assistant';
}

// ── Handlers ────────────────────────────────────────────────────────

function handleNewThread() {
  _state.activeThreadId = null;
  _state.messages = [];
  const container = document.getElementById('page-content');
  if (container) paint(container);
}

/**
 * Click on a suggested prompt chip: drop the prompt into the composer and
 * focus it. We intentionally do NOT auto-send — the chip is a starting
 * point, not a commitment. The user can edit, add context, or hit send.
 */
function handleSuggestion(prompt) {
  const container = document.getElementById('page-content');
  const input = container?.querySelector('[data-region="composer-input"]');
  if (!input) return;
  input.value = prompt;
  input.focus();
  // Move cursor to end so a quick tweak ("…and tell me why") flows naturally.
  const end = prompt.length;
  try { input.setSelectionRange(end, end); } catch { /* old browsers */ }
}

async function handleSelectThread(threadId) {
  if (threadId === _state.activeThreadId) return;
  _state.activeThreadId = threadId;
  _state.messages = [];
  const container = document.getElementById('page-content');
  if (!container) return;
  paint(container);
  try {
    const data = await fetchAssistantThread(threadId, _state.userId);
    _state.messages = Array.isArray(data?.messages) ? data.messages : [];
  } catch {
    _state.activeThreadId = null;
    _state.messages = [];
  }
  paint(container);
}

// Pending soft-deletes: thread-id → setTimeout handle. Delete is
// optimistic in the UI but the API call is deferred behind a 6s undo
// window so a misclicked X is recoverable. If the user clicks Undo, we
// cancel the timer and restore the thread without ever hitting the
// server. If 6s elapses, we fire the real DELETE.
const _pendingDeletes = new Map();
const UNDO_WINDOW_MS = 6000;

async function handleDeleteThread(threadId) {
  // Already pending? No-op — the X for a soft-deleted thread isn't
  // visible (we removed it from _state.threads), but defensive.
  if (_pendingDeletes.has(threadId)) return;

  const previousThreads = _state.threads.slice();
  const wasActive = _state.activeThreadId === threadId;
  const previousMessages = wasActive ? _state.messages.slice() : null;

  // Optimistic UI removal.
  _state.threads = _state.threads.filter((t) => t.id !== threadId);
  if (wasActive) {
    _state.activeThreadId = _state.threads[0]?.id ?? null;
    _state.messages = [];
  }
  const container = document.getElementById('page-content');
  if (container) paint(container);

  // If the active thread switched, fetch the new one's messages so the
  // chat pane isn't blank during the undo window.
  if (wasActive && _state.activeThreadId && container) {
    fetchAssistantThread(_state.activeThreadId, _state.userId)
      .then((data) => {
        _state.messages = Array.isArray(data?.messages) ? data.messages : [];
        paint(container);
      })
      .catch(() => { /* leave blank */ });
  }

  const commit = () => {
    _pendingDeletes.delete(threadId);
    deleteAssistantThread(threadId, _state.userId).catch((err) => {
      // Server rejected the delete — restore the thread + warn. Rare
      // (we already passed validation locally), but the UI shouldn't
      // lie about server state.
      _state.threads = previousThreads;
      if (wasActive && previousMessages) {
        _state.activeThreadId = threadId;
        _state.messages = previousMessages;
      }
      if (container) paint(container);
      showToast(`Couldn't delete that conversation: ${err?.message || 'unknown error'}`, { kind: 'danger' });
    });
  };

  const timer = setTimeout(commit, UNDO_WINDOW_MS);
  _pendingDeletes.set(threadId, timer);

  showToast('Conversation deleted', {
    kind: 'info',
    durationMs: UNDO_WINDOW_MS,
    action: {
      label: 'Undo',
      onClick: () => {
        const t = _pendingDeletes.get(threadId);
        if (!t) return;
        clearTimeout(t);
        _pendingDeletes.delete(threadId);
        // Restore. If the previously-active thread came back, also
        // re-select it so the chat pane shows what they were reading.
        _state.threads = previousThreads;
        if (wasActive) {
          _state.activeThreadId = threadId;
          _state.messages = previousMessages || [];
        }
        if (container) paint(container);
      },
    },
  });
}

async function handleSend() {
  if (_state.sending) return;
  const container = document.getElementById('page-content');
  const input = container?.querySelector('[data-region="composer-input"]');
  const content = (input?.value ?? '').trim();
  if (!content) return;

  _state.sending = true;
  // Optimistic user bubble — render locally so the chat feels responsive
  // even if the LLM takes 5 seconds. Real id arrives on response and
  // replaces this one.
  const optimisticUser = {
    id: 'optimistic',
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  };
  _state.messages = _state.messages.concat([optimisticUser]);
  if (input) input.value = '';
  // Clear the draft for the bucket the message was composed in. We use
  // _state.activeThreadId at this point — for a brand-new thread it's
  // still null, so we clear the 'new' bucket. The thread-ID will land
  // in onThread and any subsequent draft writes will go to the new
  // bucket, which is correct behavior.
  clearDraft(_state.activeThreadId);
  if (container) paint(container);

  // Issue #146 (phase 2a): SSE streaming. The user bubble lands optimistically
  // (above), then we open a stream — the API sends `thread` + `user` events
  // first (replacing the optimistic IDs), then `chunk` events as tokens
  // arrive (we append to a streaming assistant bubble), then a final `done`
  // or `error` event. We re-render only on the events that change the
  // structure (thread/user/done/error); per-chunk updates target a single
  // bubble in the DOM directly so we don't re-paint the entire page on
  // every token (would clobber input focus and scroll position).
  let streamingAssistantId = `streaming-${Date.now()}`;
  let streamingContent = '';
  let receivedFirstChunk = false;

  // Per-send AbortController. The Stop button calls .abort() on this so
  // the user can interrupt a long generation. Cleared in `finally` so a
  // race between abort + done doesn't leave a dangling controller.
  const controller = new AbortController();
  _state.streamController = controller;

  try {
    await sendAssistantMessageStream(_state.userId, content, _state.activeThreadId, {
      onThread: (thread) => {
        if (thread?.isNew && thread?.id) {
          _state.activeThreadId = thread.id;
        }
      },
      onUserMessage: (userMessage) => {
        _state.messages = _state.messages
          .filter((m) => m.id !== 'optimistic')
          .concat([userMessage]);
        if (container) paint(container);
      },
      onChunk: (chunk) => {
        streamingContent += chunk;
        if (!receivedFirstChunk) {
          // First chunk: insert the streaming bubble + drop the typing dots.
          receivedFirstChunk = true;
          _state.messages = _state.messages.concat([
            {
              id: streamingAssistantId,
              role: 'assistant',
              content: streamingContent,
              createdAt: new Date().toISOString(),
            },
          ]);
          if (container) paint(container);
        } else {
          // Subsequent chunks: update the bubble's text in place. Direct
          // DOM update avoids a full repaint per token (which would also
          // reset the textarea focus + scroll position).
          const bubble = container?.querySelector(`[data-streaming-id="${streamingAssistantId}"]`);
          if (bubble) {
            bubble.textContent = streamingContent;
            // Only follow the stream if the user was already near the
            // bottom — if they scrolled up to re-read history, leave
            // them alone and let the jump button appear.
            maybeAutoScroll(container);
            refreshJumpButton(container);
          } else {
            // Bubble missing (page navigated away mid-stream and came
            // back?) — fall back to a full re-paint so state stays
            // consistent.
            const idx = _state.messages.findIndex((m) => m.id === streamingAssistantId);
            if (idx >= 0) _state.messages[idx].content = streamingContent;
            if (container) paint(container);
          }
        }
      },
      onDone: (assistantMessage) => {
        // Replace the streaming bubble with the persisted one.
        _state.messages = _state.messages
          .filter((m) => m.id !== streamingAssistantId)
          .concat([assistantMessage]);
        if (container) paint(container);
        // Reverse capability flow (issue #177): check if the assistant's
        // reply indicates an unfulfillable intent and surface install affordance.
        // Best-effort — never blocks the render path.
        checkReverseCapabilityFlow(content, assistantMessage.content, container).catch(() => {});
      },
      onError: ({ message, partialContent }) => {
        // Mid-stream error — keep the partial content if any, append an
        // error caveat in a separate bubble so the user sees both what
        // landed and what went wrong.
        _state.messages = _state.messages.filter((m) => m.id !== streamingAssistantId);
        if (partialContent) {
          _state.messages = _state.messages.concat([
            {
              id: `partial-${Date.now()}`,
              role: 'assistant',
              content: partialContent,
              createdAt: new Date().toISOString(),
            },
          ]);
        }
        _state.messages = _state.messages.concat([
          {
            id: `error-${Date.now()}`,
            role: 'assistant',
            content: `Couldn't finish the reply — ${message}`,
            createdAt: new Date().toISOString(),
          },
        ]);
        if (input && !partialContent) input.value = content;
        if (container) paint(container);
      },
    }, { signal: controller.signal });

    // After a successful stream, refresh the threads list so a new thread
    // shows up in the left rail or an existing one bumps to the top. We
    // do this here rather than per-event to keep the streaming hot path
    // free of network round-trips.
    try {
      const data = await fetchAssistantThreads(_state.userId);
      _state.threads = Array.isArray(data?.threads) ? data.threads : _state.threads;
    } catch {
      /* keep stale threads list — will refresh on next render */
    }
  } catch (err) {
    // User-initiated stop: keep whatever streamed so far as a real
    // assistant bubble (no error caveat), drop the optimistic placeholder
    // tag so it stops looking transient. The server may still have
    // persisted partial text — a thread re-fetch on next view will
    // reconcile if so. No error toast / no error bubble — this was
    // intentional, not a failure.
    if (err?.name === 'AbortError') {
      const idx = _state.messages.findIndex((m) => m.id === streamingAssistantId);
      if (idx >= 0) {
        _state.messages[idx] = {
          ..._state.messages[idx],
          id: `stopped-${Date.now()}`,
          content: streamingContent || '(stopped)',
        };
      }
      return;
    }
    // Transport-level failure (network down, 4xx/5xx pre-stream). Drop
    // the optimistic bubble, restore input, surface error in an
    // assistant-shaped bubble.
    _state.messages = _state.messages.filter(
      (m) => m.id !== 'optimistic' && m.id !== streamingAssistantId,
    );
    // UX review #9: when the failure is "no AI provider configured" (HTTP
    // 409 from /api/assistant/messages), the error bubble carries an
    // intentRoute hint that the web client renders as a deep-link to
    // Settings — much friendlier than just showing "No AI provider
    // configured" with no path forward.
    const friendly = err instanceof Error ? err.message : String(err);
    const isNoProvider = err?.kind === 'bad-request' && /provider/i.test(friendly);
    const errorBubble = {
      id: `error-${Date.now()}`,
      role: 'assistant',
      content: isNoProvider
        ? `I need an AI provider configured before I can chat. Open Settings → AI brain to add one.`
        : `Couldn't reach the assistant — ${friendly}`,
      createdAt: new Date().toISOString(),
      ...(isNoProvider ? { metadata: { intentRoute: { kind: 'needs-setup', target: '#/settings' } } } : {}),
    };
    _state.messages = _state.messages.concat([errorBubble]);
    if (input) input.value = content;
  } finally {
    _state.sending = false;
    // Clear only if it's still ours — defensive in case a race somehow
    // started a second send before we got here (shouldn't be possible
    // because handleSend bails when _state.sending is true, but cheap).
    if (_state.streamController === controller) {
      _state.streamController = null;
    }
    if (container) paint(container);
  }
}

/**
 * Stop button handler. Aborts the in-flight stream — fetch read loop
 * exits, the AbortError lands in handleSend's catch, and any partial
 * streamed content is preserved as a real assistant bubble (vs. an
 * error bubble) so the user keeps what they got. No-op when nothing
 * is in flight.
 */
function handleStop() {
  const c = _state.streamController;
  if (!c) return;
  c.abort();
}
