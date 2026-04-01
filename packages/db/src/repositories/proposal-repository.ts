import { query } from '../connection.js';
import type { PreferenceProposalRow } from '../types.js';

export interface CreateProposalInput {
  userId: string;
  domain: string;
  key: string;
  value: unknown;
  confidence: string;
  supportingEvidence: unknown[];
}

export const proposalRepository = {
  async create(input: CreateProposalInput): Promise<PreferenceProposalRow> {
    const result = await query<PreferenceProposalRow>(
      `INSERT INTO preference_proposals (user_id, domain, key, value, confidence, supporting_evidence)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.userId, input.domain, input.key, JSON.stringify(input.value), input.confidence, JSON.stringify(input.supportingEvidence)],
    );
    return result.rows[0]!;
  },

  async getPending(userId: string): Promise<PreferenceProposalRow[]> {
    const result = await query<PreferenceProposalRow>(
      `SELECT * FROM preference_proposals
       WHERE user_id = $1 AND status = 'pending' AND expires_at > now()
       ORDER BY detected_at DESC`,
      [userId],
    );
    return result.rows;
  },

  async getById(id: string): Promise<PreferenceProposalRow | null> {
    const result = await query<PreferenceProposalRow>(
      'SELECT * FROM preference_proposals WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  },

  async respond(id: string, accepted: boolean): Promise<PreferenceProposalRow> {
    const status = accepted ? 'accepted' : 'rejected';
    const result = await query<PreferenceProposalRow>(
      `UPDATE preference_proposals SET status = $1, responded_at = now() WHERE id = $2 RETURNING *`,
      [status, id],
    );
    return result.rows[0]!;
  },

  async expireOld(): Promise<number> {
    const result = await query(
      `UPDATE preference_proposals SET status = 'expired'
       WHERE status = 'pending' AND expires_at < now()
       RETURNING id`,
    );
    return result.rowCount ?? 0;
  },

  async wasRecentlyRejected(userId: string, domain: string, key: string, withinDays: number = 90): Promise<boolean> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM preference_proposals
       WHERE user_id = $1 AND domain = $2 AND key = $3 AND status = 'rejected'
       AND responded_at > now() - $4::INTERVAL`,
      [userId, domain, key, `${withinDays} days`],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  },
};
