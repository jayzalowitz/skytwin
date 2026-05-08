import { query } from '../connection.js';

export interface ProvenanceNodeRow {
  id: string;
  user_id: string;
  node_type: 'signal' | 'entity' | 'suggestion' | 'install' | 'tier_promotion' | 'action' | 'feedback' | 'uninstall' | 'external_agent' | 'zero_trust_change';
  ref_table: string;
  ref_id: string;
  server_id: string | null;
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
      `SELECT id, user_id, node_type, ref_table, ref_id, server_id,
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
   */
  async writeNode(input: WriteNodeInput): Promise<ProvenanceNodeRow> {
    const occurredAt = input.occurredAt ?? new Date();
    const result = await query<ProvenanceNodeRow>(
      `INSERT INTO capability_provenance_nodes
         (user_id, node_type, ref_table, ref_id, server_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, node_type, ref_table, ref_id, server_id,
                 occurred_at, payload, created_at`,
      [
        input.userId,
        input.nodeType,
        input.refTable,
        input.refId,
        input.serverId ?? null,
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
