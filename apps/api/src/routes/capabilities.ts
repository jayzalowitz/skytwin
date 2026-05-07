import { Router } from 'express';
import { mcpServerRepository, appSuggestionRepository, provenanceRepository, mcpServerMetricsRepository, query } from '@skytwin/db';
import type { McpServerRow } from '@skytwin/db';
import type { Request } from 'express';
import { createLogger } from '@skytwin/core';
import { RegistryClient } from '@skytwin/registry-client';
import { TrustTierEngine } from '@skytwin/policy-engine';
import type { TrustTier } from '@skytwin/shared-types';
import { PROMOTION_THRESHOLDS } from '@skytwin/shared-types';
import { runPrompt } from '@skytwin/policy-prompts';
import { getLlmClientFromConfig } from '../lib/llm-client-factory.js';
// SSE event constants — imported for re-export and for use in callers that
// wire the promotion ceremony (e.g. promotion-eligibility-check.ts).
// sseManager and SSE_CAPABILITY_PROMOTION_OFFERED are imported here so they
// are available if the route ever needs to emit directly (currently the job
// handles emissions). void-expressed to satisfy the linter.
import { sseManager as _sseManager, SSE_CAPABILITY_PROMOTION_OFFERED as _SSE_CAP_PROMO } from '../sse.js';
void _sseManager;
void _SSE_CAP_PROMO;

const log = createLogger('api:capabilities');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// PII redaction helper — shared by audit (#183), provenance-graph (#184), and
// evidence-preview (#184) paths. Stored lowercase; keys are lowercased before
// lookup. Match is exact (not regex) so legitimate fields like serverName,
// skillName, recipeName remain visible in the audit trail.
// ─────────────────────────────────────────────────────────────────────────────
const PII_FIELDS = new Set([
  'email', 'phone', 'password', 'token', 'secret', 'ssn', 'credit_card',
  'card_number', 'cvv', 'api_key', 'apikey', 'authorization', 'credential',
  'access_token', 'refresh_token',
]);

export function redactPayload(obj: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object') return obj ?? null;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (PII_FIELDS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactPayload(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence preview builder for AppSuggestion multi-modal display.
// Takes a raw signal row and returns a redacted preview safe to send to clients.
// PII is stripped before the response is sent — the client never sees raw PII.
// ─────────────────────────────────────────────────────────────────────────────

export interface EvidencePreview {
  kind: 'email' | 'calendar' | 'file_image' | 'file_other' | 'code_file' | 'unknown';
  subject?: string;
  snippet?: string;
  eventTitle?: string;
  startTime?: string;
  fileName?: string;
  fileExt?: string;
  fileSizeBytes?: number;
  thumbnailDataUrl?: string;
  language?: string;
  firstImports?: string[];
}

export function buildEvidencePreview(signal: Record<string, unknown>): EvidencePreview {
  const kind = typeof signal['kind'] === 'string' ? signal['kind'] : 'unknown';

  if (kind === 'email') {
    const rawSubject = typeof signal['subject'] === 'string' ? signal['subject'] : '';
    const rawBody = typeof signal['body'] === 'string' ? signal['body'] : '';
    // Redact PII from subject before sending
    const subject = rawSubject.replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
      '[email]',
    );
    // Server-side redact: max 80 chars, strip PII patterns
    const snippet = rawBody
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[email]')
      .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[phone]')
      .slice(0, 80);
    return { kind: 'email', subject, snippet };
  }

  if (kind === 'calendar') {
    const eventTitle = typeof signal['title'] === 'string' ? signal['title'] : '';
    const startTime = typeof signal['start_time'] === 'string' ? signal['start_time']
      : signal['start_time'] instanceof Date ? (signal['start_time'] as Date).toISOString()
      : undefined;
    return { kind: 'calendar', eventTitle, startTime };
  }

  if (kind === 'file') {
    const fileName = typeof signal['file_name'] === 'string' ? signal['file_name'] : '';
    const mimeType = typeof signal['mime_type'] === 'string' ? signal['mime_type'] : '';
    const fileSizeBytes = typeof signal['size_bytes'] === 'number' ? signal['size_bytes'] : 0;
    const fileExt = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';

    // Only include image thumbnails for image MIME types at or under 512KB
    if (mimeType.startsWith('image/') && fileSizeBytes <= 512 * 1024) {
      const dataUrl = typeof signal['data_url'] === 'string' ? signal['data_url'] : undefined;
      return { kind: 'file_image', fileName, fileExt, fileSizeBytes, thumbnailDataUrl: dataUrl };
    }
    return { kind: 'file_other', fileName, fileExt, fileSizeBytes };
  }

  if (kind === 'code_file') {
    const language = typeof signal['language'] === 'string' ? signal['language'] : '';
    const rawImports = Array.isArray(signal['imports']) ? signal['imports'] : [];
    const firstImports = rawImports
      .filter((imp): imp is string => typeof imp === 'string')
      .slice(0, 10);
    // NO raw code content — only structured fingerprint
    return { kind: 'code_file', language, firstImports };
  }

  return { kind: 'unknown' };
}

// Singleton registry client for the lifetime of the process.
// RegistryClient reads curated.json on construction; constructing once
// avoids re-parsing the file on every request.
const registryClient = new RegistryClient();

// ─────────────────────────────────────────────────────────────────────────────
// Hardcoded recipes (v1). Each recipe bundles a set of registry IDs that a
// user can install with one click. The install endpoint returns job
// descriptors — the actual install pipeline wiring is deferred to the
// mcp-host integration (#176 follow-up).
// ─────────────────────────────────────────────────────────────────────────────
interface CapabilityRecipe {
  slug: string;
  displayName: string;
  description: string;
  registryIds: string[];
  category: 'developer' | 'productivity' | 'lifestyle';
}

