import { fetchJSON, escapeHtml } from '../api-client.js';
import { showToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

// ─── Singleton delegator ───────────────────────────────────────────────────
// Wired once on document. The SPA reuses #page-content across routes, so
// DOM containment can't scope the singleton — we gate on the hash route.
let _twinTokensListenerWired = false;

function ensureTwinTokensListener() {
  if (_twinTokensListenerWired) return;
  _twinTokensListenerWired = true;

  document.addEventListener('click', async (e) => {
    // Gate: only handle clicks when we're on the twin-server-tokens page
    const currentPage = window.location.hash.split('?')[0];
    if (currentPage !== '#/twin-server-tokens') return;

    const target = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!target) return;

    const action = target.dataset.action;
    const userId = getCurrentUserId();

    if (action === 'revoke-token') {
      const tokenId = target.dataset.tokenId;
      if (!tokenId) return;
      if (!confirm('Revoke this token? Any MCP client using it will lose access immediately.')) return;

      try {
        await fetchJSON(`/api/external-agents/tokens/${tokenId}?userId=${encodeURIComponent(userId)}`, {
          method: 'DELETE',
        });
        showToast('Token revoked');
        const container = document.getElementById('page-content');
        if (container) await renderTwinServerTokens(container, userId);
      } catch (err) {
        showToast(err.friendlyMessage ?? 'Failed to revoke token', 'error');
      }
      return;
    }

    if (action === 'copy-token') {
      const tokenValue = target.dataset.tokenValue;
      if (!tokenValue) return;
      try {
        await navigator.clipboard.writeText(tokenValue);
        showToast('Token copied to clipboard');
      } catch {
        showToast('Copy failed — select and copy manually', 'error');
      }
      return;
    }

    if (action === 'confirm-saved') {
      document.getElementById('new-token-modal')?.remove();
      const container = document.getElementById('page-content');
      if (container) await renderTwinServerTokens(container, userId);
      return;
    }

    if (action === 'copy-snippet') {
      const snippetId = target.dataset.snippetId;
      const snippet = document.getElementById(snippetId)?.textContent;
      if (!snippet) return;
      try {
        await navigator.clipboard.writeText(snippet);
        showToast('Snippet copied');
      } catch {
        showToast('Copy failed', 'error');
      }
    }
  });

  document.addEventListener('submit', async (e) => {
    const currentPage = window.location.hash.split('?')[0];
    if (currentPage !== '#/twin-server-tokens') return;

    const form = e.target instanceof Element ? e.target.closest('#generate-token-form') : null;
    if (!form) return;

    e.preventDefault();
    await generateToken(getCurrentUserId());
  });
}

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

