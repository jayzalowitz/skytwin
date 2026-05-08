/**
 * dxt.ts — REST endpoints for DXT artifact export, list, download, import.
 *
 * Routes (all under sessionAuth + requireOwnership):
 *   POST   /api/dxt/export/:serverId  — serialize an mcp_servers row, persist, return blob
 *   GET    /api/dxt/exports           — list this user's exports (metadata only)
 *   GET    /api/dxt/exports/:id/blob  — download the raw blob
 *   POST   /api/dxt/import            — preview an artifact (no install)
 */

import { Router } from 'express';
import type { Request } from 'express';
import { mcpServerRepository, dxtExportRepository } from '@skytwin/db';
import type { McpServerRow, DxtExportRow } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import { serialize, deserialize, redactCommand } from '@skytwin/dxt';
import type { DxtArtifactInput, DxtJsonPayload } from '@skytwin/dxt';

const log = createLogger('api:dxt');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getUserId(req: Request): string | undefined {
  const asAny = req as unknown as { user?: { id?: string } };
  const fromUser = asAny.user?.id;
  const fromQuery = typeof req.query['userId'] === 'string' ? req.query['userId'] : undefined;
  return fromUser ?? fromQuery;
}

/**
 * Build the DXT artifact input from an mcp_servers row.
 * Pulls the redacted args + transport details + per-app spend caps.
 */
function buildArtifactInput(server: McpServerRow, sourceInstanceId: string, skills: string[]): DxtArtifactInput {
  const rawArgs = Array.isArray(server.args) ? (server.args as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  const result: DxtArtifactInput = {
    sourceInstanceId,
    registryId: server.registry_id ?? server.display_name,
    transport: server.transport,
    skills,
  };
  if (server.command !== null) result.command = server.command;
  if (rawArgs.length > 0) result.args = redactCommand(rawArgs);
  if (server.url !== null) result.url = server.url;
  if (
    server.per_app_spend_per_action_cents !== null
    || server.per_app_daily_spend_cents !== null
    || server.per_app_monthly_spend_cents !== null
  ) {
    const caps: { perActionCents?: number; dailyCents?: number; monthlyCents?: number } = {};
    if (server.per_app_spend_per_action_cents !== null) caps.perActionCents = server.per_app_spend_per_action_cents;
    if (server.per_app_daily_spend_cents !== null) caps.dailyCents = server.per_app_daily_spend_cents;
    if (server.per_app_monthly_spend_cents !== null) caps.monthlyCents = server.per_app_monthly_spend_cents;
    result.perAppSpendCaps = caps;
  }
  return result;
}

export function createDxtRouter(): Router {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────────────
  // POST /export/:serverId
  // Serialize a capability config as a DXT artifact.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/export/:serverId', async (req, res, next) => {
    try {
      const { serverId } = req.params;
      if (!serverId || !UUID_REGEX.test(serverId)) {
        res.status(400).json({ error: 'serverId must be a UUID' });
        return;
      }

      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const server = await mcpServerRepository.getById(serverId);
      if (!server) {
        res.status(404).json({ error: 'Capability server not found' });
        return;
      }
      if (server.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this capability server' });
        return;
      }

      const input = buildArtifactInput(server, userId, []);
      const { blob, sha256 } = await serialize(input);

      const row = await dxtExportRepository.create({
        userId,
        serverId,
        blob,
        sha256,
      });

      log.info('DXT artifact exported', { userId, serverId, exportId: row.id, blobBytes: blob.length });

      res.status(201).json({
        id: row.id,
        sha256: sha256.toString('hex'),
        exportedAt: row.exported_at,
        blob: blob.toString('base64'),
        blobBytes: blob.length,
      });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /exports
  // List metadata for this user's exports (no blob bytes).
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/exports', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const rows = await dxtExportRepository.listForUser(userId);
      const exports = rows.map((r: DxtExportRow) => ({
        id: r.id,
        serverId: r.server_id,
        exportedAt: r.exported_at,
        sha256: r.artifact_sha256.toString('hex'),
        blobBytes: r.artifact_blob.length,
      }));

      res.json({ exports });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /exports/:id/blob
  // Download the raw artifact bytes as application/octet-stream.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/exports/:id/blob', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!id || !UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'id must be a UUID' });
        return;
      }

      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const row = await dxtExportRepository.findById(id);
      if (!row) {
        res.status(404).json({ error: 'Export not found' });
        return;
      }
      if (row.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this export' });
        return;
      }

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="capability-${id}.dxt"`);
      res.send(row.artifact_blob);
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /import
  // Body: { blob: base64String }
  // Returns a parsed preview — does NOT install. The user must explicitly
  // confirm via a separate flow (deferred to environmental UI work).
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/import', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as { blob?: unknown };
      if (typeof body.blob !== 'string' || body.blob.length === 0) {
        res.status(400).json({ error: 'blob (base64 string) is required in body' });
        return;
      }

      let blob: Buffer;
      try {
        blob = Buffer.from(body.blob, 'base64');
      } catch {
        res.status(400).json({ error: 'blob must be valid base64' });
        return;
      }

      const result = deserialize(blob);
      if (!result.success) {
        res.status(400).json({ error: result.error, code: result.code });
        return;
      }

      const payload: DxtJsonPayload = result.data.payload;

      // Detect if this capability is already installed for this user
      let alreadyInstalled = false;
      try {
        const existing = await mcpServerRepository.getByUserAndRegistry(userId, payload.capability.registryId);
        alreadyInstalled = existing !== null;
      } catch {
        // Best-effort lookup — swallow errors so import preview still works
      }

      log.info('DXT import preview', {
        userId,
        registryId: payload.capability.registryId,
        sourceInstanceId: payload.sourceInstanceId,
        alreadyInstalled,
      });

      res.json({
        preview: payload,
        alreadyInstalled,
        sha256: result.data.computedSha256.toString('hex'),
        note: 'This is a preview only. Confirmation + install flow lands in #180 environmental work.',
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
