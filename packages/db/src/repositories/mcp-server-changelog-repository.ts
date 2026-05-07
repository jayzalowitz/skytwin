import { query } from '../connection.js';

/**
 * Repository for mcp_server_changelogs and pending_skill_opt_ins.
 *
 * Schema: packages/db/src/migrations/033-mcp-server-changelogs.sql
 * Issue #184 AC#2 — Capability changelog flow + new-skill opt-in.
 */

export interface McpServerChangelogRow {
  server_id: string;
  current_version: string | null;
  raw_text: string | null;
  fetched_at: Date;
  last_seen_skills: string[];
  last_known_destructive_skills: string[];
}

export interface UpsertChangelogInput {
  currentVersion?: string;
  rawText?: string;
  lastSeenSkills: string[];
  lastKnownDestructiveSkills: string[];
}

export interface PendingSkillOptInRow {
  id: string;
  server_id: string;
  skill_name: string;
  changelog_version: string | null;
  detected_at: Date;
  accepted_at: Date | null;
  rejected_at: Date | null;
}

export const mcpServerChangelogRepository = {
  /**
   * Upsert the changelog snapshot for a server.
   * On conflict (same server_id), updates all fields atomically.
   * Rate-limit enforcement (12h window) is the caller's responsibility
   * via the fetched_at column.
   */
  async upsert(serverId: string, input: UpsertChangelogInput): Promise<void> {
    await query(
      `INSERT INTO mcp_server_changelogs
         (server_id, current_version, raw_text, fetched_at,
          last_seen_skills, last_known_destructive_skills)
       VALUES ($1, $2, $3, now(), $4::jsonb, $5::jsonb)
       ON CONFLICT (server_id) DO UPDATE SET
         current_version              = EXCLUDED.current_version,
         raw_text                     = EXCLUDED.raw_text,
         fetched_at                   = EXCLUDED.fetched_at,
         last_seen_skills             = EXCLUDED.last_seen_skills,
         last_known_destructive_skills = EXCLUDED.last_known_destructive_skills`,
      [
        serverId,
        input.currentVersion ?? null,
        input.rawText ?? null,
        JSON.stringify(input.lastSeenSkills),
        JSON.stringify(input.lastKnownDestructiveSkills),
      ],
    );
  },

  /**
   * Return the changelog row for a server, or null if none exists.
   */
  async getForServer(serverId: string): Promise<McpServerChangelogRow | null> {
    const result = await query<McpServerChangelogRow>(
      `SELECT server_id, current_version, raw_text, fetched_at,
              last_seen_skills, last_known_destructive_skills
       FROM mcp_server_changelogs
       WHERE server_id = $1`,
      [serverId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Insert a pending opt-in row for a newly discovered destructive skill.
   * ON CONFLICT DO NOTHING — idempotent; safe to call on every poll.
   */
  async addPendingOptIn(
    serverId: string,
    skillName: string,
    changelogVersion?: string,
  ): Promise<void> {
    await query(
      `INSERT INTO pending_skill_opt_ins (server_id, skill_name, changelog_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (server_id, skill_name) DO NOTHING`,
      [serverId, skillName, changelogVersion ?? null],
    );
  },

  /**
   * List all unresolved opt-in prompts for a user.
   * JOINs with mcp_servers to scope by user_id.
   * Only returns rows where accepted_at IS NULL AND rejected_at IS NULL.
   */
  async listPendingOptInsForUser(
    userId: string,
  ): Promise<Array<PendingSkillOptInRow & { server_display_name: string; server_registry_id: string | null }>> {
    const result = await query<
      PendingSkillOptInRow & { server_display_name: string; server_registry_id: string | null }
    >(
      `SELECT p.id, p.server_id, p.skill_name, p.changelog_version,
              p.detected_at, p.accepted_at, p.rejected_at,
              ms.display_name AS server_display_name,
              ms.registry_id  AS server_registry_id
       FROM pending_skill_opt_ins p
       JOIN mcp_servers ms ON ms.id = p.server_id
       WHERE ms.user_id = $1
         AND p.accepted_at IS NULL
         AND p.rejected_at IS NULL
       ORDER BY p.detected_at DESC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Accept an opt-in prompt. Sets accepted_at = now().
   */
  async acceptOptIn(id: string): Promise<{ found: boolean }> {
    const result = await query<{ id: string }>(
      `UPDATE pending_skill_opt_ins
       SET accepted_at = now()
       WHERE id = $1
         AND accepted_at IS NULL
         AND rejected_at IS NULL
       RETURNING id`,
      [id],
    );
    return { found: result.rows.length > 0 };
  },

  /**
   * Reject an opt-in prompt. Sets rejected_at = now().
   */
  async rejectOptIn(id: string): Promise<{ found: boolean }> {
    const result = await query<{ id: string }>(
      `UPDATE pending_skill_opt_ins
       SET rejected_at = now()
       WHERE id = $1
         AND accepted_at IS NULL
         AND rejected_at IS NULL
       RETURNING id`,
      [id],
    );
    return { found: result.rows.length > 0 };
  },

  /**
   * Check whether a given skill on a given server has an unaccepted
   * pending opt-in (i.e. the hard rail — block execution until accepted).
   */
  async hasPendingOptIn(serverId: string, skillName: string): Promise<boolean> {
    const result = await query<{ id: string }>(
      `SELECT id FROM pending_skill_opt_ins
       WHERE server_id = $1
         AND skill_name = $2
         AND accepted_at IS NULL
         AND rejected_at IS NULL
       LIMIT 1`,
      [serverId, skillName],
    );
    return result.rows.length > 0;
  },
};
