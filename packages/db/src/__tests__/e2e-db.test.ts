/**
 * E2E database integration tests.
 *
 * These tests run real SQL against a live CockroachDB instance pointed at by
 * the DATABASE_URL environment variable. They are gated behind E2E=true so
 * the normal `pnpm test` suite (which uses mocks) is unaffected.
 *
 * Run via:  E2E=true pnpm --filter @skytwin/db exec vitest run src/__tests__/e2e-db.test.ts
 * Or:       ./bin/skytwin-e2e-test --db-only
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Pool } from 'pg';

const E2E = process.env['E2E'] === 'true';

// We need a fresh pool per test file so we don't collide with the singleton
// in connection.ts (which may already be configured for a different DB).
let pool: Pool;

// Track user IDs created in tests so afterEach can clean them up.
const createdUserIds: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

async function sqlOne<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T> {
  const rows = await sql<T>(text, params);
  if (rows.length === 0) throw new Error(`Expected 1 row, got 0 for: ${text}`);
  return rows[0]!;
}

/**
 * Create a user and track its ID for cleanup.
 */
async function createTestUser(email: string, name: string, trustTier = 'observer') {
  const user = await sqlOne<{ id: string; email: string; name: string; trust_tier: string }>(
    `INSERT INTO users (email, name, trust_tier, autonomy_settings)
     VALUES ($1, $2, $3, '{}')
     RETURNING *`,
    [email, name, trustTier],
  );
  createdUserIds.push(user.id);
  return user;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!E2E)('E2E: CockroachDB integration', () => {
  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error('DATABASE_URL must be set for E2E tests');
    }
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterEach(async () => {
    // Clean up any users (and cascading data) we created during the test.
    // Delete in reverse dependency order so FK constraints are satisfied.
    for (const userId of createdUserIds) {
      try {
        await pool.query('DELETE FROM feedback_events WHERE user_id = $1', [userId]);
        await pool.query(
          `DELETE FROM explanation_records WHERE decision_id IN
           (SELECT id FROM decisions WHERE user_id = $1)`,
          [userId],
        );
        await pool.query(
          `DELETE FROM execution_results WHERE plan_id IN
           (SELECT ep.id FROM execution_plans ep
            JOIN decisions d ON ep.decision_id = d.id
            WHERE d.user_id = $1)`,
          [userId],
        );
        await pool.query(
          `DELETE FROM execution_plans WHERE decision_id IN
           (SELECT id FROM decisions WHERE user_id = $1)`,
          [userId],
        );
        await pool.query('DELETE FROM approval_requests WHERE user_id = $1', [userId]);
        await pool.query(
          `DELETE FROM decision_outcomes WHERE decision_id IN
           (SELECT id FROM decisions WHERE user_id = $1)`,
          [userId],
        );
        await pool.query(
          `DELETE FROM candidate_actions WHERE decision_id IN
           (SELECT id FROM decisions WHERE user_id = $1)`,
          [userId],
        );
        await pool.query('DELETE FROM decisions WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM action_policies WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM preferences WHERE user_id = $1', [userId]);
        await pool.query(
          `DELETE FROM twin_profile_versions WHERE profile_id IN
           (SELECT id FROM twin_profiles WHERE user_id = $1)`,
          [userId],
        );
        await pool.query('DELETE FROM twin_profiles WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM connected_accounts WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM spend_records WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM trust_tier_audit WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM domain_autonomy_policies WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM escalation_triggers WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM signals WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM preference_proposals WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      } catch {
        // Best-effort cleanup; table may not exist if migrations failed
      }
    }
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await pool.end();
  });

  // =========================================================================
  // a. User CRUD — create and persist
  // =========================================================================

  describe('User CRUD', () => {
    it('creates a user and reads it back by ID', async () => {
      const user = await createTestUser('e2e-alice@test.local', 'Alice E2E');

      expect(user.id).toBeDefined();
      expect(user.email).toBe('e2e-alice@test.local');
      expect(user.name).toBe('Alice E2E');
      expect(user.trust_tier).toBe('observer');

      // Read it back
      const found = await sqlOne(
        'SELECT * FROM users WHERE id = $1',
        [user.id],
      );
      expect(found['email']).toBe('e2e-alice@test.local');
      expect(found['name']).toBe('Alice E2E');
    });

    it('enforces unique email constraint', async () => {
      await createTestUser('e2e-unique@test.local', 'User One');

      await expect(
        createTestUser('e2e-unique@test.local', 'User Two'),
      ).rejects.toThrow(/duplicate key|unique/i);

      // Pop the tracked ID since the second insert failed
      createdUserIds.pop();
    });

    it('updates a user and verifies the change', async () => {
      const user = await createTestUser('e2e-update@test.local', 'Before');

      await sql(
        `UPDATE users SET name = $1, updated_at = now() WHERE id = $2`,
        ['After', user.id],
      );

      const updated = await sqlOne(
        'SELECT * FROM users WHERE id = $1',
        [user.id],
      );
      expect(updated['name']).toBe('After');
    });

    it('default trust tier is applied by the database', async () => {
      const rows = await sql<{ id: string; trust_tier: string }>(
        `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *`,
        ['e2e-default-tier@test.local', 'Default Tier'],
      );
      const user = rows[0]!;
      createdUserIds.push(user.id);
      expect(user.trust_tier).toBe('observer');
    });
  });

  // =========================================================================
  // b. Decision with full context
  // =========================================================================

  describe('Decision with full context', () => {
    it('creates a decision with candidates, outcome, explanation, and feedback — then reads full context', async () => {
      const user = await createTestUser('e2e-decision@test.local', 'Decision User');

      // Create decision
      const decision = await sqlOne<{ id: string }>(
        `INSERT INTO decisions (user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata)
         VALUES ($1, 'email_triage', '{"from":"boss@co.com"}', '{"priority":"high"}', 'email', 'high', '{}')
         RETURNING *`,
        [user.id],
      );

      // Create candidate actions
      const action1 = await sqlOne<{ id: string }>(
        `INSERT INTO candidate_actions (decision_id, action_type, description, parameters, predicted_user_preference, risk_assessment, reversible, estimated_cost)
         VALUES ($1, 'reply', 'Auto-reply to boss', '{"template":"ack"}', 'likely', '{"overall":"low"}', true, 0)
         RETURNING *`,
        [decision.id],
      );

      const action2 = await sqlOne<{ id: string }>(
        `INSERT INTO candidate_actions (decision_id, action_type, description, parameters, predicted_user_preference, risk_assessment, reversible, estimated_cost)
         VALUES ($1, 'escalate', 'Flag for manual review', '{}', 'neutral', '{"overall":"none"}', true, 0)
         RETURNING *`,
        [decision.id],
      );

      // Record outcome
      await sql(
        `INSERT INTO decision_outcomes (decision_id, selected_action_id, auto_executed, requires_approval, explanation, confidence)
         VALUES ($1, $2, false, true, 'High-urgency email from manager; escalating for review', 0.85)`,
        [decision.id, action1.id],
      );

      // Create explanation
      await sql(
        `INSERT INTO explanation_records (decision_id, what_happened, evidence_used, preferences_invoked, confidence_reasoning, action_rationale, correction_guidance)
         VALUES ($1, 'Received email from boss@co.com', '["email subject","sender history"]', '{"email_priority"}', 'High confidence due to sender importance', 'Chose reply over escalate based on urgency', 'You can change auto-reply settings')`,
        [decision.id],
      );

      // Create feedback
      await sql(
        `INSERT INTO feedback_events (user_id, decision_id, type, data)
         VALUES ($1, $2, 'approve', '{"reason":"good call"}')`,
        [user.id, decision.id],
      );

      // Now read the full context
      const decisions = await sql('SELECT * FROM decisions WHERE id = $1', [decision.id]);
      expect(decisions).toHaveLength(1);

      const candidates = await sql(
        'SELECT * FROM candidate_actions WHERE decision_id = $1 ORDER BY created_at',
        [decision.id],
      );
      expect(candidates).toHaveLength(2);
      expect(candidates[0]!['action_type']).toBe('reply');
      expect(candidates[1]!['action_type']).toBe('escalate');

      const outcomes = await sql(
        'SELECT * FROM decision_outcomes WHERE decision_id = $1',
        [decision.id],
      );
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!['selected_action_id']).toBe(action1.id);
      expect(outcomes[0]!['auto_executed']).toBe(false);
      expect(outcomes[0]!['requires_approval']).toBe(true);
      expect(Number(outcomes[0]!['confidence'])).toBeCloseTo(0.85);

      const explanations = await sql(
        'SELECT * FROM explanation_records WHERE decision_id = $1',
        [decision.id],
      );
      expect(explanations).toHaveLength(1);
      expect(explanations[0]!['what_happened']).toContain('boss@co.com');

      const feedback = await sql(
        'SELECT * FROM feedback_events WHERE decision_id = $1',
        [decision.id],
      );
      expect(feedback).toHaveLength(1);
      expect(feedback[0]!['type']).toBe('approve');

      // Verify FK integrity: action2 is correctly linked
      expect(action2.id).toBeDefined();
      const action2Row = await sql(
        'SELECT * FROM candidate_actions WHERE id = $1',
        [action2.id],
      );
      expect(action2Row[0]!['decision_id']).toBe(decision.id);
    });
  });

  // =========================================================================
  // c. Approval request — double-respond prevention
  // =========================================================================

  describe('Approval double-respond prevention', () => {
    it('prevents responding to the same approval request twice via AND status = pending', async () => {
      const user = await createTestUser('e2e-approval@test.local', 'Approval User');

      // Create a decision (FK target for approval)
      const decision = await sqlOne<{ id: string }>(
        `INSERT INTO decisions (user_id, situation_type, raw_event, interpreted_situation, domain)
         VALUES ($1, 'test_event', '{}', '{}', 'email')
         RETURNING *`,
        [user.id],
      );

      // Create a pending approval
      const approval = await sqlOne<{ id: string; status: string }>(
        `INSERT INTO approval_requests (user_id, decision_id, candidate_action, reason, urgency, status, requested_at, expires_at)
         VALUES ($1, $2, '{"actionType":"reply"}', 'Needs review', 'normal', 'pending', now(), now() + interval '1 day')
         RETURNING *`,
        [user.id, decision.id],
      );
      expect(approval.status).toBe('pending');

      // First response: approve
      const firstResponse = await sql<{ id: string; status: string }>(
        `UPDATE approval_requests
         SET status = 'approved', responded_at = now(), response = '{"action":"approve"}'
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [approval.id],
      );
      expect(firstResponse).toHaveLength(1);
      expect(firstResponse[0]!.status).toBe('approved');

      // Second response: should return no rows (status is no longer 'pending')
      const secondResponse = await sql(
        `UPDATE approval_requests
         SET status = 'rejected', responded_at = now(), response = '{"action":"reject"}'
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [approval.id],
      );
      expect(secondResponse).toHaveLength(0);

      // Verify the approval is still 'approved' (not overwritten)
      const final = await sqlOne<{ status: string }>(
        'SELECT status FROM approval_requests WHERE id = $1',
        [approval.id],
      );
      expect(final.status).toBe('approved');
    });

    it('allows responding to different approvals for the same decision', async () => {
      const user = await createTestUser('e2e-multi-approval@test.local', 'Multi Approval');

      const decision = await sqlOne<{ id: string }>(
        `INSERT INTO decisions (user_id, situation_type, raw_event, interpreted_situation, domain)
         VALUES ($1, 'test_event', '{}', '{}', 'email')
         RETURNING *`,
        [user.id],
      );

      // Create two separate approval requests
      const approval1 = await sqlOne<{ id: string }>(
        `INSERT INTO approval_requests (user_id, decision_id, candidate_action, reason, urgency, status, requested_at, expires_at)
         VALUES ($1, $2, '{"actionType":"reply"}', 'First option', 'normal', 'pending', now(), now() + interval '1 day')
         RETURNING *`,
        [user.id, decision.id],
      );

      const approval2 = await sqlOne<{ id: string }>(
        `INSERT INTO approval_requests (user_id, decision_id, candidate_action, reason, urgency, status, requested_at, expires_at)
         VALUES ($1, $2, '{"actionType":"forward"}', 'Second option', 'normal', 'pending', now(), now() + interval '1 day')
         RETURNING *`,
        [user.id, decision.id],
      );

      // Approve the first, reject the second
      const r1 = await sql(
        `UPDATE approval_requests SET status = 'approved', responded_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING *`,
        [approval1.id],
      );
      expect(r1).toHaveLength(1);

      const r2 = await sql(
        `UPDATE approval_requests SET status = 'rejected', responded_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING *`,
        [approval2.id],
      );
      expect(r2).toHaveLength(1);
    });
  });

  // =========================================================================
  // d. Schema verification after migrations
  // =========================================================================

  describe('Schema verification', () => {
    it('all expected tables exist', async () => {
      const result = await sql<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
         ORDER BY table_name`,
      );

      const tableNames = result.map((r) => r.table_name);

      const expectedTables = [
        'users',
        'connected_accounts',
        'twin_profiles',
        'twin_profile_versions',
        'preferences',
        'decisions',
        'candidate_actions',
        'decision_outcomes',
        'action_policies',
        'approval_requests',
        'execution_plans',
        'execution_results',
        'explanation_records',
        'feedback_events',
      ];

      for (const table of expectedTables) {
        expect(tableNames).toContain(table);
      }
    });

    it('users table has correct columns', async () => {
      const columns = await sql<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'users' AND table_schema = 'public'
         ORDER BY ordinal_position`,
      );

      const colNames = columns.map((c) => c.column_name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('email');
      expect(colNames).toContain('name');
      expect(colNames).toContain('trust_tier');
      expect(colNames).toContain('autonomy_settings');
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('updated_at');
    });

    it('decisions table has the expected indexes', async () => {
      const indexes = await sql<{ index_name: string }>(
        `SELECT index_name FROM information_schema.statistics
         WHERE table_name = 'decisions' AND table_schema = 'public'`,
      );

      // CockroachDB always creates a primary index; we should also see user_id indexes
      expect(indexes.length).toBeGreaterThanOrEqual(1);
    });

    it('foreign key from decisions to users is enforced', async () => {
      const fakeUserId = '00000000-0000-0000-0000-000000000000';

      await expect(
        sql(
          `INSERT INTO decisions (user_id, situation_type, raw_event, interpreted_situation, domain)
           VALUES ($1, 'test', '{}', '{}', 'test')`,
          [fakeUserId],
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });

  // =========================================================================
  // e. Transaction rollback on error
  // =========================================================================

  describe('Transaction rollback', () => {
    it('rolls back all changes when an error occurs mid-transaction', async () => {
      const user = await createTestUser('e2e-txn@test.local', 'Txn User');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Step 1: Insert a decision (should succeed)
        const decisionResult = await client.query(
          `INSERT INTO decisions (user_id, situation_type, raw_event, interpreted_situation, domain)
           VALUES ($1, 'txn_test', '{}', '{}', 'email')
           RETURNING id`,
          [user.id],
        );
        const decisionId = decisionResult.rows[0]!.id;

        // Step 2: Deliberately cause an error (violate a NOT NULL constraint)
        try {
          await client.query(
            `INSERT INTO candidate_actions (decision_id, action_type, description, predicted_user_preference, risk_assessment)
             VALUES ($1, NULL, 'test', 'likely', '{}')`,
            [decisionId],
          );
        } catch {
          // Expected to fail due to NOT NULL on action_type
          await client.query('ROLLBACK');
        }
      } finally {
        client.release();
      }

      // Verify the decision was NOT persisted (rolled back)
      const decisions = await sql(
        `SELECT * FROM decisions WHERE user_id = $1 AND situation_type = 'txn_test'`,
        [user.id],
      );
      expect(decisions).toHaveLength(0);
    });

    it('commits all changes when no error occurs', async () => {
      const user = await createTestUser('e2e-txn-commit@test.local', 'Txn Commit');

      const client = await pool.connect();
      let decisionId: string;
      try {
        await client.query('BEGIN');

        const decisionResult = await client.query(
          `INSERT INTO decisions (user_id, situation_type, raw_event, interpreted_situation, domain)
           VALUES ($1, 'txn_commit_test', '{}', '{}', 'email')
           RETURNING id`,
          [user.id],
        );
        decisionId = decisionResult.rows[0]!.id;

        await client.query(
          `INSERT INTO candidate_actions (decision_id, action_type, description, predicted_user_preference, risk_assessment)
           VALUES ($1, 'reply', 'Test action', 'likely', '{}')`,
          [decisionId],
        );

        await client.query('COMMIT');
      } finally {
        client.release();
      }

      // Verify both the decision and candidate action were persisted
      const decisions = await sql(
        `SELECT * FROM decisions WHERE id = $1`,
        [decisionId!],
      );
      expect(decisions).toHaveLength(1);

      const actions = await sql(
        `SELECT * FROM candidate_actions WHERE decision_id = $1`,
        [decisionId!],
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]!['action_type']).toBe('reply');
    });

    it('withTransaction-style helper rolls back on thrown error', async () => {
      const user = await createTestUser('e2e-withtxn@test.local', 'WithTxn User');

      // Simulate the withTransaction pattern from connection.ts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function withTxn<T>(fn: (client: any) => Promise<T>): Promise<T> {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }

      // This should throw and roll back
      await expect(
        withTxn(async (client) => {
          await client.query(
            `INSERT INTO decisions (user_id, situation_type, raw_event, interpreted_situation, domain)
             VALUES ($1, 'withtxn_test', '{}', '{}', 'email')`,
            [user.id],
          );
          // Force an error
          throw new Error('Intentional rollback');
        }),
      ).rejects.toThrow('Intentional rollback');

      // Verify nothing was persisted
      const decisions = await sql(
        `SELECT * FROM decisions WHERE user_id = $1 AND situation_type = 'withtxn_test'`,
        [user.id],
      );
      expect(decisions).toHaveLength(0);
    });
  });

  // =========================================================================
  // Bonus: JSONB queries work correctly
  // =========================================================================

  describe('JSONB handling', () => {
    it('stores and queries JSONB autonomy_settings', async () => {
      const settings = { enabledDomains: ['email', 'calendar'], maxDailySpend: 1000 };
      const user = await sqlOne<{ id: string }>(
        `INSERT INTO users (email, name, autonomy_settings)
         VALUES ($1, $2, $3)
         RETURNING *`,
        ['e2e-jsonb@test.local', 'JSONB User', JSON.stringify(settings)],
      );
      createdUserIds.push(user.id);

      // Query using JSONB operator
      const rows = await sql(
        `SELECT * FROM users WHERE id = $1 AND autonomy_settings->>'maxDailySpend' = '1000'`,
        [user.id],
      );
      expect(rows).toHaveLength(1);

      // Query using JSONB containment
      const rows2 = await sql(
        `SELECT * FROM users WHERE id = $1 AND autonomy_settings @> '{"maxDailySpend":1000}'`,
        [user.id],
      );
      expect(rows2).toHaveLength(1);
    });
  });
});
