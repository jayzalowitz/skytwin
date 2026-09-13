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
import { closePool, withTransaction } from '../connection.js';
import { collectBackup, restoreBackup } from '../backup/backup.js';
import { inferenceReceiptRepository } from '../repositories/inference-receipt-repository.js';
import { executionRepository } from '../repositories/execution-repository.js';
import { executionAdmissionRepository } from '../repositories/execution-admission-repository.js';
import {
  CredentialConnectionAuthorityError,
  CredentialDisconnectInProgressError,
  oauthRepository,
} from '../repositories/oauth-repository.js';
import { credentialDispatchLeaseRepository } from '../repositories/credential-dispatch-lease-repository.js';
import { credentialVaultMetaRepository } from '../repositories/credential-vault-meta-repository.js';
import { userPurgeRepository } from '../repositories/user-purge-repository.js';
import { policyRepository } from '../repositories/policy-repository.js';
import { decisionRepository } from '../repositories/decision-repository.js';
import { explanationRepositoryAdapter } from '../adapters/explanation-repository-adapter.js';
import { cleanupLegacyFlatDecisions } from '../seeds/legacy-decision-cleanup.js';
import { resetDemoUsers } from '../seeds/demo-fixture.js';
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

function admissionAuthority(graph: Graph) {
  const risk = riskSnapshot(graph.actionId!);
  const actionSnapshot = {
    id: graph.actionId,
    decisionId: graph.decisionId,
    actionType: 'test_action',
    description: 'Test action',
    parameters: { domain: 'test' },
    reversible: true,
  };
  return {
    riskSnapshot: risk,
    sourceRiskSnapshot: risk,
    policySnapshot: { allowed: true, requiresApproval: false, reason: 'e2e policy allowed' },
    actionSnapshot,
    outcomeSnapshot: {
      decisionId: graph.decisionId,
      selectedAction: actionSnapshot,
      autoExecute: true,
      requiresApproval: false,
    },
    preEffectExplanation: {
      whatHappened: 'Approved execution admitted before dispatch.',
      confidenceReasoning: 'e2e risk fixture',
      actionRationale: 'e2e action fixture',
      correctionGuidance: 'Review the terminal observation.',
    },
  };
}

const CURRENT_ALLOWED_POLICY = {
  allowed: true,
  requiresApproval: false,
  reason: 'current e2e policy allowed',
};