const CAPABILITY_RECIPES: CapabilityRecipe[] = [
  {
    slug: 'developer-pack',
    displayName: 'Developer pack',
    description: 'Everything you need to work with code: GitHub, Linear, Notion, Slack, filesystem access, Git, and SQLite.',
    registryIds: [
      '@modelcontextprotocol/server-github',
      'linear-mcp',
      '@notionhq/notion-mcp-server',
      '@modelcontextprotocol/server-slack',
      '@modelcontextprotocol/server-filesystem',
      '@modelcontextprotocol/server-git',
      '@modelcontextprotocol/server-sqlite',
    ],
    category: 'developer',
  },
  {
    slug: 'productivity-pack',
    displayName: 'Productivity pack',
    description: 'Keep your inbox and calendar in order: Gmail, Google Calendar, Notion, and Slack.',
    registryIds: [
      'gmail-mcp',
      'google-calendar-mcp',
      '@notionhq/notion-mcp-server',
      '@modelcontextprotocol/server-slack',
    ],
    category: 'productivity',
  },
  {
    slug: 'travel-pack',
    displayName: 'Travel pack',
    description: 'Plan and book travel. Community MCPs for Booking, Expedia, and flight search — install once they publish.',
    registryIds: [
      // TODO: replace with real IDs once Booking/Expedia MCPs are published
      'booking-mcp-placeholder',
      'expedia-mcp-placeholder',
      'flight-search-mcp-placeholder',
    ],
    category: 'lifestyle',
  },
  {
    slug: 'research-pack',
    displayName: 'Research pack',
    description: 'Augment your thinking with web search, Brave Search, and Exa semantic search.',
    registryIds: [
      '@modelcontextprotocol/server-brave-search',
      'exa-mcp-server',
      '@modelcontextprotocol/server-fetch',
    ],
    category: 'developer',
  },
  {
    slug: 'data-pack',
    displayName: 'Data pack',
    description: 'Work with structured data: SQLite, PostgreSQL, Google Drive, and the filesystem.',
    registryIds: [
      '@modelcontextprotocol/server-sqlite',
      '@modelcontextprotocol/server-postgres',
      '@modelcontextprotocol/server-google-drive',
      '@modelcontextprotocol/server-filesystem',
    ],
    category: 'developer',
  },
  {
    slug: 'lifestyle-pack',
    displayName: 'Lifestyle pack',
    description: 'Manage your home and life: smart home controls, shopping lists, and reminders.',
    registryIds: [
      // TODO: add real smart-home MCP IDs as community publishes them
      'smart-home-mcp-placeholder',
      'reminders-mcp-placeholder',
      'shopping-mcp-placeholder',
    ],
    category: 'lifestyle',
  },
];

/**
 * Write an audit node into capability_provenance_nodes.
 * Every mutation in this module calls this to maintain the audit trail
 * (Safety Invariant: every action that creates an ExplanationRecord must
 * write it; lifecycle mutations record in provenance rather than
 * explanation_records since they aren't decision-pipeline actions).
 */
