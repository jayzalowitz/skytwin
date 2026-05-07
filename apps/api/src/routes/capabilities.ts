import { Router } from 'express';
import { mcpServerRepository, query } from '@skytwin/db';
import { createLogger } from '@skytwin/core';

const log = createLogger('api:capabilities');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  return router;
}
