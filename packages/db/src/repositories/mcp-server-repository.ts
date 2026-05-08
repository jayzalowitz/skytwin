import { query } from '../connection.js';

export interface McpServerRow {
  id: string;
  user_id: string;
  registry_id: string | null;
  display_name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string | null;
  args: unknown;
  env: unknown;
  url: string | null;
  oauth_provider: string | null;
  oauth_token_id: string | null;
  trust_tier: 'observer' | 'suggest' | 'low_autonomy' | 'moderate_autonomy' | 'high_autonomy';
  per_app_spend_per_action_cents: number | null;
  per_app_daily_spend_cents: number | null;
  per_app_monthly_spend_cents: number | null;
  per_app_monthly_rollover: boolean;
  per_app_irreversible_requires_approval: boolean | null;
  zero_trust_mode: boolean;
  status: 'discovered' | 'installing' | 'installed' | 'authorized' | 'active' | 'paused' | 'dormant' | 'failed' | 'uninstalled';
  last_health_check_at: Date | null;
  health_status: string | null;
  last_active_at: Date | null;
  installed_at: Date | null;
  uninstalled_at: Date | null;
  auto_promote_paused_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const mcpServerRepository = {
  async getById(id: string): Promise<McpServerRow | null> {
    const result = await query<McpServerRow>(
      'SELECT * FROM mcp_servers WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  },

  async getByUserAndRegistry(userId: string, registryId: string): Promise<McpServerRow | null> {
    const result = await query<McpServerRow>(
      'SELECT * FROM mcp_servers WHERE user_id = $1 AND registry_id = $2',
      [userId, registryId],
    );
    return result.rows[0] ?? null;
  },

  async listForUser(userId: string): Promise<McpServerRow[]> {
    const result = await query<McpServerRow>(
      `SELECT * FROM mcp_servers WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Return the cached list_tools() skill names for a server. Used by the DXT
   * exporter so the artifact records the skill set the user actually has,
   * not an empty placeholder. Cheap query — only the names; full schemas
   * stay in the table.
   */
  async listSkillNamesForServer(serverId: string): Promise<string[]> {
    const result = await query<{ skill_name: string }>(
      `SELECT skill_name FROM mcp_server_skills WHERE server_id = $1 ORDER BY skill_name`,
      [serverId],
    );
    return result.rows.map((r) => r.skill_name);
  },

  async listActive(): Promise<McpServerRow[]> {
    const result = await query<McpServerRow>(
      `SELECT * FROM mcp_servers WHERE status = 'active' ORDER BY last_active_at DESC`,
    );
    return result.rows;
  },

  async markDormant(id: string): Promise<McpServerRow | null> {
    const result = await query<McpServerRow>(
      `UPDATE mcp_servers
       SET status = 'dormant', updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  async markPaused(id: string): Promise<McpServerRow | null> {
    const result = await query<McpServerRow>(
      `UPDATE mcp_servers
       SET status = 'paused', updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  async markActive(id: string): Promise<McpServerRow | null> {
    const result = await query<McpServerRow>(
      `UPDATE mcp_servers
       SET status = 'active', updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return result.rows[0] ?? null;
  },

  async softDelete(
    id: string,
    opts: { revokedOauth: boolean; droppedSignals: boolean },
  ): Promise<McpServerRow | null> {
    const result = await query<McpServerRow>(
      `UPDATE mcp_servers
       SET status = 'uninstalled',
           uninstalled_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    // opts are recorded in the audit row written by the caller; they do not
    // affect the row itself beyond the status transition.
    void opts;
    return result.rows[0] ?? null;
  },

  async updateLastActive(id: string): Promise<void> {
    await query(
      `UPDATE mcp_servers
       SET last_active_at = now(), updated_at = now()
       WHERE id = $1`,
      [id],
    );
  },

  /**
   * Update the trust_tier for a server.
   */
  async updateTrustTier(
    id: string,
    trustTier: McpServerRow['trust_tier'],
  ): Promise<McpServerRow | null> {
    const result = await query<McpServerRow>(
      `UPDATE mcp_servers
       SET trust_tier = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [trustTier, id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Set auto_promote_paused_until so the promotion ceremony is suppressed
   * for N days (issue #177 decline-promotion endpoint).
   */
  async pauseAutoPromotion(id: string, untilDate: Date): Promise<McpServerRow | null> {
    const result = await query<McpServerRow>(
      `UPDATE mcp_servers
       SET auto_promote_paused_until = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [untilDate, id],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Returns servers that have status='active' and last_active_at before
   * the given threshold date. Used by the dormancy-check worker job.
   */
  async getInactiveSince(thresholdDate: Date): Promise<McpServerRow[]> {
    const result = await query<McpServerRow>(
      `SELECT * FROM mcp_servers
       WHERE status = 'active'
         AND last_active_at < $1
       ORDER BY last_active_at ASC`,
      [thresholdDate],
    );
    return result.rows;
  },

  /**
   * Pause all active capability servers for a user (#190 Pause-everything button).
   * Returns the list of servers that were transitioned to 'paused'.
   */
  async markAllPausedForUser(userId: string): Promise<McpServerRow[]> {
    const result = await query<McpServerRow>(
      `UPDATE mcp_servers
       SET status = 'paused', updated_at = now()
       WHERE user_id = $1
         AND status IN ('active', 'installed', 'authorized')
       RETURNING *`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Resume all paused capability servers for a user (#190 Pause-everything button).
   * Returns the list of servers that were transitioned back to 'active'.
   */
  async markAllResumedForUser(userId: string): Promise<McpServerRow[]> {
    const result = await query<McpServerRow>(
      `UPDATE mcp_servers
       SET status = 'active', updated_at = now()
       WHERE user_id = $1
         AND status = 'paused'
       RETURNING *`,
      [userId],
    );
    return result.rows;
  },

  /**
   * Toggle zero-trust mode for a single MCP server (#183 AC#4).
   *
   * When enabled, the policy engine applies an additional +1 riskModifier
   * to all action proposals and forces every action to require approval
   * regardless of trust tier.
   *
   * Container-level network isolation is enforced by the desktop app (#180).
   */
  async setZeroTrustMode(id: string, enabled: boolean): Promise<McpServerRow | null> {
    const result = await query<McpServerRow>(
      `UPDATE mcp_servers
       SET zero_trust_mode = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [enabled, id],
    );
    return result.rows[0] ?? null;
  },
};