async function generateToken(userId) {
  const form = document.getElementById('generate-token-form');
  if (!form) return;

  const scope = form.querySelector('[name="scope"]')?.value;
  const agentName = form.querySelector('[name="agentName"]')?.value?.trim();

  if (!scope || !agentName) {
    showToast('Please fill in all fields', 'error');
    return;
  }

  try {
    const data = await fetchJSON(
      `/api/external-agents/tokens?userId=${encodeURIComponent(userId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ scope, agentName }),
      },
    );
    showNewTokenModal(data, userId);
  } catch (err) {
    showToast(err.friendlyMessage ?? 'Failed to generate token', 'error');
  }
}

/**
 * Show a modal with the new token value. The user must confirm they saved it.
 */
function showNewTokenModal(data, userId) {
  const existing = document.getElementById('new-token-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'new-token-modal';
  modal.style.cssText = `
    position: fixed; inset: 0; z-index: 2000;
    background: rgba(0,0,0,0.6); display: flex;
    align-items: center; justify-content: center; padding: 1rem;
  `;

  const tokenEscaped = escapeHtml(data.token);
  const agentEscaped = escapeHtml(data.agentName);

  const claudeConfig = JSON.stringify({
    mcpServers: {
      skytwin: {
        url: 'http://localhost:4444/mcp',
        headers: { Authorization: `Bearer ${data.token}` },
      },
    },
  }, null, 2);

  const cursorConfig = JSON.stringify({
    mcpServers: {
      skytwin: {
        url: 'http://localhost:4444/mcp',
        transport: 'http',
        headers: { Authorization: `Bearer ${data.token}` },
      },
    },
  }, null, 2);

  modal.innerHTML = `
    <div class="card" style="max-width: 600px; width: 100%; max-height: 90vh; overflow-y: auto;">
      <div class="card-header">
        <span class="card-title">Your new MCP token</span>
      </div>
      <div class="card-subtitle" style="color: var(--warning); font-weight: 600; margin-bottom: 1rem;">
        Save this token now — it will not be shown again.
      </div>

      <div class="form-group">
        <label>Agent: ${agentEscaped} &bull; Scope: ${escapeHtml(data.scope)}</label>
        <div style="display: flex; gap: 0.5rem; align-items: stretch;">
          <input
            class="form-input"
            id="new-token-value"
            readonly
            value="${tokenEscaped}"
            style="font-family: monospace; font-size: 0.8rem; flex: 1;"
          >
          <button class="btn btn-outline btn-sm"
            data-action="copy-token"
            data-token-value="${tokenEscaped}">
            Copy
          </button>
        </div>
      </div>

      <details style="margin-top: 1rem;">
        <summary style="cursor: pointer; font-weight: 600; margin-bottom: 0.5rem;">
          Claude Desktop install snippet
        </summary>
        <pre id="snippet-claude" style="background: var(--bg-input); padding: 0.75rem; border-radius: 4px; font-size: 0.75rem; overflow-x: auto;">${escapeHtml(claudeConfig)}</pre>
        <button class="btn btn-outline btn-sm" data-action="copy-snippet" data-snippet-id="snippet-claude">Copy snippet</button>
      </details>

      <details style="margin-top: 0.75rem;">
        <summary style="cursor: pointer; font-weight: 600; margin-bottom: 0.5rem;">
          Cursor install snippet
        </summary>
        <pre id="snippet-cursor" style="background: var(--bg-input); padding: 0.75rem; border-radius: 4px; font-size: 0.75rem; overflow-x: auto;">${escapeHtml(cursorConfig)}</pre>
        <button class="btn btn-outline btn-sm" data-action="copy-snippet" data-snippet-id="snippet-cursor">Copy snippet</button>
      </details>

      <div style="margin-top: 1.5rem; text-align: right;">
        <button class="btn btn-primary" data-action="confirm-saved">
          I've saved my token
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

/**
 * Render the Twin Server Tokens page.
 * Lists active tokens and provides a form to generate new ones.
 */
export async function renderTwinServerTokens(container, userId) {
  ensureTwinTokensListener();

  let tokens = [];
  try {
    const data = await fetchJSON(
      `/api/external-agents/tokens?userId=${encodeURIComponent(userId)}`,
    );
    tokens = data.tokens ?? [];
  } catch (err) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header"><span class="card-title">Connect MCP agents to your twin</span></div>
        <div class="error-banner">${escapeHtml(err.friendlyMessage ?? 'Failed to load tokens')}</div>
      </div>
    `;
    return;
  }

  const scopeLabels = {
    read: 'Read (can ask questions, query memory, view preferences)',
    propose: 'Propose (can suggest actions for your approval)',
    subscribe: 'Subscribe (can receive your signal stream)',
  };

  const tokenRows = tokens.length === 0
    ? '<p style="color: var(--text-muted); font-size: 0.9rem;">No active tokens. Generate one below to connect Claude Desktop, Cursor, or Cline to your twin.</p>'
    : tokens.map((t) => `
      <div style="display: flex; align-items: center; gap: 1rem; padding: 0.75rem 0; border-bottom: 1px solid var(--border);">
        <div style="flex: 1;">
          <div style="font-weight: 600;">${escapeHtml(t.agentName)}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">
            Scope: ${escapeHtml(t.scope)} &bull;
            Issued: ${new Date(t.issuedAt).toLocaleDateString()} &bull;
            Last used: ${t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString() : 'never'}
          </div>
        </div>
        <button class="btn btn-outline btn-sm" style="color: var(--danger);"
          data-action="revoke-token"
          data-token-id="${escapeHtml(t.id)}">
          Revoke
        </button>
      </div>
    `).join('');

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Connect MCP agents to your twin</span>
      </div>
      <div class="card-subtitle">
        Generate tokens to let Claude Desktop, Cursor, Cline, or any MCP client
        query your twin's memory, preferences, and signal stream.
      </div>

      <h3 style="margin: 1.5rem 0 0.75rem; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">
        Active tokens
      </h3>
      ${tokenRows}
    </div>

    <div class="card" style="margin-top: 1rem;">
      <div class="card-header">
        <span class="card-title">Generate a new token</span>
      </div>

      <form id="generate-token-form">
        <div class="form-group">
          <label>Agent name</label>
          <input class="form-input" name="agentName" placeholder="e.g. Claude Desktop" autocomplete="off">
          <div class="form-hint">A label so you can identify this connection later, like Cursor or Cline.</div>
        </div>

        <div class="form-group">
          <label>Scope</label>
          <select class="form-input" name="scope">
            <option value="read">Read</option>
            <option value="propose">Propose</option>
            <option value="subscribe">Subscribe</option>
          </select>
          <div class="form-hint">Read can query memory and preferences. Propose can suggest actions for approval. Subscribe can receive your signal stream.</div>
        </div>

        <button class="btn btn-primary" type="submit">
          Generate token
        </button>
      </form>
    </div>

    <div class="card" style="margin-top: 1rem;">
      <div class="card-header">
        <span class="card-title">How to install</span>
      </div>
      <div class="card-subtitle">After generating a token, paste the config snippet into your MCP client.</div>

      <h4 style="margin-top: 1rem; font-weight: 600;">Claude Desktop</h4>
      <p style="font-size: 0.85rem; color: var(--text-muted);">
        Edit <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> (macOS) or
        <code>%APPDATA%\\Claude\\claude_desktop_config.json</code> (Windows):
      </p>
      <pre style="background: var(--bg-input); padding: 0.75rem; border-radius: 4px; font-size: 0.75rem; overflow-x: auto;"
        id="snippet-claude-generic">${escapeHtml(JSON.stringify({
          mcpServers: {
            skytwin: {
              url: 'http://localhost:4444/mcp',
              headers: { Authorization: 'Bearer YOUR_TOKEN_HERE' },
            },
          },
        }, null, 2))}</pre>

      <h4 style="margin-top: 1rem; font-weight: 600;">Cursor</h4>
      <p style="font-size: 0.85rem; color: var(--text-muted);">
        Settings &rarr; MCP &rarr; Add server:
      </p>
      <pre style="background: var(--bg-input); padding: 0.75rem; border-radius: 4px; font-size: 0.75rem; overflow-x: auto;"
        id="snippet-cursor-generic">${escapeHtml(JSON.stringify({
          mcpServers: {
            skytwin: {
              url: 'http://localhost:4444/mcp',
              transport: 'http',
              headers: { Authorization: 'Bearer YOUR_TOKEN_HERE' },
            },
          },
        }, null, 2))}</pre>

      <h4 style="margin-top: 1rem; font-weight: 600;">Cline</h4>
      <p style="font-size: 0.85rem; color: var(--text-muted);">
        Cline MCP settings &rarr; Add server &rarr; URL mode:
      </p>
      <pre style="background: var(--bg-input); padding: 0.75rem; border-radius: 4px; font-size: 0.75rem; overflow-x: auto;"
        id="snippet-cline-generic">${escapeHtml(JSON.stringify({
          servers: [{
            name: 'skytwin',
            type: 'http',
            url: 'http://localhost:4444/mcp',
            headers: { Authorization: 'Bearer YOUR_TOKEN_HERE' },
          }],
        }, null, 2))}</pre>
    </div>
  `;
}
