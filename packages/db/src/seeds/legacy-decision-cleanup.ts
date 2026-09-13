import type { PoolClient } from 'pg';
import { assertNoActiveExecutionsWithClient } from '../repositories/user-purge-repository.js';

/** Remove obsolete flat seed decisions in dependency-safe order. */
export async function cleanupLegacyFlatDecisions(
  client: PoolClient,
  userId: string,
): Promise<number> {
  // Callers hold the user's row lock before reaching this helper. Refuse to
  // erase an admission/ambiguity tombstone while an external effect may run.
  await assertNoActiveExecutionsWithClient(client, userId);
  const flatDecisionFilter =
    `SELECT id FROM decisions WHERE user_id = $1 AND raw_event->'data' IS NULL`;
  const flatPlanFilter =
    `SELECT id FROM execution_plans WHERE decision_id IN (${flatDecisionFilter})`;

  await client.query(
    `DELETE FROM credential_dispatch_leases WHERE execution_plan_id IN (${flatPlanFilter})`,
    [userId],
  );
  await client.query(
    `DELETE FROM execution_admission_barriers WHERE decision_id IN (${flatDecisionFilter})`,
    [userId],
  );
  await client.query(`DELETE FROM execution_results WHERE plan_id IN (${flatPlanFilter})`, [userId]);
  await client.query(`DELETE FROM execution_events WHERE plan_id IN (${flatPlanFilter})`, [userId]);
  await client.query(`DELETE FROM decision_outcomes WHERE decision_id IN (${flatDecisionFilter})`, [userId]);
  await client.query(`DELETE FROM execution_plans WHERE decision_id IN (${flatDecisionFilter})`, [userId]);
  for (const childTable of [
    'candidate_actions',
    'approval_requests',
    'explanation_records',
    'feedback_events',
    'skill_gap_log',
    'episodic_memories',
  ]) {
    await client.query(
      `DELETE FROM ${childTable} WHERE decision_id IN (${flatDecisionFilter})`,
      [userId],
    );
  }
  const cleanup = await client.query(
    `DELETE FROM decisions WHERE user_id = $1 AND raw_event->'data' IS NULL`,
    [userId],
  );
  return cleanup.rowCount ?? 0;
}
