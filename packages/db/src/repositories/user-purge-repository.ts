import type { PoolClient } from 'pg';
import { withTransaction } from '../connection.js';
import {
  bumpPolicyAuthorityWithClient,
  lockPolicyAuthorityWithClient,
} from './policy-repository.js';
import { invalidateOAuthAccountsForUserWithClient } from './oauth-repository.js';

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
 * Safety: active or ambiguous execution authority makes the operation fail
 * closed before the first DELETE. The entire delete runs inside `withTransaction`, so a
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

/** Purge cannot truthfully complete while an admitted effect may still run. */
export class ActiveExecutionAdmissionError extends Error {
  readonly code = 'active_execution_admission';

  constructor(readonly userId: string, readonly activeAdmissions: number) {
    super(`User ${userId} has ${activeAdmissions} active or ambiguous execution admission(s).`);
    this.name = 'ActiveExecutionAdmissionError';
  }
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
    table: 'credential_dispatch_leases',
    sql: `DELETE FROM credential_dispatch_leases WHERE user_id = $1`,
  },
  {
    table: 'execution_admission_barriers',
    sql: `DELETE FROM execution_admission_barriers WHERE user_id = $1`,
  },
  {
    table: 'decision_receipt_revisions',
    sql: `DELETE FROM decision_receipt_revisions WHERE receipt_id IN
            (SELECT id FROM decision_receipts WHERE user_id = $1)`,
  },
  {
    table: 'decision_receipts',
    sql: 'DELETE FROM decision_receipts WHERE user_id = $1',
  },
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
    table: 'execution_plans',
    sql: `DELETE FROM execution_plans WHERE decision_id IN
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
    table: 'entity_codes',
    sql: `DELETE FROM entity_codes WHERE entity_id IN
            (SELECT id FROM knowledge_entities WHERE user_id = $1)`,
  },
  {
    table: 'knowledge_triples',
    sql: `DELETE FROM knowledge_triples WHERE user_id = $1`,
  },
  {
    table: 'preference_history',
    sql: 'DELETE FROM preference_history WHERE user_id = $1',
  },
  // Connector evidence is operational state, not part of the user's portable
  // twin. Delete it explicitly so purge counts are auditable and no FK cascade
  // ordering is left to chance.
  {
    table: 'signals',
    sql: 'DELETE FROM signals WHERE user_id = $1',
  },
  {
    table: 'connector_cursors',
    sql: 'DELETE FROM connector_cursors WHERE user_id = $1',
  },
  {
    table: 'gmail_message_refs',
    sql: 'DELETE FROM gmail_message_refs WHERE user_id = $1',
  },
  {
    table: 'oauth_tokens',
    sql: 'DELETE FROM oauth_tokens WHERE user_id = $1',
  },
  {
    table: 'connected_accounts',
    sql: 'DELETE FROM connected_accounts WHERE user_id = $1',
  },

  // ── 2. Final DELETE on the users row.
  //       Every direct `user_id → users(id)` FK now carries
  //       ON DELETE CASCADE (migration 061 from #413), so this single
  //       statement collapses the rest of the user's footprint —
  //       decisions, twin_profiles, preferences,
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

const AUXILIARY_COUNT_TABLES = ['oauth_new_user_authorizations'] as const;

async function execAndCount(
  client: PoolClient,
  sql: string,
  userId: string,
): Promise<number> {
  const result = await client.query(sql, [userId]);
  return result.rowCount ?? 0;
}

export async function assertNoActiveExecutionsWithClient(
  client: PoolClient,
  userId: string,
): Promise<void> {
  const active = await client.query<{ active_count: number }>(
    `SELECT (
       (SELECT count(*) FROM execution_admission_barriers
         WHERE user_id = $1 AND status IN ('in_progress', 'ambiguous'))
       + (SELECT count(*) FROM credential_dispatch_leases
         WHERE user_id = $1 AND state IN ('request_started', 'ambiguous'))
       + (SELECT count(*) FROM decision_ingest_guards g
         JOIN decisions d ON d.id = g.decision_id
         WHERE d.user_id = $1 AND g.effect_state = 'running')
       + (SELECT count(*) FROM execution_plans ep
         JOIN decisions d ON d.id = ep.decision_id
         WHERE d.user_id = $1 AND ep.status = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM execution_admission_barriers b
             WHERE b.execution_plan_id = ep.id AND b.user_id = $1
           )
           AND NOT EXISTS (
             SELECT 1 FROM decision_ingest_guards g
             WHERE g.source_execution_plan_id = ep.id AND g.decision_id = d.id
           ))
     )::INT AS active_count`,
    [userId],
  );
  const activeCount = active.rows[0]?.active_count ?? 0;
  if (activeCount > 0) throw new ActiveExecutionAdmissionError(userId, activeCount);
}

async function purgeUserWithClient(client: PoolClient, userId: string): Promise<PurgeUserResult> {
  // Admission and purge share this owner-first serializable lock order.
  const owner = await client.query<{ id: string; email: string }>(
    'SELECT id, email FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  if (!owner.rows[0]) {
    const counts = Object.fromEntries([
      ...DELETE_PLAN.map(({ table }) => [table, 0] as const),
      ...AUXILIARY_COUNT_TABLES.map((table) => [table, 0] as const),
    ]);
    return { counts, total: 0, userExisted: false };
  }

  await assertNoActiveExecutionsWithClient(client, userId);

  const oauthFence = await invalidateOAuthAccountsForUserWithClient(
    client, userId, owner.rows[0].email,
  );

  const removesPolicies = Boolean((await client.query(
    'SELECT 1 FROM action_policies WHERE user_id = $1 LIMIT 1', [userId],
  )).rows[0]);
  if (removesPolicies) await lockPolicyAuthorityWithClient(client);

  const counts: Record<string, number> = {
    oauth_new_user_authorizations: oauthFence.pendingAuthorizationsDeleted,
  };
  let total = oauthFence.pendingAuthorizationsDeleted;
  let userExisted = false;
  for (const { table, sql } of DELETE_PLAN) {
    const n = await execAndCount(client, sql, userId);
    counts[table] = n;
    total += n;
    if (table === 'users') userExisted = n > 0;
  }
  if (removesPolicies && userExisted) await bumpPolicyAuthorityWithClient(client);
  return { counts, total, userExisted };
}

export const userPurgeRepository = {
  /**
   * Delete every row belonging to the given user. Wraps the chain in
   * `withTransaction` so a failure rolls back cleanly. Returns the
   * per-table row count for the caller to surface to the user.
   *
   * Refuses active/ambiguous execution graphs rather than erasing their
   * reconciliation authority. Idempotent only in the trivial sense: a second call after a
   * successful delete is a no-op (every count is 0, `userExisted`
   * is false). Concurrent calls are guarded by the transaction —
   * the second caller sees the row gone and returns
   * `userExisted: false`.
   */
  async purgeUser(userId: string): Promise<PurgeUserResult> {
    return withTransaction((client) => purgeUserWithClient(client, userId));
  },

  /** Atomically purge only users that remain marked as demo rows. */
  async purgeDemoUsers(): Promise<number> {
    return withTransaction(async (client) => {
      const selected = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE is_demo = true FOR UPDATE',
      );
      for (const user of selected.rows) {
        await purgeUserWithClient(client, user.id);
      }
      return selected.rows.length;
    });
  },
};
