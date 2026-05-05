import {
  fetchAssistantThreads,
  fetchAssistantThread,
  deleteAssistantThread,
  sendAssistantMessageStream,
  escapeHtml,
  renderApiError,
  wireApiRetry,
} from '../api-client.js';

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
};

let _assistantListenerWired = false;

export async function renderAssistant(container, userId) {
  _state.userId = userId;
  ensureAssistantListener();

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
        <form class="assistant-composer" data-action="composer-form">
          <textarea
            class="assistant-composer-input"
            data-region="composer-input"
            rows="2"
            placeholder="Ask your twin anything…"
            ${_state.sending ? 'disabled' : ''}
            aria-label="Message"
          ></textarea>
          <button
            class="assistant-composer-send"
            type="submit"
            ${_state.sending ? 'disabled' : ''}
            aria-label="Send"
          >
            ${_state.sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      </section>
    </div>
  `;

  scrollMessagesToBottom(container);
  // Auto-focus the composer when entering the page or after a send finishes,
  // not while sending (textarea is disabled then anyway).
  if (!_state.sending) {
    const input = container.querySelector('[data-region="composer-input"]');
    input?.focus();
  }
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
    return `
      <div class="assistant-empty">
        <div class="assistant-empty-title">Start a conversation</div>
        <div class="assistant-empty-desc">
          Ask anything. I can also queue actions for your approval — try
          "archive that email" or "schedule a meeting with X".
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
    }
  });

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

async function handleDeleteThread(threadId) {
  // No native confirm() — keeps the look consistent and avoids the system
  // dialog interruption. Future phase can build a custom confirm modal.
  // Optimistically drop from the list, restore on failure.
  const previous = _state.threads.slice();
  _state.threads = _state.threads.filter((t) => t.id !== threadId);
  let switched = false;
  if (_state.activeThreadId === threadId) {
    _state.activeThreadId = _state.threads[0]?.id ?? null;
    _state.messages = [];
    switched = true;
  }
  const container = document.getElementById('page-content');
  if (container) paint(container);

  try {
    await deleteAssistantThread(threadId, _state.userId);
    // If the active thread switched to a different one, fetch its messages.
    if (switched && _state.activeThreadId && container) {
      try {
        const data = await fetchAssistantThread(_state.activeThreadId, _state.userId);
        _state.messages = Array.isArray(data?.messages) ? data.messages : [];
        paint(container);
      } catch {
        /* swallow — leave state as is */
      }
    }
  } catch (err) {
    // Rollback on failure so the UI doesn't lie about the server state.
    _state.threads = previous;
    if (container) paint(container);
    // eslint-disable-next-line no-console
    console.warn('Failed to delete thread:', err);
  }
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
            scrollMessagesToBottom(container);
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
    });

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
    if (container) paint(container);
  }
}
