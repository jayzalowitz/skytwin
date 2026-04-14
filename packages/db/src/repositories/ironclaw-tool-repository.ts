import { query } from '../connection.js';
import type { IronClawToolRow } from '../types.js';

export interface UpsertIronClawToolInput {
  toolName: string;
  description?: string;
  actionTypes: string[];
  requiresCredentials: string[];
}

export const ironClawToolRepository = {
  async upsertMany(tools: UpsertIronClawToolInput[]): Promise<IronClawToolRow[]> {
    const rows: IronClawToolRow[] = [];
    for (const tool of tools) {
      const result = await query<IronClawToolRow>(
        `INSERT INTO ironclaw_tools (tool_name, description, action_types, requires_credentials, discovered_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tool_name) DO UPDATE SET
           description = EXCLUDED.description,
           action_types = EXCLUDED.action_types,
           requires_credentials = EXCLUDED.requires_credentials,
           discovered_at = now()
         RETURNING *`,
        [
          tool.toolName,
          tool.description ?? null,
          tool.actionTypes,
          tool.requiresCredentials,
        ],
      );
      rows.push(result.rows[0]!);
    }
    return rows;
  },

  async getAll(): Promise<IronClawToolRow[]> {
    const result = await query<IronClawToolRow>(
      'SELECT * FROM ironclaw_tools ORDER BY tool_name',
    );
    return result.rows;
  },

  async getSkillSet(): Promise<Set<string>> {
    const rows = await this.getAll();
    return new Set(rows.flatMap((row) => row.action_types));
  },
};
