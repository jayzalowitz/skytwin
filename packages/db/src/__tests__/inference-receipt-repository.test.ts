import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfidenceLevel,
  RiskTier,
  sha256Hex,
  signInferenceReceipt,
  type InferenceReceiptExportV1,
} from '@skytwin/shared-types';
import type { InferenceReceiptCompletionLinkage } from '../repositories/inference-receipt-repository.js';

const mockQuery = vi.fn();
const mockTransactionQuery = vi.fn();
const mockWithTransaction = vi.fn(
  (fn: (client: { query: typeof mockTransactionQuery }) => Promise<unknown>) =>
    fn({ query: mockTransactionQuery }),
);
vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (fn: (client: { query: typeof mockTransactionQuery }) => Promise<unknown>) =>
    mockWithTransaction(fn),
}));
const { inferenceReceiptRepository } = await import('../repositories/inference-receipt-repository.js');

const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function fixture(): InferenceReceiptExportV1 {
  const request = Buffer.from('request');
  const response = Buffer.from('response');
  return {
    exportVersion: 1,
    receipt: signInferenceReceipt({
      version: 1, id: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      decisionId: '33333333-3333-4333-8333-333333333333',
      explanationId: '44444444-4444-4444-8444-444444444444',
      reasoningMode: 'conventional_cloud', provider: 'provider', model: 'model',
      endpointIdentity: 'https://provider.example', requestSha256: sha256Hex(request),
      responseSha256: sha256Hex(response), verifierVersion: '1', cost: { basis: 'unknown' },
      status: 'conventional', createdAt: '2026-09-10T00:00:00.000Z',
    }, { keyId: 'recorder', privateKeyPem, publicKeyPem }),
    requestBase64: request.toString('base64'), responseBase64: response.toString('base64'),
    disclosure: 'Exact request and response bytes are included for independent verification.',
  };
}

function completionFor(
  bundle: InferenceReceiptExportV1,
  continuationKind: 'auto_execute' | 'approval' | 'non_effect' = 'non_effect',
): InferenceReceiptCompletionLinkage {
  const selectedAction = continuationKind === 'non_effect' ? null : {
    id: '55555555-5555-4555-8555-555555555555',
    decisionId: bundle.receipt.decisionId,
    actionType: 'test_action',
    description: 'Test action',
    domain: 'test',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'test risk',
  };
  const riskAssessment = selectedAction ? {
    actionId: selectedAction.id,
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
    assessedAt: new Date('2026-09-10T00:00:00.000Z'),
  } : null;
  return {
    decisionId: bundle.receipt.decisionId,
    explanationId: bundle.receipt.explanationId,
    continuationKind,
    confirmationLevel: continuationKind === 'approval' ? 'dual' : null,
    continuation: {
      outcome: {
        id: '66666666-6666-4666-8666-666666666666',
        decisionId: bundle.receipt.decisionId,
        selectedAction,
        allCandidates: selectedAction ? [selectedAction] : [],
        riskAssessment,
        allRiskAssessments: riskAssessment ? [riskAssessment] : [],
        autoExecute: continuationKind === 'auto_execute',
        requiresApproval: continuationKind === 'approval',
        reasoning: 'test outcome',
        decidedAt: new Date('2026-09-10T00:00:00.000Z'),
      },
      explanation: {
        id: bundle.receipt.explanationId,
        decisionId: bundle.receipt.decisionId,
        userId: bundle.receipt.userId,
        summary: 'test explanation',
        evidenceUsed: [],
        preferencesInvoked: [],
        confidenceReasoning: 'test',
        actionRationale: 'test',
        correctionGuidance: 'test',
        riskTier: RiskTier.LOW,
        overallConfidence: ConfidenceLevel.HIGH,
        createdAt: new Date('2026-09-10T00:00:00.000Z'),
      },
    },
  };
}

function authorityFor(completion: InferenceReceiptCompletionLinkage) {
  return {
    id: completion.decisionId,
    outcome_id: completion.continuation.outcome.id,
    selected_action_id: completion.continuation.outcome.selectedAction?.id ?? null,
    auto_executed: completion.continuation.outcome.autoExecute,
    requires_approval: completion.continuation.outcome.requiresApproval,
    explanation: completion.continuation.outcome.reasoning,
    explanation_id: completion.explanationId,
    what_happened: completion.continuation.explanation.summary,
  };
}