function memoryPreEffect() {
  return {
    preEffectOutcome: { explanation: 'admitted before dispatch', confidence: 0.9 },
    preEffectExplanation: {
      whatHappened: 'Memory execution admitted before dispatch.',
      confidenceReasoning: 'e2e risk fixture',
      actionRationale: 'e2e action fixture',
      correctionGuidance: 'Review the terminal observation.',
    },
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

async function prepareCredentialDispatch(label: string) {
  const graph = await createGraph(label, 'auto_execute');
  await inferenceReceiptRepository.createManyForUser(graph.userId, [{
    bundle: receiptBundle(graph),
    trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
  }], completionForGraph(graph, 'auto_execute'));
  const plan = await inferenceReceiptRepository.claimExecutionForDecision(
    graph.userId,
    graph.decisionId,
    completionForGraph(graph, 'auto_execute').continuation,
    [],
    CURRENT_ALLOWED_POLICY,
  );
  if (!plan || !graph.actionId) throw new Error('Credential dispatch fixture was not claimed.');
  const accountEmail = `lease-${randomUUID()}@example.test`;
  const token = await oauthRepository.saveTokenForAccount({
    userId: graph.userId,
    provider: 'google',
    accountEmail,
    accessToken: 'lease-access-token',
    refreshToken: 'lease-refresh-token',
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: ['gmail.modify'],
  });
  const authority = await pool.query<{ execution_authority_revision: string }>(
    'SELECT execution_authority_revision FROM users WHERE id = $1', [graph.userId],
  );
  const policyAuthority = await pool.query<{ revision: string }>(
    'SELECT revision FROM execution_policy_authority WHERE singleton = true',
  );
  return {
    graph,
    plan,
    token,
    accountEmail,
    authorityRevision: authority.rows[0]!.execution_authority_revision,
    policyAuthorityRevision: policyAuthority.rows[0]!.revision,
  };
}

async function deleteUserGraph(userId: string): Promise<void> {
  const ownedPlans = `SELECT ep.id FROM execution_plans ep
    JOIN decisions d ON d.id = ep.decision_id WHERE d.user_id = $1`;
  const ownedDecisions = 'SELECT id FROM decisions WHERE user_id = $1';
  await pool.query('DELETE FROM credential_dispatch_leases WHERE user_id = $1', [userId]);
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

  it('does not let a late OAuth refresh overwrite a rotation or resurrect a disconnect', async () => {
    const owner = await createGraph('oauth-refresh-fence');
    const expiresAt = new Date('2026-09-13T01:00:00Z');
    const original = await oauthRepository.saveTokenForAccount({
      userId: owner.userId,
      provider: 'google',
      accountEmail: `oauth-${owner.userId}@example.test`,
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt,
      scopes: ['gmail.readonly'],
    });
    await pool.query(
      `UPDATE oauth_tokens SET credential_revision = gen_random_uuid(),
                               dispatch_generation = gen_random_uuid()
       WHERE id = $1`,
      [original.id],
    );
    await expect(oauthRepository.rotateTokenIfCurrent({
      id: original.id, userId: owner.userId, provider: 'google',
      expectedAccessToken: 'old-access', expectedRefreshToken: 'old-refresh',
      expectedCredentialRevision: original.credential_revision,
      accessToken: 'late-access', refreshToken: 'late-refresh', expiresAt,
      scopes: ['gmail.readonly'],
    })).resolves.toBeNull();
    await expect(oauthRepository.getToken(owner.userId, 'google')).resolves.toMatchObject({
      access_token: 'old-access', refresh_token: 'old-refresh',
    });

    await oauthRepository.deleteAllForProvider(owner.userId, 'google');
    await expect(oauthRepository.rotateTokenIfCurrent({
      id: original.id, userId: owner.userId, provider: 'google',
      expectedAccessToken: 'old-access', expectedRefreshToken: 'old-refresh',
      expectedCredentialRevision: original.credential_revision,
      accessToken: 'late-access', refreshToken: 'late-refresh', expiresAt,
      scopes: ['gmail.readonly'],
    })).resolves.toBeNull();
    await expect(oauthRepository.getToken(owner.userId, 'google')).resolves.toBeNull();
  });

  it('does not let a provider response paused before vault initialization write plaintext afterward', async () => {
    const owner = await createGraph('oauth-refresh-vault-init-fence');
    const original = await oauthRepository.saveTokenForAccount({
      userId: owner.userId,
      provider: 'google',
      accountEmail: `oauth-vault-init-${owner.userId}@example.test`,
      accessToken: 'access-before-provider-wait',
      refreshToken: 'refresh-before-provider-wait',
      expiresAt: new Date('2026-09-13T01:00:00Z'),
      scopes: ['gmail.readonly'],
    });

    // This creation represents /vault/init committing while the provider call
    // is paused. The late response still holds the exact pre-init row revision,
    // but plaintext persistence must now lose to the durable vault boundary.
    await credentialVaultMetaRepository.create(
      owner.userId,
      Buffer.alloc(16, 7),
      Buffer.alloc(32, 9),
    );
    await expect(oauthRepository.updateAccessTokenIfCurrent({
      id: original.id,
      userId: owner.userId,
      provider: 'google',
      expectedCredentialRevision: original.credential_revision,
      accessToken: 'late-plaintext-provider-response',
      expiresAt: new Date('2026-09-13T03:00:00Z'),
    })).resolves.toBe(false);
    await expect(oauthRepository.rotateTokenIfCurrent({
      id: original.id,
      userId: owner.userId,
      provider: 'google',
      expectedAccessToken: 'access-before-provider-wait',
      expectedRefreshToken: 'refresh-before-provider-wait',
      expectedCredentialRevision: original.credential_revision,
      accessToken: 'late-rotated-plaintext-access',
      refreshToken: 'late-rotated-plaintext-refresh',
      expiresAt: new Date('2026-09-13T03:00:00Z'),
      scopes: ['gmail.readonly'],
    })).resolves.toBeNull();
    await expect(oauthRepository.getToken(owner.userId, 'google')).resolves.toMatchObject({
      access_token: 'access-before-provider-wait',
      credential_revision: original.credential_revision,
    });
  });

  it('does not let a callback exchanged under an old connection epoch resurrect a disconnect', async () => {
    const owner = await createGraph('oauth-callback-fence');
    const accountEmail = `callback-${owner.userId}@example.test`;
    const callbackGeneration = await oauthRepository.getOrCreateConnectionAuthority(
      owner.userId, 'google',
    );
    await oauthRepository.saveTokenForAccount({
      userId: owner.userId, provider: 'google', accountEmail,
      accessToken: 'old-access', refreshToken: 'old-refresh',
      expiresAt: new Date(Date.now() + 60_000), scopes: ['openid'],
      expectedConnectionGeneration: callbackGeneration,
    });

    const begun = await oauthRepository.beginDisconnect(owner.userId, 'google', accountEmail);
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    await expect(oauthRepository.completeDisconnect(
      owner.userId, 'google', begun.accounts,
    )).resolves.toBe(1);

    await expect(oauthRepository.saveTokenForAccount({
      userId: owner.userId, provider: 'google', accountEmail,
      accessToken: 'late-callback-access', refreshToken: 'late-callback-refresh',
      expiresAt: new Date(Date.now() + 60_000), scopes: ['openid'],
      expectedConnectionGeneration: callbackGeneration,
    })).rejects.toBeInstanceOf(CredentialConnectionAuthorityError);
    await expect(oauthRepository.getTokenByAccount(
      owner.userId, 'google', accountEmail,
    )).resolves.toBeNull();

    const freshGeneration = await oauthRepository.getOrCreateConnectionAuthority(
      owner.userId, 'google',
    );
    expect(freshGeneration).not.toBe(callbackGeneration);
    const fresh = await oauthRepository.saveTokenForAccount({
      userId: owner.userId, provider: 'google', accountEmail,
      accessToken: 'fresh-access', refreshToken: 'fresh-refresh',
      expiresAt: new Date(Date.now() + 60_000), scopes: ['openid'],
      expectedConnectionGeneration: freshGeneration,
    });
    expect(fresh).toMatchObject({ access_token: 'fresh-access' });

    await expect(oauthRepository.deleteById(owner.userId, fresh.id)).resolves.toBe(true);
    await expect(oauthRepository.saveTokenForAccount({
      userId: owner.userId, provider: 'google', accountEmail,
      accessToken: 'late-after-delete', refreshToken: 'late-after-delete',
      expiresAt: new Date(Date.now() + 60_000), scopes: ['openid'],
      expectedConnectionGeneration: freshGeneration,
    })).rejects.toBeInstanceOf(CredentialConnectionAuthorityError);

    const unrelatedEmail = `unrelated-${randomUUID()}@example.test`;
    const newUserAuthorizationId = await oauthRepository.issueNewUserAuthorization(
      'google', new Date(Date.now() + 60_000),
    );
    const ownerRow = await pool.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1', [owner.userId],
    );
    const ownerAuthorizationId = await oauthRepository.issueNewUserAuthorization(
      'google', new Date(Date.now() + 60_000),
    );
    await expect(oauthRepository.beginDisconnect(owner.userId, 'google', accountEmail))
      .resolves.toMatchObject({ status: 'not_found' });
    await expect(oauthRepository.claimNewUserAuthorization({
      authorizationId: ownerAuthorizationId,
      provider: 'google',
      accountEmail: ownerRow.rows[0]!.email,
      userName: 'Existing owner',
      trustTier: 'observer',
    })).rejects.toBeInstanceOf(CredentialConnectionAuthorityError);
    const claim = await oauthRepository.claimNewUserAuthorization({
      authorizationId: newUserAuthorizationId,
      provider: 'google',
      accountEmail: unrelatedEmail,
      userName: 'Unrelated signup',
      trustTier: 'observer',
    });
    createdUserIds.push(claim.userId);
    await expect(oauthRepository.saveTokenForAccount({
      userId: claim.userId, provider: 'google', accountEmail: unrelatedEmail,
      accessToken: 'unrelated-access', refreshToken: 'unrelated-refresh',
      expiresAt: new Date(Date.now() + 60_000), scopes: ['openid'],
      newUserAuthorization: { id: newUserAuthorizationId, claimGeneration: claim.claimGeneration },
    })).resolves.toMatchObject({ access_token: 'unrelated-access' });

    const pausedEmail = `paused-${randomUUID()}@example.test`;
    const pausedAuthorizationId = await oauthRepository.issueNewUserAuthorization(
      'google', new Date(Date.now() + 60_000),
    );
    const pausedClaim = await oauthRepository.claimNewUserAuthorization({
      authorizationId: pausedAuthorizationId,
      provider: 'google',
      accountEmail: pausedEmail,
      userName: 'Paused signup',
      trustTier: 'observer',
    });
    createdUserIds.push(pausedClaim.userId);
    await expect(oauthRepository.beginDisconnect(pausedClaim.userId, 'google', pausedEmail))
      .resolves.toMatchObject({ status: 'not_found' });
    await expect(oauthRepository.saveTokenForAccount({
      userId: pausedClaim.userId, provider: 'google', accountEmail: pausedEmail,
      accessToken: 'must-not-persist', refreshToken: 'must-not-persist',
      expiresAt: new Date(Date.now() + 60_000), scopes: ['openid'],
      newUserAuthorization: {
        id: pausedAuthorizationId, claimGeneration: pausedClaim.claimGeneration,
      },
    })).rejects.toBeInstanceOf(CredentialConnectionAuthorityError);
    await expect(oauthRepository.getTokenByAccount(
      pausedClaim.userId, 'google', pausedEmail,
    )).resolves.toBeNull();
  });

  it('rejects a pre-purge account-unknown callback without recreating the user', async () => {
    const owner = await createGraph('oauth-new-user-purge-fence');
    const user = await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [owner.userId]);
    const accountEmail = user.rows[0]!.email;
    const authorizationId = await oauthRepository.issueNewUserAuthorization(
      'google', new Date(Date.now() + 60_000),
    );
    const claimedAuthorizationId = await oauthRepository.issueNewUserAuthorization(
      'google', new Date(Date.now() + 60_000),
    );
    await oauthRepository.claimNewUserAuthorization({
      authorizationId: claimedAuthorizationId,
      provider: 'google',
      accountEmail,
      userName: 'Existing owner',
      trustTier: 'observer',
    });

    await expect(userPurgeRepository.purgeUser(owner.userId)).resolves.toMatchObject({
      userExisted: true,
    });
    await expect(oauthRepository.claimNewUserAuthorization({
      authorizationId,
      provider: 'google',
      accountEmail,
      userName: 'Must not be recreated',
      trustTier: 'observer',
    })).rejects.toBeInstanceOf(CredentialConnectionAuthorityError);
    const recreated = await pool.query('SELECT id FROM users WHERE email = $1', [accountEmail]);
    expect(recreated.rows).toHaveLength(0);
    const pending = await pool.query<{ claimed_owner_key: string | null; claimed_account_key: string | null }>(
      `SELECT claimed_owner_key, claimed_account_key
         FROM oauth_new_user_authorizations WHERE id = $1`, [authorizationId],
    );
    expect(pending.rows).toEqual([{ claimed_owner_key: null, claimed_account_key: null }]);
    const claimedPending = await pool.query(
      'SELECT id FROM oauth_new_user_authorizations WHERE id = $1', [claimedAuthorizationId],
    );
    expect(claimedPending.rows).toHaveLength(0);
    const accountFences = await pool.query<{ account_key: string }>(
      'SELECT account_key FROM oauth_account_connection_authority WHERE provider = $1',
      ['google'],
    );
    expect(accountFences.rows.length).toBeGreaterThan(0);
    expect(accountFences.rows.every((row) => /^[a-f0-9]{64}$/.test(row.account_key))).toBe(true);
    expect(JSON.stringify(accountFences.rows)).not.toContain(accountEmail);
  });

  it('serializes request-start against disconnect and keeps secrets out of lease evidence', async () => {
    const fixture = await prepareCredentialDispatch('credential-race');
    const startInput = {
      userId: fixture.graph.userId,
      provider: 'google',
      accountEmail: fixture.accountEmail,
      decisionId: fixture.graph.decisionId,
      actionId: fixture.graph.actionId!,
      executionPlanId: fixture.plan.id,
      expectedOAuthTokenId: fixture.token.id,
      expectedCredentialRevision: fixture.token.credential_revision,
      expectedAuthorityRevision: fixture.authorityRevision,
      expectedPolicyAuthorityRevision: fixture.policyAuthorityRevision,
    };

    const [startSettled, disconnectSettled] = await Promise.allSettled([
      credentialDispatchLeaseRepository.start(startInput),
      oauthRepository.beginDisconnect(
        fixture.graph.userId, 'google', fixture.accountEmail,
      ),
    ]);
    for (const outcome of [startSettled, disconnectSettled]) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ code: '40001' });
      }
    }
    // A Cockroach serialization loser is known rolled back, not an ambiguous
    // commit. Retry it against the durable winner and assert its typed result.
    const startResult = startSettled.status === 'fulfilled'
      ? startSettled.value
      : await credentialDispatchLeaseRepository.start(startInput);
    const disconnectResult = disconnectSettled.status === 'fulfilled'
      ? disconnectSettled.value
      : await oauthRepository.beginDisconnect(
          fixture.graph.userId, 'google', fixture.accountEmail,
        );
    if (startResult.success) {
      expect(disconnectResult.status).toBe('pending');
      const durable = await pool.query<{
        capability_hash: string;
        credential_revision: string;
        credential_generation: string;
      }>(
        `SELECT capability_hash, credential_revision, credential_generation
           FROM credential_dispatch_leases WHERE execution_plan_id = $1`,
        [fixture.plan.id],
      );
      expect(durable.rows[0]).toMatchObject({
        credential_revision: fixture.token.credential_revision,
        credential_generation: fixture.token.dispatch_generation,
      });
      expect(JSON.stringify(durable.rows[0])).not.toContain('lease-access-token');
      expect(JSON.stringify(durable.rows[0])).not.toContain('lease-refresh-token');
      expect(JSON.stringify(durable.rows[0])).not.toContain(startResult.grant.capability);

      await expect(credentialDispatchLeaseRepository.terminalize({
        userId: fixture.graph.userId,
        executionPlanId: fixture.plan.id,
        capability: startResult.grant.capability,
        leaseGeneration: startResult.grant.leaseGeneration,
        state: 'completed',
      })).resolves.toBe(true);
      await expect(credentialDispatchLeaseRepository.terminalize({
        userId: fixture.graph.userId,
        executionPlanId: fixture.plan.id,
        capability: startResult.grant.capability,
        leaseGeneration: startResult.grant.leaseGeneration,
        state: 'completed',
      })).resolves.toBe(false);
      await expect(oauthRepository.beginDisconnect(
        fixture.graph.userId, 'google', fixture.accountEmail,
      )).resolves.toMatchObject({ status: 'ready' });
    } else {
      expect(startResult.code).toBe('credential_unavailable');
      expect(disconnectResult.status).toBe('ready');
      expect(await pool.query(
        'SELECT 1 FROM credential_dispatch_leases WHERE execution_plan_id = $1',
        [fixture.plan.id],
      )).toMatchObject({ rowCount: 0 });
    }
  });

  it('serializes request-start against exact refresh and vault-rotation mutations', async () => {
    for (const mutation of ['refresh', 'vault-rotation'] as const) {
      const fixture = await prepareCredentialDispatch(`credential-${mutation}`);
      const input = {
        userId: fixture.graph.userId,
        provider: 'google',
        accountEmail: fixture.accountEmail,
        decisionId: fixture.graph.decisionId,
        actionId: fixture.graph.actionId!,
        executionPlanId: fixture.plan.id,
        expectedOAuthTokenId: fixture.token.id,
        expectedCredentialRevision: fixture.token.credential_revision,
        expectedAuthorityRevision: fixture.authorityRevision,
        expectedPolicyAuthorityRevision: fixture.policyAuthorityRevision,
      };
      if (mutation === 'vault-rotation') {
        await pool.query(
          'UPDATE oauth_tokens SET encrypted_access_token = $1 WHERE id = $2',
          [Buffer.from('old-packed-value'), fixture.token.id],
        );
      }
      const runMutation = () => mutation === 'refresh'
        ? oauthRepository.updateAccessTokenIfCurrent({
            id: fixture.token.id,
            userId: fixture.graph.userId,
            provider: 'google',
            expectedCredentialRevision: fixture.token.credential_revision,
            accessToken: 'refreshed-access',
            expiresAt: new Date(Date.now() + 60_000),
          })
        : withTransaction(async (client) => {
            await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [fixture.graph.userId]);
            await oauthRepository.listEncryptedForUser(fixture.graph.userId, client);
            return oauthRepository.rotateEncrypted(fixture.token.id, {
              encryptedAccessToken: Buffer.from('new-packed-value'),
              encryptedRefreshToken: null,
              keyVersion: 2,
            }, client);
          });
      const [startSettled, mutationSettled] = await Promise.allSettled([
        credentialDispatchLeaseRepository.start(input),
        runMutation(),
      ]);
      for (const outcome of [startSettled, mutationSettled]) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toMatchObject({ code: '40001' });
        }
      }
      const started = startSettled.status === 'fulfilled'
        ? startSettled.value
        : await credentialDispatchLeaseRepository.start(input);
      const mutated = mutationSettled.status === 'fulfilled'
        ? mutationSettled.value
        : await runMutation();
      expect(Number(started.success) + Number(mutated)).toBe(1);
      if (started.success) {
        await expect(credentialDispatchLeaseRepository.terminalize({
          userId: fixture.graph.userId,
          executionPlanId: fixture.plan.id,
          capability: started.grant.capability,
          leaseGeneration: started.grant.leaseGeneration,
          state: 'completed',
        })).resolves.toBe(true);
      } else {
        expect(started.code).toBe('credential_unavailable');
      }
    }
  });

  it('blocks reconnect during remote revoke and rejects stale completion after a later reconnect', async () => {
    const fixture = await prepareCredentialDispatch('disconnect-generation');
    const first = await oauthRepository.beginDisconnect(
      fixture.graph.userId, 'google', fixture.accountEmail,
    );
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') return;
    await expect(oauthRepository.saveTokenForAccount({
      userId: fixture.graph.userId,
      provider: 'google',
      accountEmail: fixture.accountEmail,
      accessToken: 'reconnected-access',
      refreshToken: 'reconnected-refresh',
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ['gmail.readonly'],
    })).rejects.toBeInstanceOf(CredentialDisconnectInProgressError);
    await expect(oauthRepository.completeDisconnect(
      fixture.graph.userId, 'google', first.accounts,
    )).resolves.toBe(1);
    await oauthRepository.saveTokenForAccount({
      userId: fixture.graph.userId,
      provider: 'google',
      accountEmail: fixture.accountEmail,
      accessToken: 'reconnected-access',
      refreshToken: 'reconnected-refresh',
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ['gmail.readonly'],
    });
    const second = await oauthRepository.beginDisconnect(
      fixture.graph.userId, 'google', fixture.accountEmail,
    );
    expect(second.status).toBe('ready');
    if (second.status !== 'ready') return;

    await expect(oauthRepository.completeDisconnect(
      fixture.graph.userId, 'google', first.accounts,
    )).resolves.toBe(0);
    await expect(oauthRepository.completeDisconnect(
      fixture.graph.userId, 'google', second.accounts,
    )).resolves.toBe(1);
  });

  it('rejects owner/account mismatch and replay, and keeps an overdue started grant ambiguous', async () => {
    const fixture = await prepareCredentialDispatch('credential-mismatch');
    const other = await createGraph('credential-other', 'auto_execute');
    const base = {
      userId: fixture.graph.userId,
      provider: 'google',
      accountEmail: fixture.accountEmail,
      decisionId: fixture.graph.decisionId,
      actionId: fixture.graph.actionId!,
      executionPlanId: fixture.plan.id,
      expectedOAuthTokenId: fixture.token.id,
      expectedCredentialRevision: fixture.token.credential_revision,
      expectedAuthorityRevision: fixture.authorityRevision,
      expectedPolicyAuthorityRevision: fixture.policyAuthorityRevision,
    };
    await expect(credentialDispatchLeaseRepository.start({
      ...base,
      userId: other.userId,
    })).resolves.toMatchObject({ success: false, code: 'authority_revoked' });
    await expect(credentialDispatchLeaseRepository.start({
      ...base,
      accountEmail: 'other@example.test',
    })).resolves.toMatchObject({ success: false, code: 'credential_unavailable' });

    const started = await credentialDispatchLeaseRepository.start({
      ...base,
      now: new Date(Date.now() - 2_000),
      ttlMs: 1_000,
    });
    expect(started.success).toBe(true);
    await expect(credentialDispatchLeaseRepository.start(base)).resolves.toMatchObject({
      success: false,
      code: 'dispatch_replayed',
    });
    await expect(oauthRepository.beginDisconnect(
      fixture.graph.userId, 'google', fixture.accountEmail,
    )).resolves.toMatchObject({ status: 'pending', retryAfter: null });
    await expect(pool.query<{ state: string }>(
      'SELECT state FROM credential_dispatch_leases WHERE execution_plan_id = $1',
      [fixture.plan.id],
    )).resolves.toMatchObject({ rows: [{ state: 'ambiguous' }] });
    await expect(credentialDispatchLeaseRepository.terminalize({
      userId: fixture.graph.userId,
      executionPlanId: fixture.plan.id,
      capability: started.success ? started.grant.capability : '',
      leaseGeneration: started.success ? started.grant.leaseGeneration : '',
      state: 'completed',
    })).resolves.toBe(true);
    await expect(oauthRepository.beginDisconnect(
      fixture.graph.userId, 'google', fixture.accountEmail,
    )).resolves.toMatchObject({ status: 'ready' });
  });

  it('lets a committed pause or vault lock fence win before request-start authority', async () => {
    const paused = await prepareCredentialDispatch('pause-before-start');
    const pauseClient = await pool.connect();
    try {
      await pauseClient.query('BEGIN');
      await pauseClient.query(
        `UPDATE users SET autonomy_settings = jsonb_set(autonomy_settings, '{paused}', 'true'::JSONB)
          WHERE id = $1`,
        [paused.graph.userId],
      );
      const pendingStart = credentialDispatchLeaseRepository.start({
        userId: paused.graph.userId, provider: 'google', accountEmail: paused.accountEmail,
        decisionId: paused.graph.decisionId, actionId: paused.graph.actionId!,
        executionPlanId: paused.plan.id, expectedOAuthTokenId: paused.token.id,
        expectedCredentialRevision: paused.token.credential_revision,
        expectedAuthorityRevision: paused.authorityRevision,
        expectedPolicyAuthorityRevision: paused.policyAuthorityRevision,
      });
      await pauseClient.query('COMMIT');
      await expect(pendingStart).resolves.toMatchObject({
        success: false,
        code: 'authority_revoked',
      });
    } finally {
      await pauseClient.query('ROLLBACK').catch(() => undefined);
      pauseClient.release();
    }

    const locked = await prepareCredentialDispatch('vault-lock-before-start');
    const materializedRevision = locked.token.credential_revision;
    await oauthRepository.fenceVaultLock(locked.graph.userId);
    await expect(credentialDispatchLeaseRepository.start({
      userId: locked.graph.userId, provider: 'google', accountEmail: locked.accountEmail,
      decisionId: locked.graph.decisionId, actionId: locked.graph.actionId!,
      executionPlanId: locked.plan.id, expectedOAuthTokenId: locked.token.id,
      expectedCredentialRevision: materializedRevision,
      expectedAuthorityRevision: locked.authorityRevision,
      expectedPolicyAuthorityRevision: locked.policyAuthorityRevision,
    })).resolves.toMatchObject({ success: false, code: 'credential_unavailable' });
  });

  it('rejects a request-start claim after a trust or policy authority revision changes', async () => {
    const fixture = await prepareCredentialDispatch('authority-revision-before-start');
    await pool.query(
      `UPDATE users
          SET trust_tier = 'observer', execution_authority_revision = gen_random_uuid()
        WHERE id = $1`,
      [fixture.graph.userId],
    );
    await expect(credentialDispatchLeaseRepository.start({
      userId: fixture.graph.userId,
      provider: 'google',
      accountEmail: fixture.accountEmail,
      decisionId: fixture.graph.decisionId,
      actionId: fixture.graph.actionId!,
      executionPlanId: fixture.plan.id,
      expectedOAuthTokenId: fixture.token.id,
      expectedCredentialRevision: fixture.token.credential_revision,
      expectedAuthorityRevision: fixture.authorityRevision,
      expectedPolicyAuthorityRevision: fixture.policyAuthorityRevision,
    })).resolves.toMatchObject({ success: false, code: 'authority_revoked' });
    await expect(pool.query(
      'SELECT 1 FROM credential_dispatch_leases WHERE execution_plan_id = $1',
      [fixture.plan.id],
    )).resolves.toMatchObject({ rowCount: 0 });

    const policyFixture = await prepareCredentialDispatch('policy-revision-before-start');
    await pool.query(
      `UPDATE execution_policy_authority
          SET revision = gen_random_uuid(), updated_at = now()
        WHERE singleton = true`,
    );
    await expect(credentialDispatchLeaseRepository.start({
      userId: policyFixture.graph.userId,
      provider: 'google',
      accountEmail: policyFixture.accountEmail,
      decisionId: policyFixture.graph.decisionId,
      actionId: policyFixture.graph.actionId!,
      executionPlanId: policyFixture.plan.id,
      expectedOAuthTokenId: policyFixture.token.id,
      expectedCredentialRevision: policyFixture.token.credential_revision,
      expectedAuthorityRevision: policyFixture.authorityRevision,
      expectedPolicyAuthorityRevision: policyFixture.policyAuthorityRevision,
    })).resolves.toMatchObject({ success: false, code: 'authority_revoked' });
    await expect(pool.query(
      'SELECT 1 FROM credential_dispatch_leases WHERE execution_plan_id = $1',
      [policyFixture.plan.id],
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it('fences another user\'s request-start when purge removes a global policy', async () => {
    const policyOwner = await createGraph('cross-user-policy-owner');
    await policyRepository.createPolicy({
      userId: policyOwner.userId,
      name: 'Temporary global policy',
      domain: 'email',
      rules: [],
      isActive: true,
    });
    const fixture = await prepareCredentialDispatch('cross-user-policy-dispatch');

    await expect(userPurgeRepository.purgeUser(policyOwner.userId)).resolves.toMatchObject({
      userExisted: true,
    });
    await expect(credentialDispatchLeaseRepository.start({
      userId: fixture.graph.userId,
      provider: 'google',
      accountEmail: fixture.accountEmail,
      decisionId: fixture.graph.decisionId,
      actionId: fixture.graph.actionId!,
      executionPlanId: fixture.plan.id,
      expectedOAuthTokenId: fixture.token.id,
      expectedCredentialRevision: fixture.token.credential_revision,
      expectedAuthorityRevision: fixture.authorityRevision,
      expectedPolicyAuthorityRevision: fixture.policyAuthorityRevision,
    })).resolves.toMatchObject({ success: false, code: 'authority_revoked' });
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
    const executionSteps: unknown[] = [];

    const receiptAuthority = [
      ['policy_snapshot', continuation.outcome.policyVerdicts ?? {}],
      ['continuation_snapshot', continuation],
      ['risk_snapshot', continuation.outcome.riskAssessment],
    ] as const;
    for (const [column, original] of receiptAuthority) {
      await pool.query(
        `UPDATE decision_ingest_guards SET ${column} = '{"tampered":true}'::JSONB WHERE decision_id = $1`,
        [owner.decisionId],
      );
      await expect(inferenceReceiptRepository.claimExecutionForDecision(
        owner.userId, owner.decisionId, continuation, executionSteps, CURRENT_ALLOWED_POLICY,
      )).resolves.toBeNull();
      await pool.query(
        `UPDATE decision_ingest_guards SET ${column} = $2::JSONB WHERE decision_id = $1`,
        [owner.decisionId, JSON.stringify(original)],
      );
    }

    const claims = await Promise.all([
      inferenceReceiptRepository.claimExecutionForDecision(
        owner.userId, owner.decisionId, continuation, [], CURRENT_ALLOWED_POLICY,
      ),
      inferenceReceiptRepository.claimExecutionForDecision(
        owner.userId, owner.decisionId, continuation, [], CURRENT_ALLOWED_POLICY,
      ),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const plan = claims.find((claim) => claim !== null)!;
    await expect(inferenceReceiptRepository.getContinuationForDecision(
      owner.userId, owner.decisionId,
    )).resolves.toMatchObject({
      effectState: 'running',
      sourceExecutionPlanId: plan.id,
    });
    await expect(inferenceReceiptRepository.isExecutionDispatchableForDecision(
      owner.userId, owner.decisionId, plan.id, continuation, executionSteps,
      CURRENT_ALLOWED_POLICY,
    )).resolves.toBe(true);
    const liveReceiptAuthority = [
      ['policy_snapshot', continuation.outcome.policyVerdicts ?? {}],
      ['continuation_snapshot', continuation],
      ['risk_snapshot', continuation.outcome.riskAssessment],
      ['dispatch_policy_snapshot', CURRENT_ALLOWED_POLICY],
    ] as const;
    for (const [column, original] of liveReceiptAuthority) {
      await pool.query(
        `UPDATE decision_ingest_guards SET ${column} = '{"tampered":true}'::JSONB WHERE decision_id = $1`,
        [owner.decisionId],
      );
      await expect(inferenceReceiptRepository.isExecutionDispatchableForDecision(
        owner.userId, owner.decisionId, plan.id, continuation, executionSteps,
        CURRENT_ALLOWED_POLICY,
      )).resolves.toBe(false);
      await pool.query(
        `UPDATE decision_ingest_guards SET ${column} = $2::JSONB WHERE decision_id = $1`,
        [owner.decisionId, JSON.stringify(original)],
      );
    }
    await pool.query(
      `UPDATE execution_plans SET steps = '[{"type":"tampered"}]'::JSONB WHERE id = $1`,
      [plan.id],
    );
    await expect(inferenceReceiptRepository.isExecutionDispatchableForDecision(
      owner.userId, owner.decisionId, plan.id, continuation, executionSteps,
      CURRENT_ALLOWED_POLICY,
    )).resolves.toBe(false);
    await pool.query('UPDATE execution_plans SET steps = $2::JSONB WHERE id = $1', [
      plan.id, JSON.stringify(executionSteps),
    ]);
    await expect(inferenceReceiptRepository.isExecutionDispatchableForDecision(
      owner.userId, owner.decisionId, plan.id,
      continuation, executionSteps,
      { allowed: true, requiresApproval: false, reason: 'changed after claim' },
    )).resolves.toBe(false);
    await pool.query(
      `UPDATE users SET autonomy_settings = '{"paused":true}'::JSONB WHERE id = $1`,
      [owner.userId],
    );
    await expect(inferenceReceiptRepository.isExecutionDispatchableForDecision(
      owner.userId, owner.decisionId, plan.id, continuation, executionSteps,
      CURRENT_ALLOWED_POLICY,
    )).resolves.toBe(false);
  });

  it('durably admits one approved execution and reconciles its exact terminal plan', async () => {
    const owner = await createGraph('approval-admission', 'approval');
    const other = await createGraph('approval-admission-other', 'approval');
    const approval = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests
         (user_id, decision_id, candidate_action, reason, urgency, status, responded_at)
       VALUES ($1, $2, $3::JSONB, 'approved in e2e', 'normal', 'approved', now())
       RETURNING id`,
      [owner.userId, owner.decisionId, JSON.stringify({
        id: owner.actionId, actionType: 'test_action', description: 'Test action',
      })],
    );

    const exactAdmission = {
      userId: owner.userId,
      approvalId: approval.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      steps: [{ type: 'test_action', status: 'pending' }],
      ...admissionAuthority(owner),
    };
    const admitted = await executionAdmissionRepository.admitApprovalExecution(exactAdmission);
    expect(admitted).toMatchObject({ created: true, barrier: { status: 'in_progress' } });
    const duplicate = await executionAdmissionRepository.admitApprovalExecution({
      userId: owner.userId,
      approvalId: approval.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      steps: [{ type: 'test_action', status: 'pending' }],
      ...admissionAuthority(owner),
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.plan.id).toBe(admitted.plan.id);
    await expect(executionAdmissionRepository.admitApprovalExecution({
      userId: owner.userId,
      approvalId: approval.rows[0]!.id,
      decisionId: other.decisionId,
      actionId: owner.actionId!,
      steps: [{ type: 'test_action', status: 'pending' }],
      ...admissionAuthority(owner),
    })).rejects.toThrow(/conflict.*requested authority/);

    await expect(executionAdmissionRepository.isDispatchable(
      admitted, exactAdmission,
    )).resolves.toBe(true);
    const barrierAuthority = [
      ['risk_snapshot', exactAdmission.riskSnapshot],
      ['policy_snapshot', exactAdmission.policySnapshot],
      ['action_snapshot', exactAdmission.actionSnapshot],
      ['outcome_snapshot', exactAdmission.outcomeSnapshot],
    ] as const;
    for (const [column, original] of barrierAuthority) {
      await pool.query(
        `UPDATE execution_admission_barriers SET ${column} = '{"tampered":true}'::JSONB WHERE id = $1`,
        [admitted.barrier.id],
      );
      await expect(executionAdmissionRepository.isDispatchable(
        admitted, exactAdmission,
      )).resolves.toBe(false);
      await pool.query(
        `UPDATE execution_admission_barriers SET ${column} = $2::JSONB WHERE id = $1`,
        [admitted.barrier.id, JSON.stringify(original)],
      );
    }
    await pool.query(
      `UPDATE execution_plans SET steps = '[{"type":"tampered"}]'::JSONB WHERE id = $1`,
      [admitted.plan.id],
    );
    await expect(executionAdmissionRepository.isDispatchable(
      admitted, exactAdmission,
    )).resolves.toBe(false);
    await pool.query('UPDATE execution_plans SET steps = $2::JSONB WHERE id = $1', [
      admitted.plan.id, JSON.stringify(exactAdmission.steps),
    ]);
    await expect(executionAdmissionRepository.admitApprovalExecution({
      userId: owner.userId,
      approvalId: approval.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: other.actionId!,
      steps: [{ type: 'test_action', status: 'pending' }],
      ...admissionAuthority(owner),
    })).rejects.toThrow(/conflict.*requested authority/);
    await expect(executionAdmissionRepository.admitApprovalExecution({
      userId: owner.userId,
      approvalId: approval.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      steps: [{ type: 'different_action', status: 'pending' }],
      ...admissionAuthority(owner),
    })).rejects.toThrow(/conflict.*requested authority/);

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
    // Memory admission owns creation of the immutable pre-effect outcome.
    await pool.query('DELETE FROM decision_outcomes WHERE id = $1', [owner.outcomeId]);
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
      ...admissionAuthority(owner),
      ...memoryPreEffect(),
      report,
    });
    const duplicate = await executionAdmissionRepository.admitMemoryExecution({
      userId: owner.userId,
      opportunityId: opportunity.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      steps: [{ type: 'test_action', status: 'pending' }],
      ...admissionAuthority(owner),
      ...memoryPreEffect(),
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
    const linkedEvidence = await pool.query(
      `SELECT o.auto_executed, o.requires_approval, er.what_happened
       FROM execution_admission_barriers b
       JOIN decision_outcomes o ON o.id = b.outcome_id AND o.decision_id = b.decision_id
       JOIN explanation_records er ON er.id = b.explanation_id AND er.decision_id = b.decision_id
       WHERE b.id = $1`,
      [admitted.barrier.id],
    );
    expect(linkedEvidence.rows[0]).toMatchObject({
      auto_executed: true,
      requires_approval: false,
      what_happened: 'Memory execution admitted before dispatch.',
    });
  });

  it('refuses account purge while a durable admission remains live', async () => {
    const owner = await createGraph('admission-purge', 'approval');
    const approval = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests
         (user_id, decision_id, candidate_action, reason, urgency, status, responded_at)
       VALUES ($1, $2, $3::JSONB, 'purge e2e', 'normal', 'approved', now())
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
      ...admissionAuthority(owner),
    });
    expect(await pool.query(
      'SELECT execution_plan_id FROM decision_outcomes WHERE id = $1',
      [owner.outcomeId],
    )).toMatchObject({ rows: [{ execution_plan_id: admitted.plan.id }] });

    await expect(userPurgeRepository.purgeUser(owner.userId)).rejects.toMatchObject({
      code: 'active_execution_admission',
    });
    expect(await pool.query('SELECT 1 FROM users WHERE id = $1', [owner.userId]))
      .toMatchObject({ rowCount: 1 });
    expect(await pool.query('SELECT 1 FROM execution_admission_barriers WHERE id = $1', [admitted.barrier.id]))
      .toMatchObject({ rowCount: 1 });
  });

  it('serializes account purge against approval admission without erasing live authority', async () => {
    const owner = await createGraph('admission-purge-race', 'approval');
    const approval = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests
         (user_id, decision_id, candidate_action, reason, urgency, status, responded_at)
       VALUES ($1, $2, $3::JSONB, 'purge race', 'normal', 'approved', now())
       RETURNING id`,
      [owner.userId, owner.decisionId, JSON.stringify({
        id: owner.actionId, actionType: 'test_action', description: 'Test action',
      })],
    );
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [owner.userId]);

    const admissionPromise = executionAdmissionRepository.admitApprovalExecution({
      userId: owner.userId,
      approvalId: approval.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      steps: [{ type: 'test_action', status: 'pending' }],
      ...admissionAuthority(owner),
    });
    const purgePromise = userPurgeRepository.purgeUser(owner.userId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await blocker.query('COMMIT');
    blocker.release();

    const [admission, purge] = await Promise.allSettled([admissionPromise, purgePromise]);
    expect([admission, purge].filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    if (admission.status === 'fulfilled') {
      expect(purge.status).toBe('rejected');
      expect(await pool.query(
        'SELECT 1 FROM execution_admission_barriers WHERE id = $1',
        [admission.value.barrier.id],
      )).toMatchObject({ rowCount: 1 });
      expect(await pool.query('SELECT 1 FROM users WHERE id = $1', [owner.userId]))
        .toMatchObject({ rowCount: 1 });
    } else {
      expect(purge.status).toBe('fulfilled');
      expect(await pool.query('SELECT 1 FROM users WHERE id = $1', [owner.userId]))
        .toMatchObject({ rowCount: 0 });
      createdUserIds.splice(createdUserIds.indexOf(owner.userId), 1);
    }
  });

  it('refuses legacy seed cleanup while an admitted effect may continue', async () => {
    const owner = await createGraph('admission-seed-cleanup', 'approval');
    const approval = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests
         (user_id, decision_id, candidate_action, reason, urgency, status, responded_at)
       VALUES ($1, $2, $3::JSONB, 'seed cleanup', 'normal', 'approved', now())
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
      ...admissionAuthority(owner),
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(cleanupLegacyFlatDecisions(client, owner.userId)).rejects.toMatchObject({
        code: 'active_execution_admission',
      });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    expect(await pool.query(
      'SELECT 1 FROM execution_admission_barriers WHERE id = $1',
      [admitted.barrier.id],
    )).toMatchObject({ rowCount: 1 });
    expect(await pool.query('SELECT 1 FROM decisions WHERE id = $1', [owner.decisionId]))
      .toMatchObject({ rowCount: 1 });
  });

  it('replays the production demo reset across a complete admitted decision graph', async () => {
    const owner = await createGraph('demo-reset', 'approval');
    await pool.query('UPDATE users SET is_demo = true WHERE id = $1', [owner.userId]);
    const approval = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests
         (user_id, decision_id, candidate_action, reason, urgency, status, responded_at)
       VALUES ($1, $2, $3::JSONB, 'demo reset', 'normal', 'approved', now())
       RETURNING id`,
      [owner.userId, owner.decisionId, JSON.stringify({
        id: owner.actionId, actionType: 'test_action', description: 'Test action',
      })],
    );
    await executionAdmissionRepository.admitApprovalExecution({
      userId: owner.userId,
      approvalId: approval.rows[0]!.id,
      decisionId: owner.decisionId,
      actionId: owner.actionId!,
      steps: [{ type: 'test_action', status: 'pending' }],
      ...admissionAuthority(owner),
    });

    await expect(resetDemoUsers()).rejects.toMatchObject({ code: 'active_execution_admission' });
    expect(await pool.query('SELECT 1 FROM users WHERE id = $1', [owner.userId]))
      .toMatchObject({ rowCount: 1 });
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
      CURRENT_ALLOWED_POLICY,
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
      CURRENT_ALLOWED_POLICY,
    )).resolves.toBeNull();
  });
});
