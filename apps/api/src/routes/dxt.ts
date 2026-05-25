/**
 * dxt.ts — REST endpoints for DXT artifact export, list, download, import,
 * confirm, reject, and import listing.
 *
 * Routes (all under sessionAuth + requireOwnership):
 *   POST   /api/dxt/export/:serverId      — serialize an mcp_servers row, persist, return blob
 *   GET    /api/dxt/exports               — list this user's exports (metadata only)
 *   GET    /api/dxt/exports/:id/blob      — download the raw blob
 *   POST   /api/dxt/import               — preview an artifact + persist pending import row
 *   POST   /api/dxt/imports/:id/confirm  — confirm a pending import; installs the capability
 *   POST   /api/dxt/imports/:id/reject   — reject a pending import (audit trail)
 *   GET    /api/dxt/imports              — list all imports for the user (metadata only)
 */

import { Router } from 'express';
import type { Request } from 'express';
import { mcpServerRepository, dxtExportRepository, dxtImportRepository, provenanceRepository, query } from '@skytwin/db';
import type { McpServerRow, DxtExportMetadataRow } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import { serialize, deserialize, redactCommand } from '@skytwin/dxt';
import type { DxtArtifactInput, DxtJsonPayload } from '@skytwin/dxt';

const log = createLogger('api:dxt');

import { UUID_REGEX } from '../middleware/validate-uuid.js';

/**
 * Production middleware (`session-auth`) sets `req.authenticatedUserId`. In the
 * dev bypass path or when explicitly testing as another user, fall back to
 * `?userId=` then to a legacy `req.user.id`. Other route modules vary in
 * their precedence (some still read `req.user?.id` first); a shared helper
 * is a #226 follow-up worth opening if this ordering proves load-bearing.
 */
function getUserId(req: Request): string | undefined {
  const fromAuth = req.authenticatedUserId;
  const fromQuery = typeof req.query['userId'] === 'string' ? req.query['userId'] : undefined;
  const fromLegacy = (req as unknown as { user?: { id?: string } }).user?.id;
  return fromAuth ?? fromQuery ?? fromLegacy;
}

/**
 * Build the DXT artifact input from an mcp_servers row.
 *
 * `sourceInstanceId` is the originating MCP server row id (NOT the user id —
 * passing the user there confused install-attribution on import).
 *
 * `skills` is the cached `list_tools()` set fetched from `mcp_server_skills`;
 * the previous version always passed an empty array, so receivers couldn't
 * see which tools the source had registered.
 */
