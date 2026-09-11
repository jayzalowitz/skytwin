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
      // Cockroach cannot infer VALUES placeholder types through INSERT ...
      // SELECT, so pin every batch column explicitly.
      placeholders.push(
        `($${offset + 1}::STRING, $${offset + 2}::STRING, ` +
        `$${offset + 3}::STRING[], $${offset + 4}::STRING[])`,
      );
      values.push(
        tools[i]!.toolName,
        tools[i]!.description ?? null,
        tools[i]!.actionTypes,
        tools[i]!.requiresCredentials,
      );
    }

    const result = await query<IronClawToolRow>(
      `INSERT INTO ironclaw_tools
         (installation_id, tool_name, description, action_types, requires_credentials, discovered_at)
       SELECT owner.installation_id, batch.tool_name, batch.description,
              batch.action_types, batch.requires_credentials, now()
         FROM installation_identity AS owner,
              (VALUES ${placeholders.join(', ')}) AS batch
                (tool_name, description, action_types, requires_credentials)
        WHERE owner.singleton = true
       ON CONFLICT (installation_id, tool_name) DO UPDATE SET
         description = EXCLUDED.description,
         action_types = EXCLUDED.action_types,
         requires_credentials = EXCLUDED.requires_credentials,
         discovered_at = now()
       RETURNING *`,
      values,
    );
    if (result.rows.length !== tools.length) {
      throw new Error('installation_identity_unavailable');
    }
    return result.rows;
  },

  async getAll(): Promise<IronClawToolRow[]> {
    const result = await query<IronClawToolRow>(
      `SELECT tool.*
         FROM ironclaw_tools AS tool
         JOIN installation_identity AS owner
           ON owner.singleton = true
          AND owner.installation_id = tool.installation_id
        ORDER BY tool.tool_name`,
    );
    return result.rows;
  },

  async getSkillSet(): Promise<Set<string>> {
    const rows = await this.getAll();
    return new Set(rows.flatMap((row) => row.action_types));
  },
};
