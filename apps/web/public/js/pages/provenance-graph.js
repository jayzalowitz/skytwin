import {
  escapeHtml,
  renderApiError,
  wireApiRetry,
} from '../api-client.js';
import { KEY_USER_ID } from '../storage-keys.js';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton click/change delegator guard.
//
// The SPA reuses one #page-content container across all routes, so
// container.contains(target) is always true for every page's clicks.
// Instead we gate on window.location.hash. The guard prevents stacking
// one new listener per render.
// ─────────────────────────────────────────────────────────────────────────────
let _provenanceGraphListenerWired = false;

// Currently-selected node for the side flyout
let _selectedNodeId = null;
let _graphData = null;

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

function ensureProvenanceGraphListener() {
  if (_provenanceGraphListenerWired || typeof document === 'undefined') return;
  _provenanceGraphListenerWired = true;
  document.addEventListener('click', handleProvenanceGraphAction);
  document.addEventListener('change', handleProvenanceGraphChange);
}

function handleProvenanceGraphChange(e) {
  const hash = (window.location.hash || '').split('?')[0];
  if (hash !== '#/provenance') return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (!target) return;

  if (target.id === 'pg-filter-type' || target.id === 'pg-filter-since') {
    applyFilters();
  }
}

function handleProvenanceGraphAction(e) {
  const hash = (window.location.hash || '').split('?')[0];
  if (hash !== '#/provenance') return;

  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const btn = target.closest('[data-action]');
  if (!btn) return;

  const action = btn.getAttribute('data-action');

  switch (action) {
    case 'pg-close-flyout': {
      closeFlyout();
      break;
    }
    case 'pg-apply-filters': {
      applyFilters();
      break;
    }
    case 'pg-view-full-graph': {
      // Reload with a higher cap. The server hard-limits the graph endpoint
      // to 1000 nodes; passing the same default 200 here would be a no-op.
      const userId = getCurrentUserId();
      renderProvenanceGraph(document.getElementById('page-content'), userId, { limit: 1000 });
      break;
    }
    case 'pg-clear-wing-filter': {
      // Strip the `?wing=` query from the hash so subsequent renders
      // load the un-scoped graph. Two branches:
      //   - Hash currently has `?wing=…` → setting `window.location.hash`
      //     to `#/provenance` triggers a hashchange event; the SPA
      //     router responds by re-routing into this page, which calls
      //     renderProvenanceGraph again. We rely on the router here.
      //   - Hash is already `#/provenance` (unlikely path — clear was
      //     somehow clicked twice or the URL was edited) → call
      //     renderProvenanceGraph explicitly with wing='' so the
      //     scope clears without depending on a hashchange that
      //     won't fire.
      const newHash = '#/provenance';
      if (window.location.hash !== newHash) {
        window.location.hash = newHash;
      } else {
        renderProvenanceGraph(document.getElementById('page-content'), getCurrentUserId(), { wing: '' });
      }
      break;
    }
    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API fetch helper
// ─────────────────────────────────────────────────────────────────────────────

async function fetchProvenanceGraph(userId, { nodeType = '', since = '', limit = 200, wing = '' } = {}) {
  const params = new URLSearchParams({ userId });
  if (nodeType) params.set('nodeType', nodeType);
  if (since) params.set('since', since);
  if (wing) params.set('wing', wing);
  if (limit !== 200) params.set('limit', String(limit));

  const res = await fetch(`/api/capabilities/provenance-graph?${params}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(
      new Error(body.error || `HTTP ${res.status}`),
      { friendlyMessage: body.error || 'Could not load provenance graph.' },
    );
  }
  return res.json();
}

/**
 * Read the `wing` query param off the hash. Hash routes are like
 * `#/provenance?wing=<uuid>`; the lifebook page links here with that
 * shape. Returns '' when no wing param is set. Validates against the
 * UUID shape so a malformed value can't get forwarded to the API.
 */
function readWingFromHash() {
  const hash = window.location.hash || '';
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return '';
  const search = new URLSearchParams(hash.slice(qIdx + 1));
  const wing = search.get('wing') || '';
  // RFC 4122 UUID shape — same regex the API uses to validate.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wing)) {
    return '';
  }
  return wing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main render entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function renderProvenanceGraph(container, userId, opts = {}) {
  ensureProvenanceGraphListener();
  container.innerHTML = '<div class="loading">Loading provenance graph…</div>';

  // Read `wing` from the hash query string unless the caller explicitly
  // overrode it. The lifebook page links here with `?wing=<uuid>`; the
  // graph filters to nodes scoped to that Lifebook wing.
  const wing = opts.wing !== undefined ? opts.wing : readWingFromHash();
  const fetchOpts = { ...opts, wing };

  let data;
  try {
    data = await fetchProvenanceGraph(userId, fetchOpts);
  } catch (err) {
    container.innerHTML = renderApiError(err, {
      context: "Couldn't load provenance graph.",
      retry: () => renderProvenanceGraph(container, userId, opts),
    });
    wireApiRetry(container, () => renderProvenanceGraph(container, userId, opts));
    return;
  }

  _graphData = data;
  _selectedNodeId = null;

  const { nodes, edges } = data;
  const isTruncated = nodes.length >= 200;

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 1rem; height: 100%;">
      <div class="card" style="flex-shrink: 0;">
        <div class="card-header">
          <span class="card-title">Provenance graph</span>
          <span class="badge badge-info">${nodes.length} node${nodes.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="card-subtitle" style="margin-bottom: 0.75rem;">
          Capability lifecycle events — signals, installs, promotions, actions.
          Click a node to see its full payload.
        </div>
        ${wing ? `
          <div style="display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem; margin-bottom: 0.5rem; background: var(--bg-accent, var(--bg-card)); border-left: 3px solid var(--primary); border-radius: var(--radius-sm); font-size: 0.8rem;">
            <span>Scoped to one Lifebook wing.</span>
            <button class="btn btn-outline btn-sm" style="font-size: 0.7rem; padding: 0.1rem 0.4rem;" data-action="pg-clear-wing-filter">Show all wings</button>
          </div>
        ` : ''}
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: flex-end;">
          <label style="font-size: 0.8rem; color: var(--text-muted);">
            Filter by type
            <select class="form-input" id="pg-filter-type" style="margin-top: 0.2rem; min-width: 140px; font-size: 0.85rem;">
              <option value="">All types</option>
              <option value="signal">signal</option>
              <option value="entity">entity</option>
              <option value="suggestion">suggestion</option>
              <option value="install">install</option>
              <option value="tier_promotion">tier_promotion</option>
              <option value="action">action</option>
              <option value="feedback">feedback</option>
              <option value="uninstall">uninstall</option>
              <option value="external_agent">external_agent</option>
            </select>
          </label>
          <label style="font-size: 0.8rem; color: var(--text-muted);">
            Since
            <input type="date" class="form-input" id="pg-filter-since" style="margin-top: 0.2rem; font-size: 0.85rem;">
          </label>
          <button class="btn btn-primary btn-sm" data-action="pg-apply-filters">Apply</button>
        </div>
        ${isTruncated ? `
          <div style="margin-top: 0.5rem; font-size: 0.8rem; color: var(--text-muted);">
            Showing the 200 most recent nodes.
            <button class="btn btn-outline btn-sm" style="font-size: 0.75rem; padding: 0.2rem 0.5rem;" data-action="pg-view-full-graph">Reload with higher limit</button>
          </div>
        ` : ''}
      </div>

      <div style="display: flex; gap: 1rem; flex: 1; min-height: 0;">
        <div id="pg-graph-container" style="flex: 1; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; min-height: 400px;">
          ${nodes.length === 0
            ? '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-size: 0.9rem;">No provenance events yet.</div>'
            : '<!-- force graph renders here -->'
          }
        </div>
        <div id="pg-flyout" style="display: none; width: 280px; flex-shrink: 0; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1rem; overflow-y: auto; max-height: 600px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem;">
            <span style="font-weight: 600; font-size: 0.9rem;" id="pg-flyout-title">Node details</span>
            <button class="btn btn-outline btn-sm" data-action="pg-close-flyout" style="padding: 0.1rem 0.4rem; font-size: 0.8rem;">Close</button>
          </div>
          <div id="pg-flyout-body"></div>
        </div>
      </div>
    </div>
  `;

  if (nodes.length > 0) {
    renderForceGraph(document.getElementById('pg-graph-container'), nodes, edges, userId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Force-directed SVG graph — minimal Verlet integration, no external deps
//
// Model:
//   - Each node has a position (x, y) and velocity (vx, vy)
//   - Spring force: pull connected nodes together (Hooke)
//   - Charge force: repel all node pairs (simplified)
//   - Boundary: box walls clamp positions
//   - Integration: Verlet (x += vx*dt, apply damping)
//
// Runs for MAX_TICKS ticks then freezes. All rendering is into a single SVG.
// Click a node to open the flyout. No D3, no canvas, no deps.
// ─────────────────────────────────────────────────────────────────────────────

const NODE_RADIUS = 8;
const SPRING_LENGTH = 80;
const SPRING_K = 0.04;
const CHARGE_K = 2500;
const DAMPING = 0.7;
const MAX_TICKS = 250;
const TICK_MS = 16;

const NODE_TYPE_COLORS = {
  signal: '#60a5fa',        // blue
  entity: '#a78bfa',        // purple
  suggestion: '#fbbf24',    // yellow
  install: '#34d399',       // green
  tier_promotion: '#f97316', // orange
  action: '#f43f5e',        // red
  feedback: '#94a3b8',      // slate
  uninstall: '#dc2626',     // dark red
  external_agent: '#0ea5e9', // sky
};

function nodeColor(type) {
  return NODE_TYPE_COLORS[type] || '#94a3b8';
}

function renderForceGraph(container, nodes, edges, _userId) {
  const width = container.clientWidth || 600;
  const height = container.clientHeight || 420;

  // Build adjacency index for spring computation
  const adjacency = new Map();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    if (adjacency.has(edge.from)) adjacency.get(edge.from).push(edge.to);
    if (adjacency.has(edge.to)) adjacency.get(edge.to).push(edge.from);
  }

  // Initialise positions randomly inside the viewport
  const sim = nodes.map((node) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    payload: node.payload,
    occurredAt: node.occurredAt,
    x: 40 + Math.random() * (width - 80),
    y: 40 + Math.random() * (height - 80),
    vx: 0,
    vy: 0,
  }));

  const nodeById = new Map(sim.map((n) => [n.id, n]));

  let tick = 0;
  let animFrame = null;

  function step() {
    if (tick >= MAX_TICKS) return;
    tick++;

    // Reset forces
    for (const n of sim) { n.fx = 0; n.fy = 0; }

    // Charge repulsion: O(n^2) — acceptable for <= 200 nodes
    for (let i = 0; i < sim.length; i++) {
      for (let j = i + 1; j < sim.length; j++) {
        const a = sim[i];
        const b = sim[j];
        const dx = b.x - a.x || 0.01;
        const dy = b.y - a.y || 0.01;
        const dist2 = dx * dx + dy * dy;
        const dist = Math.sqrt(dist2) || 0.01;
        const force = CHARGE_K / dist2;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.fx -= fx;
        a.fy -= fy;
        b.fx += fx;
        b.fy += fy;
      }
    }

    // Spring attraction along edges
    for (const edge of edges) {
      const a = nodeById.get(edge.from);
      const b = nodeById.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const stretch = dist - SPRING_LENGTH;
      const force = SPRING_K * stretch;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.fx += fx;
      a.fy += fy;
      b.fx -= fx;
      b.fy -= fy;
    }

    // Verlet integration with damping + boundary clamping
    for (const n of sim) {
      n.vx = (n.vx + n.fx) * DAMPING;
      n.vy = (n.vy + n.fy) * DAMPING;
      n.x = Math.max(NODE_RADIUS, Math.min(width - NODE_RADIUS, n.x + n.vx));
      n.y = Math.max(NODE_RADIUS, Math.min(height - NODE_RADIUS, n.y + n.vy));
    }

    paint(svgEl, edgeGroupEl, nodeGroupEl, sim, edges);

    if (tick < MAX_TICKS) {
      animFrame = setTimeout(() => { animFrame = null; step(); }, TICK_MS);
    }
  }

  // Create SVG
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('width', String(width));
  svgEl.setAttribute('height', String(height));
  svgEl.style.cssText = 'display: block; width: 100%; height: 100%;';

  const edgeGroupEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  edgeGroupEl.setAttribute('class', 'pg-edges');
  const nodeGroupEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  nodeGroupEl.setAttribute('class', 'pg-nodes');

  svgEl.appendChild(edgeGroupEl);
  svgEl.appendChild(nodeGroupEl);
  container.innerHTML = '';
  container.appendChild(svgEl);

  // Legend
  const legendEl = document.createElement('div');
  legendEl.style.cssText = 'position: absolute; bottom: 8px; left: 8px; display: flex; flex-wrap: wrap; gap: 4px;';
  legendEl.style.pointerEvents = 'none';
  const usedTypes = [...new Set(nodes.map((n) => n.type))];
  for (const t of usedTypes) {
    const chip = document.createElement('span');
    chip.style.cssText = `background: ${nodeColor(t)}22; border: 1px solid ${nodeColor(t)}88; color: ${nodeColor(t)}; border-radius: 4px; padding: 1px 5px; font-size: 0.68rem;`;
    chip.textContent = t;
    legendEl.appendChild(chip);
  }
  const wrapEl = container;
  wrapEl.style.position = 'relative';
  wrapEl.appendChild(legendEl);

  // Node click handler — opens flyout with full payload
  svgEl.addEventListener('click', (e) => {
    const hash = (window.location.hash || '').split('?')[0];
    if (hash !== '#/provenance') return;
    const target = e.target;
    const circle = target.closest('[data-node-id]');
    if (!circle) return;
    const nodeId = circle.getAttribute('data-node-id');
    openFlyout(nodeId, sim);
  });

  step();
}

function paint(svgEl, edgeGroupEl, nodeGroupEl, sim, edges) {
  // Paint edges
  edgeGroupEl.innerHTML = '';
  const nodeById = new Map(sim.map((n) => [n.id, n]));
  for (const edge of edges) {
    const a = nodeById.get(edge.from);
    const b = nodeById.get(edge.to);
    if (!a || !b) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(Math.round(a.x)));
    line.setAttribute('y1', String(Math.round(a.y)));
    line.setAttribute('x2', String(Math.round(b.x)));
    line.setAttribute('y2', String(Math.round(b.y)));
    line.setAttribute('stroke', 'var(--border)');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-opacity', '0.7');
    edgeGroupEl.appendChild(line);
  }

  // Paint nodes
  nodeGroupEl.innerHTML = '';
  for (const n of sim) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-node-id', n.id);
    g.setAttribute('class', 'pg-node');
    g.style.cursor = 'pointer';

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(Math.round(n.x)));
    circle.setAttribute('cy', String(Math.round(n.y)));
    circle.setAttribute('r', String(NODE_RADIUS));
    circle.setAttribute('fill', nodeColor(n.type));
    circle.setAttribute('stroke', n.id === _selectedNodeId ? '#fff' : 'transparent');
    circle.setAttribute('stroke-width', '2');
    circle.setAttribute('fill-opacity', n.id === _selectedNodeId ? '1' : '0.82');
    g.appendChild(circle);

    // Label — only show for selected or when node count is small
    if (n.id === _selectedNodeId || _graphData?.nodes?.length <= 30) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(Math.round(n.x)));
      text.setAttribute('y', String(Math.round(n.y + NODE_RADIUS + 11)));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '9');
      text.setAttribute('fill', 'var(--text-muted)');
      text.setAttribute('pointer-events', 'none');
      text.textContent = n.label.length > 18 ? n.label.slice(0, 16) + '…' : n.label;
      g.appendChild(text);
    }

    nodeGroupEl.appendChild(g);
  }
}

function openFlyout(nodeId, sim) {
  _selectedNodeId = nodeId;
  const node = sim.find((n) => n.id === nodeId);
  const flyout = document.getElementById('pg-flyout');
  const title = document.getElementById('pg-flyout-title');
  const body = document.getElementById('pg-flyout-body');
  if (!flyout || !title || !body || !node) return;

  flyout.style.display = 'block';
  // textContent escapes automatically — running escapeHtml here would
  // double-escape, e.g. an `&` would render as `&amp;` literally.
  title.textContent = node.label || node.type;

  const occurredAt = node.occurredAt ? new Date(node.occurredAt).toLocaleString() : '';

  body.innerHTML = `
    <dl style="font-size: 0.8rem; margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 0.2rem 0.5rem;">
      <dt style="color: var(--text-muted); font-weight: 600;">Type</dt>
      <dd style="margin: 0;">${escapeHtml(node.type)}</dd>
      ${occurredAt ? `<dt style="color: var(--text-muted); font-weight: 600;">When</dt><dd style="margin: 0;">${escapeHtml(occurredAt)}</dd>` : ''}
    </dl>
    <div style="margin-top: 0.75rem;">
      <div style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted); margin-bottom: 0.3rem;">Full payload</div>
      <pre style="font-size: 0.72rem; background: var(--bg); border-radius: var(--radius-sm); padding: 0.5rem; overflow: auto; max-height: 300px; margin: 0; white-space: pre-wrap; word-break: break-word;">${escapeHtml(JSON.stringify(node.payload, null, 2))}</pre>
    </div>
  `;
}

function closeFlyout() {
  _selectedNodeId = null;
  const flyout = document.getElementById('pg-flyout');
  if (flyout) flyout.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter application (re-fetches from API with filter params)
// ─────────────────────────────────────────────────────────────────────────────

async function applyFilters() {
  const container = document.getElementById('page-content');
  if (!container) return;
  const userId = getCurrentUserId();
  const nodeType = document.getElementById('pg-filter-type')?.value || '';
  const sinceDate = document.getElementById('pg-filter-since')?.value || '';
  const since = sinceDate ? new Date(sinceDate).toISOString() : '';

  const graphContainer = document.getElementById('pg-graph-container');
  if (graphContainer) {
    graphContainer.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-size: 0.9rem;">Loading…</div>';
  }

  let data;
  try {
    data = await fetchProvenanceGraph(userId, { nodeType, since });
  } catch (err) {
    if (graphContainer) {
      graphContainer.innerHTML = `<div style="padding: 1rem; color: var(--danger); font-size: 0.85rem;">${escapeHtml(err.friendlyMessage || err.message)}</div>`;
    }
    return;
  }

  _graphData = data;
  _selectedNodeId = null;
  closeFlyout();

  const countBadge = document.querySelector('.card-header .badge-info');
  if (countBadge) {
    const n = data.nodes.length;
    countBadge.textContent = `${n} node${n !== 1 ? 's' : ''}`;
  }

  if (graphContainer) {
    if (data.nodes.length === 0) {
      graphContainer.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-size: 0.9rem;">No nodes match this filter.</div>';
    } else {
      renderForceGraph(graphContainer, data.nodes, data.edges, userId);
    }
  }
}