function buildArtifactInput(server: McpServerRow, sourceInstanceId: string, skills: string[]): DxtArtifactInput {
  const rawArgs = Array.isArray(server.args) ? (server.args as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  const result: DxtArtifactInput = {
    sourceInstanceId,
    // registry_id is required so the artifact identifies its capability by a
    // stable id. display_name is unstable (rename-able) and isn't a valid
    // import key — getByUserAndRegistry() only matches on registry_id.
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

      // Reject export of capabilities without a stable registry_id — the
      // import path can only round-trip rows it can re-resolve via
      // getByUserAndRegistry, which keys on registry_id.
      if (!server.registry_id) {
        res.status(400).json({
          error: 'Cannot export: this capability has no registry_id and cannot be re-imported safely',
        });
        return;
      }

      const skills = await mcpServerRepository.listSkillNamesForServer(serverId);
      const input = buildArtifactInput(server, serverId, skills);
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

      // Metadata-only — never load full blobs into memory just to render the list.
      const rows = await dxtExportRepository.listMetadataForUser(userId);
      const exports = rows.map((r: DxtExportMetadataRow) => ({
        id: r.id,
        serverId: r.server_id,
        exportedAt: r.exported_at,
        sha256: r.artifact_sha256.toString('hex'),
        blobBytes: r.blob_bytes,
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
  // Parses the artifact, returns a preview, and persists a dxt_imports row
  // with status='pending'. Returns importId so the client can reference it
  // on confirm.
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

      // Buffer.from(str, 'base64') silently drops invalid chars rather than
      // throwing — the previous try/catch was unreachable. Validate the
      // shape explicitly with a strict regex (RFC 4648 base64 alphabet,
      // optional padding) before decoding.
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.blob) || body.blob.length % 4 !== 0) {
        res.status(400).json({ error: 'blob must be valid base64' });
        return;
      }
      const blob = Buffer.from(body.blob, 'base64');
      if (blob.length === 0) {
        res.status(400).json({ error: 'blob decoded to zero bytes' });
        return;
      }

      const result = deserialize(blob);
      if (!result.success) {
        res.status(400).json({ error: result.error, code: result.code });
        return;
      }

      const payload: DxtJsonPayload = result.data.payload;
      const sha256 = result.data.computedSha256;

      // Detect if this capability is already installed for this user
      let alreadyInstalled = false;
      try {
        const existing = await mcpServerRepository.getByUserAndRegistry(userId, payload.capability.registryId);
        alreadyInstalled = existing !== null;
      } catch {
        // Best-effort lookup — swallow errors so import preview still works
      }

      // Parse sourceInstanceId — must be a UUID if present, else null
      const rawSourceId = payload.sourceInstanceId;
      const sourceInstanceId =
        typeof rawSourceId === 'string' && UUID_REGEX.test(rawSourceId)
          ? rawSourceId
          : null;

      // Persist the import row so the user can confirm or reject later
      const importRow = await dxtImportRepository.create({
        userId,
        blob,
        sha256,
        registryId: payload.capability.registryId,
        sourceInstanceId,
      });

      log.info('DXT import preview persisted', {
        userId,
        importId: importRow.id,
        registryId: payload.capability.registryId,
        sourceInstanceId,
        alreadyInstalled,
      });

      res.json({
        importId: importRow.id,
        preview: payload,
        alreadyInstalled,
        sha256: sha256.toString('hex'),
      });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /imports/:id/confirm
  // Installs a previewed DXT artifact. The import row must be status='pending'.
  //
  // Steps:
  //  1. Look up the import row, verify ownership, check status='pending'
  //  2. Re-deserialize the stored blob (SHA-256 re-verify — defense in depth)
  //  3. Build an McpServerConfig from the payload
  //  4. Insert into mcp_servers
  //  5. Update import row to status='installed'
  //  6. Write a capability_provenance_nodes row (node_type='manual_install')
  //
  // Returns { status, serverId, registryId } on success.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/imports/:id/confirm', async (req, res, next) => {
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

      const importRow = await dxtImportRepository.findById(id);
      if (!importRow) {
        res.status(404).json({ error: 'Import not found' });
        return;
      }
      if (importRow.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this import' });
        return;
      }
      if (importRow.status !== 'pending') {
        res.status(400).json({
          error: `Import is not pending (status: ${importRow.status}). Only pending imports can be confirmed.`,
        });
        return;
      }

      // Re-deserialize from stored blob — verifies SHA-256 again
      const reResult = deserialize(importRow.artifact_blob);
      if (!reResult.success) {
        // Stored blob is corrupt — mark failed, return error
        await dxtImportRepository.markFailed(id, `Stored blob failed re-deserialization: ${reResult.code}`);
        log.info('DXT confirm failed: stored blob tampered or corrupt', { userId, importId: id });
        res.status(400).json({
          error: 'Stored artifact failed integrity check. Import has been marked failed.',
          code: reResult.code,
        });
        return;
      }

      // Verify SHA-256 matches what we stored
      const storedSha256Hex = importRow.artifact_sha256.toString('hex');
      const recomputedSha256Hex = reResult.data.computedSha256.toString('hex');
      if (storedSha256Hex !== recomputedSha256Hex) {
        await dxtImportRepository.markFailed(id, 'SHA-256 mismatch on re-deserialization');
        log.info('DXT confirm failed: SHA-256 mismatch', { userId, importId: id });
        res.status(400).json({
          error: 'Artifact integrity check failed: SHA-256 mismatch. Import has been marked failed.',
        });
        return;
      }

      const payload: DxtJsonPayload = reResult.data.payload;
      const cap = payload.capability;

      // Build mcp_servers insert. Transport determines which fields are set.
      // args and env are JSONB — pass as JSON strings.
      const argsJson = JSON.stringify(cap.args ?? []);
      const envJson = JSON.stringify({});

      let insertedServer: { id: string } | null = null;
      try {
        const insertResult = await query<{ id: string }>(
          `INSERT INTO mcp_servers
             (user_id, registry_id, display_name, transport, command, args, env, url,
              trust_tier, status, installed_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8,
                   'observer', 'installed', now())
           RETURNING id`,
          [
            userId,
            cap.registryId,
            cap.registryId,       // display_name defaults to registryId
            cap.transport,
            cap.command ?? null,
            argsJson,
            envJson,
            cap.url ?? null,
          ],
        );
        insertedServer = insertResult.rows[0] ?? null;
      } catch (dbErr: unknown) {
        // Handle duplicate registry_id for this user (unique constraint)
        const errMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        if (errMsg.includes('unique') || errMsg.includes('duplicate') || errMsg.includes('UNIQUE')) {
          await dxtImportRepository.markFailed(id, 'Registry ID already installed for this user');
          log.info('DXT confirm failed: duplicate registry_id', { userId, importId: id, registryId: cap.registryId });
          res.status(400).json({
            error: 'A capability with this registry ID is already installed for your account.',
          });
          return;
        }
        await dxtImportRepository.markFailed(id, `DB insert failed: ${errMsg.slice(0, 200)}`);
        throw dbErr;
      }

      if (!insertedServer) {
        await dxtImportRepository.markFailed(id, 'mcp_servers insert returned no row');
        res.status(500).json({ error: 'Failed to create capability server record' });
        return;
      }

      const serverId = insertedServer.id;

      // Apply spend caps from payload if present
      if (payload.perAppSpendCaps) {
        const caps = payload.perAppSpendCaps;
        try {
          await query(
            `UPDATE mcp_servers
             SET per_app_spend_per_action_cents = $2,
                 per_app_daily_spend_cents = $3,
                 per_app_monthly_spend_cents = $4,
                 updated_at = now()
             WHERE id = $1`,
            [
              serverId,
              caps.perActionCents ?? null,
              caps.dailyCents ?? null,
              caps.monthlyCents ?? null,
            ],
          );
        } catch {
          // Best-effort — spend caps are not fatal
        }
      }

      // Mark import as installed
      await dxtImportRepository.markInstalled(id, serverId);

      // Write provenance node (hard rail: every install must write provenance)
      try {
        await provenanceRepository.writeNode({
          userId,
          nodeType: 'manual_install',
          refTable: 'dxt_imports',
          refId: id,
          serverId,
          payload: {
            source: 'dxt_import',
            importId: id,
            sourceInstanceId: importRow.source_instance_id,
            registryId: importRow.registry_id,
          },
        });
      } catch (provErr) {
        // Provenance write failure is logged but not fatal — install already committed
        log.info('DXT confirm: provenance write failed (non-fatal)', {
          userId,
          importId: id,
          serverId,
          error: provErr instanceof Error ? provErr.message : String(provErr),
        });
      }

      log.info('DXT import confirmed and installed', {
        userId,
        importId: id,
        serverId,
        registryId: importRow.registry_id,
      });

      res.status(201).json({
        status: 'installed',
        serverId,
        registryId: importRow.registry_id,
      });
    } catch (err) {
      // Attempt to mark the import as failed so the row reflects reality
      try {
        const { id } = req.params;
        if (id && UUID_REGEX.test(id)) {
          await dxtImportRepository.markFailed(id, err instanceof Error ? err.message.slice(0, 200) : 'Unknown error');
        }
      } catch {
        // Ignore secondary failure
      }
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /imports/:id/reject
  // Mark a pending import as rejected (audit trail). Returns 204.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/imports/:id/reject', async (req, res, next) => {
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

      const importRow = await dxtImportRepository.findById(id);
      if (!importRow) {
        res.status(404).json({ error: 'Import not found' });
        return;
      }
      if (importRow.user_id !== userId) {
        res.status(403).json({ error: 'Forbidden: you do not own this import' });
        return;
      }
      if (importRow.status !== 'pending') {
        res.status(400).json({
          error: `Import is not pending (status: ${importRow.status}). Only pending imports can be rejected.`,
        });
        return;
      }

      await dxtImportRepository.markRejected(id);

      log.info('DXT import rejected', { userId, importId: id, registryId: importRow.registry_id });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /imports
  // List all imports for the user, newest first. No blob bytes in response.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/imports', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const statusFilter = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
      const rows = await dxtImportRepository.listForUser(userId, statusFilter ? { status: statusFilter } : undefined);

      const imports = rows.map((r) => ({
        id: r.id,
        registryId: r.registry_id,
        sourceInstanceId: r.source_instance_id,
        importedAt: r.imported_at,
        status: r.status,
        installedServerId: r.installed_server_id,
        installedAt: r.installed_at,
        rejectedAt: r.rejected_at,
        errorMessage: r.error_message,
        sha256: r.artifact_sha256.toString('hex'),
        blobBytes: r.artifact_blob.length,
      }));

      res.json({ imports });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