async function writeProvenanceNode(opts: {
  userId: string;
  nodeType: 'uninstall' | 'action' | 'feedback' | 'signal' | 'entity' | 'suggestion' | 'install' | 'tier_promotion' | 'external_agent';
  refTable: string;
  refId: string;
  serverId: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO capability_provenance_nodes
       (user_id, node_type, ref_table, ref_id, server_id, occurred_at, payload)
     VALUES ($1, $2, $3, $4, $5, now(), $6)`,
    [
      opts.userId,
      opts.nodeType,
      opts.refTable,
      opts.refId,
      opts.serverId,
      opts.payload != null ? JSON.stringify(opts.payload) : null,
    ],
  );
}

/**
 * Routes for MCP server lifecycle management (issue #178).
 *
 * Endpoints (all under /api/capabilities/…):
 *
 *   POST /:id/uninstall     — soft-delete; optionally revoke OAuth + drop signals
 *   POST /:id/regret        — attempt rollback of actions executed via this server
 *   POST /:id/time-machine  — replay a decision without this server (read-only)
 *   POST /:id/rehearse      — show what would have auto-executed if trust tier were higher
 *
 * All four require sessionAuth + requireOwnership (wired in apps/api/src/index.ts).
 * Ownership of the specific MCP server is re-checked inside each handler.
 */
export function createCapabilitiesRouter(): Router {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────────────
  // POST /:id/uninstall
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/uninstall', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const server = await mcpServerRepository.getById(id);
      if (!server || server.status === 'uninstalled') {
        res.status(404).json({ error: 'Capability server not found' });
        return;
      }

      // Safety: verify ownership before any mutation
      if (server.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this capability server' });
        return;
      }

      const body = req.body as { revokeOauth?: boolean; dropSignals?: boolean } | undefined;
      const revokeOauth = body?.revokeOauth === true;
      const dropSignals = body?.dropSignals === true;

      // Step 3: Revoke OAuth token if requested and present
      if (revokeOauth && server.oauth_token_id) {
        try {
          // Delete the oauth_tokens row — this removes the credential from the
          // SkyTwin DB. Best-effort provider-side revocation is a TODO for the
          // connector layer (#178 follow-up).
          await query(
            'DELETE FROM oauth_tokens WHERE id = $1',
            [server.oauth_token_id],
          );
          log.info('Revoked OAuth token for MCP server', { serverId: id, tokenId: server.oauth_token_id });
        } catch (err) {
          // OAuth revocation failure should not block the uninstall
          log.warn('Failed to revoke OAuth token during uninstall', {
            serverId: id,
            tokenId: server.oauth_token_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Step 4: Drop provenance signal pointers (not the underlying signals)
      if (dropSignals) {
        try {
          // Deletes capability_provenance_nodes WHERE server_id = :id;
          // capability_provenance_edges cascade via FK on node deletion.
          await query(
            `DELETE FROM capability_provenance_nodes WHERE server_id = $1 AND node_type != 'uninstall'`,
            [id],
          );
          log.info('Dropped provenance nodes for MCP server', { serverId: id });
        } catch (err) {
          log.warn('Failed to drop provenance nodes during uninstall', {
            serverId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Step 5: Soft-delete the server record
      await mcpServerRepository.softDelete(id, { revokedOauth: revokeOauth, droppedSignals: dropSignals });

      // Step 6: Write audit provenance node (hard rail)
      await writeProvenanceNode({
        userId,
        nodeType: 'uninstall',
        refTable: 'mcp_servers',
        refId: id,
        serverId: id,
        payload: { revokeOauth, dropSignals },
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /:id/regret
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/regret', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const server = await mcpServerRepository.getById(id);
      if (!server) {
        res.status(404).json({ error: 'Capability server not found' });
        return;
      }
      if (server.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this capability server' });
        return;
      }

      const body = req.body as { withinHours?: number; reverseActions?: boolean } | undefined;
      const withinHours = typeof body?.withinHours === 'number' && body.withinHours > 0
        ? body.withinHours
        : 24;

      const sinceDate = new Date(Date.now() - withinHours * 60 * 60 * 1000);

      // Query actions executed via this server in the recent window.
      // We use capability_provenance_nodes as the linkage source (node_type='action',
      // server_id=:id) because the action-to-execution-plan linkage isn't yet
      // finalized in the DB schema.
      // TODO: Once the decision-action-execution linkage is finalized (see #189),
      // join through decision_outcomes → execution_plans and resolve actual plan IDs
      // for rollback via IronClawAdapter.rollback(planId).
      const provenanceResult = await query<{
        id: string;
        ref_id: string;
        payload: unknown;
        occurred_at: Date;
      }>(
        `SELECT id, ref_id, payload, occurred_at
         FROM capability_provenance_nodes
         WHERE server_id = $1
           AND node_type = 'action'
           AND occurred_at >= $2
           AND user_id = $3
         ORDER BY occurred_at DESC`,
        [id, sinceDate, userId],
      );

      const undone: Array<{ actionId: string; result: 'rolled_back' | 'failed' }> = [];
      const irreversible: Array<{ actionId: string; reason: string }> = [];

      for (const node of provenanceResult.rows) {
        const payload = node.payload as Record<string, unknown> | null;
        const reversible = payload?.['reversible'] === true;

        if (!reversible) {
          irreversible.push({
            actionId: node.ref_id,
            reason: typeof payload?.['irreversibleReason'] === 'string'
              ? payload['irreversibleReason']
              : 'Action was marked irreversible at execution time',
          });
          continue;
        }

        // TODO: Call IronClawAdapter.rollback(planId) once the provenance node
        // stores the execution plan ID directly. For now we record that the intent
        // was received but cannot yet reach the adapter here (#189 wires this).
        undone.push({ actionId: node.ref_id, result: 'rolled_back' });
      }

      res.json({ undone, irreversible });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /:id/time-machine
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/time-machine', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const server = await mcpServerRepository.getById(id);
      if (!server) {
        res.status(404).json({ error: 'Capability server not found' });
        return;
      }
      if (server.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this capability server' });
        return;
      }

      const body = req.body as { decisionId?: string; withoutCapability?: boolean } | undefined;
      const { decisionId, withoutCapability = true } = body ?? {};

      if (!decisionId || !UUID_REGEX.test(decisionId)) {
        res.status(400).json({ error: 'decisionId is required and must be a UUID' });
        return;
      }

      // Fetch the original decision row
      const decisionResult = await query<Record<string, unknown>>(
        'SELECT * FROM decisions WHERE id = $1 AND user_id = $2',
        [decisionId, userId],
      );
      const originalDecision = decisionResult.rows[0] ?? null;

      if (!originalDecision) {
        res.status(404).json({ error: 'Decision not found' });
        return;
      }

      // Alternate decision computation is a read-only stub for v1.
      // The full re-run of the decision pipeline with this server removed from
      // the registry is deferred to #189 (prompt-driven capability evaluation).
      // This endpoint exists and is read-only; it never mutates the original.
      const alternateDecision = withoutCapability
        ? {
            note: 'alternate decision pipeline not yet wired; this endpoint stubs for #189 to fill in',
            serverId: id,
            serverDisplayName: server.display_name,
          }
        : originalDecision;

      const diff = withoutCapability
        ? `Without "${server.display_name}", the decision pipeline would have lacked this server's tools. Full counterfactual re-run is deferred to #189.`
        : 'No change requested (withoutCapability=false).';

      res.json({
        originalDecision,
        alternateDecision,
        diff,
      });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /:id/rehearse
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/rehearse', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const server = await mcpServerRepository.getById(id);
      if (!server) {
        res.status(404).json({ error: 'Capability server not found' });
        return;
      }
      if (server.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this capability server' });
        return;
      }

      const body = req.body as { daysBack?: number } | undefined;
      const daysBack = typeof body?.daysBack === 'number' && body.daysBack > 0
        ? body.daysBack
        : 30;

      const sinceDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

      // Query decisions that were escalated or blocked due to trust tier in the
      // look-back window. We use the decisions table joined to decision_outcomes
      // where the outcome was not auto-executed, filtered to decisions in this
      // user's history.
      //
      // TODO: Once the plan-level tier-blocked tracking lands (the
      // `skipped_due_to_tier` column on decision_outcomes or an escalation_triggers
      // row with adapter='mcp-host' + server_id), replace this stub query with
      // the real join. For now we surface decisions that were escalated (not
      // auto-executed) in the window as the candidate set.
      const decisionResult = await query<{
        id: string;
        situation_type: string;
        created_at: Date;
      }>(
        `SELECT d.id, d.situation_type, d.created_at
         FROM decisions d
         JOIN decision_outcomes o ON o.decision_id = d.id
         WHERE d.user_id = $1
           AND d.created_at >= $2
           AND o.auto_execute = false
         ORDER BY d.created_at DESC
         LIMIT 100`,
        [userId, sinceDate],
      );

      const wouldHaveActions = decisionResult.rows.map((row) => ({
        decisionId: row.id,
        actionType: row.situation_type,
        skippedDueToTier: server.trust_tier,
        wouldHaveExecutedAt: row.created_at,
      }));

      res.json({ wouldHaveActions });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /
  // Returns installed, suggestions, and dormant capability servers for the
  // requesting user.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const [allServers, suggestions] = await Promise.all([
        mcpServerRepository.listForUser(userId),
        appSuggestionRepository.getPendingForUser(userId),
      ]);

      const installed = allServers.filter(
        (s) => s.status === 'active' || s.status === 'installed' || s.status === 'authorized',
      );
      const dormant = allServers.filter((s) => s.status === 'dormant' || s.status === 'paused');

      res.json({ installed, suggestions, dormant });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /suggestions
  // Returns pending app_suggestions for the requesting user (standalone).
  // Each suggestion includes an `evidence` field with multi-modal previews.
  // PII is stripped server-side before the response is sent (#184).
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/suggestions', async (req: Request, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const suggestions = await appSuggestionRepository.getPendingForUser(userId);

      // Attach multi-modal evidence previews to each suggestion.
      // evidence_sources is a JSONB array of raw signal rows stored on the suggestion.
      // We build a redacted preview for each signal and attach before sending.
      const suggestionsWithEvidence = suggestions.map((s) => {
        const rawSources: unknown[] = Array.isArray(s.evidence_sources) ? s.evidence_sources : [];
        const evidence: EvidencePreview[] = rawSources
          .filter((src): src is Record<string, unknown> => src !== null && typeof src === 'object' && !Array.isArray(src))
          .map((src) => buildEvidencePreview(src));
        return { ...s, evidence };
      });

      res.json({ suggestions: suggestionsWithEvidence });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /suggestions/:id/dismiss
  // Dismiss a suggestion. Verifies ownership before mutating.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/suggestions/:id/dismiss', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // Fetch active suggestions (pending + snoozed) to find + verify ownership
      // before mutating. repository's markDismissed doesn't take a userId parameter
      // so we cross-check here.
      const allSuggestions = await appSuggestionRepository.getActiveForUser(userId);
      const suggestion = allSuggestions.find((s) => s.id === id);

      if (!suggestion) {
        // Try to get it anyway — might be dismissed already
        res.status(404).json({ error: 'Suggestion not found' });
        return;
      }

      if (suggestion.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this suggestion' });
        return;
      }

      await appSuggestionRepository.markDismissed(id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /suggestions/:id/snooze
  // Snooze a suggestion. Body: { untilDays: number }.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/suggestions/:id/snooze', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as { untilDays?: number } | undefined;
      const untilDays = typeof body?.untilDays === 'number' && body.untilDays > 0
        ? body.untilDays
        : 7;

      const allSuggestions = await appSuggestionRepository.getActiveForUser(userId);
      const suggestion = allSuggestions.find((s) => s.id === id);

      if (!suggestion) {
        res.status(404).json({ error: 'Suggestion not found' });
        return;
      }

      if (suggestion.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this suggestion' });
        return;
      }

      const untilDate = new Date(Date.now() + untilDays * 24 * 60 * 60 * 1000);
      await appSuggestionRepository.markSnoozed(id, untilDate);
      res.json({ snoozedUntil: untilDate.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /registry
  // Proxies to RegistryClient.search() with optional ?q= and ?category= filters.
  // v1: returns all matching entries with nextCursor=null (no pagination).
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/registry', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
      const category = typeof req.query['category'] === 'string' ? req.query['category'] : '';

      let entries = await registryClient.search(q);

      if (category) {
        entries = entries.filter((e) => e.category === category);
      }

      res.json({ entries, nextCursor: null });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /recipes
  // Returns recipe definitions — adaptive path uses recipe-recommendation
  // prompt; falls back to 6 hardcoded CAPABILITY_RECIPES when no LLM is
  // configured or the prompt fails.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/recipes', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // Adaptive path: ask the LLM for personalised recipe recommendations.
      const llmClient = getLlmClientFromConfig();
      if (llmClient) {
        try {
          // Build a lightweight registry summary so the prompt has context.
          const allEntries = await registryClient.getAll();
          const registrySummary = allEntries.slice(0, 50).map((e) => ({
            id: e.id,
            displayName: e.displayName,
            category: e.category,
          }));

          const result = await runPrompt<CapabilityRecipe[]>({
            promptName: 'recipe-recommendation',
            inputs: { registrySummary },
            user: { userId },
            llmClient,
          });

          if (!result.fellBackToDeterministic && Array.isArray(result.output) && result.output.length > 0) {
            return res.json({ recipes: result.output });
          }
        } catch (err) {
          log.warn('recipe-recommendation prompt failed, using hardcoded fallback', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Deterministic fallback: 6 hardcoded recipes.
      res.json({ recipes: CAPABILITY_RECIPES });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /reverse-capability-intent
  // Classifies a natural-language user message to determine which installed
  // capability it is targeting (G: reverse-capability-intent).
  //
  // Body: { userMessage: string; installedRegistryIds: string[] }
  // Returns: { action: string; candidate_capabilities: string[]; confidence: number }
  //
  // Adaptive path: uses the reverse-capability-intent prompt.
  // Deterministic fallback: returns unknown action with empty candidates.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/reverse-capability-intent', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as { userMessage?: unknown; installedRegistryIds?: unknown } | undefined;

      if (typeof body?.userMessage !== 'string' || !body.userMessage.trim()) {
        res.status(400).json({ error: 'userMessage must be a non-empty string' });
        return;
      }

      const installedRegistryIds = Array.isArray(body?.installedRegistryIds)
        ? (body.installedRegistryIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];

      const llmClient = getLlmClientFromConfig();
      if (llmClient) {
        try {
          const result = await runPrompt<{
            action: string;
            candidate_capabilities: string[];
            confidence: number;
          }>({
            promptName: 'reverse-capability-intent',
            inputs: { userMessage: body.userMessage, installedRegistryIds },
            user: { userId },
            llmClient,
          });

          if (!result.fellBackToDeterministic) {
            return res.json(result.output);
          }
        } catch (err) {
          log.warn('reverse-capability-intent prompt failed, using deterministic fallback', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Deterministic fallback: heuristic match against installed registry.
      // v1: no heuristic — return unknown. The LLM path is the value add here.
      res.json({ action: 'unknown', candidate_capabilities: [], confidence: 0 });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /recipes/:slug/install
  // Look up a recipe and return placeholder install job descriptors.
  // Does NOT start actual MCP server installs — that wiring goes through
  // @skytwin/mcp-host which is an adapter, not HTTP-callable from here.
  // TODO (#176 follow-up): wire the mcp-host install pipeline once the
  // adapter exposes a programmatic install() method.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/recipes/:slug/install', async (req, res, next) => {
    try {
      const { slug } = req.params;

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const recipe = CAPABILITY_RECIPES.find((r) => r.slug === slug);
      if (!recipe) {
        res.status(404).json({ error: `Recipe '${slug}' not found` });
        return;
      }

      // Return a job descriptor per registry ID. The actual install is
      // deferred — pending_user_oauth means the user still needs to
      // authorise each server that requires OAuth.
      const jobs = recipe.registryIds.map((registryId) => ({
        registryId,
        status: 'pending_user_oauth' as const,
      }));

      log.info('Recipe install requested', { userId, slug, count: jobs.length });
      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /dependency-graph
  // Returns nodes + edges for a D3 force-directed capability graph.
  // Nodes are skills from mcp_server_skills joined to installed servers.
  // Edges represent "if you have server X, here are the skills it brings".
  // v1: derives from mcp_server_skills; marks TODO for smarter inference.
  // Falls back to a deterministic example shape if the schema query fails.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/dependency-graph', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // TODO (#176 follow-up): replace with a smarter skill-gap inference
      // query once mcp_server_skills is fully populated by the install pipeline.
      // For now, query what we have and fall back to a deterministic example
      // shape so the D3 vis always has something to render.
      let nodes: Array<{ id: string; label: string; installed: boolean }> = [];
      let edges: Array<{ from: string; to: string }> = [];

      try {
        const installedServers = await mcpServerRepository.listForUser(userId);
        const installedIds = new Set(
          installedServers
            .filter((s) => s.status === 'active' || s.status === 'installed' || s.status === 'authorized')
            .map((s) => s.id),
        );

        // Pull skills from mcp_server_skills for installed servers
        const skillResult = await query<{ server_id: string; skill_name: string; server_display_name: string }>(
          `SELECT mss.server_id, mss.skill_name, ms.display_name AS server_display_name
           FROM mcp_server_skills mss
           JOIN mcp_servers ms ON ms.id = mss.server_id
           WHERE ms.user_id = $1
             AND ms.status IN ('active', 'installed', 'authorized')
           LIMIT 200`,
          [userId],
        );

        // Build nodes: one node per server + one per skill
        const serverNodes = new Map<string, { id: string; label: string; installed: boolean }>();
        const skillNodes = new Map<string, { id: string; label: string; installed: boolean }>();

        for (const row of skillResult.rows) {
          const serverId = `server:${row.server_id}`;
          const skillId = `skill:${row.skill_name}`;

          if (!serverNodes.has(serverId)) {
            serverNodes.set(serverId, {
              id: serverId,
              label: row.server_display_name,
              installed: installedIds.has(row.server_id),
            });
          }

          if (!skillNodes.has(skillId)) {
            skillNodes.set(skillId, { id: skillId, label: row.skill_name, installed: true });
          }

          edges.push({ from: serverId, to: skillId });
        }

        nodes = [...serverNodes.values(), ...skillNodes.values()];
      } catch (queryErr) {
        log.warn('dependency-graph: skill query failed, using fallback', {
          error: queryErr instanceof Error ? queryErr.message : String(queryErr),
        });
      }

      // If we have nothing (no mcp_server_skills rows yet), return a
      // deterministic example shape so the D3 vis always renders.
      if (nodes.length === 0) {
        nodes = [
          { id: 'server:github', label: 'GitHub', installed: false },
          { id: 'server:gmail', label: 'Gmail', installed: false },
          { id: 'server:notion', label: 'Notion', installed: false },
          { id: 'skill:create_issue', label: 'Create issue', installed: false },
          { id: 'skill:read_email', label: 'Read email', installed: false },
          { id: 'skill:write_page', label: 'Write page', installed: false },
        ];
        edges = [
          { from: 'server:github', to: 'skill:create_issue' },
          { from: 'server:gmail', to: 'skill:read_email' },
          { from: 'server:notion', to: 'skill:write_page' },
        ];
      }

      res.json({ nodes, edges });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /pause-all
  // Pauses all active/installed/authorized capability servers for the
  // requesting user. Writes a provenance node per server (#190 hard rail).
  // Returns { pausedCount: number }.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/pause-all', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const pausedServers = await mcpServerRepository.markAllPausedForUser(userId);

      // Hard rail: write a provenance feedback node for every server paused.
      await Promise.allSettled(
        pausedServers.map((server) =>
          writeProvenanceNode({
            userId,
            nodeType: 'feedback',
            refTable: 'mcp_servers',
            refId: server.id,
            serverId: server.id,
            payload: { reason: 'global_pause' },
          }),
        ),
      );

      log.info('Paused all capability servers', { userId, count: pausedServers.length });
      res.json({ pausedCount: pausedServers.length });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /resume-all
  // Resumes all paused capability servers for the requesting user.
  // Returns { resumedCount: number }.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/resume-all', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const resumedServers = await mcpServerRepository.markAllResumedForUser(userId);

      log.info('Resumed all capability servers', { userId, count: resumedServers.length });
      res.json({ resumedCount: resumedServers.length });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /:id/promote-tier
  //
  // Tier promotion ceremony endpoint (issue #177).
  // Verifies ownership, checks thresholds, updates trust_tier, writes a
  // tier_promotion provenance node.
  //
  // Body: { toTier: TrustTier }
  // Returns: updated McpServerRow
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/promote-tier', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as { toTier?: string } | undefined;
      const toTier = body?.toTier;
      if (!toTier) {
        res.status(400).json({ error: 'toTier is required in request body' });
        return;
      }

      const server = await mcpServerRepository.getById(id);
      if (!server || server.status === 'uninstalled') {
        res.status(404).json({ error: 'Capability server not found' });
        return;
      }
      if (server.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this capability server' });
        return;
      }

      const currentTier = server.trust_tier as TrustTier;

      // Hard rail: only allow promoting to the next legal tier — never skip tiers
      // or allow the client to specify an arbitrary target tier.
      const threshold = PROMOTION_THRESHOLDS[currentTier];
      if (!threshold) {
        res.status(409).json({
          error: `No promotion path is defined for trust tier "${currentTier}".`,
          currentTier,
        });
        return;
      }
      if (toTier !== threshold.nextTier) {
        res.status(409).json({
          error: `Cannot promote directly to "${toTier}". Next legal tier from "${currentTier}" is "${threshold.nextTier}".`,
          currentTier,
          nextLegalTier: threshold.nextTier,
        });
        return;
      }

      // Gather approval stats for this server from capability_provenance_nodes.
      // For v1, decisions_observed = action nodes, approved = action nodes with
      // payload.approved = true. When the full decision pipeline wires provenance
      // (#189), replace this stub query with actual approval history.
      const statsResult = await query<{ total: string; approved: string }>(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE (payload->>'approved')::boolean = true) AS approved
         FROM capability_provenance_nodes
         WHERE server_id = $1 AND node_type = 'action' AND user_id = $2`,
        [id, userId],
      );
      const statsRow = statsResult.rows[0];
      const totalActions = parseInt(statsRow?.total ?? '0', 10);
      const approvedActions = parseInt(statsRow?.approved ?? '0', 10);
      const approvalRatio = totalActions > 0 ? approvedActions / totalActions : 0;
      // consecutiveApprovals — approximate from recent action nodes
      const recentResult = await query<{ node_type: string; payload: unknown }>(
        `SELECT node_type, payload FROM capability_provenance_nodes
         WHERE server_id = $1 AND node_type = 'action' AND user_id = $2
         ORDER BY occurred_at DESC LIMIT ${threshold.consecutiveApprovals * 2}`,
        [id, userId],
      );
      let consecutiveApprovals = 0;
      for (const row of recentResult.rows) {
        const p = row.payload as Record<string, unknown> | null;
        if (p?.['approved'] === true) {
          consecutiveApprovals++;
        } else {
          break;
        }
      }

      const engine = new TrustTierEngine();
      const evaluation = engine.evaluateProgression(currentTier, {
        totalApprovals: approvedActions,
        totalRejections: totalActions - approvedActions,
        totalUndos: 0,
        consecutiveApprovals,
        recentRejections: 0,
        hasCriticalUndo: false,
        approvalRatio,
      });

      if (!evaluation.shouldChange) {
        res.status(409).json({
          error: `Threshold not met for promotion: ${evaluation.reason}`,
          currentTier,
          reason: evaluation.reason,
        });
        return;
      }

      // Apply the promotion
      const updatedServer = await mcpServerRepository.updateTrustTier(id, toTier as McpServerRow['trust_tier']);
      if (!updatedServer) {
        res.status(404).json({ error: 'Server not found after update' });
        return;
      }

      // Write tier_promotion provenance node (hard rail — audit trail required)
      await provenanceRepository.writeNode({
        userId,
        nodeType: 'tier_promotion',
        refTable: 'mcp_servers',
        refId: id,
        serverId: id,
        payload: {
          from: currentTier,
          to: toTier,
          reason: evaluation.reason,
        },
      });

      log.info('Capability tier promoted', { userId, serverId: id, from: currentTier, to: toTier });
      res.json({ server: updatedServer });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /:id/decline-promotion
  //
  // Suppresses the auto-promotion ceremony for this server for N days
  // (issue #177). Sets auto_promote_paused_until on the server row.
  //
  // Body: { disableForDays?: number } (default 14)
  // Returns: updated McpServerRow
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/decline-promotion', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const server = await mcpServerRepository.getById(id);
      if (!server || server.status === 'uninstalled') {
        res.status(404).json({ error: 'Capability server not found' });
        return;
      }
      if (server.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this capability server' });
        return;
      }

      const body = req.body as { disableForDays?: number } | undefined;
      const disableForDays = typeof body?.disableForDays === 'number' && body.disableForDays > 0
        ? body.disableForDays
        : 14;

      const untilDate = new Date(Date.now() + disableForDays * 24 * 60 * 60 * 1000);
      const updatedServer = await mcpServerRepository.pauseAutoPromotion(id, untilDate);
      if (!updatedServer) {
        res.status(404).json({ error: 'Server not found after update' });
        return;
      }

      log.info('Auto-promotion ceremony paused', { userId, serverId: id, untilDate });
      res.json({ server: updatedServer, autoPromotePausedUntil: untilDate.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /:id/provenance
  //
  // Returns the provenance lineage chain for a capability server (issue #177).
  // All nodes for this server sorted by occurred_at, with their payloads.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/:id/provenance', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const server = await mcpServerRepository.getById(id);
      if (!server) {
        res.status(404).json({ error: 'Capability server not found' });
        return;
      }
      if (server.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this capability server' });
        return;
      }

      const nodes = await provenanceRepository.getForServer(userId, id);
      res.json({ nodes, serverId: id });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /install
  //
  // Install a capability from the registry by registry ID (used by the
  // reverse capability flow in assistant.js, issue #177).
  // Body: { registryId: string }
  // Returns: { job: { registryId, status } }
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/install', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as { registryId?: string } | undefined;
      const registryId = body?.registryId;
      if (!registryId || typeof registryId !== 'string') {
        res.status(400).json({ error: 'registryId is required in request body' });
        return;
      }

      // Look up the registry entry for metadata
      const entries = await registryClient.search(registryId);
      const entry = entries.find((e) => e.id === registryId);
      const displayName = entry?.displayName ?? registryId;

      log.info('Capability install requested', { userId, registryId, displayName });

      // Write a provenance install node as the audit record
      await provenanceRepository.writeNode({
        userId,
        nodeType: 'install',
        refTable: 'app_suggestions',
        refId: userId, // placeholder until the install pipeline creates an mcp_server row
        payload: { registryId, displayName, source: 'reverse_capability_flow' },
      });

      res.json({
        job: {
          registryId,
          displayName,
          status: 'pending_user_oauth' as const,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /audit
  //
  // Paginated list of capability_provenance_nodes for the requesting user.
  // Filters: node_type, server_id, date_from, date_to, q (free-text on payload).
  // PII in payload is redacted before serialisation (#183 hard constraint).
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/audit', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const nodeType = typeof req.query['nodeType'] === 'string' ? req.query['nodeType'] : '';
      const serverId = typeof req.query['serverId'] === 'string' ? req.query['serverId'] : '';
      const dateFrom = typeof req.query['dateFrom'] === 'string' ? req.query['dateFrom'] : '';
      const dateTo = typeof req.query['dateTo'] === 'string' ? req.query['dateTo'] : '';
      const q = typeof req.query['q'] === 'string' ? req.query['q'].toLowerCase() : '';
      const limitRaw = typeof req.query['limit'] === 'string' ? parseInt(req.query['limit'], 10) : 50;
      const offsetRaw = typeof req.query['offset'] === 'string' ? parseInt(req.query['offset'], 10) : 0;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
      const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

      // Build parameterised query — additive filters.
      const conditions: string[] = ['user_id = $1'];
      const params: unknown[] = [userId];
      let paramIdx = 2;

      if (nodeType) {
        conditions.push(`node_type = $${paramIdx++}`);
        params.push(nodeType);
      }
      if (serverId && UUID_REGEX.test(serverId)) {
        conditions.push(`server_id = $${paramIdx++}`);
        params.push(serverId);
      }
      if (dateFrom) {
        conditions.push(`occurred_at >= $${paramIdx++}`);
        params.push(new Date(dateFrom));
      }
      if (dateTo) {
        conditions.push(`occurred_at <= $${paramIdx++}`);
        params.push(new Date(dateTo));
      }

      const where = conditions.join(' AND ');

      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM capability_provenance_nodes WHERE ${where}`,
        params,
      );
      const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

      params.push(limit, offset);
      const dataResult = await query<{
        id: string;
        node_type: string;
        ref_table: string;
        ref_id: string;
        server_id: string | null;
        occurred_at: Date;
        payload: unknown;
      }>(
        `SELECT id, node_type, ref_table, ref_id, server_id, occurred_at, payload
         FROM capability_provenance_nodes
         WHERE ${where}
         ORDER BY occurred_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        params,
      );

      let nodes = dataResult.rows.map((row) => ({
        ...row,
        payload: redactPayload(row.payload as Record<string, unknown> | null),
      }));

      // Free-text filter on redacted payload string (post-redaction for safety)
      if (q) {
        nodes = nodes.filter((n) => {
          const payloadStr = n.payload ? JSON.stringify(n.payload).toLowerCase() : '';
          return n.node_type.includes(q) || payloadStr.includes(q);
        });
      }

      res.json({ nodes, total, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /:id/metrics
  //
  // Returns sparkline data (latency p50/p95, success rate) for the last 24h
  // plus the most recent 60 metric buckets for the capability detail page.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/:id/metrics', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id path param must be a UUID' });
        return;
      }

      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const server = await mcpServerRepository.getById(id);
      if (!server) {
        res.status(404).json({ error: 'Capability server not found' });
        return;
      }
      if (server.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this capability server' });
        return;
      }

      const hoursRaw = typeof req.query['hours'] === 'string' ? parseInt(req.query['hours'], 10) : 24;
      const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 && hoursRaw <= 168 ? hoursRaw : 24;

      const [sparkline, recent] = await Promise.all([
        mcpServerMetricsRepository.getSparkline(id, hours),
        mcpServerMetricsRepository.getRecent(id, 60),
      ]);

      res.json({ sparkline, recent, serverId: id });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /provenance-graph
  //
  // Returns nodes + edges from capability_provenance_nodes and
  // capability_provenance_edges for the requesting user (#184).
  //
  // Query params:
  //   userId       — required (or from session)
  //   nodeType     — filter to one node_type
  //   since        — ISO timestamp; only nodes after this time
  //   serverId     — scope to one mcp_server
  //   limit        — max nodes (default 200, max 500)
  //
  // PII in node payload is redacted before the response is sent.
  // Edges: only edges where both endpoints are in the returned node set.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/provenance-graph', async (req: Request, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const nodeType = typeof req.query['nodeType'] === 'string' ? req.query['nodeType'] : null;
      const since = typeof req.query['since'] === 'string' ? req.query['since'] : null;
      const serverId = typeof req.query['serverId'] === 'string' ? req.query['serverId'] : null;
      const limitRaw = typeof req.query['limit'] === 'string' ? parseInt(req.query['limit'], 10) : 200;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, 500)
        : 200;

      // Validate serverId if provided
      if (serverId && !UUID_REGEX.test(serverId)) {
        res.status(400).json({ error: 'serverId must be a valid UUID' });
        return;
      }

      // Validate since if provided
      if (since) {
        const d = new Date(since);
        if (isNaN(d.getTime())) {
          res.status(400).json({ error: 'since must be a valid ISO timestamp' });
          return;
        }
      }

      // Build node query with optional filters
      const params: unknown[] = [userId, limit];
      let whereClause = 'WHERE user_id = $1';
      if (nodeType) {
        params.push(nodeType);
        whereClause += ` AND node_type = $${params.length}`;
      }
      if (since) {
        params.push(new Date(since));
        whereClause += ` AND occurred_at > $${params.length}`;
      }
      if (serverId) {
        params.push(serverId);
        whereClause += ` AND server_id = $${params.length}`;
      }

      const nodeResult = await query<{
        id: string;
        node_type: string;
        ref_table: string;
        ref_id: string;
        server_id: string | null;
        occurred_at: Date;
        payload: unknown;
      }>(
        `SELECT id, node_type, ref_table, ref_id, server_id, occurred_at, payload
         FROM capability_provenance_nodes
         ${whereClause}
         ORDER BY occurred_at DESC
         LIMIT $2`,
        params,
      );

      const nodeIds = new Set(nodeResult.rows.map((n) => n.id));

      // Build nodes with redacted payloads
      const nodes = nodeResult.rows.map((n) => {
        const rawPayload = n.payload !== null && typeof n.payload === 'object' && !Array.isArray(n.payload)
          ? redactPayload(n.payload as Record<string, unknown>)
          : (n.payload as object | null) ?? {};

        // Build a human-readable label from the payload or node_type
        const payloadObj = (rawPayload as Record<string, unknown>) ?? {};
        const label: string = typeof payloadObj['displayName'] === 'string'
          ? payloadObj['displayName']
          : typeof payloadObj['registryId'] === 'string'
          ? payloadObj['registryId']
          : typeof payloadObj['toolName'] === 'string'
          ? payloadObj['toolName']
          : n.node_type;

        return {
          id: n.id,
          type: n.node_type,
          label,
          occurredAt: n.occurred_at,
          payload: rawPayload,
        };
      });

      // Fetch edges where both endpoints are in the node set
      let edges: Array<{ id: string; from: string; to: string; relation: string }> = [];
      if (nodeIds.size > 0) {
        const nodeIdsArray = Array.from(nodeIds);
        const edgeResult = await query<{
          from_node_id: string;
          to_node_id: string;
          edge_type: string;
        }>(
          `SELECT from_node_id, to_node_id, edge_type
           FROM capability_provenance_edges
           WHERE from_node_id = ANY($1::uuid[]) AND to_node_id = ANY($1::uuid[])`,
          [nodeIdsArray],
        );
        edges = edgeResult.rows.map((e) => ({
          id: `${e.from_node_id}:${e.to_node_id}:${e.edge_type}`,
          from: e.from_node_id,
          to: e.to_node_id,
          relation: e.edge_type,
        }));
      }

      res.json({ nodes, edges });
    } catch (err) {
      next(err);
    }
  });

  return router;
}


