/**
 * backup-restore-guards.test.ts — validation + pre-DB guards in restoreBackup
 * and validateBackupData (#400).
 *
 * The connection + repository modules are mocked so these tests run without a
 * real DB. They cover the paths that should reject BEFORE any write happens:
 * malformed payloads, unsupported schema versions, and an already-existing
 * user. The happy-path DB write itself is covered end-to-end against a real
 * CRDB in the e2e suite; here we assert the guards fail closed.
 */

import { generateKeyPairSync } from 'node:crypto';
import {
  sha256Hex,
  signInferenceReceipt,
  workflowVersionContentHash,
  type InferenceReceiptV1,
} from '@skytwin/shared-types';
import { compileSignalDigestV1 } from '@skytwin/routines';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildDecisionReceiptEventKey,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  joinedDecisionReceiptRevisionDigest,
  type DecisionReceiptEventKey,
  type JoinedDecisionReceiptContent,
  type JoinedDecisionReceiptContentV1,
  type JoinedDecisionReceiptContentV2,
} from '@skytwin/shared-types';
import {
  decisionReceiptRowArtifactRefV1,
  decisionReceiptRowArtifactV1,
} from '../repositories/decision-receipt-artifacts.js';
import {
  buildGmailArchiveReconciliationTerminalEnvelope,
  gmailArchiveReconciliationExplanationSemantics,
} from '../repositories/gmail-archive-reconciliation-repository.js';

let userExists = false;
const poolQuery = vi.fn(async (..._args: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => ({
  rows: [], rowCount: 0,
}));
const clientQuery = vi.fn(async (..._args: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => ({
  rows: [], rowCount: 1,
}));

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => poolQuery(...args),
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: clientQuery }),
  ),
}));

vi.mock('../repositories/user-repository.js', () => ({
  userRepository: {
    findById: vi.fn(async () => (userExists ? { id: 'u1' } : null)),
  },
}));

vi.mock('../repositories/twin-repository.js', () => ({
  twinRepository: { getProfile: vi.fn(async () => null) },
}));

import {
  collectBackup,
  restoreBackup,
  validateBackupData,
  BACKUP_SCHEMA_VERSION,
} from '../backup/backup.js';

const receiptKeys = generateKeyPairSync('ed25519');
const receiptPublicKeyPem = receiptKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const receiptPrivateKeyPem = receiptKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const DECISION_ID = '33333333-3333-4333-8333-333333333333';
const EXPLANATION_ID = '44444444-4444-4444-8444-444444444444';

function signedReceipt(
  overrides: Partial<Omit<InferenceReceiptV1, 'seal'>> = {},
): InferenceReceiptV1 {
  return signInferenceReceipt({
    version: 1,
    id: RECEIPT_ID,
    userId: USER_ID,
    decisionId: DECISION_ID,
    explanationId: EXPLANATION_ID,
    reasoningMode: 'on_device',
    provider: 'embedded',
    model: 'local',
    endpointIdentity: 'local',
    requestSha256: sha256Hex(Buffer.from('request')),
    responseSha256: sha256Hex(Buffer.from('response')),
    verifierVersion: '1',
    cost: { basis: 'exact', currency: 'USD', amountMinor: 0 },
    status: 'on_device',
    createdAt: '2026-06-15T00:00:00.000Z',
    ...overrides,
  }, {
    keyId: 'recorder',
    privateKeyPem: receiptPrivateKeyPem,
    publicKeyPem: receiptPublicKeyPem,
  });
}

function decisionBundle(receipt = signedReceipt()): Record<string, unknown> {
  return {
    decision: { id: DECISION_ID, user_id: USER_ID },
    candidateActions: [],
    outcome: null,
    explanations: [{ id: EXPLANATION_ID, decision_id: DECISION_ID }],
    inferenceReceipts: [{
      id: receipt.id,
      version: receipt.version,
      decision_id: receipt.decisionId,
      explanation_id: receipt.explanationId,
      status: receipt.status,
      receipt,
      trusted: false,
      created_at: new Date(receipt.createdAt),
    }],
    executionPlans: [],
    ingestState: {
      decisionId: DECISION_ID,
      receiptCaptureComplete: true,
      receiptExplanationId: EXPLANATION_ID,
      continuationKind: 'non_effect',
      confirmationLevel: null,
      effectState: 'non_effect',
      sourceEffectState: null,
      sourceExecutionStatus: null,
      sourceExecutionPlanId: null,
      completedAt: new Date(receipt.createdAt),
    },
  };
}

beforeEach(() => {
  userExists = false;
  poolQuery.mockClear();
  poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  clientQuery.mockClear();
  clientQuery.mockImplementation(async (sql: unknown) => ({
    rows: userExists && typeof sql === 'string' && sql.includes('SELECT id FROM users')
      ? [{ id: 'u1' }]
      : [],
    rowCount: 1,
  }));
});

function validPayload(): Record<string, unknown> {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: '2026-06-15T00:00:00.000Z',
    user: {
      id: USER_ID,
      email: 'a@b.c',
      name: 'A',
      trust_tier: 'observer',
      autonomy_settings: {},
      ironclaw_channel: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
    twinProfile: null,
    twinProfileVersions: [],
    preferences: [],
    decisions: [],
    workflows: [],
  };
}

function workflowBundle(): Record<string, unknown> {
  const workflowId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const proposalId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const payload = { filter: { keywords: ['invoice'] }, schedule: { hour: 9, timezone: 'UTC' } };
  return {
    workflow: {
      id: workflowId,
      userId: USER_ID,
      providerKey: 'signal_digest',
      activeVersionId: versionId,
      activeActivationEventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:01:00.000Z',
    },
    versions: [{
      id: versionId,
      workflowId,
      userId: USER_ID,
      versionNumber: 1,
      providerKey: 'signal_digest',
      providerSchemaVersion: 'v1',
      canonicalPayload: payload,
      contentHash: workflowVersionContentHash({
        providerKey: 'signal_digest',
        providerSchemaVersion: 'v1',
        canonicalPayload: payload,
      }),
      parentVersionId: null,
      authoring: {
        version: 1,
        source: 'user',
        sourceReferences: [{ kind: 'message', id: 'message-1' }],
      },
      inference: null,
      createdAt: '2026-06-15T00:00:00.000Z',
    }],
    proposals: [{
      id: proposalId,
      workflowId,
      userId: USER_ID,
      baseVersionId: null,
      proposedVersionId: versionId,
      kind: 'initial',
      idempotencyKey: null,
      requestHash: null,
      createdAt: '2026-06-15T00:00:30.000Z',
    }],
    activationEvents: [{
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      workflowId,
      userId: USER_ID,
      previousVersionId: null,
      activatedVersionId: versionId,
      proposalId,
      kind: 'activate',
      eventSequence: 1,
      createdAt: '2026-06-15T00:01:00.000Z',
    }],
    watchProjection: null,
  };
}

function signalDigestWorkflowBundle(
  status: 'active' | 'paused' | 'draft' = 'paused',
): Record<string, unknown> {
  const workflowId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const proposalId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const payload = {
    name: 'Invoice digest',
    cadence: 'daily',
    hourOfDay: 9,
    filter: {
      sources: ['gmail'],
      fromContains: [],
      keywords: ['invoice'],
      domains: [],
    },
    action: 'digest',
    summaryInstruction: 'Summarize invoice messages.',
  };
  const compiled = compileSignalDigestV1(payload);
  if (!compiled.ok) throw new Error('test signal digest payload must compile');
  const artifact = compiled.artifact;
  return {
    workflow: {
      id: workflowId,
      userId: USER_ID,
      providerKey: artifact.providerKey,
      activeVersionId: versionId,
      activeActivationEventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:01:00.000Z',
    },
    versions: [{
      id: versionId,
      workflowId,
      userId: USER_ID,
      versionNumber: 1,
      providerKey: artifact.providerKey,
      providerSchemaVersion: artifact.providerSchemaVersion,
      canonicalPayload: payload,
      contentHash: artifact.contentHash,
      parentVersionId: null,
      authoring: {
        version: 1,
        source: 'user',
        sourceReferences: [{ kind: 'message', id: 'message-1' }],
      },
      inference: null,
      createdAt: '2026-06-15T00:00:00.000Z',
    }],
    proposals: [{
      id: proposalId,
      workflowId,
      userId: USER_ID,
      baseVersionId: null,
      proposedVersionId: versionId,
      kind: 'initial',
      idempotencyKey: null,
      requestHash: null,
      createdAt: '2026-06-15T00:00:30.000Z',
    }],
    activationEvents: [{
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      workflowId,
      userId: USER_ID,
      previousVersionId: null,
      activatedVersionId: versionId,
      proposalId,
      kind: 'activate',
      eventSequence: 1,
      createdAt: '2026-06-15T00:01:00.000Z',
    }],
    watchProjection: {
      kind: 'compiled_signal_digest.v1',
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      workflowId,
      workflowVersionId: versionId,
      userId: USER_ID,
      providerKey: artifact.providerKey,
      providerSchemaVersion: artifact.providerSchemaVersion,
      contentHash: artifact.contentHash,
      projectionVersion: artifact.projectionVersion,
      sourceText: 'Every morning summarize invoice mail.',
      status,
      scheduleRevision: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      createdAt: '2026-06-15T00:01:00.000Z',
      updatedAt: '2026-06-15T00:02:00.000Z',
      lastRunAt: '2026-06-15T00:01:30.000Z',
      nextRunAt: status === 'active' ? '2026-06-16T09:00:00.000Z' : null,
      snapshot: {
        name: artifact.routineSpec.name,
        cadence: artifact.routineSpec.cadence,
        hourOfDay: artifact.routineSpec.hourOfDay ?? null,
        dayOfWeek: artifact.routineSpec.dayOfWeek ?? null,
        filter: {
          sources: artifact.routineSpec.filter.sources ?? [],
          fromContains: artifact.routineSpec.filter.fromContains ?? [],
          keywords: artifact.routineSpec.filter.keywords ?? [],
          domains: artifact.routineSpec.filter.domains ?? [],
        },
        action: artifact.routineSpec.action,
      },
    },
  };
}

function inertQuarantineSnapshot(): Record<string, unknown> {
  return {
    name: 'Workflow projection unavailable',
    cadence: 'hourly',
    hourOfDay: null,
    dayOfWeek: null,
    filter: { sources: [], fromContains: [], keywords: [], domains: [] },
    action: 'digest',
  };
}

