import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';

/**
 * Delete every row belonging to a single user, in a single CRDB
 * serializable transaction (#376).
 *
 * Why this lives in @skytwin/db: the API route should not have to
 * know the dependency order between 30+ tables. The cascade FK
 * backfill in migration 061 (#413) takes care of the direct
 * `user_id → users(id)` references, but a handful of tables FK to
 * children of user-owned rows via non-user-id keys
 * (`candidate_actions.decision_id`, `twin_profile_versions.profile_id`,
 * `execution_plans.decision_id`, etc.). Those child rows must be
 * deleted explicitly BEFORE the final `DELETE FROM users` so the
 * cascade through `user_id` FKs doesn't trip over orphaned
 * intermediate rows.
 *
 * The function returns a per-table row count map so the API can
 * surface what was actually purged — useful both for the user (they
 * see "twin profile (1), decisions (147), preferences (23)…" in the
 * response) and for debugging if a stale row is left behind.
 *
 * Safety: the entire delete runs inside `withTransaction`, so a
 * failure anywhere in the chain rolls back. There is no "partially
 * deleted user" state.
 */

export interface PurgeUserResult {
  /** Number of rows removed, per table, in dependency order. */
  counts: Record<string, number>;
  /** Total rows touched. */
  total: number;
  /** True if the users row itself was removed (false → user didn't exist). */
  userExisted: boolean;
}

/**
 * Statement plan executed inside `withTransaction`. The order matters:
 * each entry is run sequentially. Entries earlier in the list must
 * remove every row whose deletion would be blocked by a later DELETE.
 *
 * Each statement uses `$1` for the user id. The `table` field is the
 * key under which the row count is reported.
 */
const DELETE_PLAN: ReadonlyArray<{ table: string; sql: string }> = [
  // ── 1. Leaves that chain off decisions / execution_plans / twin_profiles
  //       (FK via non-user-id columns — would block the user delete
  //       cascade if left in place)
  {
    table: 'execution_results',
    sql: `DELETE FROM execution_results WHERE plan_id IN
            (SELECT ep.id FROM execution_plans ep
              JOIN decisions d ON ep.decision_id = d.id
             WHERE d.user_id = $1)`,
  },
  {
    table: 'execution_events',
    sql: `DELETE FROM execution_events WHERE plan_id IN
            (SELECT ep.id FROM execution_plans ep
              JOIN decisions d ON ep.decision_id = d.id
             WHERE d.user_id = $1)`,
  },
  {
    table: 'execution_plans',
    sql: `DELETE FROM execution_plans WHERE decision_id IN
            (SELECT id FROM decisions WHERE user_id = $1)`,
  },
  {
    table: 'explanation_records',
    sql: `DELETE FROM explanation_records WHERE decision_id IN
            (SELECT id FROM decisions WHERE user_id = $1)`,
  },
  {
    table: 'decision_outcomes',
    sql: `DELETE FROM decision_outcomes WHERE decision_id IN
            (SELECT id FROM decisions WHERE user_id = $1)`,
  },
  {
    table: 'candidate_actions',
    sql: `DELETE FROM candidate_actions WHERE decision_id IN
            (SELECT id FROM decisions WHERE user_id = $1)`,
  },
  {
    table: 'twin_profile_versions',
    sql: `DELETE FROM twin_profile_versions WHERE profile_id IN
            (SELECT id FROM twin_profiles WHERE user_id = $1)`,
  },
  {
    table: 'knowledge_triples',
    sql: `DELETE FROM knowledge_triples
           WHERE user_id = $1
              OR entity_id IN (SELECT id FROM knowledge_entities WHERE user_id = $1)`,
  },

  // ── 2. Final DELETE on the users row.
  //       Every direct `user_id → users(id)` FK now carries
  //       ON DELETE CASCADE (migration 061 from #413), so this single
  //       statement collapses the rest of the user's footprint —
  //       decisions, twin_profiles, preferences, signals, oauth_tokens,
  //       sessions, all the mempalace tables (which themselves cascade
  //       internally via wing_id / room_id), behavioral_patterns,
  //       eval_runs, briefings, spend_records, trust_tier_audit,
  //       domain_autonomy_policies, escalation_triggers, connector_*,
  //       capability_*, ai_provider_settings, lifebooks,
  //       recovery_codes, model_downloads, connector_health,
  //       external_agent_tokens, dxt_imports, fs_scan_*,
  //       promotion_offers, user_onboarding_state,
  //       user_risk_profiles, user_credential_vault_meta,
  //       draft_email_*, mcp_servers (via per-user installs), etc.
  //
  //       The DELETE-then-cascade chain is verified in
  //       `cascade-cleanup.e2e.test.ts` (#413) and exercised
  //       end-to-end by `user-purge-repository.e2e.test.ts` (#376).
  {
    table: 'users',
    sql: `DELETE FROM users WHERE id = $1`,
  },
];

async function execAndCount(
  client: PoolClient,
  sql: string,
  userId: string,
): Promise<number> {
  const result = await client.query(sql, [userId]);
  return result.rowCount ?? 0;
}

export const userPurgeRepository = {
  /**
   * Delete every row belonging to the given user. Wraps the chain in
   * `withTransaction` so a failure rolls back cleanly. Returns the
   * per-table row count for the caller to surface to the user.
   *
   * Idempotent only in the trivial sense: a second call after a
   * successful delete is a no-op (every count is 0, `userExisted`
   * is false). Concurrent calls are guarded by the transaction —
   * the second caller sees the row gone and returns
   * `userExisted: false`.
   */
  async purgeUser(userId: string): Promise<PurgeUserResult> {
    return withTransaction(async (client) => {
      const counts: Record<string, number> = {};
      let total = 0;
      let userExisted = false;
      for (const { table, sql } of DELETE_PLAN) {
        const n = await execAndCount(client, sql, userId);
        counts[table] = n;
        total += n;
        if (table === 'users') {
          userExisted = n > 0;
        }
      }
      return { counts, total, userExisted };
    });
  },
};
