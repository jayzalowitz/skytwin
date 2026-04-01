import { query } from '../connection.js';
import type { SkillGapRow } from '../types.js';

export interface CreateSkillGapInput {
  actionType: string;
  actionDescription: string;
  attemptedAdapters: string[];
  userId: string;
  decisionId?: string;
}

export const skillGapRepository = {
  async log(input: CreateSkillGapInput): Promise<SkillGapRow> {
    const result = await query<SkillGapRow>(
      `INSERT INTO skill_gap_log (action_type, action_description, attempted_adapters, user_id, decision_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.actionType, input.actionDescription, JSON.stringify(input.attemptedAdapters), input.userId, input.decisionId ?? null],
    );
    return result.rows[0]!;
  },

  async getAll(limit: number = 50): Promise<SkillGapRow[]> {
    const result = await query<SkillGapRow>(
      'SELECT * FROM skill_gap_log ORDER BY logged_at DESC LIMIT $1',
      [limit],
    );
    return result.rows;
  },

  async getByActionType(actionType: string): Promise<SkillGapRow[]> {
    const result = await query<SkillGapRow>(
      'SELECT * FROM skill_gap_log WHERE action_type = $1 ORDER BY logged_at DESC',
      [actionType],
    );
    return result.rows;
  },

  async setIssueUrl(id: string, url: string): Promise<void> {
    await query(
      'UPDATE skill_gap_log SET ironclaw_issue_url = $1 WHERE id = $2',
      [url, id],
    );
  },
};