function invalidSignalDigestQuarantineBundle(hashMismatch = false): Record<string, unknown> {
  const bundle = signalDigestWorkflowBundle('paused');
  const version = (bundle['versions'] as Array<Record<string, unknown>>)[0]!;
  if (hashMismatch) {
    version['contentHash'] = 'a'.repeat(64);
  } else {
    const invalidPayload = {
      ...(version['canonicalPayload'] as Record<string, unknown>),
      cadence: 'weekly',
      dayOfWeek: null,
    };
    version['canonicalPayload'] = invalidPayload;
    version['contentHash'] = workflowVersionContentHash({
      providerKey: version['providerKey'] as string,
      providerSchemaVersion: version['providerSchemaVersion'] as string,
      canonicalPayload: invalidPayload,
    });
  }
  const projection = bundle['watchProjection'] as Record<string, unknown>;
  projection['kind'] = 'quarantined_watch_snapshot.v1';
  projection['contentHash'] = version['contentHash'];
  projection['sourceText'] = hashMismatch
    ? 'Projection quarantined: content_hash_mismatch'
    : 'Projection quarantined: invalid_provider_payload:dayOfWeek:missing_value';
  projection['snapshot'] = inertQuarantineSnapshot();
  return bundle;
}

function legacyWatchQuarantineBundle(): Record<string, unknown> {
  const bundle = workflowBundle();
  const workflow = bundle['workflow'] as Record<string, unknown>;
  const version = (bundle['versions'] as Array<Record<string, unknown>>)[0]!;
  const providerKey = 'legacy_watch.quarantine.v1';
  const canonicalPayload = {
    kind: 'legacy_watch_quarantine.v1',
    reasonCode: 'invalid_signal_digest_payload',
    reason: 'name:unsafe_value',
    sourceWatchId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    originalStatus: 'active',
  };
  workflow['providerKey'] = providerKey;
  workflow['activeVersionId'] = null;
  workflow['activeActivationEventId'] = null;
  version['providerKey'] = providerKey;
  version['providerSchemaVersion'] = '1';
  version['canonicalPayload'] = canonicalPayload;
  version['contentHash'] = workflowVersionContentHash({
    providerKey,
    providerSchemaVersion: '1',
    canonicalPayload,
  });
  bundle['activationEvents'] = [];
  bundle['watchProjection'] = {
    kind: 'quarantined_watch_snapshot.v1',
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    workflowId: workflow['id'],
    workflowVersionId: version['id'],
    userId: USER_ID,
    providerKey,
    providerSchemaVersion: '1',
    contentHash: version['contentHash'],
    projectionVersion: 1,
    sourceText: 'Legacy source text',
    status: 'paused',
    scheduleRevision: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    createdAt: '2026-06-15T00:01:00.000Z',
    updatedAt: '2026-06-15T00:02:00.000Z',
    lastRunAt: '2026-06-15T00:01:30.000Z',
    nextRunAt: null,
    snapshot: {
      name: 'Legacy\u0000watch',
      cadence: 'weekly',
      hourOfDay: 7,
      dayOfWeek: 2,
      filter: {
        sources: ['gmail'],
        fromContains: ['billing@example.com'],
        keywords: ['invoice'],
        domains: ['finance'],
      },
      action: 'notify',
    },
  };
  return bundle;
}

