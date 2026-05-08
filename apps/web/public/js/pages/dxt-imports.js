import { fetchJSON, escapeHtml } from '../api-client.js';
import { showToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

// ─── Singleton delegator ───────────────────────────────────────────────────
// Wired once on document. The SPA reuses #page-content across routes, so
// DOM containment can't scope the singleton — we gate on the hash route.
let _dxtImportsListenerWired = false;

function ensureDxtImportsListener() {
  if (_dxtImportsListenerWired) return;
  _dxtImportsListenerWired = true;

  document.addEventListener('click', async (e) => {
    // Gate: only handle clicks when we're on the dxt/imports page
    const currentPage = window.location.hash.split('?')[0];
    if (currentPage !== '#/dxt/imports') return;

    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const userId = getCurrentUserId();

    if (action === 'review-import') {
      const importId = target.dataset.importId;
      if (!importId) return;
      const detailEl = document.getElementById(`import-detail-${importId}`);
      if (detailEl) {
        detailEl.style.display = detailEl.style.display === 'none' ? 'block' : 'none';
      }
      return;
    }

    if (action === 'confirm-import') {
      const importId = target.dataset.importId;
      if (!importId) return;
      if (!confirm('Install this capability? It will be added to your account at trust tier "observer".')) return;

      target.disabled = true;
      target.textContent = 'Installing...';

      try {
        const data = await fetchJSON(
          `/api/dxt/imports/${encodeURIComponent(importId)}/confirm?userId=${encodeURIComponent(userId)}`,
          { method: 'POST' },
        );
        showToast(`Installed: ${escapeHtml(data.registryId)}`);
        const container = document.getElementById('page-content');
        if (container) await renderDxtImports(container, userId);
      } catch (err) {
        showToast(err.friendlyMessage ?? 'Failed to install capability', 'error');
        target.disabled = false;
        target.textContent = 'Install';
      }
      return;
    }

    if (action === 'reject-import') {
      const importId = target.dataset.importId;
      if (!importId) return;
      if (!confirm('Reject this import? It will be marked as rejected and cannot be installed without re-uploading.')) return;

      target.disabled = true;
      target.textContent = 'Rejecting...';

      try {
        await fetchJSON(
          `/api/dxt/imports/${encodeURIComponent(importId)}/reject?userId=${encodeURIComponent(userId)}`,
          { method: 'POST' },
        );
        showToast('Import rejected');
        const container = document.getElementById('page-content');
        if (container) await renderDxtImports(container, userId);
      } catch (err) {
        showToast(err.friendlyMessage ?? 'Failed to reject import', 'error');
        target.disabled = false;
        target.textContent = 'Reject';
      }
      return;
    }
  });
}

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

function statusBadge(status) {
  const colors = {
    pending: 'var(--warning)',
    installed: 'var(--success)',
    rejected: 'var(--text-muted)',
    failed: 'var(--danger)',
  };
  const color = colors[status] ?? 'var(--text-muted)';
  return `<span style="display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; color: ${color}; border: 1px solid ${color};">${escapeHtml(status)}</span>`;
}

/**
 * Render the DXT Imports page.
 * Lists all imports for the user with status badges and confirm/reject actions.
 */
export async function renderDxtImports(container, userId) {
  ensureDxtImportsListener();

  let imports = [];
  try {
    const data = await fetchJSON(
      `/api/dxt/imports?userId=${encodeURIComponent(userId)}`,
    );
    imports = data.imports ?? [];
  } catch (err) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header"><span class="card-title">DXT Capability Imports</span></div>
        <div class="error-banner">${escapeHtml(err.friendlyMessage ?? 'Failed to load imports')}</div>
      </div>
    `;
    return;
  }

  const pendingImports = imports.filter((i) => i.status === 'pending');
  const otherImports = imports.filter((i) => i.status !== 'pending');

  const renderImportRow = (imp) => {
    const detailId = `import-detail-${escapeHtml(imp.id)}`;
    const skills = imp.preview?.capability?.skills ?? [];
    const transport = imp.preview?.capability?.transport ?? 'unknown';
    const sourceId = imp.sourceInstanceId ? escapeHtml(imp.sourceInstanceId) : 'unknown';

    const detailBlock = `
      <div id="${detailId}" style="display: none; margin-top: 0.75rem; padding: 0.75rem; background: var(--bg-input); border-radius: 4px;">
        <div style="font-size: 0.85rem; margin-bottom: 0.5rem;">
          <strong>Transport:</strong> ${escapeHtml(transport)}<br>
          <strong>Source instance:</strong> ${sourceId}<br>
          <strong>SHA-256:</strong> <code style="font-size: 0.75rem;">${escapeHtml((imp.sha256 ?? '').slice(0, 16))}...</code>
        </div>
        ${skills.length > 0 ? `
          <div style="font-size: 0.85rem; margin-bottom: 0.5rem;">
            <strong>Skills (${skills.length}):</strong>
            <ul style="margin: 0.25rem 0 0 1rem; padding: 0;">
              ${skills.map((s) => `<li>${escapeHtml(String(s))}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        ${imp.status === 'pending' ? `
          <div style="margin-top: 0.75rem; display: flex; gap: 0.5rem;">
            <button class="btn btn-primary btn-sm"
              data-action="confirm-import"
              data-import-id="${escapeHtml(imp.id)}">
              Install
            </button>
            <button class="btn btn-outline btn-sm" style="color: var(--danger);"
              data-action="reject-import"
              data-import-id="${escapeHtml(imp.id)}">
              Reject
            </button>
          </div>
        ` : ''}
        ${imp.errorMessage ? `<div style="color: var(--danger); font-size: 0.8rem; margin-top: 0.5rem;">Error: ${escapeHtml(imp.errorMessage)}</div>` : ''}
      </div>
    `;

    return `
      <div style="padding: 0.75rem 0; border-bottom: 1px solid var(--border);">
        <div style="display: flex; align-items: center; gap: 1rem;">
          <div style="flex: 1;">
            <div style="font-weight: 600;">${escapeHtml(imp.registryId)}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">
              Imported: ${new Date(imp.importedAt).toLocaleString()}
              ${imp.installedAt ? ` &bull; Installed: ${new Date(imp.installedAt).toLocaleString()}` : ''}
              ${imp.rejectedAt ? ` &bull; Rejected: ${new Date(imp.rejectedAt).toLocaleString()}` : ''}
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            ${statusBadge(imp.status)}
            ${imp.status === 'pending' ? `
              <button class="btn btn-outline btn-sm"
                data-action="review-import"
                data-import-id="${escapeHtml(imp.id)}">
                Review
              </button>
            ` : `
              <button class="btn btn-outline btn-sm"
                data-action="review-import"
                data-import-id="${escapeHtml(imp.id)}">
                Details
              </button>
            `}
          </div>
        </div>
        ${detailBlock}
      </div>
    `;
  };

  const pendingSection = pendingImports.length === 0
    ? '<p style="color: var(--text-muted); font-size: 0.9rem;">No pending imports. Upload a .dxt file via POST /api/dxt/import to get started.</p>'
    : pendingImports.map(renderImportRow).join('');

  const historySection = otherImports.length === 0
    ? '<p style="color: var(--text-muted); font-size: 0.9rem;">No import history yet.</p>'
    : otherImports.map(renderImportRow).join('');

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">DXT Capability Imports</span>
      </div>
      <div class="card-subtitle">
        Review and install capability configurations shared as .dxt files.
        Each import requires your explicit confirmation before anything is installed.
      </div>

      <h3 style="margin: 1.5rem 0 0.75rem; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">
        Pending review (${pendingImports.length})
      </h3>
      ${pendingSection}
    </div>

    <div class="card" style="margin-top: 1rem;">
      <div class="card-header">
        <span class="card-title">Import history</span>
      </div>
      ${historySection}
    </div>
  `;
}
