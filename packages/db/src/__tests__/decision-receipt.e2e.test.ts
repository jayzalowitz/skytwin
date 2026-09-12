/**
 * Real CockroachDB proof for migration 081. Run with E2E=true and DATABASE_URL.
 * The default unit suite truthfully skips this file when no live DB is selected.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  type DecisionReceiptArtifactKind,
  type JoinedDecisionReceiptContentV1,
  type JoinedDecisionReceiptContentV2,
} from '@skytwin/shared-types';
import { closePool } from '../connection.js';
import { decisionReceiptRepository } from '../repositories/decision-receipt-repository.js';

const E2E = process.env['E2E'] === 'true';
let pool: Pool;
const users: string[] = [];
const eventKey = (kind: string) => buildDecisionReceiptEventKey(kind, randomUUID());

function artifact(kind: DecisionReceiptArtifactKind, row: Record<string, unknown>): string {
  const copy = { ...row };
  delete copy['created_at'];
  delete copy['updated_at'];
  delete copy['completed_at'];
  delete copy['requested_at'];
  delete copy['responded_at'];
  return joinedDecisionReceiptArtifactDigest(kind, copy);
}

async function createUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, name, trust_tier, autonomy_settings)
     VALUES ($1, $2, 'Receipt E2E', 'observer', '{}')`,
    [id, `receipt-${id}@test.local`],
  );
  users.push(id);
  return id;
}

async function createDecision(userId: string): Promise<Record<string, unknown>> {
  return (await pool.query<Record<string, unknown>>(
    `INSERT INTO decisions
       (user_id, situation_type, raw_event, interpreted_situation, domain)
     VALUES ($1, 'receipt_e2e', '{}', '{}', 'test') RETURNING *`,
    [userId],
  )).rows[0]!;
}

async function createAction(decisionId: string): Promise<Record<string, unknown>> {
  return (await pool.query<Record<string, unknown>>(
    `INSERT INTO candidate_actions
       (decision_id, action_type, description, predicted_user_preference, risk_assessment)
     VALUES ($1, 'test', 'test action', 'neutral', '{}') RETURNING *`,
    [decisionId],
  )).rows[0]!;
}

async function policyContentFor(
  userId: string,
  decision: Record<string, unknown>,
  actionInput?: Record<string, unknown>,
): Promise<JoinedDecisionReceiptContentV1> {
  const action = actionInput ?? await createAction(String(decision['id']));
  const explanation = (await pool.query<Record<string, unknown>>(
    `INSERT INTO explanation_records
       (decision_id, what_happened, evidence_used, preferences_invoked,
        confidence_reasoning, action_rationale, correction_guidance)
     VALUES ($1, 'policy checked', '[]', '{}', 'typed', 'allowed', 'review') RETURNING *`,
    [decision['id']],
  )).rows[0]!;
  const policySnapshot = { allowed: true, requiresApproval: false, policyIds: [] };
  const barrier = (await pool.query<Record<string, unknown>>(
    `INSERT INTO pre_effect_barriers
       (user_id, effect_type, idempotency_key, status, decision_id, action_id,
        explanation_id, policy_snapshot)
     VALUES ($1, 'event_execution', $2, 'prepared', $3, $4, $5, $6) RETURNING *`,
    [userId, randomUUID(), decision['id'], action['id'], explanation['id'], policySnapshot],
  )).rows[0]!;
  const candidateAction = {
    id: String(action['id']), canonicalHash: artifact('candidate_action', action),
  };
  const risk = {
    candidateActionId: String(action['id']),
    canonicalHash: joinedDecisionReceiptArtifactDigest('risk', action['risk_assessment']),
  };
  const policy = {
    barrierId: String(barrier['id']), policyIds: [],
    canonicalHash: joinedDecisionReceiptArtifactDigest('policy', policySnapshot),
  };
  const barrierSnapshot = {
    version: 1 as const, status: 'prepared' as const, effectType: 'event_execution' as const,
    decisionId: String(decision['id']), candidateActionId: String(action['id']),
    explanationId: String(explanation['id']), policyHash: policy.canonicalHash,
    createdAt: (barrier['created_at'] as Date).toISOString(),
    updatedAt: (barrier['updated_at'] as Date).toISOString(),
  };
  const barrierRef = {
    id: String(barrier['id']), snapshot: barrierSnapshot,
    canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', barrierSnapshot),
  };
  const explanationRef = {
    id: String(explanation['id']), canonicalHash: artifact('explanation', explanation),
  };
  return {
    ...contentFor(decision), stage: 'policy_evaluated', disposition: 'allowed',
    policyEvaluations: [{
      version: 1, phase: 'pre_effect', disposition: 'allowed', candidateAction, risk,
      policy, barrier: barrierRef, explanation: explanationRef, evidence: [],
    }],
    candidateAction, risk, policy, barrier: barrierRef, explanation: explanationRef,
  };
}

function contentFor(decision: Record<string, unknown>): JoinedDecisionReceiptContentV1 {
  return {
    version: 1,
    stage: 'decision_recorded',
    disposition: 'pending',
    decision: { id: String(decision['id']), canonicalHash: artifact('decision', decision) },
    policyEvaluations: [],
    evidence: [],
    inference: { receipts: [] },
    feedbackEvents: [],
    corrections: [],
  };
}

async function createAdmittedChain(userId: string, decision: Record<string, unknown>) {
  const decisionContent = contentFor(decision);
  const r1 = await decisionReceiptRepository.appendForUser(userId, {
    eventKey: eventKey('decision_created'), expectedPreviousDigest: null, content: decisionContent,
  });
  if (!r1.success) throw new Error('failed to append decision receipt');
  const policyContent = await policyContentFor(userId, decision);
  const r2 = await decisionReceiptRepository.appendForUser(userId, {
    eventKey: eventKey('policy_evaluated'),
    expectedPreviousDigest: r1.revision.revision_digest,
    content: policyContent,
  });
  if (!r2.success) throw new Error('failed to append policy receipt');
  const plan = (await pool.query<Record<string, unknown>>(
    `INSERT INTO execution_plans (decision_id, action_id, status, steps)
     VALUES ($1, $2, 'pending', '[]') RETURNING *`,
    [decision['id'], policyContent.candidateAction!.id],
  )).rows[0]!;
  const planSnapshot = {
    version: 1 as const,
    status: 'pending' as const,
    decisionId: String(decision['id']),
    candidateActionId: policyContent.candidateAction!.id,
    createdAt: (plan['created_at'] as Date).toISOString(),
    updatedAt: (plan['updated_at'] as Date).toISOString(),
  };
  const admitted: JoinedDecisionReceiptContentV1 = {
    ...policyContent,
    stage: 'execution_admitted',
    disposition: 'pending',
    executionPlan: {
      id: String(plan['id']),
      snapshot: planSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', planSnapshot),
    },
  };
  const r3 = await decisionReceiptRepository.appendForUser(userId, {
    eventKey: eventKey('execution_admitted'),
    expectedPreviousDigest: r2.revision.revision_digest,
    content: admitted,
  });
  if (!r3.success) throw new Error('failed to append admission receipt');
  return { admitted, plan, previousDigest: r3.revision.revision_digest };
}

async function terminalContentFor(
  admitted: JoinedDecisionReceiptContentV1,
  plan: Record<string, unknown>,
  outcome: 'succeeded' | 'failed' | 'unknown',
): Promise<JoinedDecisionReceiptContentV2> {
  const barrier = (await pool.query<Record<string, unknown>>(
    `UPDATE pre_effect_barriers SET status = $2, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [admitted.barrier!.id, outcome],
  )).rows[0]!;
  const planStatus: 'completed' | 'failed' = outcome === 'succeeded' ? 'completed' : 'failed';
  const terminalPlan = (await pool.query<Record<string, unknown>>(
    `UPDATE execution_plans SET status = $2, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [plan['id'], planStatus],
  )).rows[0]!;
  const result = (await pool.query<Record<string, unknown>>(
    `INSERT INTO execution_results (plan_id, success, outputs, error, rollback_available)
     VALUES ($1, $2, '{}', $3, false) RETURNING *`,
    [plan['id'], outcome === 'succeeded', outcome === 'succeeded' ? null : outcome],
  )).rows[0]!;
  const executionExplanation = (await pool.query<Record<string, unknown>>(
    `INSERT INTO explanation_records
       (decision_id, what_happened, evidence_used, preferences_invoked,
        confidence_reasoning, action_rationale, escalation_rationale, correction_guidance)
     VALUES ($1, $2, '[]', '{}', 'provider result', 'approved execution', $3, 'review result')
     RETURNING *`,
    [admitted.decision.id, `execution ${outcome}`, outcome === 'succeeded' ? null : outcome],
  )).rows[0]!;
  const barrierSnapshot = {
    version: 1 as const,
    status: outcome,
    effectType: barrier['effect_type'] as 'event_execution',
    decisionId: String(barrier['decision_id']),
    candidateActionId: String(barrier['action_id']),
    explanationId: String(barrier['explanation_id']),
    policyHash: joinedDecisionReceiptArtifactDigest('policy', barrier['policy_snapshot']),
    createdAt: (barrier['created_at'] as Date).toISOString(),
    updatedAt: (barrier['updated_at'] as Date).toISOString(),
  };
  const planSnapshot = {
    version: 1 as const,
    status: planStatus,
    decisionId: String(terminalPlan['decision_id']),
    candidateActionId: String(terminalPlan['action_id']),
    createdAt: (terminalPlan['created_at'] as Date).toISOString(),
    updatedAt: (terminalPlan['updated_at'] as Date).toISOString(),
  };
  const resultSnapshot = {
    version: 1 as const,
    planId: String(plan['id']),
    success: outcome === 'succeeded',
    outcome,
    rollbackAvailable: false,
    completedAt: (result['completed_at'] as Date).toISOString(),
  };
  return {
    ...admitted,
    version: 2,
    stage: 'execution_recorded',
    disposition: outcome,
    barrier: {
      id: String(barrier['id']), snapshot: barrierSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', barrierSnapshot),
    },
    executionPlan: {
      id: String(plan['id']), snapshot: planSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', planSnapshot),
    },
    executionResult: {
      id: String(result['id']), snapshot: resultSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('execution_result', resultSnapshot),
    },
    executionDisposition: outcome,
    executionExplanation: {
      id: String(executionExplanation['id']),
      canonicalHash: artifact('explanation', executionExplanation),
    },
  };
}

describe.skipIf(!E2E)('E2E: joined decision receipt identity and CAS', () => {
  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) throw new Error('DATABASE_URL must be set when E2E=true');
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
  });

  afterEach(async () => {
    for (const userId of users) {
      await pool.query(
        `DELETE FROM decision_receipt_revisions WHERE receipt_id IN
           (SELECT id FROM decision_receipts WHERE user_id = $1)`, [userId],
      );
      await pool.query('DELETE FROM decision_receipts WHERE user_id = $1', [userId]);
      await pool.query(
        `DELETE FROM execution_events WHERE plan_id IN
           (SELECT plan.id FROM execution_plans plan
             JOIN decisions decision ON decision.id = plan.decision_id
            WHERE decision.user_id = $1)`, [userId],
      );
      await pool.query(
        `DELETE FROM execution_results WHERE plan_id IN
           (SELECT plan.id FROM execution_plans plan
             JOIN decisions decision ON decision.id = plan.decision_id
            WHERE decision.user_id = $1)`, [userId],
      );
      await pool.query(
        `DELETE FROM execution_plans WHERE decision_id IN
           (SELECT id FROM decisions WHERE user_id = $1)`, [userId],
      );
      await pool.query(
        `DELETE FROM inference_receipt_completions WHERE decision_id IN
           (SELECT id FROM decisions WHERE user_id = $1)`, [userId],
      );
      await pool.query(
        `DELETE FROM pre_effect_barriers WHERE decision_id IN
           (SELECT id FROM decisions WHERE user_id = $1)`, [userId],
      );
      await pool.query(
        `DELETE FROM explanation_records WHERE decision_id IN
           (SELECT id FROM decisions WHERE user_id = $1)`, [userId],
      );
      await pool.query(
        `DELETE FROM candidate_actions WHERE decision_id IN
           (SELECT id FROM decisions WHERE user_id = $1)`, [userId],
      );
      await pool.query('DELETE FROM decisions WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    users.length = 0;
  });

  afterAll(async () => {
    await pool.end();
    await closePool();
  });

  it('persists exact links, replays one event, and rejects stale CAS writers', async () => {
    const owner = await createUser();
    const decision = await createDecision(owner);
    const content = contentFor(decision);
    const firstEventKey = eventKey('decision_created');
    const first = await decisionReceiptRepository.appendForUser(owner, {
      eventKey: firstEventKey, expectedPreviousDigest: null, content,
    });
    expect(first).toMatchObject({ success: true, created: true, revision: { sequence: 1 } });
    if (!first.success) throw new Error('first receipt append failed');

    const replay = await decisionReceiptRepository.appendForUser(owner, {
      eventKey: firstEventKey, expectedPreviousDigest: null, content,
    });
    expect(replay).toMatchObject({ success: true, created: false, revision: { id: first.revision.id } });

    const conflictingContent = {
      ...content,
      decision: { ...content.decision, canonicalHash: 'f'.repeat(64) },
    };
    await expect(decisionReceiptRepository.appendForUser(owner, {
      eventKey: firstEventKey, expectedPreviousDigest: null, content: conflictingContent,
    })).resolves.toEqual({ success: false, code: 'idempotency_conflict' });

    const nextContent = await policyContentFor(owner, decision);
    const results = await Promise.all([
      decisionReceiptRepository.appendForUser(owner, {
        eventKey: eventKey('cas_a'), expectedPreviousDigest: first.revision.revision_digest, content: nextContent,
      }),
      decisionReceiptRepository.appendForUser(owner, {
        eventKey: eventKey('cas_b'), expectedPreviousDigest: first.revision.revision_digest, content: nextContent,
      }),
    ]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toEqual([
      { success: false, code: 'chain_conflict' },
    ]);
    const rows = await pool.query(
      'SELECT sequence, previous_digest FROM decision_receipt_revisions WHERE receipt_id = $1 ORDER BY sequence',
      [first.receipt.id],
    );
    expect(rows.rows).toHaveLength(2);
    const read = await decisionReceiptRepository.findByDecisionForUser(owner, String(decision['id']));
    expect(read && read.success && read.revisions.map((revision) => revision.sequence)).toEqual([1, 2]);
    expect(rows.rows[1]).toMatchObject({ previous_digest: first.revision.revision_digest });
  });

  it('rejects same-user cross-decision and cross-user candidate links before root insert', async () => {
    const owner = await createUser();
    const peer = await createUser();
    const decision = await createDecision(owner);
    const sameUserOther = await createDecision(owner);
    const peerDecision = await createDecision(peer);
    const sameUserAction = await createAction(String(sameUserOther['id']));
    const peerAction = await createAction(String(peerDecision['id']));

    for (const [label, action] of [['same-user-cross-decision', sameUserAction], ['cross-user', peerAction]] as const) {
      const content = await policyContentFor(owner, decision, action);
      await expect(decisionReceiptRepository.appendForUser(owner, {
        eventKey: eventKey(label.replaceAll('-', '_')), expectedPreviousDigest: null, content,
      })).resolves.toEqual({ success: false, code: 'linkage_mismatch' });
    }
    const roots = await pool.query('SELECT id FROM decision_receipts WHERE decision_id = $1', [decision['id']]);
    expect(roots.rows).toHaveLength(0);
  });

  it('rejects a false decision hash and a stale missing completion before insert', async () => {
    const owner = await createUser();
    const falseHashDecision = await createDecision(owner);
    const falseContent = contentFor(falseHashDecision);
    falseContent.decision = { ...falseContent.decision, canonicalHash: 'f'.repeat(64) };
    await expect(decisionReceiptRepository.appendForUser(owner, {
      eventKey: eventKey('false_hash'), expectedPreviousDigest: null, content: falseContent,
    })).resolves.toEqual({ success: false, code: 'linkage_mismatch' });

    const completedDecision = await createDecision(owner);
    const explanation = (await pool.query<{ id: string }>(
      `INSERT INTO explanation_records
         (decision_id, what_happened, evidence_used, preferences_invoked,
          confidence_reasoning, action_rationale, correction_guidance)
       VALUES ($1, 'test', '[]', '{}', 'test', 'test', 'test') RETURNING id`,
      [completedDecision['id']],
    )).rows[0]!;
    await pool.query(
      'INSERT INTO inference_receipt_completions (decision_id, explanation_id) VALUES ($1, $2)',
      [completedDecision['id'], explanation.id],
    );
    await expect(decisionReceiptRepository.appendForUser(owner, {
      eventKey: eventKey('stale_completion'), expectedPreviousDigest: null,
      content: contentFor(completedDecision),
    })).resolves.toEqual({ success: false, code: 'linkage_mismatch' });

    const roots = await pool.query(
      'SELECT id FROM decision_receipts WHERE decision_id IN ($1, $2)',
      [falseHashDecision['id'], completedDecision['id']],
    );
    expect(roots.rows).toHaveLength(0);
  });

  it.each(['succeeded', 'failed', 'unknown'] as const)(
    'persists an owned terminal explanation in a v2 %s receipt without overloading explanation_id',
    async (outcome) => {
      const owner = await createUser();
      const decision = await createDecision(owner);
      const { admitted, plan, previousDigest } = await createAdmittedChain(owner, decision);
      const terminal = await terminalContentFor(admitted, plan, outcome);
      const result = await decisionReceiptRepository.appendForUser(owner, {
        eventKey: eventKey(`execution_${outcome}`),
        expectedPreviousDigest: previousDigest,
        content: terminal,
      });
      expect(result).toMatchObject({ success: true, created: true, revision: { sequence: 4 } });
      if (!result.success) return;
      const stored = await pool.query<{
        explanation_id: string;
        content: JoinedDecisionReceiptContentV2;
      }>(
        'SELECT explanation_id, content FROM decision_receipt_revisions WHERE id = $1',
        [result.revision.id],
      );
      expect(stored.rows[0]?.explanation_id).toBe(admitted.explanation!.id);
      expect(stored.rows[0]?.content.executionExplanation).toEqual(terminal.executionExplanation);
    },
  );

  it('rejects a terminal explanation from a different owned decision', async () => {
    const owner = await createUser();
    const decision = await createDecision(owner);
    const otherDecision = await createDecision(owner);
    const { admitted, plan, previousDigest } = await createAdmittedChain(owner, decision);
    const terminal = await terminalContentFor(admitted, plan, 'failed');
    const otherExplanation = (await pool.query<Record<string, unknown>>(
      `INSERT INTO explanation_records
         (decision_id, what_happened, evidence_used, preferences_invoked,
          confidence_reasoning, action_rationale, correction_guidance)
       VALUES ($1, 'other decision', '[]', '{}', 'test', 'test', 'test') RETURNING *`,
      [otherDecision['id']],
    )).rows[0]!;
    terminal.executionExplanation = {
      id: String(otherExplanation['id']),
      canonicalHash: artifact('explanation', otherExplanation),
    };
    await expect(decisionReceiptRepository.appendForUser(owner, {
      eventKey: eventKey('cross_decision_terminal_explanation'),
      expectedPreviousDigest: previousDigest,
      content: terminal,
    })).resolves.toEqual({ success: false, code: 'linkage_mismatch' });
  });
});