function terminalReceiptPayload(): {
  payload: Record<string, unknown>;
  executionExplanation: Record<string, unknown>;
} {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const decisionId = '22222222-2222-4222-8222-222222222222';
  const rootId = '33333333-3333-4333-8333-333333333333';
  const candidateId = '44444444-4444-4444-8444-444444444444';
  const policyExplanationId = '55555555-5555-4555-8555-555555555555';
  const barrierId = '66666666-6666-4666-8666-666666666666';
  const planId = '77777777-7777-4777-8777-777777777777';
  const executionExplanationId = '88888888-8888-4888-8888-888888888888';
  const now = new Date('2026-06-15T00:00:00.000Z');
  const decision = {
    id: decisionId, user_id: ownerId, situation_type: 'email', raw_event: {},
    interpreted_situation: {}, domain: 'email', urgency: 'normal', metadata: {},
    signal_id: null, created_at: now,
  };
  const candidate = {
    id: candidateId, decision_id: decisionId, action_type: 'archive_email',
    description: 'Archive the selected message', parameters: {},
    predicted_user_preference: 'positive', risk_assessment: {}, reversible: true,
    estimated_cost: null, created_at: now,
  };
  const policyExplanation = {
    id: policyExplanationId, decision_id: decisionId, what_happened: 'Policy allowed the action',
    evidence_used: [], preferences_invoked: [], confidence_reasoning: 'Explicit policy',
    action_rationale: 'The action is within scope', escalation_rationale: null,
    correction_guidance: 'Change the archive policy', capability_provenance_node_id: null,
    created_at: now,
  };
  const executionExplanation = {
    id: executionExplanationId, decision_id: decisionId,
    what_happened: 'The mutation POST outcome remains unknown after the confirming read.',
    evidence_used: [{
      schema: 'gmail_archive_terminal_result_v1',
      outcome: 'unknown',
      code: 'remote_outcome_unknown',
      compensationAvailable: false,
    }], preferences_invoked: [],
    confidence_reasoning:
      'The execution port returned remote_outcome_unknown after one POST and one inconclusive confirming read.',
    action_rationale: 'The admitted action was dispatched',
    escalation_rationale: 'Terminal classification: remote_outcome_unknown.',
    correction_guidance:
      'Reconcile the mailbox state before considering any new archive request; automated restore and compensation are unavailable.',
    capability_provenance_node_id: null,
    created_at: now,
  };
  const policySnapshot = { allowed: true, requiresApproval: false, policyIds: [] };
  const policyHash = joinedDecisionReceiptArtifactDigest('policy', policySnapshot);
  const candidateAction = {
    id: candidateId,
    canonicalHash: joinedDecisionReceiptArtifactDigest(
      'candidate_action',
      decisionReceiptRowArtifactV1('candidate_action', candidate),
    ),
  };
  const risk = {
    candidateActionId: candidateId,
    canonicalHash: joinedDecisionReceiptArtifactDigest('risk', candidate.risk_assessment),
  };
  const explanation = {
    id: policyExplanationId,
    canonicalHash: joinedDecisionReceiptArtifactDigest(
      'explanation',
      decisionReceiptRowArtifactV1('explanation', policyExplanation),
    ),
  };
  const barrierSnapshot = {
    version: 1 as const, status: 'prepared' as const, effectType: 'event_execution' as const,
    decisionId, candidateActionId: candidateId, explanationId: policyExplanationId,
    policyHash, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  const barrier = {
    id: barrierId, snapshot: barrierSnapshot,
    canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', barrierSnapshot),
  };
  const evaluation = {
    version: 1 as const, phase: 'pre_effect' as const, disposition: 'allowed' as const,
    candidateAction, risk, policy: { barrierId, policyIds: [], canonicalHash: policyHash },
    barrier, explanation, evidence: [],
  };
  const base: JoinedDecisionReceiptContentV1 = {
    version: 1, stage: 'decision_recorded', disposition: 'pending',
    decision: {
      id: decisionId,
      canonicalHash: joinedDecisionReceiptArtifactDigest(
        'decision',
        decisionReceiptRowArtifactV1('decision', decision),
      ),
    },
    policyEvaluations: [], evidence: [], inference: { receipts: [] },
    feedbackEvents: [], corrections: [],
  };
  const evaluated: JoinedDecisionReceiptContentV1 = {
    ...base, stage: 'policy_evaluated', disposition: 'allowed',
    policyEvaluations: [evaluation], candidateAction, risk, policy: evaluation.policy,
    barrier, explanation,
  };
  const planSnapshot = {
    version: 1 as const, status: 'pending' as const, decisionId,
    candidateActionId: candidateId, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  const admitted: JoinedDecisionReceiptContentV1 = {
    ...evaluated, stage: 'execution_admitted', disposition: 'pending',
    executionPlan: {
      id: planId, snapshot: planSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', planSnapshot),
    },
  };
  const terminalBarrierSnapshot = { ...barrierSnapshot, status: 'unknown' as const };
  const terminalPlanSnapshot = { ...planSnapshot, status: 'failed' as const };
  const terminal: JoinedDecisionReceiptContentV2 = {
    ...admitted, version: 2, stage: 'execution_recorded', disposition: 'unknown',
    barrier: {
      id: barrierId, snapshot: terminalBarrierSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', terminalBarrierSnapshot),
    },
    executionPlan: {
      id: planId, snapshot: terminalPlanSnapshot,
      canonicalHash: joinedDecisionReceiptArtifactDigest('execution_plan', terminalPlanSnapshot),
    },
    executionDisposition: 'unknown',
    executionExplanation: {
      id: executionExplanationId,
      canonicalHash: joinedDecisionReceiptArtifactDigest(
        'explanation',
        decisionReceiptRowArtifactV1('explanation', executionExplanation),
      ),
    },
  };
  let previousDigest: string | null = null;
  const revisionIds = [
    '99999999-9999-4999-8999-999999999999',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ];
  const revisions = ([base, evaluated, admitted, terminal] as JoinedDecisionReceiptContent[])
    .map((content, index) => {
      const revisionId = revisionIds[index]!;
      const eventKey = buildDecisionReceiptEventKey(`backup_${index + 1}`, revisionId);
      const contentDigest = joinedDecisionReceiptContentDigest(content);
      const revisionDigest = joinedDecisionReceiptRevisionDigest({
        revisionId, receiptId: rootId, decisionId, userId: ownerId,
        sequence: index + 1, eventKey, previousDigest, contentDigest,
      });
      const revision = {
        id: revisionId, receipt_id: rootId, sequence: index + 1, event_key: eventKey,
        previous_digest: previousDigest, content_digest: contentDigest, revision_digest: revisionDigest,
        stage: content.stage, disposition: content.disposition, content,
        candidate_action_id: content.candidateAction?.id ?? null,
        barrier_id: content.barrier?.id ?? null,
        explanation_id: content.explanation?.id ?? null,
        approval_request_id: content.approvalRequest?.id ?? null,
        execution_plan_id: content.executionPlan?.id ?? null,
        execution_result_id: content.executionResult?.id ?? null,
        execution_disposition: content.executionDisposition ?? null,
        correction_of_revision_id: content.correctionOfRevision?.id ?? null,
        trusted: true, created_at: now,
      };
      previousDigest = revisionDigest;
      return revision;
    });
  const payload = validPayload();
  payload['user'] = { ...(payload['user'] as object), id: ownerId };
  payload['decisions'] = [{
    decision, candidateActions: [candidate], outcome: null,
    explanations: [policyExplanation, executionExplanation], inferenceReceipts: [],
    executionPlans: [{
      id: planId, decision_id: decisionId, action_id: candidateId, status: 'failed', steps: [],
      created_at: now, updated_at: now,
    }],
    ingestState: null,
    joinedReceipt: {
      root: { id: rootId, user_id: ownerId, decision_id: decisionId, created_at: now },
      revisions,
    },
  }];
  return { payload, executionExplanation };
}

function rehashTerminalReceipt(payload: Record<string, unknown>): void {
  const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
  const revisions = (bundle['joinedReceipt'] as {
    revisions: Array<Record<string, unknown>>;
  }).revisions;
  let previousDigest: string | null = null;
  for (const revision of revisions) {
    const content = revision['content'] as JoinedDecisionReceiptContent;
    const contentDigest = joinedDecisionReceiptContentDigest(content);
    revision['previous_digest'] = previousDigest;
    revision['content_digest'] = contentDigest;
    revision['revision_digest'] = joinedDecisionReceiptRevisionDigest({
      revisionId: revision['id'] as string,
      receiptId: revision['receipt_id'] as string,
      decisionId: (bundle['decision'] as Record<string, unknown>)['id'] as string,
      userId: (payload['user'] as Record<string, unknown>)['id'] as string,
      sequence: revision['sequence'] as number,
      eventKey: revision['event_key'] as DecisionReceiptEventKey,
      previousDigest,
      contentDigest,
    });
    previousDigest = revision['revision_digest'] as string;
  }
}

function reconciliationTerminalReceiptPayload(): {
  payload: Record<string, unknown>;
  executionExplanation: Record<string, unknown>;
} {
  const { payload, executionExplanation } = terminalReceiptPayload();
  const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
  const candidate = (bundle['candidateActions'] as Array<Record<string, unknown>>)[0]!;
  const revisions = (bundle['joinedReceipt'] as {
    revisions: Array<Record<string, unknown>>;
  }).revisions;
  const terminal = revisions.at(-1)!;
  const terminalContent = terminal['content'] as JoinedDecisionReceiptContentV2;
  const ownerId = (payload['user'] as Record<string, unknown>)['id'] as string;
  const messageRefId = '12121212-1212-4212-8212-121212121212';
  const terminalAt = terminalContent.barrier!.snapshot.updatedAt;
  candidate['parameters'] = { messageRefId };
  const candidateHash = joinedDecisionReceiptArtifactDigest(
    'candidate_action',
    decisionReceiptRowArtifactV1('candidate_action', candidate),
  );
  for (const revision of revisions) {
    const content = revision['content'] as JoinedDecisionReceiptContent;
    if (content.candidateAction) content.candidateAction.canonicalHash = candidateHash;
  }
  const envelope = buildGmailArchiveReconciliationTerminalEnvelope({
    phase: 'dispatch_may_have_started',
    phaseChangedAt: new Date(Date.parse(terminalAt) - 600_000).toISOString(),
    evidence: {
      kind: 'mailbox_observed',
      binding: {
        userId: ownerId,
        admissionId: terminalContent.barrier!.id,
        messageRefId,
      },
      inbox: false,
      observedAt: new Date(Date.parse(terminalAt) - 1_000).toISOString(),
    },
  });
  const semantics = gmailArchiveReconciliationExplanationSemantics(envelope);
  executionExplanation['evidence_used'] = [envelope];
  executionExplanation['what_happened'] = semantics.whatHappened;
  executionExplanation['confidence_reasoning'] = semantics.confidenceReasoning;
  executionExplanation['escalation_rationale'] = semantics.escalationRationale;
  executionExplanation['correction_guidance'] = semantics.correctionGuidance;
  terminalContent.executionExplanation.canonicalHash = joinedDecisionReceiptArtifactDigest(
    'explanation',
    decisionReceiptRowArtifactV1('explanation', executionExplanation),
  );
  rehashTerminalReceipt(payload);
  return { payload, executionExplanation };
}

function rehashReconciliationExplanation(
  payload: Record<string, unknown>,
  executionExplanation: Record<string, unknown>,
): void {
  const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
  const revisions = (bundle['joinedReceipt'] as {
    revisions: Array<Record<string, unknown>>;
  }).revisions;
  const explanationHash = joinedDecisionReceiptArtifactDigest(
    'explanation',
    decisionReceiptRowArtifactV1('explanation', executionExplanation),
  );
  for (const revision of revisions) {
    const content = revision['content'] as JoinedDecisionReceiptContent;
    if (content.version === 2) content.executionExplanation.canonicalHash = explanationHash;
  }
  rehashTerminalReceipt(payload);
}

describe('validateBackupData', () => {
  it('accepts an owner-scoped workflow graph with canonical content and activation history', () => {
    const payload = validPayload();
    payload['workflows'] = [workflowBundle()];
    expect(validateBackupData(payload)).toEqual([]);
  });

  it('rejects workflow owner, content-hash, source-body, and activation-chain tampering', () => {
    const ownerTamper = validPayload();
    ownerTamper['workflows'] = [workflowBundle()];
    const ownerBundle = (ownerTamper['workflows'] as Array<Record<string, unknown>>)[0]!;
    (ownerBundle['workflow'] as Record<string, unknown>)['userId'] =
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    expect(validateBackupData(ownerTamper)).toContain(
      'workflows[0].workflow has invalid identity or ownership',
    );

    const hashTamper = validPayload();
    hashTamper['workflows'] = [workflowBundle()];
    const hashVersion = ((hashTamper['workflows'] as Array<Record<string, unknown>>)[0]!
      ['versions'] as Array<Record<string, unknown>>)[0]!;
    hashVersion['contentHash'] = 'f'.repeat(64);
    expect(validateBackupData(hashTamper)).toContain(
      'workflows[0].versions[0] has invalid content, identity, or ownership',
    );

    const bodyTamper = validPayload();
    bodyTamper['workflows'] = [workflowBundle()];
    const bodyVersion = ((bodyTamper['workflows'] as Array<Record<string, unknown>>)[0]!
      ['versions'] as Array<Record<string, unknown>>)[0]!;
    bodyVersion['canonicalPayload'] = { sourceBody: 'portable backups must not contain this' };
    bodyVersion['contentHash'] = workflowVersionContentHash({
      providerKey: 'signal_digest',
      providerSchemaVersion: 'v1',
      canonicalPayload: bodyVersion['canonicalPayload'] as Record<string, never>,
    });
    expect(validateBackupData(bodyTamper)).toContain(
      'workflows[0].versions[0] has invalid content, identity, or ownership',
    );

    const eventTamper = validPayload();
    eventTamper['workflows'] = [workflowBundle()];
    const event = ((eventTamper['workflows'] as Array<Record<string, unknown>>)[0]!
      ['activationEvents'] as Array<Record<string, unknown>>)[0]!;
    event['previousVersionId'] = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    expect(validateBackupData(eventTamper)).toContain(
      'workflows[0].activationEvents[0] has invalid transition or ownership',
    );

    const sequenceTamper = validPayload();
    const sequenceBundle = workflowBundle();
    ((sequenceBundle['activationEvents'] as Array<Record<string, unknown>>)[0])!['eventSequence'] = 2;
    sequenceTamper['workflows'] = [sequenceBundle];
    expect(validateBackupData(sequenceTamper)).toContain(
      'workflows[0].activationEvents[0] has invalid transition or ownership',
    );

    const activeEventTamper = validPayload();
    const activeEventBundle = workflowBundle();
    (activeEventBundle['workflow'] as Record<string, unknown>)['activeActivationEventId'] =
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    activeEventTamper['workflows'] = [activeEventBundle];
    expect(validateBackupData(activeEventTamper)).toContain(
      'workflows[0].activationEvents do not resolve to the active activation event',
    );
  });

  it('provider-validates known signal digest payloads after a self-consistent rehash', () => {
    const payload = validPayload();
    const bundle = signalDigestWorkflowBundle();
    const version = (bundle['versions'] as Array<Record<string, unknown>>)[0]!;
    const invalidPayload = {
      ...(version['canonicalPayload'] as Record<string, unknown>),
      cadence: 'weekly',
      dayOfWeek: null,
    };
    version['canonicalPayload'] = invalidPayload;
    version['contentHash'] = workflowVersionContentHash({
      providerKey: version['providerKey'] as string,
      providerSchemaVersion: version['providerSchemaVersion'] as string,
      canonicalPayload: invalidPayload,
    });
    const projection = bundle['watchProjection'] as Record<string, unknown>;
    projection['contentHash'] = version['contentHash'];
    payload['workflows'] = [bundle];

    expect(validateBackupData(payload)).toContain(
      'workflows[0].versions[0] has invalid content, identity, or ownership',
    );
  });

  it('rejects Watch projection status and schedule combinations that could change runtime state', () => {
    for (const [status, nextRunAt] of [
      ['active', null],
      ['paused', '2026-06-16T09:00:00.000Z'],
      ['draft', '2026-06-16T09:00:00.000Z'],
      ['unknown', null],
    ] as const) {
      const payload = validPayload();
      const bundle = signalDigestWorkflowBundle('paused');
      const projection = bundle['watchProjection'] as Record<string, unknown>;
      projection['status'] = status;
      projection['nextRunAt'] = nextRunAt;
      payload['workflows'] = [bundle];

      expect(validateBackupData(payload), status).toContain(
        'workflows[0].watchProjection has invalid state, identity, or version pin',
      );
    }
  });

  it('requires the portable Watch state for an active signal digest workflow', () => {
    const payload = validPayload();
    const bundle = signalDigestWorkflowBundle();
    bundle['watchProjection'] = null;
    payload['workflows'] = [bundle];

    expect(validateBackupData(payload)).toContain(
      'workflows[0].watchProjection is required for the active signal digest',
    );
  });

  it.each([
    ['legacy invalid Watch', legacyWatchQuarantineBundle],
    ['invalid provider payload', () => invalidSignalDigestQuarantineBundle(false)],
    ['hash-mismatched provider payload', () => invalidSignalDigestQuarantineBundle(true)],
  ])('accepts an explicit inert quarantine snapshot for %s', (_label, buildBundle) => {
    const payload = validPayload();
    payload['workflows'] = [buildBundle()];
    expect(validateBackupData(payload)).toEqual([]);
  });

  it('rejects a quarantine snapshot if it can become scheduled', () => {
    const payload = validPayload();
    const bundle = invalidSignalDigestQuarantineBundle(true);
    const projection = bundle['watchProjection'] as Record<string, unknown>;
    projection['status'] = 'active';
    projection['nextRunAt'] = '2026-06-16T09:00:00.000Z';
    payload['workflows'] = [bundle];
    expect(validateBackupData(payload)).toContain(
      'workflows[0].watchProjection has invalid state, identity, or version pin',
    );
  });

  it('rejects executable semantics hidden inside a signal-digest quarantine snapshot', () => {
    const payload = validPayload();
    const bundle = invalidSignalDigestQuarantineBundle(true);
    const projection = bundle['watchProjection'] as Record<string, unknown>;
    const snapshot = projection['snapshot'] as Record<string, unknown>;
    snapshot['action'] = 'notify';
    payload['workflows'] = [bundle];
    expect(validateBackupData(payload)).toContain(
      'workflows[0].watchProjection has invalid state, identity, or version pin',
    );
  });

  it('rejects replay of a proposal after a rollback before restore writes', async () => {
    const payload = validPayload();
    const bundle = workflowBundle();
    const workflow = bundle['workflow'] as Record<string, unknown>;
    const first = (bundle['versions'] as Array<Record<string, unknown>>)[0]!;
    const secondId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const secondProposalId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const secondPayload = { filter: { keywords: ['invoice', 'receipt'] } };
    const second = {
      ...first,
      id: secondId,
      versionNumber: 2,
      canonicalPayload: secondPayload,
      contentHash: workflowVersionContentHash({
        providerKey: first['providerKey'] as string,
        providerSchemaVersion: first['providerSchemaVersion'] as string,
        canonicalPayload: secondPayload,
      }),
      parentVersionId: first['id'],
      createdAt: '2026-06-15T00:02:00.000Z',
    };
    bundle['versions'] = [first, second];
    bundle['proposals'] = [
      ...(bundle['proposals'] as Array<Record<string, unknown>>),
      {
        id: secondProposalId,
        workflowId: workflow['id'],
        userId: USER_ID,
        baseVersionId: first['id'],
        proposedVersionId: secondId,
        kind: 'edit',
        createdAt: '2026-06-15T00:02:30.000Z',
      },
    ];
    const firstEvent = (bundle['activationEvents'] as Array<Record<string, unknown>>)[0]!;
    bundle['activationEvents'] = [firstEvent, {
      id: '10000000-0000-4000-8000-000000000001',
      workflowId: workflow['id'], userId: USER_ID,
      previousVersionId: first['id'], activatedVersionId: secondId,
      proposalId: secondProposalId, kind: 'activate', eventSequence: 2,
      createdAt: '2026-06-15T00:03:00.000Z',
    }, {
      id: '10000000-0000-4000-8000-000000000002',
      workflowId: workflow['id'], userId: USER_ID,
      previousVersionId: secondId, activatedVersionId: first['id'],
      proposalId: null, kind: 'rollback', eventSequence: 3,
      createdAt: '2026-06-15T00:04:00.000Z',
    }, {
      id: '10000000-0000-4000-8000-000000000003',
      workflowId: workflow['id'], userId: USER_ID,
      previousVersionId: first['id'], activatedVersionId: secondId,
      proposalId: secondProposalId, kind: 'activate', eventSequence: 4,
      createdAt: '2026-06-15T00:05:00.000Z',
    }];
    workflow['activeVersionId'] = secondId;
    workflow['activeActivationEventId'] = '10000000-0000-4000-8000-000000000003';
    payload['workflows'] = [bundle];

    expect(validateBackupData(payload)).toContain(
      'workflows[0].activationEvents[3] has invalid transition or ownership',
    );
    await expect(restoreBackup(payload)).resolves.toMatchObject({
      success: false,
      reason: 'invalid_data',
    });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('rejects proposal kinds whose base-version shape cannot satisfy the schema', async () => {
    const payload = validPayload();
    const bundle = workflowBundle();
    const proposal = (bundle['proposals'] as Array<Record<string, unknown>>)[0]!;
    proposal['kind'] = 'edit';
    payload['workflows'] = [bundle];

    expect(validateBackupData(payload)).toContain(
      'workflows[0].proposals[0] has invalid linkage or ownership',
    );
    await expect(restoreBackup(payload)).resolves.toMatchObject({
      success: false,
      reason: 'invalid_data',
    });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('rejects malformed nested workflow array entries without throwing', async () => {
    for (const field of ['versions', 'proposals', 'activationEvents'] as const) {
      const payload = validPayload();
      const bundle = workflowBundle();
      bundle[field] = [null, 1, 'malformed'];
      payload['workflows'] = [bundle];

      expect(() => validateBackupData(payload), field).not.toThrow();
      expect(validateBackupData(payload), field).toEqual(expect.arrayContaining([
        expect.stringContaining(`workflows[0].${field}[0] is malformed`),
      ]));
      await expect(restoreBackup(payload), field).resolves.toMatchObject({
        success: false,
        reason: 'invalid_data',
      });
    }
  });

  it('requires proposal idempotency state in current backups and rejects half-bound keys', () => {
    const missing = validPayload();
    const missingBundle = workflowBundle();
    const missingProposal = (missingBundle['proposals'] as Array<Record<string, unknown>>)[0]!;
    delete missingProposal['idempotencyKey'];
    delete missingProposal['requestHash'];
    missing['workflows'] = [missingBundle];
    expect(validateBackupData(missing)).toContain(
      'workflows[0].proposals[0] has invalid linkage or ownership',
    );

    const halfBound = validPayload();
    const halfBoundBundle = workflowBundle();
    const halfBoundProposal = (halfBoundBundle['proposals'] as Array<Record<string, unknown>>)[0]!;
    halfBoundProposal['idempotencyKey'] = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    halfBoundProposal['requestHash'] = null;
    halfBound['workflows'] = [halfBoundBundle];
    expect(validateBackupData(halfBound)).toContain(
      'workflows[0].proposals[0] has invalid linkage or ownership',
    );
  });

  it('requires workflow data since schema v5 and keeps v4 readable', () => {
    const missing = validPayload();
    delete missing['workflows'];
    expect(validateBackupData(missing)).toContain(
      `workflows is required by schema version ${BACKUP_SCHEMA_VERSION}`,
    );

    const v4 = validPayload();
    v4['schemaVersion'] = 4;
    delete v4['workflows'];
    expect(validateBackupData(v4)).toEqual([]);

    v4['workflows'] = [workflowBundle()];
    expect(validateBackupData(v4)).toContain(
      'workflows requires schema version 5 or later',
    );

    const v5 = validPayload();
    v5['schemaVersion'] = 5;
    const v5Bundle = workflowBundle();
    const v5Proposal = (v5Bundle['proposals'] as Array<Record<string, unknown>>)[0]!;
    delete v5Proposal['idempotencyKey'];
    delete v5Proposal['requestHash'];
    v5['workflows'] = [v5Bundle];
    expect(validateBackupData(v5)).toEqual([]);
  });

  it('accepts a well-formed payload', () => {
    expect(validateBackupData(validPayload())).toEqual([]);
  });

  it('rejects a hostile non-UUID restored execution plan before any write', async () => {
    const payload = validPayload();
    const bundle = decisionBundle();
    (bundle['ingestState'] as Record<string, unknown>)['sourceExecutionPlanId'] =
      "x'); DROP TABLE users; --";
    payload['decisions'] = [bundle];

    expect(validateBackupData(payload)).toContain(
      'decisions[0].ingestState has inconsistent linkage or classification',
    );
    const result = await restoreBackup(payload);
    expect(result).toMatchObject({ success: false, reason: 'invalid_data' });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('accepts an explicit receipt-free schema-v1 archive', () => {
    const payload = validPayload();
    payload['schemaVersion'] = 1;
    payload['decisions'] = [{
      decision: { id: DECISION_ID, user_id: USER_ID }, candidateActions: [], outcome: null,
      explanations: [{ id: EXPLANATION_ID, decision_id: DECISION_ID }],
    }];
    expect(validateBackupData(payload)).toEqual([]);
  });

  it('keeps schema-v1/v2/v3 fields explicit and fail-safe', () => {
    const current = validPayload();
    current['decisions'] = [{
      decision: { id: DECISION_ID, user_id: USER_ID }, candidateActions: [], outcome: null,
      explanations: [],
    }];
    expect(validateBackupData(current)).toContain(
      `decisions[0].inferenceReceipts is required by schema version ${BACKUP_SCHEMA_VERSION}`,
    );

    const legacy = validPayload();
    legacy['schemaVersion'] = 1;
    legacy['decisions'] = [{
      decision: { id: DECISION_ID, user_id: USER_ID }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [],
    }];
    expect(validateBackupData(legacy)).toContain(
      'decisions[0].inferenceReceipts requires schema version 2',
    );
    (legacy['decisions'] as Array<Record<string, unknown>>)[0]!['ingestState'] = null;
    expect(validateBackupData(legacy)).toContain(
      'decisions[0].ingestState requires schema version 3 or later',
    );

    const v2 = validPayload();
    v2['schemaVersion'] = 2;
    v2['decisions'] = [{
      decision: { id: DECISION_ID, user_id: USER_ID }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [],
    }];
    expect(validateBackupData(v2)).toEqual([]);

    const v3WithoutState = validPayload();
    v3WithoutState['schemaVersion'] = 3;
    v3WithoutState['decisions'] = [{
      decision: { id: DECISION_ID, user_id: USER_ID }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [],
    }];
    expect(validateBackupData(v3WithoutState)).toContain(
      'decisions[0].ingestState is required by schema version 3',
    );

    const v4 = validPayload();
    v4['schemaVersion'] = 4;
    v4['decisions'] = [];
    expect(validateBackupData(v4)).toEqual([]);
  });

  it('accepts only sealed receipt snapshots with exact archive linkage', () => {
    const payload = validPayload();
    payload['decisions'] = [decisionBundle()];
    expect(validateBackupData(payload)).toEqual([]);

    const tampered = signedReceipt();
    tampered.model = 'changed-after-signing';
    payload['decisions'] = [decisionBundle(tampered)];
    expect(validateBackupData(payload)).toContain(
      'decisions[0].inferenceReceipts[0] has inconsistent linkage',
    );
  });

  it('accepts UUID linkage when signed and stored values differ only by case', () => {
    const userId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const decisionId = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
    const explanationId = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
    const receiptId = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD';
    const receipt = signedReceipt({
      id: receiptId,
      userId,
      decisionId,
      explanationId,
    });
    const bundle = decisionBundle(receipt);
    const decision = bundle['decision'] as Record<string, unknown>;
    decision['id'] = decisionId.toLowerCase();
    decision['user_id'] = userId.toLowerCase();
    const explanation = (bundle['explanations'] as Array<Record<string, unknown>>)[0]!;
    explanation['id'] = explanationId.toLowerCase();
    explanation['decision_id'] = decisionId.toLowerCase();
    const storedReceipt = (bundle['inferenceReceipts'] as Array<Record<string, unknown>>)[0]!;
    storedReceipt['id'] = receiptId.toLowerCase();
    storedReceipt['decision_id'] = decisionId.toLowerCase();
    storedReceipt['explanation_id'] = explanationId.toLowerCase();
    const ingestState = bundle['ingestState'] as Record<string, unknown>;
    ingestState['decisionId'] = decisionId;
    ingestState['receiptExplanationId'] = explanationId;

    const payload = validPayload();
    (payload['user'] as Record<string, unknown>)['id'] = userId.toLowerCase();
    payload['decisions'] = [bundle];

    expect(validateBackupData(payload)).toEqual([]);
  });

  it('rejects more than one receipt for a decision before restore', () => {
    const bundle = decisionBundle();
    const receipt = (bundle['inferenceReceipts'] as Array<Record<string, unknown>>)[0]!;
    bundle['inferenceReceipts'] = [receipt, { ...receipt }];
    const payload = validPayload();
    payload['schemaVersion'] = 2;
    delete bundle['ingestState'];
    payload['decisions'] = [bundle];

    expect(validateBackupData(payload)).toContain(
      'decisions[0].inferenceReceipts must contain at most one receipt',
    );
  });

  it('rejects duplicate schema-v3 receipt IDs case-insensitively before restore', async () => {
    const bundle = decisionBundle();
    const receipt = (bundle['inferenceReceipts'] as Array<Record<string, unknown>>)[0]!;
    bundle['inferenceReceipts'] = [receipt, { ...receipt, id: RECEIPT_ID.toUpperCase() }];
    const payload = validPayload();
    payload['decisions'] = [bundle];

    expect(validateBackupData(payload)).toContain(
      'decisions[0].inferenceReceipts[1] duplicates a receipt id',
    );
    await expect(restoreBackup(payload)).resolves.toMatchObject({
      success: false,
      reason: 'invalid_data',
    });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('rejects duplicate schema-v3 capture ordinals before restore', () => {
    const bundle = decisionBundle();
    const first = (bundle['inferenceReceipts'] as Array<Record<string, unknown>>)[0]!;
    first['capture_ordinal'] = 0;
    const secondReceipt = signedReceipt({ id: '55555555-5555-4555-8555-555555555555' });
    const second = {
      ...first,
      id: secondReceipt.id,
      receipt: secondReceipt,
      capture_ordinal: 0,
    };
    bundle['inferenceReceipts'] = [first, second];
    const payload = validPayload();
    payload['decisions'] = [bundle];

    expect(validateBackupData(payload)).toContain(
      'decisions[0].inferenceReceipts[1] duplicates a capture ordinal',
    );
  });

  it('accepts plural receipts in a schema-v3 decision bundle', () => {
    const bundle = decisionBundle();
    const secondBundle = decisionBundle(signedReceipt({
      id: '55555555-5555-4555-8555-555555555555',
    }));
    (bundle['inferenceReceipts'] as Array<Record<string, unknown>>).push(
      (secondBundle['inferenceReceipts'] as Array<Record<string, unknown>>)[0]!,
    );
    const payload = validPayload();
    payload['decisions'] = [bundle];

    expect(validateBackupData(payload)).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateBackupData('nope')).toContain('payload is not an object');
    expect(validateBackupData(null)).toContain('payload is not an object');
  });

  it('reports each missing required field', () => {
    const problems = validateBackupData({ schemaVersion: 1 });
    expect(problems).toContain('missing user');
    expect(problems).toContain('preferences is not an array');
    expect(problems).toContain('decisions is not an array');
    expect(problems).toContain('twinProfileVersions is not an array');
  });

  it('rejects receipt metadata whose signed linkage disagrees with its decision bundle', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a' }, candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a' }],
      inferenceReceipts: [{
        id: 'receipt-a', decision_id: 'decision-a', explanation_id: 'explanation-a', status: 'verified',
        receipt: { id: 'receipt-a', decisionId: 'decision-b', explanationId: 'explanation-a', status: 'verified' },
      }],
    }];
    expect(validateBackupData(payload)).toContain(
      'decisions[0].inferenceReceipts[0] has inconsistent linkage',
    );
  });

  it('rejects an explanation linked to a different decision than its containing bundle', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a' }, candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a', decision_id: 'decision-b' }], inferenceReceipts: [],
    }];
    expect(validateBackupData(payload)).toContain(
      'decisions[0].explanations[0] has inconsistent linkage',
    );
  });

  it('rejects malformed nested collections without throwing', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'u1' },
      candidateActions: {}, explanations: {}, inferenceReceipts: {},
    }];
    expect(() => validateBackupData(payload)).not.toThrow();
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0].candidateActions is not an array',
      'decisions[0].explanations is not an array',
      'decisions[0].inferenceReceipts is not an array',
    ]));
  });

  it('rejects malformed joined receipt nesting without throwing', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'u1' }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [], joinedReceipt: {},
    }];
    expect(() => validateBackupData(payload)).not.toThrow();
    expect(validateBackupData(payload)).toContain('decisions[0].joinedReceipt is malformed');
  });

  it('validates the joined receipt owner, sequence, digest chain, and event uniqueness', () => {
    const payload = validPayload();
    const joinedDecisionId = '22222222-2222-4222-8222-222222222222';
    const joinedRootId = '33333333-3333-4333-8333-333333333333';
    const joinedUserId = '11111111-1111-4111-8111-111111111111';
    const content = {
      version: 1 as const, stage: 'decision_recorded' as const, disposition: 'pending' as const,
      policyEvaluations: [],
      decision: {
        id: joinedDecisionId,
        canonicalHash: joinedDecisionReceiptArtifactDigest('decision', {
          id: joinedDecisionId, user_id: joinedUserId,
        }),
      },
      evidence: [], inference: { receipts: [] }, feedbackEvents: [], corrections: [],
    };
    payload['user'] = { ...(payload['user'] as object), id: joinedUserId };
    const contentDigest = joinedDecisionReceiptContentDigest(content);
    const receiptEventKey = buildDecisionReceiptEventKey('created', '55555555-5555-4555-8555-555555555555');
    payload['decisions'] = [{
      decision: { id: joinedDecisionId, user_id: joinedUserId }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [], executionPlans: [], ingestState: null,
      joinedReceipt: {
        root: { id: joinedRootId, user_id: joinedUserId, decision_id: joinedDecisionId, created_at: new Date() },
        revisions: [{
          id: '44444444-4444-4444-8444-444444444444', receipt_id: joinedRootId, sequence: '1',
          event_key: receiptEventKey,
          previous_digest: null, content_digest: contentDigest,
          revision_digest: joinedDecisionReceiptRevisionDigest({
            revisionId: '44444444-4444-4444-8444-444444444444',
            receiptId: joinedRootId, decisionId: joinedDecisionId, userId: joinedUserId,
            sequence: 1, eventKey: receiptEventKey, previousDigest: null, contentDigest,
          }),
          stage: content.stage, disposition: content.disposition, content,
          candidate_action_id: null, barrier_id: null, explanation_id: null,
          approval_request_id: null, execution_plan_id: null, execution_result_id: null,
          execution_disposition: null,
          correction_of_revision_id: null, trusted: true,
        }],
      },
    }];
    expect(validateBackupData(payload)).toEqual([]);
    const revision = ((payload['decisions'] as Array<Record<string, unknown>>)[0]!
      ['joinedReceipt'] as { revisions: Array<Record<string, unknown>> }).revisions[0]!;
    revision['sequence'] = '1';
    expect(validateBackupData(payload)).toEqual([]);
    for (const invalidSequence of [true, [1], '01', ' 1', '1 ', 0, -1, 1.5]) {
      revision['sequence'] = invalidSequence;
      expect(validateBackupData(payload)).toContain(
        'decisions[0].joinedReceipt.revisions[0] has inconsistent chain',
      );
    }
    revision['sequence'] = 1;
    const decision = (payload['decisions'] as Array<{ decision: Record<string, unknown> }>)[0]!.decision;
    decision['domain'] = 'tampered-after-receipt';
    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt.revisions[0] has inconsistent chain',
    );
    delete decision['domain'];
    revision['previous_digest'] = 'f'.repeat(64);
    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt.revisions[0] has inconsistent chain',
    );
  });

  it('requires a v2 terminal explanation row in the exported decision bundle', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    expect(validateBackupData(payload)).toEqual([]);
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    bundle['explanations'] = (bundle['explanations'] as Array<Record<string, unknown>>)
      .filter((row) => row['id'] !== executionExplanation['id']);

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has inconsistent execution explanation snapshot',
    );
  });

  it('rejects a v2 terminal explanation whose exported canonical projection was tampered', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    expect(validateBackupData(payload)).toEqual([]);
    executionExplanation['what_happened'] = 'tampered after receipt creation';

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has inconsistent execution explanation snapshot',
    );
  });

  it('retains and verifies the canonical terminal result envelope', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    expect(validateBackupData(payload)).toEqual([]);
    expect(executionExplanation['evidence_used']).toEqual([{
      schema: 'gmail_archive_terminal_result_v1',
      outcome: 'unknown',
      code: 'remote_outcome_unknown',
      compensationAvailable: false,
    }]);
    (executionExplanation['evidence_used'] as Array<Record<string, unknown>>)[0]!['code'] =
      'remote_rejected';
    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has inconsistent execution explanation snapshot',
    );
  });

  it('rejects malformed Gmail terminal evidence after an internally consistent rehash', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const terminal = revisions.at(-1)!;
    const content = terminal['content'] as JoinedDecisionReceiptContentV2;
    delete (executionExplanation['evidence_used'] as Array<Record<string, unknown>>)[0]!
      ['compensationAvailable'];
    content.executionExplanation.canonicalHash = joinedDecisionReceiptArtifactDigest(
      'explanation',
      decisionReceiptRowArtifactV1('explanation', executionExplanation),
    );
    terminal['content_digest'] = joinedDecisionReceiptContentDigest(content);
    terminal['revision_digest'] = joinedDecisionReceiptRevisionDigest({
      revisionId: terminal['id'] as string,
      receiptId: terminal['receipt_id'] as string,
      decisionId: (bundle['decision'] as Record<string, unknown>)['id'] as string,
      userId: ((payload['user'] as Record<string, unknown>)['id']) as string,
      sequence: terminal['sequence'] as number,
      eventKey: terminal['event_key'] as DecisionReceiptEventKey,
      previousDigest: terminal['previous_digest'] as string,
      contentDigest: terminal['content_digest'] as string,
    });

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has invalid Gmail terminal explanation',
    );
  });

  it('rejects a phase-incompatible v2 terminal envelope after an internally consistent rehash', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const terminal = revisions.at(-1)!;
    const content = terminal['content'] as JoinedDecisionReceiptContentV2;
    executionExplanation['evidence_used'] = [{
      schema: 'gmail_archive_terminal_result_v2',
      attemptPhase: 'pre_dispatch',
      outcome: 'unknown',
      code: 'remote_outcome_unknown',
      compensationAvailable: false,
    }];
    content.executionExplanation.canonicalHash = joinedDecisionReceiptArtifactDigest(
      'explanation',
      decisionReceiptRowArtifactV1('explanation', executionExplanation),
    );
    terminal['content_digest'] = joinedDecisionReceiptContentDigest(content);
    terminal['revision_digest'] = joinedDecisionReceiptRevisionDigest({
      revisionId: terminal['id'] as string,
      receiptId: terminal['receipt_id'] as string,
      decisionId: (bundle['decision'] as Record<string, unknown>)['id'] as string,
      userId: (payload['user'] as Record<string, unknown>)['id'] as string,
      sequence: terminal['sequence'] as number,
      eventKey: terminal['event_key'] as DecisionReceiptEventKey,
      previousDigest: terminal['previous_digest'] as string,
      contentDigest: terminal['content_digest'] as string,
    });

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has invalid Gmail terminal explanation',
    );
  });

  it('retains strict compatibility for a valid phase-bound legacy v2 terminal envelope', () => {
    const { payload, executionExplanation } = terminalReceiptPayload();
    executionExplanation['evidence_used'] = [{
      schema: 'gmail_archive_terminal_result_v2',
      attemptPhase: 'dispatch_may_have_started',
      outcome: 'unknown',
      code: 'remote_outcome_unknown',
      compensationAvailable: false,
    }];
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const terminal = revisions.at(-1)!;
    const content = terminal['content'] as JoinedDecisionReceiptContentV2;
    content.executionExplanation.canonicalHash = joinedDecisionReceiptArtifactDigest(
      'explanation',
      decisionReceiptRowArtifactV1('explanation', executionExplanation),
    );
    rehashTerminalReceipt(payload);

    expect(validateBackupData(payload)).toEqual([]);
  });

  it('accepts a causal-unknown reconciliation envelope with exact authority and time bounds', () => {
    const { payload } = reconciliationTerminalReceiptPayload();
    expect(validateBackupData(payload)).toEqual([]);
  });

  it.each([
    ['under grace', (envelope: Record<string, unknown>, terminalAt: string) => {
      envelope['phaseChangedAt'] = new Date(Date.parse(terminalAt) - 299_999).toISOString();
    }],
    ['future observation', (envelope: Record<string, unknown>, terminalAt: string) => {
      const evidence = envelope['evidence'] as Record<string, unknown>;
      evidence['observedAt'] = new Date(Date.parse(terminalAt) + 1).toISOString();
    }],
    ['pre-phase observation', (envelope: Record<string, unknown>) => {
      const evidence = envelope['evidence'] as Record<string, unknown>;
      evidence['observedAt'] = new Date(
        Date.parse(envelope['phaseChangedAt'] as string) - 1,
      ).toISOString();
    }],
    ['wrong owner binding', (envelope: Record<string, unknown>) => {
      const evidence = envelope['evidence'] as Record<string, unknown>;
      const binding = evidence['binding'] as Record<string, unknown>;
      binding['userId'] = '99999999-9999-4999-8999-999999999999';
    }],
    ['wrong admission binding', (envelope: Record<string, unknown>) => {
      const evidence = envelope['evidence'] as Record<string, unknown>;
      const binding = evidence['binding'] as Record<string, unknown>;
      binding['admissionId'] = '99999999-9999-4999-8999-999999999999';
    }],
    ['wrong message binding', (envelope: Record<string, unknown>) => {
      const evidence = envelope['evidence'] as Record<string, unknown>;
      const binding = evidence['binding'] as Record<string, unknown>;
      binding['messageRefId'] = '99999999-9999-4999-8999-999999999999';
    }],
  ] as const)('rejects rehashed reconciliation evidence %s', (_label, tamper) => {
    const { payload, executionExplanation } = reconciliationTerminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const terminalContent = revisions.at(-1)!['content'] as JoinedDecisionReceiptContentV2;
    const terminalAt = terminalContent.barrier!.snapshot.updatedAt;
    const envelope = (executionExplanation['evidence_used'] as Array<Record<string, unknown>>)[0]!;
    tamper(envelope, terminalAt);
    const parsed = buildGmailArchiveReconciliationTerminalEnvelope({
      phase: envelope['attemptPhase'] as 'dispatch_may_have_started',
      phaseChangedAt: envelope['phaseChangedAt'] as string,
      evidence: envelope['evidence'] as never,
    });
    const semantics = gmailArchiveReconciliationExplanationSemantics(parsed);
    executionExplanation['what_happened'] = semantics.whatHappened;
    executionExplanation['confidence_reasoning'] = semantics.confidenceReasoning;
    executionExplanation['escalation_rationale'] = semantics.escalationRationale;
    executionExplanation['correction_guidance'] = semantics.correctionGuidance;
    rehashReconciliationExplanation(payload, executionExplanation);

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has invalid Gmail terminal explanation',
    );
  });

  it('uses the unique execution-recorded instant despite a later continuation timestamp', () => {
    const { payload, executionExplanation } = reconciliationTerminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const r7 = revisions.at(-1)!;
    const r7Content = r7['content'] as JoinedDecisionReceiptContentV2;
    const r7At = r7Content.barrier!.snapshot.updatedAt;
    const laterAt = new Date(Date.parse(r7At) + 600_000).toISOString();
    const feedback = {
      id: '13131313-1313-4313-8313-131313131313',
      user_id: (payload['user'] as Record<string, unknown>)['id'],
      decision_id: (bundle['decision'] as Record<string, unknown>)['id'],
      type: 'approval',
      data: {},
      created_at: new Date(laterAt),
    };
    const laterBarrierSnapshot = { ...r7Content.barrier!.snapshot, updatedAt: laterAt };
    const continuation: JoinedDecisionReceiptContentV2 = {
      ...r7Content,
      stage: 'feedback_recorded',
      barrier: {
        ...r7Content.barrier!,
        snapshot: laterBarrierSnapshot,
        canonicalHash: joinedDecisionReceiptArtifactDigest('barrier', laterBarrierSnapshot),
      },
      feedbackEvents: [decisionReceiptRowArtifactRefV1('feedback', feedback)],
    };
    revisions.push({
      id: '14141414-1414-4414-8414-141414141414',
      receipt_id: r7['receipt_id'],
      sequence: 5,
      event_key: buildDecisionReceiptEventKey('feedback_recorded', feedback.id),
      previous_digest: r7['revision_digest'],
      content_digest: '',
      revision_digest: '',
      stage: 'feedback_recorded',
      disposition: continuation.disposition,
      content: continuation,
      candidate_action_id: continuation.candidateAction?.id ?? null,
      barrier_id: continuation.barrier?.id ?? null,
      explanation_id: continuation.explanation?.id ?? null,
      approval_request_id: continuation.approvalRequest?.id ?? null,
      execution_plan_id: continuation.executionPlan?.id ?? null,
      execution_result_id: continuation.executionResult?.id ?? null,
      execution_disposition: continuation.executionDisposition ?? null,
      correction_of_revision_id: continuation.correctionOfRevision?.id ?? null,
      trusted: true,
      created_at: new Date(laterAt),
    });
    const envelope = (executionExplanation['evidence_used'] as Array<Record<string, unknown>>)[0]!;
    envelope['phaseChangedAt'] = new Date(Date.parse(r7At) - 299_999).toISOString();
    const rebuilt = buildGmailArchiveReconciliationTerminalEnvelope({
      phase: 'dispatch_may_have_started',
      phaseChangedAt: envelope['phaseChangedAt'] as string,
      evidence: envelope['evidence'] as never,
    });
    const semantics = gmailArchiveReconciliationExplanationSemantics(rebuilt);
    executionExplanation['what_happened'] = semantics.whatHappened;
    executionExplanation['confidence_reasoning'] = semantics.confidenceReasoning;
    executionExplanation['escalation_rationale'] = semantics.escalationRationale;
    executionExplanation['correction_guidance'] = semantics.correctionGuidance;
    rehashReconciliationExplanation(payload, executionExplanation);

    expect(validateBackupData(payload)).toContain(
      'decisions[0].joinedReceipt has invalid Gmail terminal explanation',
    );
  });

  it('reports a malformed v2 tail with missing inference instead of throwing', () => {
    const { payload } = terminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<{ content: Record<string, unknown> }>;
    }).revisions;
    delete revisions.at(-1)!.content['inference'];

    expect(() => validateBackupData(payload)).not.toThrow();
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0].joinedReceipt failed chain verification',
      'decisions[0].joinedReceipt.revisions[3] has invalid content',
      'decisions[0].joinedReceipt.revisions[3] has inconsistent chain',
    ]));
  });

  it('reports a malformed nested policy evaluation instead of traversing it', () => {
    const { payload } = terminalReceiptPayload();
    const bundle = (payload['decisions'] as Array<Record<string, unknown>>)[0]!;
    const revisions = (bundle['joinedReceipt'] as {
      revisions: Array<{ content: Record<string, unknown> }>;
    }).revisions;
    revisions.at(-1)!.content['policyEvaluations'] = [{}];

    expect(() => validateBackupData(payload)).not.toThrow();
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0].joinedReceipt failed chain verification',
      'decisions[0].joinedReceipt.revisions[3] has invalid content',
      'decisions[0].joinedReceipt.revisions[3] has inconsistent chain',
    ]));
  });

  it('rejects execution-plan payloads instead of exporting portable provider content', () => {
    const payload = validPayload();
    const decisionId = '22222222-2222-4222-8222-222222222222';
    payload['user'] = { ...(payload['user'] as object), id: '11111111-1111-4111-8111-111111111111' };
    payload['decisions'] = [{
      decision: { id: decisionId, user_id: '11111111-1111-4111-8111-111111111111' },
      candidateActions: [], outcome: null, explanations: [], inferenceReceipts: [],
      executionPlans: [{
        id: '33333333-3333-4333-8333-333333333333', decision_id: decisionId,
        action_id: null, status: 'failed',
        steps: [{ accessToken: 'SECRET_MARKER', providerError: 'raw body' }],
        created_at: new Date(), updated_at: new Date(),
      }],
    }];
    expect(validateBackupData(payload)).toContain('decisions[0] has inconsistent execution linkage');
  });

  it('rejects cross-decision candidate and outcome linkage before restore', () => {
    const payload = validPayload();
    const owner = '11111111-1111-4111-8111-111111111111';
    const firstDecision = '22222222-2222-4222-8222-222222222222';
    const secondDecision = '33333333-3333-4333-8333-333333333333';
    const candidateId = '44444444-4444-4444-8444-444444444444';
    const planId = '55555555-5555-4555-8555-555555555555';
    payload['user'] = { ...(payload['user'] as object), id: owner };
    payload['decisions'] = [{
      decision: { id: firstDecision, user_id: owner },
      candidateActions: [{ id: candidateId, decision_id: secondDecision }],
      explanations: [], inferenceReceipts: [], executionPlans: [],
      outcome: {
        id: '66666666-6666-4666-8666-666666666666', decision_id: firstDecision,
        selected_action_id: candidateId, execution_plan_id: planId,
      },
    }, {
      decision: { id: secondDecision, user_id: owner }, candidateActions: [], outcome: null,
      explanations: [], inferenceReceipts: [], executionPlans: [],
    }];
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0] has inconsistent candidate linkage',
      'decisions[0] has inconsistent outcome linkage',
    ]));
  });

  it('rejects decisions and signed receipts attributed to another archive owner', () => {
    const payload = validPayload();
    payload['decisions'] = [{
      decision: { id: 'decision-a', user_id: 'another-user' }, candidateActions: [], outcome: null,
      explanations: [{ id: 'explanation-a', decision_id: 'decision-a' }],
      inferenceReceipts: [{
        id: 'receipt-a', decision_id: 'decision-a', explanation_id: 'explanation-a', status: 'on_device',
        receipt: {
          id: 'receipt-a', userId: 'another-user', decisionId: 'decision-a',
          explanationId: 'explanation-a', status: 'on_device',
        },
      }],
    }];
    expect(validateBackupData(payload)).toEqual(expect.arrayContaining([
      'decisions[0] has inconsistent owner',
      'decisions[0].inferenceReceipts[0] has inconsistent linkage',
    ]));
  });
});

