/**
 * Real CockroachDB coverage for the inference-receipt ownership boundary.
 *
 * Run via:
 * E2E=true pnpm --filter @skytwin/db exec vitest run src/__tests__/inference-receipt-repository.e2e.test.ts
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  ConfidenceLevel,
  RiskTier,
  SituationType,
  TrustTier,
  sha256Hex,
  signInferenceReceipt,
  type InferenceReceiptExportV1,
} from '@skytwin/shared-types';
import { ExplanationGenerator } from '@skytwin/explanations';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool } from '../connection.js';
import { collectBackup, restoreBackup } from '../backup/backup.js';
import { inferenceReceiptRepository } from '../repositories/inference-receipt-repository.js';
import { executionRepository } from '../repositories/execution-repository.js';
import { executionAdmissionRepository } from '../repositories/execution-admission-repository.js';
import { decisionRepository } from '../repositories/decision-repository.js';
import { explanationRepositoryAdapter } from '../adapters/explanation-repository-adapter.js';
import type { InferenceReceiptCompletionLinkage } from '../repositories/inference-receipt-repository.js';

const E2E = process.env['E2E'] === 'true';
const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let pool: Pool;
const createdUserIds: string[] = [];

interface Graph {
  userId: string;
  decisionId: string;
  explanationId: string;
  explanationCreatedAt: Date;
  outcomeId: string;
  actionId: string | null;
}

async function createGraph(
  label: string,
  continuationKind: 'auto_execute' | 'approval' | 'non_effect' = 'non_effect',
): Promise<Graph> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, trust_tier, autonomy_settings)
     VALUES ($1, $2, 'observer', '{}') RETURNING id`,
    [`receipt-${label}-${randomUUID()}@example.test`, `Receipt ${label}`],
  );
  const userId = user.rows[0]!.id;
  createdUserIds.push(userId);
  const decision = await pool.query<{ id: string }>(
    `INSERT INTO decisions
       (user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata)
     VALUES ($1, 'test', '{}', '{}', 'test', 'normal', '{}') RETURNING id`,
    [userId],
  );
  const decisionId = decision.rows[0]!.id;
  let actionId: string | null = null;
  if (continuationKind !== 'non_effect') {
    const action = await pool.query<{ id: string }>(
      `INSERT INTO candidate_actions
         (decision_id, action_type, description, parameters, predicted_user_preference,
          risk_assessment, reversible, estimated_cost)
       VALUES ($1, 'test_action', 'Test action', '{"domain":"test"}', 'high', $2, true, NULL)
       RETURNING id`,
      [decisionId, JSON.stringify(riskSnapshot('placeholder'))],
    );
    actionId = action.rows[0]!.id;
    await pool.query(
      'UPDATE candidate_actions SET risk_assessment = $1 WHERE id = $2',
      [JSON.stringify(riskSnapshot(actionId)), actionId],
    );
  }
  const outcome = await pool.query<{ id: string }>(
    `INSERT INTO decision_outcomes
       (decision_id, selected_action_id, auto_executed, requires_approval,
        escalation_reason, explanation, confidence)
     VALUES ($1, $2, $3, $4, $5, 'test outcome', 0.9) RETURNING id`,
    [decisionId, actionId, continuationKind === 'auto_execute', continuationKind === 'approval',
      continuationKind === 'approval' ? 'test outcome' : null],
  );
  const explanation = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO explanation_records
       (decision_id, what_happened, evidence_used, preferences_invoked,
        confidence_reasoning, action_rationale, correction_guidance)
     VALUES ($1, 'receipt test', $2, '{}', 'fixture', 'fixture', 'fixture')
     RETURNING id, created_at`,
    [decisionId, JSON.stringify([{
      __adapter_meta: true,
      riskTier: RiskTier.LOW,
      overallConfidence: ConfidenceLevel.HIGH,
      userId,
    }])],
  );
  return {
    userId,
    decisionId,
    explanationId: explanation.rows[0]!.id,
    explanationCreatedAt: explanation.rows[0]!.created_at,
    outcomeId: outcome.rows[0]!.id,
    actionId,
  };
}

function riskSnapshot(actionId: string) {
  return {
    actionId,
    overallTier: RiskTier.LOW,
    dimensions: {
      reversibility: { tier: RiskTier.LOW, score: 0.1, reasoning: 'test' },
      financial_impact: { tier: RiskTier.LOW, score: 0.1, reasoning: 'test' },
      legal_sensitivity: { tier: RiskTier.LOW, score: 0.1, reasoning: 'test' },
      privacy_sensitivity: { tier: RiskTier.LOW, score: 0.1, reasoning: 'test' },
      relationship_sensitivity: { tier: RiskTier.LOW, score: 0.1, reasoning: 'test' },
      operational_risk: { tier: RiskTier.LOW, score: 0.1, reasoning: 'test' },
    },
    reasoning: 'test risk',
    assessedAt: '2026-09-12T00:00:00.000Z',
  };
}

function completionForGraph(
  graph: Graph,
  continuationKind: 'auto_execute' | 'approval' | 'non_effect',
): InferenceReceiptCompletionLinkage {
  const selectedAction = graph.actionId ? {
    id: graph.actionId, decisionId: graph.decisionId, actionType: 'test_action',
    description: 'Test action', domain: 'test', parameters: {}, estimatedCostCents: 0,
    reversible: true, confidence: ConfidenceLevel.HIGH, reasoning: 'test risk',
  } : null;
  const riskAssessment = graph.actionId
    ? { ...riskSnapshot(graph.actionId), assessedAt: new Date('2026-09-12T00:00:00.000Z') }
    : null;
  return {
    decisionId: graph.decisionId,
    explanationId: graph.explanationId,
    continuationKind,
    confirmationLevel: continuationKind === 'approval' ? 'dual' : null,
    continuation: {
      outcome: {
        id: graph.outcomeId, decisionId: graph.decisionId, selectedAction,
        allCandidates: selectedAction ? [selectedAction] : [], riskAssessment,
        allRiskAssessments: riskAssessment ? [riskAssessment] : [],
        autoExecute: continuationKind === 'auto_execute',
        requiresApproval: continuationKind === 'approval',
        reasoning: 'test outcome', decidedAt: new Date('2026-09-12T00:00:00.000Z'),
        policyVerdicts: selectedAction ? {
          [selectedAction.id]: continuationKind === 'auto_execute' ? 'allowed' : 'requires-approval',
        } : {},
      },
      explanation: {
        id: graph.explanationId, decisionId: graph.decisionId, userId: graph.userId,
        summary: 'receipt test', evidenceUsed: [], preferencesInvoked: [],
        confidenceReasoning: 'fixture', actionRationale: 'fixture', correctionGuidance: 'fixture',
        riskTier: RiskTier.LOW, overallConfidence: ConfidenceLevel.HIGH,
        createdAt: graph.explanationCreatedAt,
      },
    },
  };
}

function receiptBundle(graph: Graph): InferenceReceiptExportV1 {
  const request = Buffer.from('request');
  const response = Buffer.from('response');
  return {
    exportVersion: 1,
    receipt: signInferenceReceipt({
      version: 1,
      id: randomUUID(),
      userId: graph.userId,
      decisionId: graph.decisionId,
      explanationId: graph.explanationId,
      reasoningMode: 'on_device',
      provider: 'embedded',
      model: 'local',
      endpointIdentity: 'local',
      requestSha256: sha256Hex(request),
      responseSha256: sha256Hex(response),
      verifierVersion: '1',
      cost: { basis: 'exact', currency: 'USD', amountMinor: 0 },
      status: 'on_device',
      createdAt: '2026-09-12T00:00:00.000Z',
    }, { keyId: 'e2e-recorder', privateKeyPem, publicKeyPem }),
    requestBase64: request.toString('base64'),
    responseBase64: response.toString('base64'),
    disclosure: 'Test fixture bytes.',
  };
}

async function deleteUserGraph(userId: string): Promise<void> {
  const ownedPlans = `SELECT ep.id FROM execution_plans ep
    JOIN decisions d ON d.id = ep.decision_id WHERE d.user_id = $1`;
  const ownedDecisions = 'SELECT id FROM decisions WHERE user_id = $1';
  await pool.query('DELETE FROM execution_admission_barriers WHERE user_id = $1', [userId]);
  await pool.query(`DELETE FROM execution_results WHERE plan_id IN (${ownedPlans})`, [userId]);
  await pool.query(`DELETE FROM execution_events WHERE plan_id IN (${ownedPlans})`, [userId]);
  await pool.query('DELETE FROM approval_requests WHERE user_id = $1', [userId]);
  await pool.query(`DELETE FROM decision_outcomes WHERE decision_id IN (${ownedDecisions})`, [userId]);
  await pool.query(`DELETE FROM execution_plans WHERE decision_id IN (${ownedDecisions})`, [userId]);
  await pool.query(`DELETE FROM candidate_actions WHERE decision_id IN (${ownedDecisions})`, [userId]);
  await pool.query(`DELETE FROM explanation_records WHERE decision_id IN (${ownedDecisions})`, [userId]);
  await pool.query('DELETE FROM decisions WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
}

describe.skipIf(!E2E)('E2E: inference receipt repository', () => {
  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) throw new Error('DATABASE_URL must be set for E2E tests');
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      await deleteUserGraph(userId);
    }
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await closePool();
    await pool.end();
  });

  it('inserts, reads, and deletes only through the exact decision owner', async () => {
    const owner = await createGraph('owner');
    const other = await createGraph('other');
    const bundle = receiptBundle(owner);
    expect(await inferenceReceiptRepository.createManyForUser(other.userId, [{
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], completionForGraph(owner, 'non_effect'))).toBeNull();
    const created = await inferenceReceiptRepository.createManyForUser(owner.userId, [{
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], completionForGraph(owner, 'non_effect'));

    expect(created?.receipts[0]).toMatchObject({
      id: bundle.receipt.id,
      version: 1,
      decision_id: owner.decisionId,
      explanation_id: owner.explanationId,
      trusted: true,
    });
    expect(await inferenceReceiptRepository.findByIdForUser(owner.userId, bundle.receipt.id))
      .toMatchObject({ id: bundle.receipt.id });
    expect(await inferenceReceiptRepository.findByDecisionForUser(owner.userId, owner.decisionId))
      .toMatchObject({ id: bundle.receipt.id });
    expect(await inferenceReceiptRepository.findByIdForUser(other.userId, bundle.receipt.id)).toBeNull();
    expect(await inferenceReceiptRepository.findByDecisionForUser(other.userId, owner.decisionId)).toBeNull();
    expect(await inferenceReceiptRepository.deleteForUser(other.userId, bundle.receipt.id)).toBe(false);
    expect(await inferenceReceiptRepository.deleteByDecisionForUser(other.userId, owner.decisionId)).toBe(false);
    expect(await inferenceReceiptRepository.deleteForUser(owner.userId, bundle.receipt.id)).toBe(true);
    expect(await inferenceReceiptRepository.findByIdForUser(owner.userId, bundle.receipt.id)).toBeNull();
  });

  it('uses the durable explanation UUID returned by the real generator and adapter', async () => {
    const graph = await createGraph('durable-explanation', 'auto_execute');
    const continuation = completionForGraph(graph, 'auto_execute').continuation;
    const decision = {
      id: graph.decisionId,
      situationType: SituationType.GENERIC,
      domain: 'test',
      urgency: 'medium' as const,
      summary: 'Persist the explanation identity',
      rawData: {},
      interpretedAt: new Date(),
    };
    const generated = await new ExplanationGenerator(explanationRepositoryAdapter).generate(
      decision,
      continuation.outcome,
      {
        userId: graph.userId,
        decision,
        trustTier: TrustTier.MODERATE_AUTONOMY,
        relevantPreferences: [],
        timestamp: new Date(),
      },
    );
    expect(generated.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(generated.id).not.toMatch(/^expl_/);

    const persisted = await pool.query<{ id: string }>(
      'SELECT id FROM explanation_records WHERE id = $1 AND decision_id = $2',
      [generated.id, graph.decisionId],
    );
    expect(persisted.rows).toEqual([{ id: generated.id }]);

    const linkedGraph = {
      ...graph,
      explanationId: generated.id,
      explanationCreatedAt: generated.createdAt,
    };
    const linkedCompletion = completionForGraph(linkedGraph, 'auto_execute');
    linkedCompletion.continuation.explanation = generated;
    const bundle = receiptBundle(linkedGraph);
    await expect(inferenceReceiptRepository.createManyForUser(graph.userId, [{
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], linkedCompletion)).resolves.not.toBeNull();
  });

  it('enforces receipt version, status, and exact explanation-decision linkage constraints', async () => {
    const owner = await createGraph('constraints-owner');
    const other = await createGraph('constraints-other');
    const insert = (version: number, status: string, explanationId = owner.explanationId) =>
      pool.query(
        `INSERT INTO inference_receipts
           (id, version, decision_id, explanation_id, status, receipt, trusted)
         VALUES ($1, $2, $3, $4, $5, '{}', false)`,
        [randomUUID(), version, owner.decisionId, explanationId, status],
      );

    await expect(insert(2, 'on_device')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(1, 'unknown')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(1, 'on_device', other.explanationId))
      .rejects.toMatchObject({ code: '23503' });

    await insert(1, 'on_device');
    const secondExplanation = await pool.query<{ id: string }>(
      `INSERT INTO explanation_records
         (decision_id, what_happened, evidence_used, preferences_invoked,
          confidence_reasoning, action_rationale, correction_guidance)
       VALUES ($1, 'second receipt test', '[]', '{}', 'fixture', 'fixture', 'fixture')
       RETURNING id`,
      [owner.decisionId],
    );
    await expect(insert(1, 'on_device', secondExplanation.rows[0]!.id))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('admits exactly one immutable receipt batch under concurrent finalization', async () => {
    const owner = await createGraph('concurrent-completion', 'auto_execute');
    const first = receiptBundle(owner);
    const second = receiptBundle(owner);
    const input = (bundle: InferenceReceiptExportV1) => [{
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }];
    const completion = completionForGraph(owner, 'auto_execute');

    const settled = await Promise.allSettled([
      inferenceReceiptRepository.createManyForUser(owner.userId, input(first), completion),
      inferenceReceiptRepository.createManyForUser(owner.userId, input(second), completion),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rows = await pool.query<{ id: string; version: number }>(
      `SELECT id, version::INT4 AS version
         FROM inference_receipts WHERE decision_id = $1`,
      [owner.decisionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(typeof rows.rows[0]?.version).toBe('number');
    const completions = await pool.query(
      `SELECT 1 FROM inference_receipt_completions WHERE decision_id = $1`,
      [owner.decisionId],
    );
    expect(completions.rows).toHaveLength(1);
    const guards = await pool.query(
      `SELECT 1 FROM decision_ingest_guards WHERE decision_id = $1`,
      [owner.decisionId],
    );
    expect(guards.rows).toHaveLength(1);
  });

  it('fences a distinct outcome update after receipt finalization', async () => {
    const owner = await createGraph('outcome-fence', 'auto_execute');
    const bundle = receiptBundle(owner);
    await inferenceReceiptRepository.createManyForUser(owner.userId, [{
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], completionForGraph(owner, 'auto_execute'));

    await expect(decisionRepository.recordOutcome({
      decisionId: owner.decisionId,
      selectedActionId: null,
      autoExecuted: false,
      requiresApproval: false,
      explanation: 'Conflicting late evaluation',
      confidence: 0,
    })).rejects.toThrow('immutable after receipt finalization');
    const stored = await pool.query<{
      selected_action_id: string | null;
      auto_executed: boolean;
      explanation: string;
    }>('SELECT selected_action_id, auto_executed, explanation FROM decision_outcomes WHERE id = $1', [
      owner.outcomeId,
    ]);
    expect(stored.rows[0]).toMatchObject({
      selected_action_id: owner.actionId,
      auto_executed: true,
      explanation: 'test outcome',
    });
  });

  it('serializes a concurrent outcome upsert against guard finalization', async () => {
    const owner = await createGraph('outcome-race', 'auto_execute');
    const bundle = receiptBundle(owner);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM decisions WHERE id = $1 FOR UPDATE', [owner.decisionId]);

    const capture = inferenceReceiptRepository.createManyForUser(owner.userId, [{
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], completionForGraph(owner, 'auto_execute'));
    const drift = decisionRepository.recordOutcome({
      decisionId: owner.decisionId,
      selectedActionId: null,
      autoExecuted: false,
      requiresApproval: false,
      explanation: 'Concurrent conflicting evaluation',
      confidence: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await blocker.query('COMMIT');
    blocker.release();
    const [captureResult, driftResult] = await Promise.allSettled([capture, drift]);
    const guard = await pool.query<{ outcome_id: string }>(
      'SELECT outcome_id FROM decision_ingest_guards WHERE decision_id = $1',
      [owner.decisionId],
    );
    const stored = await pool.query<{
      id: string;
      selected_action_id: string | null;
      auto_executed: boolean;
      explanation: string;
    }>('SELECT id, selected_action_id, auto_executed, explanation FROM decision_outcomes WHERE decision_id = $1', [
      owner.decisionId,
    ]);

    if (guard.rows[0]) {
      expect(captureResult.status).toBe('fulfilled');
      expect(driftResult.status).toBe('rejected');
      expect(guard.rows[0].outcome_id).toBe(stored.rows[0]!.id);
      expect(stored.rows[0]).toMatchObject({
        selected_action_id: owner.actionId,
        auto_executed: true,
        explanation: 'test outcome',
      });
    } else {
      expect(driftResult.status).toBe('fulfilled');
      expect(captureResult.status).toBe('rejected');
      expect(stored.rows[0]).toMatchObject({
        selected_action_id: null,
        auto_executed: false,
        explanation: 'Concurrent conflicting evaluation',
      });
    }
  });

  it('serializes a concurrent fresh candidate insert against guard finalization', async () => {
    const owner = await createGraph('fresh-candidate-race', 'auto_execute');
    const candidateId = randomUUID();
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM decisions WHERE id = $1 FOR UPDATE', [owner.decisionId]);

    const capture = inferenceReceiptRepository.createManyForUser(owner.userId, [{
      bundle: receiptBundle(owner),
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], completionForGraph(owner, 'auto_execute'));
    const insert = decisionRepository.addCandidateAction({
      id: candidateId,
      decisionId: owner.decisionId,
      actionType: 'late_candidate',
      description: 'Concurrent candidate',
      predictedUserPreference: 'high',
      riskAssessment: { reasoning: 'concurrent placeholder' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await blocker.query('COMMIT');
    blocker.release();
    const [captureResult, insertResult] = await Promise.allSettled([capture, insert]);
    const candidate = await pool.query(
      'SELECT id FROM candidate_actions WHERE id = $1 AND decision_id = $2',
      [candidateId, owner.decisionId],
    );
    const guard = await pool.query(
      'SELECT 1 FROM decision_ingest_guards WHERE decision_id = $1',
      [owner.decisionId],
    );

    expect(captureResult.status).toBe('fulfilled');
    expect(guard.rows).toHaveLength(1);
    if (insertResult.status === 'fulfilled') {
      // The candidate transaction won the shared decision lock and committed
      // before capture. Capture may include a decision with extra alternatives,
      // but no candidate authority changed after its guard was written.
      expect(candidate.rows).toHaveLength(1);
    } else {
      expect(insertResult.reason).toBeInstanceOf(Error);
      expect((insertResult.reason as Error).message).toContain('immutable');
      expect(candidate.rows).toHaveLength(0);
    }
    await expect(decisionRepository.addCandidateAction({
      decisionId: owner.decisionId,
      actionType: 'post_capture_candidate',
      description: 'Must not persist',
      predictedUserPreference: 'high',
      riskAssessment: {},
    })).rejects.toThrow('immutable after receipt finalization');
  });

  it('serializes an existing-id candidate upsert against guard finalization', async () => {
    const owner = await createGraph('existing-candidate-race', 'auto_execute');
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM decisions WHERE id = $1 FOR UPDATE', [owner.decisionId]);

    const capture = inferenceReceiptRepository.createManyForUser(owner.userId, [{
      bundle: receiptBundle(owner),
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], completionForGraph(owner, 'auto_execute'));
    const upsert = decisionRepository.addCandidateAction({
      id: owner.actionId!,
      decisionId: owner.decisionId,
      actionType: 'changed_action',
      description: 'Concurrent changed candidate',
      parameters: { changed: true },
      predictedUserPreference: 'low',
      riskAssessment: riskSnapshot(owner.actionId!),
      reversible: false,
      estimatedCost: 99,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await blocker.query('COMMIT');
    blocker.release();
    const [captureResult, upsertResult] = await Promise.allSettled([capture, upsert]);
    const stored = await pool.query<{
      action_type: string;
      description: string;
      reversible: boolean;
    }>('SELECT action_type, description, reversible FROM candidate_actions WHERE id = $1', [
      owner.actionId,
    ]);
    const guard = await pool.query(
      'SELECT 1 FROM decision_ingest_guards WHERE decision_id = $1',
      [owner.decisionId],
    );

    if (captureResult.status === 'fulfilled') {
      expect(upsertResult.status).toBe('rejected');
      expect(guard.rows).toHaveLength(1);
      expect(stored.rows[0]).toMatchObject({
        action_type: 'test_action', description: 'Test action', reversible: true,
      });
    } else {
      expect(upsertResult.status).toBe('fulfilled');
      expect(guard.rows).toHaveLength(0);
      expect(stored.rows[0]).toMatchObject({
        action_type: 'changed_action',
        description: 'Concurrent changed candidate',
        reversible: false,
      });
    }
  });

  it('serializes a concurrent candidate risk write against guard finalization', async () => {
    const owner = await createGraph('risk-race', 'auto_execute');
    const replacementRisk = riskSnapshot(owner.actionId!);
    replacementRisk.reasoning = 'concurrent replacement risk';
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM decisions WHERE id = $1 FOR UPDATE', [owner.decisionId]);

    const capture = inferenceReceiptRepository.createManyForUser(owner.userId, [{
      bundle: receiptBundle(owner),
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], completionForGraph(owner, 'auto_execute'));
    const riskWrite = decisionRepository.updateCandidateRiskAssessment(
      owner.actionId!,
      replacementRisk,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    await blocker.query('COMMIT');
    blocker.release();
    const [captureResult, riskResult] = await Promise.allSettled([capture, riskWrite]);
    const stored = await pool.query<{ risk_assessment: { reasoning: string } }>(
      'SELECT risk_assessment FROM candidate_actions WHERE id = $1',
      [owner.actionId],
    );
    const guard = await pool.query(
      'SELECT 1 FROM decision_ingest_guards WHERE decision_id = $1',
      [owner.decisionId],
    );

    if (captureResult.status === 'fulfilled') {
      expect(riskResult.status).toBe('rejected');
      expect(guard.rows).toHaveLength(1);
      expect(stored.rows[0]!.risk_assessment.reasoning).toBe('test risk');
    } else {
      expect(riskResult.status).toBe('fulfilled');
      expect(guard.rows).toHaveLength(0);
      expect(stored.rows[0]!.risk_assessment.reasoning).toBe('concurrent replacement risk');
    }
  });

  it('allows only one concurrent ready-to-running execution claim', async () => {
    const owner = await createGraph('concurrent-claim', 'auto_execute');
    const bundle = receiptBundle(owner);
    await inferenceReceiptRepository.createManyForUser(owner.userId, [{
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], completionForGraph(owner, 'auto_execute'));
    const continuation = completionForGraph(owner, 'auto_execute').continuation;

    const claims = await Promise.all([
      inferenceReceiptRepository.claimExecutionForDecision(owner.userId, owner.decisionId, continuation, []),
      inferenceReceiptRepository.claimExecutionForDecision(owner.userId, owner.decisionId, continuation, []),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('durably admits one approved execution and reconciles its exact terminal plan', async () => {
    const owner = await createGraph('approval-admission', 'approval');
    const approval = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests
         (user_id, decision_id, candidate_action, reason, urgency, status, responded_at)
       VALUES ($1, $2, $3::JSONB, 'approved in e2e', 'normal', 'approved', now())
       RETURNING id`,
      [owner.userId, owner.decisionId, JSON.stringify({
        id: owner.actionId, actionType: 'test_action', description: 'Test action',
      })],
    );

    const admitted = await executionAdmissionRepository.admitApprovalExecution({
      userId: owner.userId,
      approvalId: approval.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      steps: [{ type: 'test_action', status: 'pending' }],
    });
    expect(admitted).toMatchObject({ created: true, barrier: { status: 'in_progress' } });
    const duplicate = await executionAdmissionRepository.admitApprovalExecution({
      userId: owner.userId,
      approvalId: approval.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      steps: [],
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.plan.id).toBe(admitted.plan.id);

    const observed = {
      planId: admitted.plan.id,
      adapterPlanId: 'remote-plan',
      adapterUsed: 'direct',
      status: 'completed',
      output: { adapter_used: 'direct' },
      error: null,
    };
    await executionAdmissionRepository.observeTerminal({
      id: admitted.barrier.id,
      userId: owner.userId,
      status: 'completed',
      result: observed,
    });
    await executionRepository.finalizeAdmittedPlan({
      userId: owner.userId,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      planId: admitted.plan.id,
      status: 'completed',
      success: true,
      outputs: { adapter_used: 'direct', adapter_plan_id: 'remote-plan' },
      rollbackAvailable: true,
    });
    await expect(executionAdmissionRepository.observeTerminal({
      id: admitted.barrier.id,
      userId: owner.userId,
      status: 'failed',
      result: { ...observed, status: 'failed' },
    })).rejects.toThrow('conflicts with its observed result');

    const linked = await pool.query<{ execution_plan_id: string }>(
      'SELECT execution_plan_id FROM decision_outcomes WHERE id = $1',
      [owner.outcomeId],
    );
    expect(linked.rows[0]!.execution_plan_id).toBe(admitted.plan.id);
  });

  it('freezes a memory opportunity into a non-replay state before dispatch', async () => {
    const owner = await createGraph('memory-admission', 'auto_execute');
    const opportunity = await pool.query<{ id: string }>(
      `INSERT INTO memory_action_opportunities
         (user_id, fingerprint, suggestion_id, title, reason, suggested_action,
          action_type, action_label, action_plan, novelty, provenance, status, decision_id)
       VALUES ($1, $2, 'suggestion-e2e', 'Memory action', 'Memory reason',
         'Create the task', 'test_action', 'Test action', '{}'::JSONB,
         'resurface', 'user_originated', 'suggested', $3)
       RETURNING id`,
      [owner.userId, `memory-${randomUUID()}`, owner.decisionId],
    );
    const report = {
      opportunityId: opportunity.rows[0]!.id,
      status: 'execution_ambiguous' as const,
      title: 'Memory action', actionType: 'test_action', actionLabel: 'Test action',
      summary: 'Execution admitted', nextStep: 'Reconcile',
      attemptedAt: new Date().toISOString(),
    };

    const admitted = await executionAdmissionRepository.admitMemoryExecution({
      userId: owner.userId,
      opportunityId: opportunity.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      steps: [{ type: 'test_action', status: 'pending' }],
      report,
    });
    const duplicate = await executionAdmissionRepository.admitMemoryExecution({
      userId: owner.userId,
      opportunityId: opportunity.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      steps: [],
      report,
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.plan.id).toBe(admitted.plan.id);

    const frozen = await pool.query<{ status: string; execution_plan_id: string }>(
      `SELECT status, execution_plan_id FROM memory_action_opportunities WHERE id = $1`,
      [opportunity.rows[0]!.id],
    );
    expect(frozen.rows[0]).toEqual({
      status: 'execution_ambiguous',
      execution_plan_id: admitted.plan.id,
    });
  });

  it('terminalizes only the exact owner, decision, selected action, and plan', async () => {
    const owner = await createGraph('terminal-owner', 'auto_execute');
    const other = await createGraph('terminal-other', 'auto_execute');
    const bundle = receiptBundle(owner);
    await inferenceReceiptRepository.createManyForUser(owner.userId, [{
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], completionForGraph(owner, 'auto_execute'));
    const ownerPlan = await inferenceReceiptRepository.claimExecutionForDecision(
      owner.userId, owner.decisionId, completionForGraph(owner, 'auto_execute').continuation, [],
    );
    expect(ownerPlan).not.toBeNull();
    const otherPlan = await executionRepository.createPlan({
      decisionId: other.decisionId, actionId: other.actionId!, status: 'running', steps: [],
    });

    expect(await inferenceReceiptRepository.markExecutionTerminalForDecision(
      owner.userId, owner.decisionId, 'completed', otherPlan.id,
    )).toBe(false);
    expect(await inferenceReceiptRepository.markExecutionTerminalForDecision(
      other.userId, owner.decisionId, 'completed', ownerPlan!.id,
    )).toBe(false);
    expect(await inferenceReceiptRepository.markExecutionTerminalForDecision(
      owner.userId, owner.decisionId, 'completed', ownerPlan!.id,
    )).toBe(false);
    await executionRepository.createResult({
      planId: ownerPlan!.id, success: true, outputs: {}, rollbackAvailable: true,
    });
    expect(await inferenceReceiptRepository.markExecutionTerminalForDecision(
      owner.userId, owner.decisionId, 'completed', ownerPlan!.id,
    )).toBe(false);
    await executionRepository.updatePlanStatus(ownerPlan!.id, 'completed');
    expect(await inferenceReceiptRepository.markExecutionTerminalForDecision(
      owner.userId, owner.decisionId, 'failed', ownerPlan!.id,
    )).toBe(false);
    expect(await inferenceReceiptRepository.markExecutionTerminalForDecision(
      owner.userId, owner.decisionId, 'completed', ownerPlan!.id,
    )).toBe(true);
  });

  it('round-trips a schema-v3 receipt backup with a non-replay restore tombstone', async () => {
    const owner = await createGraph('backup-owner', 'auto_execute');
    const bundle = receiptBundle(owner);
    const created = await inferenceReceiptRepository.createManyForUser(owner.userId, [{
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }], completionForGraph(owner, 'auto_execute'));
    expect(created).not.toBeNull();

    const backup = await collectBackup(owner.userId);
    expect(backup.success).toBe(true);
    if (!backup.success) return;
    expect(backup.data.schemaVersion).toBe(3);
    expect(backup.data.decisions).toHaveLength(1);
    expect(backup.data.decisions[0]?.inferenceReceipts).toHaveLength(1);
    expect(backup.data.decisions[0]?.inferenceReceipts?.[0]).toMatchObject({
      id: bundle.receipt.id,
      version: 1,
      trusted: true,
      receipt: bundle.receipt,
    });
    expect(typeof backup.data.decisions[0]?.inferenceReceipts?.[0]?.version).toBe('number');
    expect(backup.data.decisions[0]?.ingestState).toMatchObject({
      receiptCaptureComplete: true,
      receiptExplanationId: owner.explanationId,
      continuationKind: 'auto_execute',
      effectState: 'ready',
    });

    await deleteUserGraph(owner.userId);

    const restored = await restoreBackup(backup.data);
    expect(restored).toMatchObject({ success: true });
    const stored = await pool.query<{
      version: number;
      trusted: boolean;
      receipt: unknown;
    }>(
      `SELECT version::INT4 AS version, trusted, receipt
         FROM inference_receipts WHERE id = $1`,
      [bundle.receipt.id],
    );
    expect(stored.rows).toEqual([{
      version: 1,
      trusted: false,
      receipt: bundle.receipt,
    }]);
    expect(typeof stored.rows[0]?.version).toBe('number');
    await expect(inferenceReceiptRepository.getContinuationForDecision(owner.userId, owner.decisionId))
      .resolves.toMatchObject({
        effectState: 'restored_non_replay',
        sourceEffectState: 'ready',
        sourceExecutionStatus: null,
      });
    await expect(inferenceReceiptRepository.claimExecutionForDecision(
      owner.userId,
      owner.decisionId,
      completionForGraph(owner, 'auto_execute').continuation,
      [],
    )).resolves.toBeNull();
  });
});
