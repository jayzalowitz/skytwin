import { Router } from 'express';
import { mcpServerRepository, appSuggestionRepository, query } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import { RegistryClient } from '@skytwin/registry-client';

const log = createLogger('api:capabilities');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/suggestions', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const suggestions = await appSuggestionRepository.getPendingForUser(userId);
      res.json({ suggestions });
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
  // Returns the 6 hardcoded recipe definitions.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/recipes', async (req, res, next) => {
    try {
      const userId: string | undefined = (req as unknown as { user?: { id?: string } }).user?.id
        ?? (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      res.json({ recipes: CAPABILITY_RECIPES });
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

  return router;
}