describe('collectBackup workflow export', () => {
  it('exports the complete workflow graph and paused Watch projection from one transaction', async () => {
    const portable = signalDigestWorkflowBundle('paused');
    const workflow = portable['workflow'] as Record<string, unknown>;
    const version = (portable['versions'] as Array<Record<string, unknown>>)[0]!;
    const proposal = (portable['proposals'] as Array<Record<string, unknown>>)[0]!;
    const event = (portable['activationEvents'] as Array<Record<string, unknown>>)[0]!;
    const projection = portable['watchProjection'] as Record<string, unknown>;
    clientQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('SELECT * FROM users')) {
        return { rows: [(validPayload()['user'] as Record<string, unknown>)], rowCount: 1 };
      }
      if (text.includes('SELECT * FROM twin_profiles')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT * FROM preferences')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT * FROM decisions')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT * FROM workflows')) return { rows: [{
        id: workflow['id'], user_id: workflow['userId'], provider_key: workflow['providerKey'],
        active_version_id: workflow['activeVersionId'],
        active_activation_event_id: workflow['activeActivationEventId'],
        created_at: new Date(workflow['createdAt'] as string),
        updated_at: new Date(workflow['updatedAt'] as string),
      }], rowCount: 1 };
      if (text.includes('SELECT * FROM workflow_versions')) return { rows: [{
        id: version['id'], workflow_id: version['workflowId'], user_id: version['userId'],
        version_number: version['versionNumber'], provider_key: version['providerKey'],
        provider_schema_version: version['providerSchemaVersion'],
        canonical_payload: version['canonicalPayload'], content_hash: version['contentHash'],
        parent_version_id: version['parentVersionId'], authoring_metadata: version['authoring'],
        inference_metadata: version['inference'], created_at: new Date(version['createdAt'] as string),
      }], rowCount: 1 };
      if (text.includes('SELECT * FROM workflow_proposals')) return { rows: [{
        id: proposal['id'], workflow_id: proposal['workflowId'], user_id: proposal['userId'],
        base_version_id: proposal['baseVersionId'], proposed_version_id: proposal['proposedVersionId'],
        kind: proposal['kind'], created_at: new Date(proposal['createdAt'] as string),
      }], rowCount: 1 };
      if (text.includes('SELECT * FROM workflow_activation_events')) return { rows: [{
        id: event['id'], workflow_id: event['workflowId'], user_id: event['userId'],
        previous_version_id: event['previousVersionId'],
        activated_version_id: event['activatedVersionId'], proposal_id: event['proposalId'],
        kind: event['kind'], event_sequence: event['eventSequence'],
        created_at: new Date(event['createdAt'] as string),
      }], rowCount: 1 };
      if (text.includes('FROM watches')) return { rows: [{
        id: projection['id'], user_id: projection['userId'],
        name: (projection['snapshot'] as Record<string, unknown>)['name'],
        source_text: projection['sourceText'], status: projection['status'],
        cadence: (projection['snapshot'] as Record<string, unknown>)['cadence'],
        hour_of_day: (projection['snapshot'] as Record<string, unknown>)['hourOfDay'],
        day_of_week: (projection['snapshot'] as Record<string, unknown>)['dayOfWeek'],
        filter: (projection['snapshot'] as Record<string, unknown>)['filter'],
        action: (projection['snapshot'] as Record<string, unknown>)['action'],
        created_at: new Date(projection['createdAt'] as string),
        updated_at: new Date(projection['updatedAt'] as string),
        last_run_at: new Date(projection['lastRunAt'] as string),
        next_run_at: projection['nextRunAt'], schedule_revision: projection['scheduleRevision'],
        workflow_id: projection['workflowId'], workflow_version_id: projection['workflowVersionId'],
        workflow_provider_key: projection['providerKey'],
        workflow_provider_schema_version: projection['providerSchemaVersion'],
        content_hash: projection['contentHash'], projection_version: projection['projectionVersion'],
      }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await collectBackup(USER_ID);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workflows).toEqual([portable]);
      expect(validateBackupData(result.data)).toEqual([]);
      expect(JSON.stringify(result.data.workflows)).not.toContain('sourceBody');
      expect(JSON.stringify(result.data.workflows)).not.toContain('apiKey');
    }
  });
});

