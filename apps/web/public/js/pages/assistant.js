import {
  fetchAssistantThreads,
  fetchAssistantThread,
  deleteAssistantThread,
  sendAssistantMessage,
  escapeHtml,
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
    container.innerHTML = renderError(err);
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
          Ask anything. Phase 1 is text-only — for now I can talk but not
          take actions on your accounts. Use the rest of the dashboard for that.
        </div>
      </div>
    `;
  }
  const bubbles = messages
    .map((m) => {
      const role = m.role === 'user' ? 'user' : 'assistant';
      return `
        <div class="assistant-bubble assistant-bubble-${role}">
          <div class="assistant-bubble-content">${escapeHtml(m.content)}</div>
        </div>
      `;
    })
    .join('');
  const typing = sending
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

function renderError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return `
    <div class="card" style="border-left: 3px solid var(--danger, #ef4444);">
      <div class="card-header"><span class="card-title">Couldn't load the assistant</span></div>
      <div class="card-subtitle">${escapeHtml(msg)}</div>
    </div>
  `;
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

  try {
    const result = await sendAssistantMessage(_state.userId, content, _state.activeThreadId);
    // Replace optimistic message with the persisted ones from the server,
    // then append the assistant reply.
    _state.messages = _state.messages
      .filter((m) => m.id !== 'optimistic')
      .concat([result.userMessage, result.assistantMessage]);

    // If this was a new thread, capture its id and refresh the threads list
    // so it appears in the left rail immediately.
    if (result.thread?.isNew && result.thread?.id) {
      _state.activeThreadId = result.thread.id;
      try {
        const data = await fetchAssistantThreads(_state.userId);
        _state.threads = Array.isArray(data?.threads) ? data.threads : _state.threads;
      } catch {
        /* keep stale threads list — will refresh on next render */
      }
    } else {
      // Bump the active thread to the top of the threads list locally
      // (server bumped updated_at; reflect that in the UI without a fetch).
      const idx = _state.threads.findIndex((t) => t.id === _state.activeThreadId);
      if (idx > 0) {
        const [t] = _state.threads.splice(idx, 1);
        if (t) _state.threads.unshift({ ...t, updatedAt: new Date().toISOString() });
      }
    }
  } catch (err) {
    // Restore the input so the user can retry, drop the optimistic bubble,
    // and surface the error in an assistant-shaped bubble. Phase 2 should
    // make this a proper toast.
    _state.messages = _state.messages.filter((m) => m.id !== 'optimistic');
    _state.messages = _state.messages.concat([
      {
        id: 'error',
        role: 'assistant',
        content: `Couldn't reach the assistant — ${err instanceof Error ? err.message : String(err)}`,
        createdAt: new Date().toISOString(),
      },
    ]);
    if (input) input.value = content;
  } finally {
    _state.sending = false;
    if (container) paint(container);
  }
}