describe('inferenceReceiptRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockTransactionQuery.mockReset();
  });

  it('rejects an untrusted self-signed receipt before querying the database', async () => {
    const bundle = fixture();
    const result = await inferenceReceiptRepository.createManyForUser(bundle.receipt.userId, [{
      bundle, trustedRecorderKeys: new Map(),
    }], completionFor(bundle));
    expect(result).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('cannot persist verified status without provider trust and an attestation verifier', async () => {
    const value = fixture();
    const response = Buffer.from('response');
    const evidence = Buffer.from('evidence');
    const { seal: _seal, ...base } = value.receipt;
    value.evidenceBase64 = evidence.toString('base64');
    value.receipt = signInferenceReceipt({
      ...base, reasoningMode: 'verified_confidential', status: 'verified',
      evidenceSha256: sha256Hex(evidence), attestationPolicyVersion: 'policy-1',
      measurementIdentity: 'measurement-1', verifiedAt: '2026-09-10T00:00:00.000Z',
      freshUntil: '2026-09-11T00:00:00.000Z',
      responseSignature: { algorithm: 'Ed25519', keyId: 'provider', publicKeyPem,
        signatureBase64: sign(null, response, keys.privateKey).toString('base64') },
    }, { keyId: 'recorder', privateKeyPem, publicKeyPem });
    expect(await inferenceReceiptRepository.createManyForUser(value.receipt.userId, [{
      bundle: value, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    }], completionFor(value))).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('derives batch ownership from the locked decision and explanation', async () => {
    const bundle = fixture();
    const completion = completionFor(bundle);
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [authorityFor(completion)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: bundle.receipt.id }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ decision_id: bundle.receipt.decisionId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ continuation_snapshot: completion.continuation }], rowCount: 1 });
    await inferenceReceiptRepository.createManyForUser(bundle.receipt.userId, [{
      bundle, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    }], completion);
    const [sql, args] = mockTransactionQuery.mock.calls[2]!;
    expect(sql).toContain('JOIN explanation_records er ON er.decision_id = d.id');
    expect(sql).toContain('WHERE d.user_id = $1');
    expect(sql).toContain('$7::JSONB, true');
    expect(sql).toContain('version::INT4 AS version');
    expect(args[0]).toBe(bundle.receipt.userId);
    expect(args[7]).toBe(bundle.receipt.userId);
  });

  it('rejects the batch when the locked linkage is not owned', async () => {
    mockTransactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const bundle = fixture();
    await expect(inferenceReceiptRepository.createManyForUser(bundle.receipt.userId, [{
      bundle, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    }], completionFor(bundle))).rejects.toThrow(/authority/);
  });

  it('validates every bundle before opening the atomic batch transaction', async () => {
    const trusted = fixture();
    const untrusted = fixture();
    const { seal: _seal, ...unsigned } = untrusted.receipt;
    const attacker = generateKeyPairSync('ed25519');
    untrusted.receipt = signInferenceReceipt(unsigned, {
      keyId: 'attacker',
      privateKeyPem: attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKeyPem: attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    expect(await inferenceReceiptRepository.createManyForUser(trusted.receipt.userId, [
      { bundle: trusted, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]) },
      { bundle: untrusted, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]) },
    ], completionFor(trusted))).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockTransactionQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['userId', 'another-user', undefined, undefined],
    ['decisionId', undefined, '55555555-5555-4555-8555-555555555555', undefined],
    ['explanationId', undefined, undefined, '66666666-6666-4666-8666-666666666666'],
  ] as const)('rejects a bundle with mismatched %s before opening a transaction', async (
    _field,
    userId,
    decisionId,
    explanationId,
  ) => {
    const bundle = fixture();
    const { seal: _seal, ...unsigned } = bundle.receipt;
    bundle.receipt = signInferenceReceipt({
      ...unsigned,
      userId: userId ?? unsigned.userId,
      decisionId: decisionId ?? unsigned.decisionId,
      explanationId: explanationId ?? unsigned.explanationId,
    }, { keyId: 'recorder', privateKeyPem, publicKeyPem });

    expect(await inferenceReceiptRepository.createManyForUser(
      unsigned.userId,
      [{ bundle, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]) }],
      {
        decisionId: unsigned.decisionId,
        explanationId: unsigned.explanationId,
        continuationKind: 'non_effect',
        confirmationLevel: null,
        continuation: completionFor(fixture()).continuation,
      },
    )).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockTransactionQuery).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('fails the transaction when any receipt cannot link to the owned explanation', async () => {
    const first = fixture();
    const completion = completionFor(first);
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [authorityFor(completion)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'first' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const second = fixture();
    const { seal: _seal, ...unsigned } = second.receipt;
    second.receipt = signInferenceReceipt({
      ...unsigned, id: '55555555-5555-4555-8555-555555555555',
    }, { keyId: 'recorder', privateKeyPem, publicKeyPem });
    await expect(inferenceReceiptRepository.createManyForUser(first.receipt.userId, [first, second].map((bundle) => ({
      bundle, trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    })), completion)).rejects.toThrow(/linkage/);
  });

  it('writes a completion marker in the same transaction even when no call completed', async () => {
    const bundle = fixture();
    const completion = completionFor(bundle);
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [authorityFor(completion)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ decision_id: 'decision' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ continuation_snapshot: completion.continuation }], rowCount: 1 });
    const result = await inferenceReceiptRepository.createManyForUser(bundle.receipt.userId, [], completion);
    expect(result?.receipts).toEqual([]);
    expect(mockTransactionQuery).toHaveBeenCalledTimes(4);
    expect(mockTransactionQuery.mock.calls[0]![0]).toContain('FOR UPDATE OF d');
    expect(mockTransactionQuery.mock.calls[2]![0]).toContain('inference_receipt_completions');
    expect(mockTransactionQuery.mock.calls[3]![0]).toContain('decision_ingest_guards');
    expect(mockTransactionQuery.mock.calls[3]![1].slice(-3)).toEqual(['non_effect', null, 'non_effect']);
  });

  it('rejects a second capture after serializing on an existing completion', async () => {
    const bundle = fixture();
    const completion = completionFor(bundle);
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [authorityFor(completion)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ explanation_id: 'explanation' }], rowCount: 1 });

    await expect(inferenceReceiptRepository.createManyForUser(
      bundle.receipt.userId, [], completion,
    )).rejects.toThrow(/already finalized/);

    expect(mockTransactionQuery).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['selected action', { selected_action_id: '77777777-7777-4777-8777-777777777777' }],
    ['auto-execute flag', { auto_executed: false }],
    ['explanation id', { explanation_id: '88888888-8888-4888-8888-888888888888' }],
    ['explanation summary', { what_happened: 'a different explanation' }],
  ] as const)('rejects a continuation when a concurrent evaluation changes the persisted %s', async (
    _field,
    drift,
  ) => {
    const bundle = fixture();
    const completion = completionFor(bundle, 'auto_execute');
    mockTransactionQuery.mockResolvedValueOnce({
      rows: [{
        ...authorityFor(completion),
        ...drift,
      }],
      rowCount: 1,
    });

    await expect(inferenceReceiptRepository.createManyForUser(bundle.receipt.userId, [{
      bundle,
      trustedRecorderKeys: new Map([['recorder', publicKeyPem]]),
    }], completion)).rejects.toThrow(/persisted authority/);
    expect(mockTransactionQuery).toHaveBeenCalledTimes(1);
    expect(mockTransactionQuery.mock.calls[0]![0]).toContain('FOR UPDATE OF d, o, er');
  });

  it('persists the batch snapshot that passed trust verification', async () => {
    const bundle = fixture();
    const completion = completionFor(bundle);
    const persistedContinuation = JSON.parse(JSON.stringify(completion.continuation));
    const hostileTrustMap = { get: () => {
      bundle.receipt.model = 'changed-during-trust-lookup';
      completion.continuationKind = 'auto_execute';
      completion.confirmationLevel = null;
      completion.continuation.outcome.reasoning = 'changed-during-trust-lookup';
      return publicKeyPem;
    } } as unknown as ReadonlyMap<string, string>;
    mockTransactionQuery
      .mockResolvedValueOnce({ rows: [authorityFor(completion)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: bundle.receipt.id }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ decision_id: bundle.receipt.decisionId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ continuation_snapshot: persistedContinuation }], rowCount: 1 });

    await inferenceReceiptRepository.createManyForUser(bundle.receipt.userId, [{
      bundle,
      trustedRecorderKeys: hostileTrustMap,
    }], completion);

    const receiptInsertArgs = mockTransactionQuery.mock.calls[2]![1] as unknown[];
    expect(JSON.parse(receiptInsertArgs[6] as string)).toMatchObject({ model: 'model' });
    expect(bundle.receipt.model).toBe('changed-during-trust-lookup');
    expect(mockTransactionQuery.mock.calls[4]![1].slice(-3)).toEqual(['non_effect', null, 'non_effect']);
    expect(JSON.parse(mockTransactionQuery.mock.calls[4]![1][6])).toMatchObject({
      outcome: { reasoning: 'test outcome' },
    });
  });

  it('reads the owner-scoped guard and claims ready execution only once', async () => {
    const completion = completionFor(fixture(), 'auto_execute');
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        receipt_capture_complete: true,
        receipt_explanation_id: completion.explanationId,
        continuation_kind: 'auto_execute',
        confirmation_level: null,
        effect_state: 'ready',
        source_effect_state: null,
        source_execution_status: null,
        source_execution_plan_id: null,
        outcome_id: completion.continuation.outcome.id,
        selected_action_id: completion.continuation.outcome.selectedAction!.id,
        outcome_auto_execute: true,
        outcome_requires_approval: false,
        risk_snapshot: JSON.parse(JSON.stringify(completion.continuation.outcome.riskAssessment)),
        policy_snapshot: {},
        continuation_snapshot: completion.continuation,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ decision_id: 'decision' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(inferenceReceiptRepository.getContinuationForDecision('user', completion.decisionId))
      .resolves.toMatchObject({ effectState: 'ready', continuationKind: 'auto_execute' });
    const claimAuthority = {
      outcomeId: completion.continuation.outcome.id,
      explanationId: completion.explanationId,
      selectedActionId: completion.continuation.outcome.selectedAction!.id,
    };
    await expect(inferenceReceiptRepository.claimExecutionForDecision('user', completion.decisionId, claimAuthority))
      .resolves.toBe(true);
    await expect(inferenceReceiptRepository.claimExecutionForDecision('user', completion.decisionId, claimAuthority))
      .resolves.toBe(false);
    expect(mockQuery.mock.calls[1]![0]).toContain("g.effect_state = 'ready'");
    expect(mockQuery.mock.calls[1]![0]).toContain('d.user_id = $1');
  });

  it('classifies a legacy completion without a guard as restored and non-replayable', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ explanation_id: 'explanation' }], rowCount: 1 });

    await expect(inferenceReceiptRepository.getContinuationForDecision('user', 'decision'))
      .resolves.toEqual({
        receiptCaptureComplete: true,
        receiptExplanationId: 'explanation',
        continuationKind: 'auto_execute',
        confirmationLevel: null,
        effectState: 'restored_non_replay',
        sourceEffectState: null,
        sourceExecutionStatus: 'ambiguous',
        sourceExecutionPlanId: null,
        continuation: null,
      });
  });

  it('preserves a restored terminal classification without exposing continuation authority', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      receipt_capture_complete: true,
      receipt_explanation_id: 'explanation',
      continuation_kind: 'auto_execute',
      confirmation_level: null,
      effect_state: 'restored_non_replay',
      source_effect_state: 'completed',
      source_execution_status: 'completed',
      source_execution_plan_id: 'historical-plan',
      outcome_id: null,
      selected_action_id: null,
      outcome_auto_execute: null,
      outcome_requires_approval: null,
      risk_snapshot: null,
      policy_snapshot: null,
      continuation_snapshot: null,
    }], rowCount: 1 });

    await expect(inferenceReceiptRepository.getContinuationForDecision('user', 'decision'))
      .resolves.toEqual({
        receiptCaptureComplete: true,
        receiptExplanationId: 'explanation',
        continuationKind: 'auto_execute',
        confirmationLevel: null,
        effectState: 'restored_non_replay',
        sourceEffectState: 'completed',
        sourceExecutionStatus: 'completed',
        sourceExecutionPlanId: 'historical-plan',
        continuation: null,
      });
  });

  it('marks only an owned running execution terminal', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ decision_id: 'decision' }], rowCount: 1 });
    await expect(inferenceReceiptRepository.markExecutionTerminalForDecision(
      'user', 'decision', 'failed', 'plan',
    )).resolves.toBe(true);
    expect(mockQuery.mock.calls[0]![0]).toContain("g.effect_state = 'running'");
    expect(mockQuery.mock.calls[0]![0]).toContain('ep.id = $4');
    expect(mockQuery.mock.calls[0]![0]).toContain('ep.decision_id = g.decision_id');
    expect(mockQuery.mock.calls[0]![0]).toContain('ep.action_id = g.selected_action_id');
    expect(mockQuery.mock.calls[0]![1]).toEqual(['user', 'decision', 'failed', 'plan']);
  });

  it('scopes reads and deletion through the decision owner', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await inferenceReceiptRepository.findByIdForUser('user', 'receipt');
    await inferenceReceiptRepository.listForUser('user');
    await inferenceReceiptRepository.deleteForUser('user', 'receipt');
    for (const call of mockQuery.mock.calls) {
      expect(call[0]).toContain('d.user_id = $1');
      expect(call[1][0]).toBe('user');
    }
  });
});