describe('restoreBackup guards', () => {
  it('rejects an invalid payload before any DB write', async () => {
    const result = await restoreBackup({ not: 'a backup' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('invalid_data');
  });

  it('rejects an unsupported schema version', async () => {
    const payload = { ...validPayload(), schemaVersion: 999 };
    const result = await restoreBackup(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('unsupported_schema');
  });

  it('refuses to clobber an existing user (fresh-install only)', async () => {
    userExists = true;
    const result = await restoreBackup(validPayload());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('user_exists');
  });

  it('restores a fresh install and reports row counts', async () => {
    userExists = false;
    const result = await restoreBackup(validPayload());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.summary.counts.users).toBe(1);
      expect(result.summary.total).toBeGreaterThanOrEqual(1);
    }
  });

  it('restores workflow identity, versions, proposals, history, then the active pointer', async () => {
    const payload = validPayload();
    const bundle = workflowBundle();
    payload['workflows'] = [bundle];
    const result = await restoreBackup(payload);
    expect(result).toMatchObject({ success: true, summary: { counts: {
      users: 1,
      workflows: 1,
      workflow_versions: 1,
      workflow_proposals: 1,
      workflow_activation_events: 1,
    } } });
    const statements = clientQuery.mock.calls.map(([sql]) => String(sql));
    const indexOf = (needle: string) => statements.findIndex((sql) => sql.includes(needle));
    expect(indexOf('INSERT INTO workflows')).toBeLessThan(indexOf('INSERT INTO workflow_versions'));
    expect(indexOf('INSERT INTO workflow_versions')).toBeLessThan(indexOf('INSERT INTO workflow_proposals'));
    expect(indexOf('INSERT INTO workflow_proposals'))
      .toBeLessThan(indexOf('INSERT INTO workflow_activation_events'));
    expect(indexOf('INSERT INTO workflow_activation_events'))
      .toBeLessThan(indexOf('SET active_version_id = $3, active_activation_event_id = $4'));
    const activationUpdate = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('active_activation_event_id = $4'));
    const activationArgs = activationUpdate?.[1] as unknown[] | undefined;
    expect(activationArgs?.[3]).toBe(
      (bundle['activationEvents'] as Array<Record<string, unknown>>)[0]?.['id'],
    );
  });

  it.each([
    ['active', '2026-06-16T09:00:00.000Z'],
    ['paused', null],
    ['draft', null],
  ] as const)('restores an adaptive Watch in exact %s state', async (status, nextRunAt) => {
    const payload = validPayload();
    payload['workflows'] = [signalDigestWorkflowBundle(status)];

    await expect(restoreBackup(payload)).resolves.toMatchObject({
      success: true,
      summary: { counts: { watches: 1 } },
    });
    const watchInsert = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO watches'));
    expect(watchInsert).toBeDefined();
    const params = watchInsert?.[1] as unknown[];
    expect(params[3]).toBe('Every morning summarize invoice mail.');
    expect(params[9]).toBe(status);
    expect(params[12]).toBe('2026-06-15T00:01:30.000Z');
    expect(params[13]).toBe(nextRunAt);
    expect(params[14]).toBe('ffffffff-ffff-4fff-8fff-ffffffffffff');
  });

  it.each([
    ['legacy invalid Watch', legacyWatchQuarantineBundle],
    ['invalid provider payload', () => invalidSignalDigestQuarantineBundle(false)],
    ['hash-mismatched provider payload', () => invalidSignalDigestQuarantineBundle(true)],
  ])('restores the exact inert Watch snapshot for %s', async (_label, buildBundle) => {
    const payload = validPayload();
    const bundle = buildBundle();
    const projection = bundle['watchProjection'] as Record<string, unknown>;
    const snapshot = projection['snapshot'] as Record<string, unknown>;
    payload['workflows'] = [bundle];

    await expect(restoreBackup(payload)).resolves.toMatchObject({
      success: true,
      summary: { counts: { watches: 1 } },
    });
    const watchInsert = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO watches'));
    expect(watchInsert).toBeDefined();
    const params = watchInsert?.[1] as unknown[];
    expect(params.slice(2, 10)).toEqual([
      snapshot['name'],
      projection['sourceText'],
      snapshot['cadence'],
      snapshot['hourOfDay'],
      snapshot['dayOfWeek'],
      JSON.stringify(snapshot['filter']),
      snapshot['action'],
      projection['status'],
    ]);
    expect(params[13]).toBeNull();
  });

  it('restores user locale and inserts reversed valid workflow lineage in canonical order', async () => {
    const payload = validPayload();
    const user = payload['user'] as Record<string, unknown>;
    user['language'] = 'en-US';
    user['timezone'] = 'America/Los_Angeles';
    const bundle = workflowBundle();
    const versions = bundle['versions'] as Array<Record<string, unknown>>;
    const first = versions[0]!;
    const secondPayload = { filter: { keywords: ['invoice', 'receipt'] }, schedule: { hour: 9, timezone: 'UTC' } };
    const second = {
      ...first,
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      versionNumber: 2,
      canonicalPayload: secondPayload,
      contentHash: workflowVersionContentHash({
        providerKey: first['providerKey'] as string,
        providerSchemaVersion: first['providerSchemaVersion'] as string,
        canonicalPayload: secondPayload,
      }),
      parentVersionId: first['id'],
      createdAt: '2026-06-15T00:00:10.000Z',
    };
    bundle['versions'] = [second, first];
    payload['workflows'] = [bundle];

    await expect(restoreBackup(payload)).resolves.toMatchObject({
      success: true,
      summary: { counts: { workflow_versions: 2 } },
    });
    const userInsert = clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO users'))!;
    expect(userInsert[1]).toEqual(expect.arrayContaining(['en-US', 'America/Los_Angeles']));
    const versionInserts = clientQuery.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO workflow_versions'));
    expect(versionInserts.map(([, args]) => (args as unknown[])[0]))
      .toEqual([first['id'], second.id]);
  });

  it('retries a serialization failure and then restores once', async () => {
    let failOnce = true;
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error('retry'), { code: '40001' });
      }
      return { rows: [], rowCount: typeof sql === 'string' && sql.includes('SELECT id FROM users') ? 0 : 1 };
    });
    await expect(restoreBackup(validPayload())).resolves.toMatchObject({ success: true });
    expect(clientQuery.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('SELECT id FROM users'))).toHaveLength(2);
  });

  it('classifies a 23505 as user_exists only after verifying the same user id', async () => {
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM users')) {
        return { rows: [], rowCount: 0 };
      }
      throw Object.assign(new Error('unique'), { code: '23505' });
    });
    poolQuery.mockResolvedValue({ rows: [{ id: 'u1' }], rowCount: 1 });
    await expect(restoreBackup(validPayload())).resolves.toMatchObject({
      success: false, reason: 'user_exists',
    });
    expect(poolQuery).toHaveBeenCalledWith('SELECT id FROM users WHERE id = $1', [USER_ID]);
  });

  it('reports a non-user 23505 as invalid backup data', async () => {
    clientQuery.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM users')) {
        return { rows: [], rowCount: 0 };
      }
      throw Object.assign(new Error('unique'), { code: '23505' });
    });
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(restoreBackup(validPayload())).resolves.toEqual({
      success: false,
      reason: 'invalid_data',
      message: 'backup restore encountered a conflicting unique artifact',
    });
  });

  it('restores joined receipt roots and revisions without an update path', async () => {
    const payload = validPayload();
    const joinedDecisionId = '22222222-2222-4222-8222-222222222222';
    const joinedRootId = '33333333-3333-4333-8333-333333333333';
    const joinedUserId = '11111111-1111-4111-8111-111111111111';
    const decisionRow = {
      id: joinedDecisionId, user_id: joinedUserId, situation_type: 'test', raw_event: {},
      interpreted_situation: {}, domain: 'test', urgency: 'normal', metadata: {}, created_at: new Date(),
    };
    const content = {
      version: 1 as const, stage: 'decision_recorded' as const, disposition: 'pending' as const,
      policyEvaluations: [],
      decision: {
        id: joinedDecisionId,
        canonicalHash: joinedDecisionReceiptArtifactDigest('decision', {
          id: joinedDecisionId, user_id: joinedUserId, situation_type: 'test', raw_event: {},
          interpreted_situation: {}, domain: 'test', urgency: 'normal', metadata: {},
        }),
      },
      evidence: [], inference: { receipts: [] }, feedbackEvents: [], corrections: [],
    };
    payload['user'] = { ...(payload['user'] as object), id: joinedUserId };
    const contentDigest = joinedDecisionReceiptContentDigest(content);
    const receiptEventKey = buildDecisionReceiptEventKey('created', '55555555-5555-4555-8555-555555555555');
    payload['decisions'] = [{
      decision: decisionRow,
      candidateActions: [], outcome: null, explanations: [], inferenceReceipts: [],
      executionPlans: [], ingestState: null,
      joinedReceipt: {
        root: { id: joinedRootId, user_id: joinedUserId, decision_id: joinedDecisionId, created_at: new Date() },
        revisions: [{
          id: '44444444-4444-4444-8444-444444444444', receipt_id: joinedRootId, sequence: '1',
          event_key: receiptEventKey,
          previous_digest: null, content_digest: contentDigest,
          revision_digest: joinedDecisionReceiptRevisionDigest({
            revisionId: '44444444-4444-4444-8444-444444444444',
            receiptId: joinedRootId, decisionId: joinedDecisionId, userId: joinedUserId,
            sequence: 1, eventKey: receiptEventKey, previousDigest: null, contentDigest,
          }),
          stage: content.stage, disposition: content.disposition, content,
          candidate_action_id: null, barrier_id: null, explanation_id: null,
          approval_request_id: null, execution_plan_id: null, execution_result_id: null,
          execution_disposition: null,
          correction_of_revision_id: null, created_at: new Date(),
          trusted: true,
        }],
      },
    }];
    const result = await restoreBackup(payload);
    expect(result).toMatchObject({ success: true, summary: { counts: {
      decision_receipts: 1, decision_receipt_revisions: 1,
    } } });
    expect(clientQuery.mock.calls.some(([sql]) =>
      typeof sql === 'string' && /UPDATE\s+decision_receipt/iu.test(sql))).toBe(false);
    const revisionInsert = clientQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO decision_receipt_revisions'));
    const revisionParams = revisionInsert?.[1] as unknown[] | undefined;
    expect(revisionParams?.[2]).toBe(1);
  });

  it('restores an explicit receipt-free schema-v1 archive', async () => {
    const payload = validPayload();
    payload['schemaVersion'] = 1;
    const result = await restoreBackup(payload);
    expect(result.success).toBe(true);
  });

  it('restores legacy decisions with a non-replay tombstone', async () => {
    const payload = validPayload();
    payload['schemaVersion'] = 2;
    payload['decisions'] = [{
      decision: {
        id: DECISION_ID, user_id: USER_ID, situation_type: 'test', raw_event: {},
        interpreted_situation: {}, domain: 'test', urgency: 'normal', metadata: {},
        signal_id: null, created_at: new Date('2026-06-15T00:00:00.000Z'),
      },
      candidateActions: [], outcome: null, explanations: [], inferenceReceipts: [],
    }];

    await expect(restoreBackup(payload)).resolves.toMatchObject({ success: true });
    const guardCall = clientQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO decision_ingest_guards'));
    expect(guardCall?.[1]).toEqual([
      DECISION_ID, null, 'non_effect', null, null, 'ambiguous', null,
      new Date('2026-06-15T00:00:00.000Z'),
    ]);
  });

  it('preserves execution-policy-denial explanation types during restore', async () => {
    const payload = validPayload();
    const bundle = decisionBundle();
    bundle['explanations'] = [{
      id: EXPLANATION_ID,
      decision_id: DECISION_ID,
      type: 'execution_policy_denial',
      what_happened: 'Execution was blocked before dispatch.',
      evidence_used: [],
      preferences_invoked: [],
      confidence_reasoning: 'Policy denied the exact prepared risk.',
      action_rationale: 'No action was taken.',
      escalation_rationale: null,
      correction_guidance: 'Review the policy.',
      capability_provenance_node_id: null,
      created_at: new Date('2026-06-15T00:00:00.000Z'),
    }];
    payload['decisions'] = [bundle];

    await expect(restoreBackup(payload)).resolves.toMatchObject({ success: true });
    const explanationInsert = clientQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO explanation_records'));
    const explanationParams = explanationInsert?.[1] as unknown[] | undefined;
    expect(explanationParams?.[2]).toBe('execution_policy_denial');
  });

  it('aborts instead of reporting a receipt whose linkage insert affected no row', async () => {
    const payload = validPayload();
    payload['decisions'] = [decisionBundle()];
    clientQuery.mockImplementation(async (sql: unknown) => ({
      rows: [], rowCount: typeof sql === 'string' && sql.includes('INSERT INTO inference_receipts') ? 0 : 1,
    }));
    await expect(restoreBackup(payload)).rejects.toThrow('could not be linked during restore');
  });
});
