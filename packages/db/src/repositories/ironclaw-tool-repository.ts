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
    if (tools.length === 0) return [];

    // Batch upsert: build a single multi-row INSERT to avoid N round-trips
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (let i = 0; i < tools.length; i++) {
      const offset = i * 4;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, now())`);
      values.push(
        tools[i]!.toolName,
        tools[i]!.description ?? null,
        tools[i]!.actionTypes,
        tools[i]!.requiresCredentials,
      );
    }

    const result = await query<IronClawToolRow>(
      `INSERT INTO ironclaw_tools (tool_name, description, action_types, requires_credentials, discovered_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (tool_name) DO UPDATE SET
         description = EXCLUDED.description,
         action_types = EXCLUDED.action_types,
         requires_credentials = EXCLUDED.requires_credentials,
         discovered_at = now()
       RETURNING *`,
      values,
    );
    return result.rows;
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
