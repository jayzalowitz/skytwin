import { query } from '../connection.js';

export interface ProvenanceNodeRow {
  id: string;
  user_id: string;
  node_type: 'signal' | 'entity' | 'suggestion' | 'install' | 'tier_promotion' | 'action' | 'feedback' | 'uninstall' | 'external_agent' | 'zero_trust_change' | 'manual_install';
  ref_table: string;
  ref_id: string;
  server_id: string | null;
  /**
   * #193 follow-up: optional Lifebook wing this node belongs to.
   * Populated at write time when the caller has lifebook context
   * (typically: the payload contains a `registryId` that matches a
   * lifebook's `suggested_capabilities` entry). NULL for rows
   * written before migration 041 and for node types with no
   * obvious lifebook linkage (tier_promotion, external_agent, etc.).
   */
  wing_id: string | null;
  occurred_at: Date;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

export interface ProvenanceEdgeRow {
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
}

export interface WriteNodeInput {
  userId: string;
  nodeType: ProvenanceNodeRow['node_type'];
  refTable: string;
  refId: string;
  serverId?: string | null;
  /** #193 follow-up: Lifebook wing to tie this node to. Optional. */
  wingId?: string | null;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
}

/**
 * Repository for capability_provenance_nodes + capability_provenance_edges.
 *
 * Provides typed parameterized-query access — no raw SQL in callers.
 * Used by the tier-promotion ceremony (issue #177) and the provenance
 * lineage flyout, in addition to the lifecycle routes written in #178.
 */
export const provenanceRepository = {
  /**
   * Return all provenance nodes for a given server, sorted oldest-first.
   * Ownership is enforced via user_id join.
   */
  async getForServer(userId: string, serverId: string): Promise<ProvenanceNodeRow[]> {
    const result = await query<ProvenanceNodeRow>(
      `SELECT id, user_id, node_type, ref_table, ref_id, server_id, wing_id,
              occurred_at, payload, created_at
       FROM capability_provenance_nodes
       WHERE user_id = $1 AND server_id = $2
       ORDER BY occurred_at ASC`,
      [userId, serverId],
    );
    return result.rows;
  },

  /**
   * Write a single provenance node and return the persisted row.
   *
   * #193 follow-up: when `input.wingId` is omitted but the payload
   * carries a `registryId`, we look up the matching lifebook (the one
   * whose `suggested_capabilities` contains that registry id) and stamp
   * its wing_id on the node. This is best-effort — if the registry id
   * isn't in any lifebook (e.g. capability installed before the domain
   * extractor ran), wing_id stays NULL. Explicit `wingId` always wins
   * over the auto-derivation.
   */
  async writeNode(input: WriteNodeInput): Promise<ProvenanceNodeRow> {
    const occurredAt = input.occurredAt ?? new Date();
    const wingId = input.wingId !== undefined
      ? input.wingId
      : await resolveWingIdFromPayload(input.userId, input.payload);
    const result = await query<ProvenanceNodeRow>(
      `INSERT INTO capability_provenance_nodes
         (user_id, node_type, ref_table, ref_id, server_id, wing_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id, node_type, ref_table, ref_id, server_id, wing_id,
                 occurred_at, payload, created_at`,
      [
        input.userId,
        input.nodeType,
        input.refTable,
        input.refId,
        input.serverId ?? null,
        wingId,
        occurredAt,
        input.payload != null ? JSON.stringify(input.payload) : null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('provenance node insert returned no row');
    return row;
  },

  /**
   * Write a directed edge between two existing provenance nodes.
   */
  async writeEdge(fromId: string, toId: string, edgeType: string): Promise<void> {
    await query(
      `INSERT INTO capability_provenance_edges (from_node_id, to_node_id, edge_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (from_node_id, to_node_id, edge_type) DO NOTHING`,
      [fromId, toId, edgeType],
    );
  },
};

/**
 * Resolve a Lifebook wing_id for a provenance-node payload, when the
 * payload carries a `registryId` matching a lifebook's
 * `suggested_capabilities` entry. Returns null when:
 *
 *   - The payload is null / not an object / has no `registryId`.
 *   - No lifebook claims that registryId.
 *   - The matching lifebook hasn't been bound to a wing yet.
 *
 * Used by `writeNode()` to auto-derive wing_id when the caller doesn't
 * pass one explicitly. Kept as a module-local helper rather than a
 * public repo method because the auto-derivation logic shouldn't be
 * called from anywhere else — explicit `wingId` is the long-term path.
 */
async function resolveWingIdFromPayload(
  userId: string,
  payload: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!payload) return null;
  const registryId = payload['registryId'];
  if (typeof registryId !== 'string' || registryId.length === 0) return null;

  // `@>` is the JSONB containment operator. `jsonb_build_array($2)`
  // builds the single-element array `[<registryId>]`, and the @> check
  // returns true when `suggested_capabilities` contains that element.
  // Portable form across CockroachDB and PG; no `?` operator quirks.
  const result = await query<{ wing_id: string | null }>(
    `SELECT wing_id
     FROM lifebooks
     WHERE user_id = $1
       AND wing_id IS NOT NULL
       AND suggested_capabilities @> jsonb_build_array($2::text)
     ORDER BY last_seen_at DESC
     LIMIT 1`,
    [userId, registryId],
  );
  return result.rows[0]?.wing_id ?? null;
}
