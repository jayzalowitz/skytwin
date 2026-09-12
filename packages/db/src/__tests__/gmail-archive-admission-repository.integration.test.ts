import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskAssessor } from '@skytwin/decision-engine';
import { verifyJoinedDecisionReceiptChain, type JoinedDecisionReceiptContentV2 } from '@skytwin/shared-types';
import { closePool, getPool, withTransaction } from '../connection.js';
import { collectBackup, restoreBackup, validateBackupData } from '../backup/backup.js';
import { decisionReceiptLifecycleRepository } from '../repositories/decision-receipt-lifecycle.js';
import { decisionReceiptRowArtifactRefV1 } from '../repositories/decision-receipt-artifacts.js';
import { up } from '../migrations/001-initial.js';
import {
  gmailArchiveApprovalResponseRepository,
  loadCanonicalGmailArchiveApprovalState,
} from '../repositories/gmail-archive-approval-response-repository.js';
import {
  canonicalGmailArchiveCandidate,
  gmailArchivePreparationRepository,
} from '../repositories/gmail-archive-preparation-repository.js';
import {
  gmailArchiveClaimRepository,
  gmailArchiveClaimTestHooks,
} from '../repositories/gmail-archive-claim-repository.js';
import {
  gmailArchiveTerminalizationRepository,
  gmailArchiveTerminalizationTestHooks,
  parseGmailArchiveTerminalExplanationEvidence,
} from '../repositories/gmail-archive-terminalization-repository.js';
import {
  buildGmailArchiveProposalCandidate,
  gmailArchiveProposalRepository,
} from '../repositories/gmail-archive-proposal-repository.js';
import { gmailMessageRefRepository } from '../repositories/gmail-message-ref-repository.js';

const cockroachAvailable = spawnSync('cockroach', ['version'], { encoding: 'utf8' }).status === 0;
const userId = '11000000-0000-4000-8000-000000000001';
const otherUserId = '11000000-0000-4000-8000-000000000002';
const accountId = '22000000-0000-4000-8000-000000000001';
const gmailModifyScope = 'https://www.googleapis.com/auth/gmail.modify';

async function reservePort(start: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tryPort = (port: number) => {
      const server = createServer();
      server.once('error', (error: NodeJS.ErrnoException) => {
        server.close();
        if (error.code === 'EADDRINUSE' && port < start + 1_000) tryPort(port + 1);
        else reject(error);
      });
      server.listen(port, '127.0.0.1', () => {
        server.close((error) => error ? reject(error) : resolve(port));
      });
    };
    tryPort(start);
  });
}

async function waitForCockroach(port: number, processHandle: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`CockroachDB exited with ${processHandle.exitCode}`);
    const probe = spawnSync('cockroach', [
      'sql', '--insecure', `--host=127.0.0.1:${port}`, '--execute=SELECT 1',
    ], { encoding: 'utf8' });
    if (probe.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('CockroachDB did not become ready');
}

function id(prefix: string, suffix: number): string {
  return `${prefix}000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
}

describe.runIf(cockroachAvailable)('Gmail archive approval and preparation repositories on CockroachDB', () => {
  let cockroach: ChildProcess | undefined;
  let previousDatabaseUrl: string | undefined;

  async function seedOwner(
    ownerUserId = userId,
    ownerAccountId = accountId,
    ownerTokenId = id('55', 1),
    ownerEmail = 'admission-owner@example.test',
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, $2, 'Admission Owner')`,
      [ownerUserId, ownerEmail],
    );
    await getPool().query(
      `INSERT INTO connected_accounts (
         id, user_id, provider, account_id, scopes, is_active,
         provider_subject_digest, account_display, identity_verified
       ) VALUES ($2, $1, 'google', 'owned-account', ARRAY[$3]::STRING[], true,
         $4, 'Owned account', true)`,
      [ownerUserId, ownerAccountId, gmailModifyScope, 'a'.repeat(64)],
    );
    await getPool().query(
      `INSERT INTO oauth_tokens (
         id, user_id, provider, access_token, refresh_token, expires_at, scopes,
         account_email, account_provider_id, connector_account_id
       ) VALUES ($2, $1, 'google', NULL, NULL, now() + INTERVAL '1 hour',
         ARRAY[$3]::STRING[], 'owner@example.test', 'owner', $4)`,
      [ownerUserId, ownerTokenId, gmailModifyScope, ownerAccountId],
    );
  }

  beforeAll(async () => {
    const sqlPort = await reservePort(28_000 + (process.pid % 3_000));
    const httpPort = await reservePort(48_000 + (process.pid % 3_000));
    cockroach = spawn('cockroach', [
      'start-single-node', '--insecure', `--listen-addr=127.0.0.1:${sqlPort}`,
      `--http-addr=127.0.0.1:${httpPort}`, '--store=type=mem,size=0.15',
      '--logtostderr=ERROR',
    ], { stdio: 'ignore' });
    await waitForCockroach(sqlPort, cockroach);
    previousDatabaseUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = `postgresql://root@127.0.0.1:${sqlPort}/defaultdb?sslmode=disable`;
    await up();
    await getPool().query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, 'other-owner@example.test', 'Other Owner')`,
      [otherUserId],
    );
    await seedOwner();
  }, 300_000);

  afterAll(async () => {
    await closePool();
    if (previousDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previousDatabaseUrl;
    cockroach?.kill('SIGTERM');
  });

  async function createProposal(
    suffix: number,
    ownerUserId = userId,
    ownerAccountId = accountId,
  ) {
    const messageRefId = id('33', suffix);
    const signalId = id('44', suffix);
    const decisionId = id('66', suffix);
    const candidateId = id('77', suffix);
    await getPool().query(
      `INSERT INTO gmail_message_refs (
         id, user_id, connector_account_id, provider, provider_message_id,
         provider_thread_id, source_signal_id, authoring_tier,
         last_observed_inbox, first_observed_at, last_observed_at
       ) VALUES ($3, $1, $2, 'google', $4, NULL, $5,
         'inbox_automated', true, now(), now())`,
      [ownerUserId, ownerAccountId, messageRefId, `native-${suffix}`, `source-${suffix}`],
    );
    await getPool().query(
      `INSERT INTO signals (
         id, user_id, source, type, domain, data, timestamp,
         source_signal_id, connector_account_id, resource_ref_id
       ) VALUES ($4, $1, 'gmail', 'email', 'email', '{}', now(), $5, $2, $3)`,
      [ownerUserId, ownerAccountId, messageRefId, signalId, `source-${suffix}`],
    );
    const candidate = buildGmailArchiveProposalCandidate(decisionId, candidateId, messageRefId);
    const proposal = await gmailArchiveProposalRepository.persist({
      userId: ownerUserId,
      connectorAccountId: ownerAccountId,
      messageRefId,
      signalId,
      proposal: {
        candidate,
        riskAssessment: new RiskAssessor().assess(candidate),
      },
    });
    expect(proposal).toMatchObject({ ok: true, created: true });
    if (!proposal.ok) throw new Error(`proposal failed: ${proposal.error}`);
    return { ...proposal.proposal, messageRefId };
  }

  async function artifactCounts(decisionId: string, approvalId: string) {
    const result = await getPool().query<{
      barriers: string;
      explanations: string;
      plans: string;
      revisions: string;
    }>(`SELECT
      (SELECT count(*) FROM pre_effect_barriers WHERE decision_id = $1 OR idempotency_key = $2) AS barriers,
      (SELECT count(*) FROM execution_plans WHERE decision_id = $1) AS plans,
      (SELECT count(*) FROM explanation_records WHERE decision_id = $1) AS explanations,
      (SELECT count(*) FROM decision_receipt_revisions revision
        JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
       WHERE receipt.decision_id = $1) AS revisions`, [decisionId, approvalId]);
    return result.rows[0]!;
  }

  async function createPreparedProposal(
    suffix: number,
    ownerUserId = userId,
    ownerAccountId = accountId,
  ) {
    const proposal = await createProposal(suffix, ownerUserId, ownerAccountId);
    const approved = await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId: ownerUserId,
      action: 'approve',
    });
    expect(approved).toMatchObject({ ok: true, response: { reservedBarrier: { status: 'reserved' } } });
    const prepared = await gmailArchivePreparationRepository.prepare({
      userId: ownerUserId,
      approvalId: proposal.approval.id,
    });
    expect(prepared).toMatchObject({
      ok: true,
      created: true,
      preparation: { status: 'prepared', plan: { status: 'pending' } },
    });
    if (!prepared.ok || prepared.preparation.status !== 'prepared' || !prepared.preparation.plan) {
      throw new Error('Claim fixture did not produce a prepared plan.');
    }
    return {
      proposal,
      prepared: { ...prepared.preparation, plan: prepared.preparation.plan },
    };
  }

  async function createPolicyBlockedProposal(suffix: number) {
    const proposal = await createProposal(suffix);
    const approved = await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId,
      action: 'approve',
    });
    expect(approved).toMatchObject({ ok: true, response: { reservedBarrier: { status: 'reserved' } } });
    const policyId = id('99', suffix);
    await getPool().query(
      `INSERT INTO action_policies (id, user_id, name, domain, rules, priority, is_active)
       VALUES ($1, $2, 'Block archive claim', 'email', $3, 500, true)`,
      [policyId, userId, JSON.stringify([{
        id: `block-archive-claim-${suffix}`,
        policyId,
        condition: { field: 'actionType', operator: 'eq', value: 'archive_email' },
        effect: 'deny',
        reason: 'Archive is disabled.',
      }])],
    );
    try {
      const blocked = await gmailArchivePreparationRepository.prepare({
        userId,
        approvalId: proposal.approval.id,
      });
      expect(blocked).toMatchObject({
        ok: true,
        created: true,
        preparation: { status: 'blocked', plan: null },
      });
      if (!blocked.ok || blocked.preparation.status !== 'blocked') {
        throw new Error('Claim fixture did not produce a policy-blocked graph.');
      }
      return { proposal, blocked: blocked.preparation };
    } finally {
      await getPool().query('DELETE FROM action_policies WHERE id = $1', [policyId]);
    }
  }

  async function createClaimedProposal(
    suffix: number,
    ownerUserId = userId,
    ownerAccountId = accountId,
  ) {
    const fixture = await createPreparedProposal(suffix, ownerUserId, ownerAccountId);
    const claimed = await gmailArchiveClaimRepository.claim({
      userId: ownerUserId,
      approvalId: fixture.proposal.approval.id,
    });
    expect(claimed).toMatchObject({ ok: true, claimed: true });
    if (!claimed.ok || !claimed.claimed) throw new Error('Terminal fixture was not claimed.');
    return { ...fixture, command: claimed.command };
  }

  it('atomically records approval and reserves a distinct, non-executable barrier', async () => {
    const proposal = await createProposal(1);
    const input = {
      approvalId: proposal.approval.id,
      userId,
      action: 'approve' as const,
      reason: 'Archive it',
    };
    const [first, concurrentReplay] = await Promise.all([
      gmailArchiveApprovalResponseRepository.respond(input),
      gmailArchiveApprovalResponseRepository.respond(input),
    ]);
    const results = [first, concurrentReplay];
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    const admitted = results.find((result) => result.ok && result.created);
    if (!admitted?.ok) return;
    expect(admitted.response.approval).toMatchObject({ status: 'approved' });
    expect(admitted.response.proposalBarrier).toMatchObject({
      id: proposal.barrier.id,
      status: 'blocked',
      failure_reason: 'proposal_only_boundary',
    });
    expect(admitted.response.reservedBarrier).toMatchObject({
      status: 'reserved',
      decision_id: null,
      action_id: null,
      explanation_id: null,
      idempotency_key: proposal.approval.id,
      policy_snapshot: {},
      effect_result: {},
    });
    expect(admitted.response.reservedBarrier?.id).not.toBe(proposal.barrier.id);
    expect(admitted.response.revisions.map((revision) => [revision.stage, revision.disposition])).toEqual([
      ['decision_recorded', 'pending'],
      ['policy_evaluated', 'requires_approval'],
      ['approval_recorded', 'requires_approval'],
      ['approval_recorded', 'approved'],
    ]);
    expect(verifyJoinedDecisionReceiptChain({
      receiptId: admitted.response.receipt.id,
      decisionId: proposal.decision.id,
      userId,
      revisions: admitted.response.revisions,
    })).toBe(true);
    const durable = await getPool().query<{ execution_plan_id: string | null; barriers: string; plans: string }>(
      `SELECT outcome.execution_plan_id,
        (SELECT count(*) FROM pre_effect_barriers WHERE decision_id = outcome.decision_id
          OR id = $2) AS barriers,
        (SELECT count(*) FROM execution_plans WHERE decision_id = outcome.decision_id) AS plans
       FROM decision_outcomes outcome WHERE outcome.decision_id = $1`,
      [proposal.decision.id, admitted.response.reservedBarrier!.id],
    );
    expect(durable.rows[0]).toEqual({ execution_plan_id: null, barriers: '2', plans: '0' });
    await expect(gmailMessageRefRepository.resolveInboxMutationTarget({
      userId,
      admissionId: admitted.response.reservedBarrier!.id,
      messageRefId: proposal.messageRefId,
      operation: 'archive',
    })).resolves.toBeNull();
    await expect(gmailArchiveApprovalResponseRepository.respond({ ...input, reason: 'different' })).resolves.toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });
    await expect(gmailArchiveApprovalResponseRepository.respond({ ...input, userId: otherUserId })).resolves.toEqual({
      ok: false,
      error: 'not_found',
    });
  }, 120_000);

  it('records rejection without creating a second barrier and replays exactly', async () => {
    const proposal = await createProposal(2);
    const input = { approvalId: proposal.approval.id, userId, action: 'reject' as const };
    const first = await gmailArchiveApprovalResponseRepository.respond(input);
    const replay = await gmailArchiveApprovalResponseRepository.respond(input);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(replay).toMatchObject({ ok: true, created: false });
    if (!first.ok) return;
    expect(first.response.reservedBarrier).toBeNull();
    expect(first.response.proposalBarrier).toMatchObject({ status: 'blocked' });
    expect(first.response.revisions).toHaveLength(4);
    expect(first.response.revisions.at(-1)).toMatchObject({
      stage: 'approval_recorded',
      disposition: 'rejected',
    });
    const counts = await getPool().query<{ barriers: string; plans: string }>(
      `SELECT
        (SELECT count(*) FROM pre_effect_barriers WHERE decision_id = $1) AS barriers,
        (SELECT count(*) FROM execution_plans WHERE decision_id = $1) AS plans`,
      [proposal.decision.id],
    );
    expect(counts.rows[0]).toEqual({ barriers: '1', plans: '0' });
    await expect(gmailArchiveApprovalResponseRepository.respond({ ...input, action: 'approve' })).resolves.toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });
  });

  it('leaves expired approvals unchanged', async () => {
    const expired = await createProposal(3);
    await getPool().query(
      `UPDATE approval_requests SET expires_at = now() - INTERVAL '1 second' WHERE id = $1`,
      [expired.approval.id],
    );
    await expect(gmailArchiveApprovalResponseRepository.respond({
      approvalId: expired.approval.id,
      userId,
      action: 'approve',
    })).resolves.toEqual({ ok: false, error: 'not_pending_or_expired' });

    const untouched = await getPool().query<{ status: string; revisions: string; barriers: string; plans: string }>(
      `SELECT approval.status,
        (SELECT count(*) FROM decision_receipt_revisions revision
          JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
         WHERE receipt.decision_id = approval.decision_id) AS revisions,
        (SELECT count(*) FROM pre_effect_barriers WHERE decision_id = approval.decision_id) AS barriers,
        (SELECT count(*) FROM execution_plans WHERE decision_id = approval.decision_id) AS plans
       FROM approval_requests approval WHERE approval.id = $1`,
      [expired.approval.id],
    );
    expect(untouched.rows[0]).toEqual({ status: 'pending', revisions: '3', barriers: '1', plans: '0' });
  });

  it('rejects a proposal whose owner-bound signal relation is no longer intact', async () => {
    const proposal = await createProposal(4);
    await getPool().query('DELETE FROM signals WHERE id = $1', [proposal.decision.signal_id]);
    await expect(gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId,
      action: 'approve',
    })).resolves.toEqual({ ok: false, error: 'not_found' });
    const durable = await getPool().query<{ status: string; revisions: string; barriers: string }>(
      `SELECT approval.status,
        (SELECT count(*) FROM decision_receipt_revisions revision
          JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
         WHERE receipt.decision_id = approval.decision_id) AS revisions,
        (SELECT count(*) FROM pre_effect_barriers
          WHERE decision_id = approval.decision_id
             OR idempotency_key = approval.id::STRING) AS barriers
       FROM approval_requests approval WHERE approval.id = $1`,
      [proposal.approval.id],
    );
    expect(durable.rows[0]).toEqual({ status: 'pending', revisions: '3', barriers: '1' });
  });

  it('refuses to append a response after an extra pending approval revision', async () => {
    const proposal = await createProposal(5);
    const pendingContent = proposal.revisions.at(-1)!.content;
    const appended = await withTransaction((client) =>
      decisionReceiptLifecycleRepository.appendForUser(client, userId, {
        eventKind: 'approval_reminded',
        eventId: id('88', 5),
        expectedPreviousDigest: proposal.revisions.at(-1)!.revision_digest,
        content: pendingContent,
      }),
    );
    expect(appended).toMatchObject({ success: true, created: true });

    await expect(gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId,
      action: 'approve',
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    const durable = await getPool().query<{ status: string; revisions: string; barriers: string }>(
      `SELECT approval.status,
        (SELECT count(*) FROM decision_receipt_revisions revision
          JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
         WHERE receipt.decision_id = approval.decision_id) AS revisions,
        (SELECT count(*) FROM pre_effect_barriers
          WHERE decision_id = approval.decision_id
             OR idempotency_key = approval.id::STRING) AS barriers
       FROM approval_requests approval WHERE approval.id = $1`,
      [proposal.approval.id],
    );
    expect(durable.rows[0]).toEqual({ status: 'pending', revisions: '4', barriers: '1' });
  });

  it('returns typed invalid input before opening a transaction', async () => {
    await expect(gmailArchiveApprovalResponseRepository.respond({
      approvalId: 'not-a-uuid',
      userId,
      action: 'approve',
    })).resolves.toEqual({ ok: false, error: 'invalid_input' });
    const revoked = Proxy.revocable({ approvalId: id('88', 1), userId, action: 'approve' as const }, {});
    revoked.revoke();
    await expect(gmailArchiveApprovalResponseRepository.respond(
      revoked.proxy as { approvalId: string; userId: string; action: 'approve' },
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
  });

  it('atomically prepares one policy-checked plan and replays the immutable graph', async () => {
    const proposal = await createProposal(20);
    const approved = await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId,
      action: 'approve',
      reason: 'Archive it',
    });
    expect(approved).toMatchObject({ ok: true, response: { reservedBarrier: { status: 'reserved' } } });

    const [first, concurrent] = await Promise.all([
      gmailArchivePreparationRepository.prepare({ userId, approvalId: proposal.approval.id }),
      gmailArchivePreparationRepository.prepare({ userId, approvalId: proposal.approval.id }),
    ]);
    expect([first, concurrent].map((result) => result.ok ? 'ok' : result.error)).toEqual(['ok', 'ok']);
    expect([first, concurrent]).toMatchObject([{ ok: true }, { ok: true }]);
    expect([first, concurrent].filter((result) => result.ok && result.created)).toHaveLength(1);
    const prepared = [first, concurrent].find((result) => result.ok && result.created);
    if (!prepared?.ok) return;
    expect(prepared.preparation).toMatchObject({
      status: 'prepared',
      barrier: {
        status: 'prepared',
        idempotency_key: proposal.approval.id,
        decision_id: proposal.decision.id,
        action_id: proposal.candidate.id,
        failure_reason: null,
      },
      plan: { status: 'pending', decision_id: proposal.decision.id, action_id: proposal.candidate.id },
    });
    expect(prepared.preparation.barrier.policy_snapshot).toMatchObject({
      version: 1,
      phase: 'post_approval',
      approvalId: proposal.approval.id,
      decisionId: proposal.decision.id,
      candidateActionId: proposal.candidate.id,
      allowed: true,
      requiresApproval: true,
      confirmationLevel: 'single',
      trustTier: 'observer',
      policyIds: [],
    });
    expect(prepared.preparation.plan?.steps).toEqual([{
      type: 'archive_email',
      status: 'pending',
      parameters: {
        schema: 'gmail_inbox_mutation_v1',
        messageRefId: proposal.messageRefId,
        operation: 'archive',
        domain: 'email',
        costZeroIntent: 'verified_zero',
        provenance: 'untrusted_external',
      },
    }]);
    expect(prepared.preparation.revisions.map((revision) => [revision.stage, revision.disposition])).toEqual([
      ['decision_recorded', 'pending'],
      ['policy_evaluated', 'requires_approval'],
      ['approval_recorded', 'requires_approval'],
      ['approval_recorded', 'approved'],
      ['policy_evaluated', 'allowed'],
      ['execution_admitted', 'pending'],
    ]);
    expect(verifyJoinedDecisionReceiptChain({
      receiptId: prepared.preparation.receipt.id,
      decisionId: proposal.decision.id,
      userId,
      revisions: prepared.preparation.revisions,
    })).toBe(true);
    expect(prepared.preparation.explanation.what_happened).toContain('no external action was attempted');
    const durable = await getPool().query<{ proposal_status: string; plans: string; explanations: string }>(
      `SELECT barrier.status AS proposal_status,
        (SELECT count(*) FROM execution_plans WHERE decision_id = $1) AS plans,
        (SELECT count(*) FROM explanation_records WHERE decision_id = $1) AS explanations
       FROM pre_effect_barriers barrier WHERE barrier.id = $2`,
      [proposal.decision.id, proposal.barrier.id],
    );
    expect(durable.rows[0]).toEqual({ proposal_status: 'blocked', plans: '1', explanations: '2' });
    await expect(gmailMessageRefRepository.resolveInboxMutationTarget({
      userId,
      admissionId: prepared.preparation.barrier.id,
      messageRefId: proposal.messageRefId,
      operation: 'archive',
    })).resolves.toBeNull();
    const responseLossReplay = await gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: proposal.approval.id,
    });
    expect(responseLossReplay).toMatchObject({
      ok: true,
      created: false,
      preparation: {
        status: 'prepared',
        barrier: { id: prepared.preparation.barrier.id },
        plan: { id: prepared.preparation.plan!.id },
      },
    });
    if (responseLossReplay.ok) {
      expect(responseLossReplay.preparation.revisions.map((revision) => revision.id)).toEqual(
        prepared.preparation.revisions.map((revision) => revision.id),
      );
    }
  }, 120_000);

  it('rejects an orphan plan before first preparation without adding artifacts', async () => {
    const proposal = await createProposal(27);
    await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId,
      action: 'approve',
    });
    await getPool().query(
      `INSERT INTO execution_plans (id, decision_id, action_id, status, steps)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [id('88', 27), proposal.decision.id, proposal.candidate.id, JSON.stringify([])],
    );
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    const durable = await getPool().query<{ explanations: string; plans: string; revisions: string; status: string }>(
      `SELECT barrier.status,
        (SELECT count(*) FROM execution_plans WHERE decision_id = $1) AS plans,
        (SELECT count(*) FROM explanation_records WHERE decision_id = $1) AS explanations,
        (SELECT count(*) FROM decision_receipt_revisions revision
          JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
         WHERE receipt.decision_id = $1) AS revisions
       FROM pre_effect_barriers barrier WHERE barrier.idempotency_key = $2`,
      [proposal.decision.id, proposal.approval.id],
    );
    expect(durable.rows[0]).toEqual({ status: 'reserved', plans: '1', explanations: '1', revisions: '4' });
  });

  it('rejects prepared replay when an extra plan pollutes the decision graph', async () => {
    const proposal = await createProposal(28);
    await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId,
      action: 'approve',
    });
    const prepared = await gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: proposal.approval.id,
    });
    expect(prepared).toMatchObject({ ok: true, created: true });
    await getPool().query(
      `INSERT INTO execution_plans (id, decision_id, action_id, status, steps)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [id('88', 28), proposal.decision.id, proposal.candidate.id, JSON.stringify([])],
    );
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    const durable = await getPool().query<{ plans: string; revisions: string }>(
      `SELECT
        (SELECT count(*) FROM execution_plans WHERE decision_id = $1) AS plans,
        (SELECT count(*) FROM decision_receipt_revisions revision
          JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
         WHERE receipt.decision_id = $1) AS revisions`,
      [proposal.decision.id],
    );
    expect(durable.rows[0]).toEqual({ plans: '2', revisions: '6' });
  });

  it('rejects untrusted approval and preparation receipt revisions', async () => {
    const approvalProposal = await createProposal(31);
    const approvalInput = {
      approvalId: approvalProposal.approval.id,
      userId,
      action: 'approve' as const,
    };
    await gmailArchiveApprovalResponseRepository.respond(approvalInput);
    await getPool().query(
      `UPDATE decision_receipt_revisions SET trusted = false
        WHERE receipt_id = $1 AND sequence = 4`,
      [approvalProposal.receipt.id],
    );
    await expect(gmailArchiveApprovalResponseRepository.respond(approvalInput)).resolves.toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: approvalProposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const preparedProposal = await createProposal(32);
    await gmailArchiveApprovalResponseRepository.respond({
      approvalId: preparedProposal.approval.id,
      userId,
      action: 'approve',
    });
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: preparedProposal.approval.id,
    })).resolves.toMatchObject({ ok: true, created: true });
    await getPool().query(
      `UPDATE decision_receipt_revisions SET trusted = false
        WHERE receipt_id = $1 AND sequence = 5`,
      [preparedProposal.receipt.id],
    );
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: preparedProposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    await getPool().query(
      `UPDATE decision_receipt_revisions SET trusted = CASE sequence WHEN 5 THEN true ELSE false END
        WHERE receipt_id = $1 AND sequence IN (5, 6)`,
      [preparedProposal.receipt.id],
    );
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: preparedProposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
  });

  it('uses current owner policy and autonomy state to block without a plan', async () => {
    const proposal = await createProposal(21);
    await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId,
      action: 'approve',
    });
    const policyId = id('99', 21);
    await getPool().query(
      `INSERT INTO action_policies (id, user_id, name, domain, rules, priority, is_active)
       VALUES ($1, $2, 'Block archive', 'email', $3, 500, true)`,
      [policyId, userId, JSON.stringify([{
        id: 'block-archive',
        policyId,
        condition: { field: 'actionType', operator: 'eq', value: 'archive_email' },
        effect: 'deny',
        reason: 'Archive is disabled.',
      }])],
    );
    await getPool().query(
      `UPDATE users SET trust_tier = 'low_autonomy', autonomy_settings = $2, updated_at = now()
        WHERE id = $1`,
      [userId, JSON.stringify({
        maxSpendPerActionCents: 0,
        maxDailySpendCents: 0,
        allowedDomains: ['email'],
        blockedDomains: [],
        requireApprovalForIrreversible: true,
      })],
    );
    const blocked = await gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: proposal.approval.id,
    });
    expect(blocked).toMatchObject({
      ok: true,
      created: true,
      preparation: {
        status: 'blocked',
        barrier: {
          status: 'blocked',
          failure_reason: 'post_approval_policy_blocked',
          policy_snapshot: {
            allowed: false,
            requiresApproval: false,
            trustTier: 'low_autonomy',
            policyIds: [policyId],
          },
        },
        plan: null,
        explanation: { preferences_invoked: [policyId] },
      },
    });
    if (!blocked.ok) return;
    expect(blocked.preparation.revisions).toHaveLength(5);
    expect(blocked.preparation.revisions.at(-1)).toMatchObject({
      stage: 'policy_evaluated',
      disposition: 'blocked',
    });
    const counts = await getPool().query<{ plans: string; pointer: string | null }>(
      `SELECT (SELECT count(*) FROM execution_plans WHERE decision_id = outcome.decision_id) AS plans,
              outcome.execution_plan_id AS pointer
         FROM decision_outcomes outcome WHERE outcome.decision_id = $1`,
      [proposal.decision.id],
    );
    expect(counts.rows[0]).toEqual({ plans: '0', pointer: null });
    await getPool().query('DELETE FROM action_policies WHERE id = $1', [policyId]);
    await getPool().query(
      `UPDATE users SET trust_tier = 'observer', autonomy_settings = '{}', updated_at = now() WHERE id = $1`,
      [userId],
    );
  });

  it('rejects foreign outcome links for reserved and blocked preparations without new artifacts', async () => {
    const donor = await createProposal(33);
    await gmailArchiveApprovalResponseRepository.respond({
      approvalId: donor.approval.id,
      userId,
      action: 'approve',
    });
    const donorPreparation = await gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: donor.approval.id,
    });
    expect(donorPreparation).toMatchObject({
      ok: true,
      created: true,
      preparation: { status: 'prepared', plan: { status: 'pending' } },
    });
    if (!donorPreparation.ok || donorPreparation.preparation.status !== 'prepared' ||
        !donorPreparation.preparation.plan) {
      throw new Error('Donor preparation fixture did not produce its required plan.');
    }

    const reserved = await createProposal(34);
    await gmailArchiveApprovalResponseRepository.respond({
      approvalId: reserved.approval.id,
      userId,
      action: 'approve',
    });
    await getPool().query(
      'UPDATE decision_outcomes SET execution_plan_id = $1 WHERE decision_id = $2',
      [donorPreparation.preparation.plan.id, reserved.decision.id],
    );
    const reservedBefore = await artifactCounts(reserved.decision.id, reserved.approval.id);
    expect(reservedBefore).toEqual({ barriers: '2', explanations: '1', plans: '0', revisions: '4' });
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: reserved.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    await expect(artifactCounts(reserved.decision.id, reserved.approval.id)).resolves.toEqual(reservedBefore);

    const blocked = await createProposal(35);
    await gmailArchiveApprovalResponseRepository.respond({
      approvalId: blocked.approval.id,
      userId,
      action: 'approve',
    });
    const policyId = id('99', 35);
    await getPool().query(
      `INSERT INTO action_policies (id, user_id, name, domain, rules, priority, is_active)
       VALUES ($1, $2, 'Block archive replay', 'email', $3, 500, true)`,
      [policyId, userId, JSON.stringify([{
        id: 'block-archive-replay',
        policyId,
        condition: { field: 'actionType', operator: 'eq', value: 'archive_email' },
        effect: 'deny',
        reason: 'Archive is disabled.',
      }])],
    );
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: blocked.approval.id,
    })).resolves.toMatchObject({ ok: true, created: true, preparation: { status: 'blocked' } });
    await getPool().query('DELETE FROM action_policies WHERE id = $1', [policyId]);
    await getPool().query(
      'UPDATE decision_outcomes SET execution_plan_id = $1 WHERE decision_id = $2',
      [donorPreparation.preparation.plan.id, blocked.decision.id],
    );
    const before = await artifactCounts(blocked.decision.id, blocked.approval.id);
    expect(before).toEqual({ barriers: '2', explanations: '2', plans: '0', revisions: '5' });
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: blocked.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    await expect(artifactCounts(blocked.decision.id, blocked.approval.id)).resolves.toEqual(before);
  });

  it('does not prepare when current Inbox or account eligibility is absent', async () => {
    for (const [suffix, mutate] of [
      [22, 'UPDATE gmail_message_refs SET last_observed_inbox = false WHERE id = $1'],
      [23, 'UPDATE connected_accounts SET is_active = false WHERE id = $1'],
    ] as const) {
      const proposal = await createProposal(suffix);
      await gmailArchiveApprovalResponseRepository.respond({
        approvalId: proposal.approval.id,
        userId,
        action: 'approve',
      });
      await getPool().query(mutate, [mutate.includes('connected_accounts') ? accountId : proposal.messageRefId]);
      const result = await gmailArchivePreparationRepository.prepare({
        userId,
        approvalId: proposal.approval.id,
      });
      expect(result).toEqual({ ok: false, error: 'not_ready' });
      const counts = await getPool().query<{ reserved: string; plans: string; revisions: string }>(
        `SELECT
          (SELECT count(*) FROM pre_effect_barriers WHERE idempotency_key = $2 AND status = 'reserved') AS reserved,
          (SELECT count(*) FROM execution_plans WHERE decision_id = $1) AS plans,
          (SELECT count(*) FROM decision_receipt_revisions revision
            JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
           WHERE receipt.decision_id = $1) AS revisions`,
        [proposal.decision.id, proposal.approval.id],
      );
      expect(counts.rows[0]).toEqual({ reserved: '1', plans: '0', revisions: '4' });
      if (mutate.includes('connected_accounts')) {
        await getPool().query('UPDATE connected_accounts SET is_active = true WHERE id = $1', [accountId]);
      }
    }
  });

  it('requires Gmail write scope on both account and credential metadata', async () => {
    for (const [suffix, table] of [[24, 'connected_accounts'], [25, 'oauth_tokens']] as const) {
      const proposal = await createProposal(suffix);
      await gmailArchiveApprovalResponseRepository.respond({
        approvalId: proposal.approval.id,
        userId,
        action: 'approve',
      });
      const accountColumn = table === 'connected_accounts' ? 'id' : 'connector_account_id';
      await getPool().query(`UPDATE ${table} SET scopes = ARRAY[]::STRING[] WHERE ${accountColumn} = $1`, [accountId]);
      await expect(gmailArchivePreparationRepository.prepare({
        userId,
        approvalId: proposal.approval.id,
      })).resolves.toEqual({ ok: false, error: 'not_ready' });
      await getPool().query(
        `UPDATE ${table} SET scopes = ARRAY[$2]::STRING[] WHERE ${accountColumn} = $1`,
        [accountId, gmailModifyScope],
      );
    }
  });

  it('requires the schema-unique current owner/account credential binding', async () => {
    const proposal = await createProposal(29);
    await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId,
      action: 'approve',
    });
    await getPool().query('DELETE FROM oauth_tokens WHERE connector_account_id = $1', [accountId]);
    try {
      await expect(gmailArchivePreparationRepository.prepare({
        userId,
        approvalId: proposal.approval.id,
      })).resolves.toEqual({ ok: false, error: 'not_ready' });
    } finally {
      await getPool().query(
        `INSERT INTO oauth_tokens (
           id, user_id, provider, access_token, refresh_token, expires_at, scopes,
           account_email, account_provider_id, connector_account_id
         ) VALUES ($1, $2, 'google', NULL, NULL, now() + INTERVAL '1 hour',
           ARRAY[$3]::STRING[], 'owner@example.test', 'owner', $4)`,
        [id('55', 1), userId, gmailModifyScope, accountId],
      );
    }
  });

  it('rejects cross-owner and post-approval source-link drift without writes', async () => {
    const proposal = await createProposal(30);
    await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId,
      action: 'approve',
    });
    await expect(gmailArchivePreparationRepository.prepare({
      userId: otherUserId,
      approvalId: proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'not_found' });
    await getPool().query(
      `UPDATE signals SET source_signal_id = 'drifted-source' WHERE id = $1`,
      [proposal.decision.signal_id],
    );
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'not_found' });
    const durable = await getPool().query<{ explanations: string; plans: string; revisions: string; status: string }>(
      `SELECT barrier.status,
        (SELECT count(*) FROM execution_plans WHERE decision_id = $1) AS plans,
        (SELECT count(*) FROM explanation_records WHERE decision_id = $1) AS explanations,
        (SELECT count(*) FROM decision_receipt_revisions revision
          JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
         WHERE receipt.decision_id = $1) AS revisions
       FROM pre_effect_barriers barrier WHERE barrier.idempotency_key = $2`,
      [proposal.decision.id, proposal.approval.id],
    );
    expect(durable.rows[0]).toEqual({ status: 'reserved', plans: '0', explanations: '1', revisions: '4' });
  });

  it('rejects an approved graph whose recorded response is later than expiry', async () => {
    const proposal = await createProposal(26);
    await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId,
      action: 'approve',
    });
    await getPool().query(
      'UPDATE approval_requests SET expires_at = responded_at - INTERVAL \'1 second\' WHERE id = $1',
      [proposal.approval.id],
    );
    await expect(gmailArchivePreparationRepository.prepare({
      userId,
      approvalId: proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'not_found' });
  });

  it('atomically gives one concurrent claimant a frozen command and never appends a receipt', async () => {
    const { proposal, prepared } = await createPreparedProposal(40);
    const input = { userId, approvalId: proposal.approval.id };
    const claims = await Promise.all([
      gmailArchiveClaimRepository.claim(input),
      gmailArchiveClaimRepository.claim(input),
    ]);
    const winners = claims.filter((result) => result.ok && result.claimed);
    expect(winners).toHaveLength(1);
    expect(claims.filter((result) => result.ok && !result.claimed)).toEqual([{
      ok: true,
      claimed: false,
      state: 'in_progress',
      command: null,
    }]);
    const winner = winners[0];
    if (!winner?.ok || !winner.claimed) throw new Error('No claim winner.');
    expect(winner.command).toEqual({
      userId,
      admissionId: prepared.barrier.id,
      messageRefId: proposal.messageRefId,
      operation: 'archive',
    });
    expect(Object.keys(winner.command).sort()).toEqual(['admissionId', 'messageRefId', 'operation', 'userId']);
    expect(Object.isFrozen(winner.command)).toBe(true);
    expect(() => {
      (winner.command as { messageRefId: string }).messageRefId = id('33', 999);
    }).toThrow();

    const durable = await getPool().query<{
      barrier_status: string;
      plan_status: string;
      revisions: string;
      results: string;
      events: string;
    }>(
      `SELECT barrier.status AS barrier_status, plan.status AS plan_status,
         (SELECT count(*) FROM decision_receipt_revisions WHERE receipt_id = $3) AS revisions,
         (SELECT count(*) FROM execution_results WHERE plan_id = plan.id) AS results,
         (SELECT count(*) FROM execution_events WHERE plan_id = plan.id) AS events
       FROM pre_effect_barriers AS barrier
       JOIN execution_plans AS plan ON plan.id = $2
       WHERE barrier.id = $1`,
      [prepared.barrier.id, prepared.plan.id, prepared.receipt.id],
    );
    expect(durable.rows[0]).toEqual({
      barrier_status: 'in_progress',
      plan_status: 'in_progress',
      revisions: '6',
      results: '0',
      events: '0',
    });
    await expect(gmailMessageRefRepository.resolveInboxMutationTarget(winner.command)).resolves.toEqual({
      connectorAccountId: accountId,
      providerMessageId: 'native-40',
    });
    await expect(gmailArchiveClaimRepository.claim(input)).resolves.toEqual({
      ok: true,
      claimed: false,
      state: 'in_progress',
      command: null,
    });
  }, 120_000);

  it('fails closed on cross-owner, mixed, and incomplete terminal states', async () => {
    const crossOwner = await createPreparedProposal(41);
    await expect(gmailArchiveClaimRepository.claim({
      userId: otherUserId,
      approvalId: crossOwner.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'not_found' });

    const mixed = await createPreparedProposal(42);
    await getPool().query(
      `UPDATE execution_plans SET status = 'in_progress' WHERE id = $1`,
      [mixed.prepared.plan.id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: mixed.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    const mixedState = await getPool().query<{ barrier: string; plan: string }>(
      `SELECT barrier.status AS barrier, plan.status AS plan
         FROM pre_effect_barriers barrier, execution_plans plan
        WHERE barrier.id = $1 AND plan.id = $2`,
      [mixed.prepared.barrier.id, mixed.prepared.plan.id],
    );
    expect(mixedState.rows[0]).toEqual({ barrier: 'prepared', plan: 'in_progress' });

    const incompleteTerminal = await createPreparedProposal(43);
    await getPool().query(
      `UPDATE pre_effect_barriers
          SET status = 'blocked', effect_result = '{"dispatched":false}', failure_reason = 'stopped_before_claim'
        WHERE id = $1`,
      [incompleteTerminal.prepared.barrier.id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: incompleteTerminal.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
  }, 120_000);

  it('recognizes only the complete policy-blocked terminal graph', async () => {
    const legitimate = await createPolicyBlockedProposal(54);
    const legitimateInput = { userId, approvalId: legitimate.proposal.approval.id };
    await expect(gmailArchiveClaimRepository.claim({
      ...legitimateInput,
    })).resolves.toEqual({ ok: true, claimed: false, state: 'terminal', command: null });

    await getPool().query(
      'UPDATE pre_effect_barriers SET action_id = NULL WHERE id = $1',
      [legitimate.blocked.barrier.id],
    );
    await expect(gmailArchiveClaimRepository.claim(legitimateInput)).resolves.toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });
    await getPool().query(
      'UPDATE pre_effect_barriers SET action_id = $2 WHERE id = $1',
      [legitimate.blocked.barrier.id, legitimate.proposal.candidate.id],
    );

    await getPool().query(
      `UPDATE pre_effect_barriers SET policy_snapshot = jsonb_set(policy_snapshot, '{allowed}', 'true')
        WHERE id = $1`,
      [legitimate.blocked.barrier.id],
    );
    await expect(gmailArchiveClaimRepository.claim(legitimateInput)).resolves.toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });
    await getPool().query(
      'UPDATE pre_effect_barriers SET policy_snapshot = $2::JSONB WHERE id = $1',
      [legitimate.blocked.barrier.id, JSON.stringify(legitimate.blocked.barrier.policy_snapshot)],
    );

    await getPool().query(
      `UPDATE explanation_records SET what_happened = 'tampered' WHERE id = $1`,
      [legitimate.blocked.explanation.id],
    );
    await expect(gmailArchiveClaimRepository.claim(legitimateInput)).resolves.toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });
    await getPool().query(
      'UPDATE explanation_records SET what_happened = $2 WHERE id = $1',
      [legitimate.blocked.explanation.id, legitimate.blocked.explanation.what_happened],
    );
    await expect(gmailArchiveClaimRepository.claim(legitimateInput)).resolves.toEqual({
      ok: true,
      claimed: false,
      state: 'terminal',
      command: null,
    });

    const wrongResult = await createPolicyBlockedProposal(55);
    await getPool().query(
      `UPDATE pre_effect_barriers SET effect_result = '{"dispatched":true}' WHERE id = $1`,
      [wrongResult.blocked.barrier.id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: wrongResult.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const extraPlan = await createPolicyBlockedProposal(56);
    await getPool().query(
      `INSERT INTO execution_plans (id, decision_id, action_id, status, steps)
       VALUES ($1, $2, $3, 'pending', '[]')`,
      [id('88', 56), extraPlan.proposal.decision.id, extraPlan.proposal.candidate.id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: extraPlan.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const receiptTamper = await createPolicyBlockedProposal(57);
    await getPool().query(
      `UPDATE decision_receipt_revisions SET trusted = false
        WHERE receipt_id = $1 AND sequence = 5`,
      [receiptTamper.blocked.receipt.id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: receiptTamper.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
  }, 120_000);

  it.each(['succeeded', 'failed', 'unknown'] as const)(
    'rejects an unproven %s barrier without a canonical terminal receipt',
    async (status) => {
      const suffix = status === 'succeeded' ? 58 : status === 'failed' ? 59 : 60;
      const fixture = await createPreparedProposal(suffix);
      await getPool().query(
        `UPDATE pre_effect_barriers SET status = $2,
           effect_result = '{"dispatched":true}', failure_reason = NULL
         WHERE id = $1`,
        [fixture.prepared.barrier.id, status],
      );
      await expect(gmailArchiveClaimRepository.claim({
        userId,
        approvalId: fixture.proposal.approval.id,
      })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    },
    120_000,
  );

  it('rolls back a real transaction when the plan CAS misses after the barrier CAS', async () => {
    const fixture = await createPreparedProposal(61);
    const input = { userId, approvalId: fixture.proposal.approval.id };
    let barrierCasRows: number | undefined;
    let planCasRows: number | undefined;
    const result = await gmailArchiveClaimTestHooks.claimWithTransition(input, async (client, snapshot) => {
      const state = await loadCanonicalGmailArchiveApprovalState(client, {
        ...snapshot,
        action: 'approve',
      }, { allowExecutionPlan: true });
      const candidate = state ? canonicalGmailArchiveCandidate(state) : null;
      if (!state || !candidate) throw new Error('Missing canonical claim fixture.');
      const observedClient = new Proxy(client, {
        get(target, property, receiver) {
          if (property !== 'query') return Reflect.get(target, property, receiver);
          return async (sql: string, parameters?: unknown[]) => {
            const queryResult = await target.query(sql, parameters);
            if (sql.includes('UPDATE pre_effect_barriers')) barrierCasRows = queryResult.rows.length;
            if (sql.includes('UPDATE execution_plans AS plan')) planCasRows = queryResult.rows.length;
            return queryResult;
          };
        },
      });
      await gmailArchiveClaimTestHooks.claimPreparedPair(
        observedClient,
        snapshot,
        state,
        fixture.prepared.barrier,
        { ...fixture.prepared.plan, id: id('88', 61) },
        candidate,
        fixture.prepared.barrier.policy_snapshot,
      );
      throw new Error('A missing plan must not pass the second CAS.');
    });
    expect(result).toEqual({ ok: false, error: 'idempotency_conflict' });
    expect({ barrierCasRows, planCasRows }).toEqual({ barrierCasRows: 1, planCasRows: 0 });
    const durable = await getPool().query<{ barrier: string; plan: string }>(
      `SELECT barrier.status AS barrier, plan.status AS plan
         FROM pre_effect_barriers AS barrier, execution_plans AS plan
        WHERE barrier.id = $1 AND plan.id = $2`,
      [fixture.prepared.barrier.id, fixture.prepared.plan.id],
    );
    expect(durable.rows[0]).toEqual({ barrier: 'prepared', plan: 'pending' });
  }, 120_000);

  it('keeps preparation unclaimed when current policy or operator-pause authority changes', async () => {
    const policyDrift = await createPreparedProposal(44);
    await getPool().query(
      `UPDATE users SET trust_tier = 'suggest', updated_at = now() + INTERVAL '1 second' WHERE id = $1`,
      [userId],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: policyDrift.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'policy_stale' });
    await getPool().query(
      `UPDATE users SET trust_tier = 'observer', updated_at = now() + INTERVAL '2 seconds' WHERE id = $1`,
      [userId],
    );

    const priorPause = process.env['SKYTWIN_AUTO_EXECUTE_DISABLED'];
    delete process.env['SKYTWIN_AUTO_EXECUTE_DISABLED'];
    const pauseDrift = await createPreparedProposal(45);
    process.env['SKYTWIN_AUTO_EXECUTE_DISABLED'] = 'true';
    try {
      await expect(gmailArchiveClaimRepository.claim({
        userId,
        approvalId: pauseDrift.proposal.approval.id,
      })).resolves.toEqual({ ok: false, error: 'policy_stale' });
    } finally {
      if (priorPause === undefined) delete process.env['SKYTWIN_AUTO_EXECUTE_DISABLED'];
      else process.env['SKYTWIN_AUTO_EXECUTE_DISABLED'] = priorPause;
    }

    for (const prepared of [policyDrift.prepared, pauseDrift.prepared]) {
      const state = await getPool().query<{ barrier: string; plan: string }>(
        `SELECT barrier.status AS barrier, plan.status AS plan
           FROM pre_effect_barriers barrier, execution_plans plan
          WHERE barrier.id = $1 AND plan.id = $2`,
        [prepared.barrier.id, prepared.plan.id],
      );
      expect(state.rows[0]).toEqual({ barrier: 'prepared', plan: 'pending' });
    }
  }, 120_000);

  it('rechecks current Inbox, account, and credential scope before claiming', async () => {
    for (const [suffix, mutate, restore] of [
      [46,
        `UPDATE gmail_message_refs SET last_observed_inbox = false WHERE id = $1`,
        `UPDATE gmail_message_refs SET last_observed_inbox = true WHERE id = $1`],
      [47,
        `UPDATE connected_accounts SET is_active = false WHERE id = $1`,
        `UPDATE connected_accounts SET is_active = true WHERE id = $1`],
      [48,
        `UPDATE oauth_tokens SET scopes = ARRAY[]::STRING[] WHERE connector_account_id = $1`,
        `UPDATE oauth_tokens SET scopes = ARRAY[$2]::STRING[] WHERE connector_account_id = $1`],
      [51,
        `UPDATE connected_accounts SET scopes = ARRAY[]::STRING[] WHERE id = $1`,
        `UPDATE connected_accounts SET scopes = ARRAY[$2]::STRING[] WHERE id = $1`],
    ] as const) {
      const fixture = await createPreparedProposal(suffix);
      const target = suffix === 46 ? fixture.proposal.messageRefId : accountId;
      await getPool().query(mutate, [target]);
      await expect(gmailArchiveClaimRepository.claim({
        userId,
        approvalId: fixture.proposal.approval.id,
      })).resolves.toEqual({ ok: true, claimed: false, state: 'not_ready', command: null });
      const state = await getPool().query<{ barrier: string; plan: string }>(
        `SELECT barrier.status AS barrier, plan.status AS plan
           FROM pre_effect_barriers barrier, execution_plans plan
          WHERE barrier.id = $1 AND plan.id = $2`,
        [fixture.prepared.barrier.id, fixture.prepared.plan.id],
      );
      expect(state.rows[0]).toEqual({ barrier: 'prepared', plan: 'pending' });
      await getPool().query(restore, suffix === 48 || suffix === 51 ? [target, gmailModifyScope] : [target]);
    }
  }, 120_000);

  it('rejects plan and receipt tampering without issuing a command', async () => {
    const planTamper = await createPreparedProposal(49);
    await getPool().query(
      `UPDATE execution_plans SET steps = '[]' WHERE id = $1`,
      [planTamper.prepared.plan.id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: planTamper.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const receiptTamper = await createPreparedProposal(50);
    await getPool().query(
      `UPDATE decision_receipt_revisions SET trusted = false WHERE receipt_id = $1 AND sequence = 6`,
      [receiptTamper.prepared.receipt.id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: receiptTamper.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const evidenceTamper = await createPreparedProposal(52);
    await getPool().query(
      `UPDATE signals SET source_signal_id = 'changed-after-admission' WHERE id = $1`,
      [evidenceTamper.proposal.decision.signal_id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: evidenceTamper.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'not_found' });

    const attempted = await createPreparedProposal(53);
    await getPool().query(
      `INSERT INTO execution_results (id, plan_id, success, outputs, rollback_available)
       VALUES ($1, $2, false, '{}', false)`,
      [id('88', 53), attempted.prepared.plan.id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: attempted.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const eventBeforeClaim = await createPreparedProposal(62);
    await getPool().query(
      `INSERT INTO execution_events (id, plan_id, event_type, payload)
       VALUES ($1, $2, 'started', '{}')`,
      [id('88', 62), eventBeforeClaim.prepared.plan.id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: eventBeforeClaim.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const eventAfterClaim = await createPreparedProposal(63);
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: eventAfterClaim.proposal.approval.id,
    })).resolves.toMatchObject({ ok: true, claimed: true });
    await getPool().query(
      `INSERT INTO execution_events (id, plan_id, event_type, payload)
       VALUES ($1, $2, 'started', '{}')`,
      [id('88', 63), eventAfterClaim.prepared.plan.id],
    );
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: eventAfterClaim.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
  }, 120_000);

  it.each([
    ['changed', 70],
    ['already_in_state', 71],
    ['reconciled', 72],
  ] as const)('terminalizes and exactly replays a confirmed %s result', async (effect, suffix) => {
    const fixture = await createClaimedProposal(suffix);
    const result = {
      outcome: 'confirmed' as const,
      operation: 'archive' as const,
      inbox: false as const,
      effect,
      compensationAvailable: false as const,
      observedAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const input = { command: fixture.command, result };
    const terminalized = await gmailArchiveTerminalizationRepository.terminalize(input);
    expect(terminalized).toMatchObject({
      ok: true,
      created: true,
      terminalization: {
        status: 'succeeded',
        barrier: { status: 'succeeded', failure_reason: null },
        plan: { status: 'completed' },
        executionResult: { success: true, error: null, rollback_available: false },
        revision: { sequence: 7, stage: 'execution_recorded', disposition: 'succeeded' },
      },
    });
    if (!terminalized.ok) throw new Error(`terminalization failed: ${terminalized.error}`);
    expect(terminalized.terminalization.barrier.explanation_id).toBe(fixture.prepared.barrier.explanation_id);
    expect(terminalized.terminalization.executionExplanation.id)
      .not.toBe(fixture.prepared.barrier.explanation_id);
    expect(parseGmailArchiveTerminalExplanationEvidence(
      terminalized.terminalization.executionExplanation.evidence_used,
    )).toEqual(result);
    if (effect === 'already_in_state') {
      expect(terminalized.terminalization.executionExplanation.what_happened).toContain('no mutation POST');
    }
    if (effect === 'reconciled') {
      expect(terminalized.terminalization.executionExplanation.what_happened)
        .toContain('ambiguous outcome');
      expect(terminalized.terminalization.executionExplanation.what_happened)
        .toContain('confirming read');
    }
    expect(terminalized.terminalization.executionExplanation.correction_guidance)
      .toContain('automated restore and compensation are unavailable');
    const revisions = (await getPool().query(
      'SELECT * FROM decision_receipt_revisions WHERE receipt_id = $1 ORDER BY sequence ASC',
      [fixture.prepared.receipt.id],
    )).rows;
    expect(revisions).toHaveLength(7);
    expect(verifyJoinedDecisionReceiptChain({
      receiptId: fixture.prepared.receipt.id,
      decisionId: fixture.proposal.decision.id,
      userId,
      revisions,
    })).toBe(true);
    expect(terminalized.terminalization.revision.content).toMatchObject({
      version: 2,
      executionDisposition: 'succeeded',
      executionExplanation: { id: terminalized.terminalization.executionExplanation.id },
      executionResult: { id: terminalized.terminalization.executionResult?.id },
    });
    const terminalAt = terminalized.terminalization.revision.created_at.getTime();
    expect(terminalized.terminalization.barrier.updated_at.getTime()).toBe(terminalAt);
    expect(terminalized.terminalization.plan.updated_at.getTime()).toBe(terminalAt);
    expect(terminalized.terminalization.executionResult?.completed_at.getTime()).toBe(terminalAt);
    expect(terminalized.terminalization.executionExplanation.created_at.getTime()).toBe(terminalAt);
    const countsBefore = await artifactCounts(fixture.proposal.decision.id, fixture.proposal.approval.id);
    await expect(gmailArchiveTerminalizationRepository.terminalize(input)).resolves.toMatchObject({
      ok: true,
      created: false,
      terminalization: { status: 'succeeded' },
    });
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: fixture.proposal.approval.id,
    })).resolves.toEqual({ ok: true, claimed: false, state: 'terminal', command: null });
    await expect(artifactCounts(
      fixture.proposal.decision.id,
      fixture.proposal.approval.id,
    )).resolves.toEqual(countsBefore);
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: fixture.command,
      result: { ...result, effect: effect === 'changed' ? 'reconciled' : 'changed' },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
  }, 120_000);

  it.each([
    'invalid_command',
    'not_admitted',
    'admission_unavailable',
    'credentials_unavailable',
    'preflight_unavailable',
    'remote_rejected',
  ] as const)('terminalizes known failure %s with only the safe enum', async (code) => {
    const suffix = 80 + [
      'invalid_command',
      'not_admitted',
      'admission_unavailable',
      'credentials_unavailable',
      'preflight_unavailable',
      'remote_rejected',
    ].indexOf(code);
    const fixture = await createClaimedProposal(suffix);
    const result = { outcome: 'known_failure' as const, code, compensationAvailable: false as const };
    const terminalized = await gmailArchiveTerminalizationRepository.terminalize({
      command: fixture.command,
      result,
    });
    expect(terminalized).toMatchObject({
      ok: true,
      created: true,
      terminalization: {
        status: 'failed',
        barrier: { status: 'failed', failure_reason: code },
        plan: { status: 'failed' },
        executionResult: {
          success: false,
          outputs: { schema: 'gmail_archive_terminal_result_v1', outcome: 'known_failure', code },
          error: code,
          rollback_available: false,
        },
        revision: { sequence: 7, disposition: 'failed' },
      },
    });
    if (!terminalized.ok) throw new Error(`terminalization failed: ${terminalized.error}`);
    expect(parseGmailArchiveTerminalExplanationEvidence(
      terminalized.terminalization.executionExplanation.evidence_used,
    )).toEqual(result);
    if (code === 'remote_rejected') {
      expect(terminalized.terminalization.executionExplanation.what_happened)
        .not.toContain('before any mutation');
    } else {
      expect(terminalized.terminalization.executionExplanation.what_happened)
        .toContain('before any mutation');
    }
  }, 120_000);

  it('terminalizes an unknown remote outcome without fabricating a result row', async () => {
    const fixture = await createClaimedProposal(90);
    const result = {
      outcome: 'unknown' as const,
      code: 'remote_outcome_unknown' as const,
      compensationAvailable: false as const,
    };
    const input = { command: fixture.command, result };
    const terminalized = await gmailArchiveTerminalizationRepository.terminalize(input);
    expect(terminalized).toMatchObject({
      ok: true,
      created: true,
      terminalization: {
        status: 'unknown',
        barrier: { status: 'unknown', failure_reason: 'remote_outcome_unknown' },
        plan: { status: 'failed' },
        executionResult: null,
        revision: {
          sequence: 7,
          disposition: 'unknown',
          execution_result_id: null,
          execution_disposition: 'unknown',
        },
      },
    });
    if (!terminalized.ok) throw new Error(`terminalization failed: ${terminalized.error}`);
    expect(parseGmailArchiveTerminalExplanationEvidence(
      terminalized.terminalization.executionExplanation.evidence_used,
    )).toEqual(result);
    const resultCount = await getPool().query<{ count: string }>(
      'SELECT count(*)::STRING AS count FROM execution_results WHERE plan_id = $1',
      [fixture.prepared.plan.id],
    );
    expect(resultCount.rows[0]?.count).toBe('0');
    await expect(gmailArchiveTerminalizationRepository.terminalize(input)).resolves.toMatchObject({
      ok: true,
      created: false,
      terminalization: { status: 'unknown', executionResult: null },
    });
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: fixture.proposal.approval.id,
    })).resolves.toEqual({ ok: true, claimed: false, state: 'terminal', command: null });
  }, 120_000);

  it('rolls back the barrier and plan when a later result insert cannot commit', async () => {
    const donor = await createClaimedProposal(91);
    const donorResult = {
      outcome: 'confirmed' as const,
      operation: 'archive' as const,
      inbox: false as const,
      effect: 'changed' as const,
      compensationAvailable: false as const,
      observedAt: new Date(Date.now() - 2_000).toISOString(),
    };
    const donorTerminal = await gmailArchiveTerminalizationRepository.terminalize({
      command: donor.command,
      result: donorResult,
    });
    expect(donorTerminal).toMatchObject({ ok: true, created: true });
    if (!donorTerminal.ok || !donorTerminal.terminalization.executionResult) {
      throw new Error('Rollback donor did not create an execution result.');
    }

    const target = await createClaimedProposal(92);
    const before = await artifactCounts(target.proposal.decision.id, target.proposal.approval.id);
    await expect(gmailArchiveTerminalizationTestHooks.terminalizeWithTransition(
      {
        command: target.command,
        result: { ...donorResult, observedAt: new Date(Date.now() - 1_000).toISOString() },
      },
      gmailArchiveTerminalizationTestHooks.transition,
      () => ({
        explanationId: id('91', 92),
        resultId: donorTerminal.terminalization.executionResult!.id,
        revisionId: id('93', 92),
        persistedAt: new Date().toISOString(),
      }),
    )).rejects.toMatchObject({ code: '23505' });

    await expect(artifactCounts(
      target.proposal.decision.id,
      target.proposal.approval.id,
    )).resolves.toEqual(before);
    const graph = await getPool().query<{
      barrier_status: string;
      plan_status: string;
      results: string;
    }>(`SELECT barrier.status AS barrier_status, plan.status AS plan_status,
               (SELECT count(*)::STRING FROM execution_results WHERE plan_id = plan.id) AS results
          FROM pre_effect_barriers barrier
          JOIN execution_plans plan ON plan.id = $2
         WHERE barrier.id = $1`, [target.command.admissionId, target.prepared.plan.id]);
    expect(graph.rows[0]).toEqual({
      barrier_status: 'in_progress',
      plan_status: 'in_progress',
      results: '0',
    });
  }, 120_000);

  it('rolls back a real terminal transition on 40001 and retries with stable artifacts', async () => {
    const fixture = await createClaimedProposal(103);
    const persistedAt = new Date().toISOString();
    const retryStable = {
      explanationId: id('91', 103),
      resultId: id('92', 103),
      revisionId: id('93', 103),
      persistedAt,
    };
    let attempts = 0;
    const seenStable: unknown[] = [];
    const terminalized = await gmailArchiveTerminalizationTestHooks.terminalizeWithTransition(
      {
        command: fixture.command,
        result: {
          outcome: 'confirmed',
          operation: 'archive',
          inbox: false,
          effect: 'changed',
          compensationAvailable: false,
          observedAt: new Date(Date.parse(persistedAt) - 1_000).toISOString(),
        },
      },
      async (client, input, stableValues) => {
        seenStable.push(stableValues);
        const result = await gmailArchiveTerminalizationTestHooks.transition(
          client, input, stableValues,
        );
        attempts += 1;
        if (attempts === 1) {
          expect(result).toMatchObject({ ok: true, created: true });
          const inside = await client.query<{ revisions: string; results: string }>(`SELECT
            (SELECT count(*)::STRING FROM decision_receipt_revisions
              WHERE receipt_id = $1) AS revisions,
            (SELECT count(*)::STRING FROM execution_results WHERE plan_id = $2) AS results`,
          [fixture.prepared.receipt.id, fixture.prepared.plan.id]);
          expect(inside.rows[0]).toEqual({ revisions: '7', results: '1' });
          throw Object.assign(new Error('restart after writes'), { code: '40001' });
        }
        return result;
      },
      () => retryStable,
      async () => persistedAt,
    );
    expect(terminalized).toMatchObject({
      ok: true,
      created: true,
      terminalization: {
        executionExplanation: { id: retryStable.explanationId },
        executionResult: { id: retryStable.resultId },
        revision: { id: retryStable.revisionId, sequence: 7 },
      },
    });
    expect(attempts).toBe(2);
    expect(seenStable).toEqual([retryStable, retryStable]);
    await expect(artifactCounts(
      fixture.proposal.decision.id,
      fixture.proposal.approval.id,
    )).resolves.toEqual({ barriers: '2', explanations: '3', plans: '1', revisions: '7' });
  }, 120_000);

  it('serializes concurrent terminal replay and rejects a conflicting result', async () => {
    const same = await createClaimedProposal(104);
    const sameInput = {
      command: same.command,
      result: {
        outcome: 'known_failure' as const,
        code: 'remote_rejected' as const,
        compensationAvailable: false as const,
      },
    };
    const sameResults = await Promise.all([
      gmailArchiveTerminalizationRepository.terminalize(sameInput),
      gmailArchiveTerminalizationRepository.terminalize(sameInput),
    ]);
    expect(sameResults.every((result) => result.ok)).toBe(true);
    expect(sameResults.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(sameResults.filter((result) => result.ok && !result.created)).toHaveLength(1);

    const different = await createClaimedProposal(105);
    const differentResults = await Promise.all([
      gmailArchiveTerminalizationRepository.terminalize({
        command: different.command,
        result: { ...sameInput.result, code: 'remote_rejected' },
      }),
      gmailArchiveTerminalizationRepository.terminalize({
        command: different.command,
        result: { ...sameInput.result, code: 'preflight_unavailable' },
      }),
    ]);
    expect(differentResults.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(differentResults.filter(
      (result) => !result.ok && result.error === 'idempotency_conflict',
    )).toHaveLength(1);
  }, 120_000);

  it('binds terminalization to the exact winning command and owner', async () => {
    const fixture = await createClaimedProposal(93);
    const result = {
      outcome: 'known_failure' as const,
      code: 'remote_rejected' as const,
      compensationAvailable: false as const,
    };
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: { ...fixture.command, userId: otherUserId },
      result,
    })).resolves.toEqual({ ok: false, error: 'not_found' });
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: { ...fixture.command, messageRefId: id('33', 999) },
      result,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: { ...fixture.command, admissionId: id('12', 999) },
      result,
    })).resolves.toEqual({ ok: false, error: 'not_found' });
    const barrier = await getPool().query<{ status: string }>(
      'SELECT status FROM pre_effect_barriers WHERE id = $1',
      [fixture.command.admissionId],
    );
    expect(barrier.rows[0]?.status).toBe('in_progress');
  }, 120_000);

  it('fails closed on untrusted or pre-populated claimed graphs', async () => {
    const untrusted = await createClaimedProposal(94);
    await getPool().query(
      `UPDATE decision_receipt_revisions SET trusted = false
        WHERE receipt_id = $1 AND sequence = 6`,
      [untrusted.prepared.receipt.id],
    );
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: untrusted.command,
      result: { outcome: 'known_failure', code: 'remote_rejected', compensationAvailable: false },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const attempted = await createClaimedProposal(95);
    await getPool().query(
      `INSERT INTO execution_events (id, plan_id, event_type, payload)
       VALUES ($1, $2, 'started', '{}')`,
      [id('98', 95), attempted.prepared.plan.id],
    );
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: attempted.command,
      result: { outcome: 'known_failure', code: 'remote_rejected', compensationAvailable: false },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
  }, 120_000);

  it.each([
    ['missing', []],
    ['extra', [{ schema: 'gmail_archive_terminal_result_v1' }, { extra: true }]],
    ['changed', [{
      schema: 'gmail_archive_terminal_result_v1',
      outcome: 'known_failure',
      code: 'preflight_unavailable',
      compensationAvailable: false,
    }]],
  ] as const)('rejects replay when terminal evidence is %s', async (_label, evidence) => {
    const suffix = 96 + ['missing', 'extra', 'changed'].indexOf(_label);
    const fixture = await createClaimedProposal(suffix);
    const input = {
      command: fixture.command,
      result: {
        outcome: 'known_failure' as const,
        code: 'remote_rejected' as const,
        compensationAvailable: false as const,
      },
    };
    const terminalized = await gmailArchiveTerminalizationRepository.terminalize(input);
    expect(terminalized).toMatchObject({ ok: true, created: true });
    if (!terminalized.ok) throw new Error('Terminal evidence fixture failed.');
    await getPool().query(
      'UPDATE explanation_records SET evidence_used = $2::JSONB WHERE id = $1',
      [terminalized.terminalization.executionExplanation.id, JSON.stringify(evidence)],
    );
    await expect(gmailArchiveTerminalizationRepository.terminalize(input)).resolves.toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: fixture.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
  }, 120_000);

  it('rejects a synthetic result added after an unknown terminal outcome', async () => {
    const fixture = await createClaimedProposal(100);
    const input = {
      command: fixture.command,
      result: {
        outcome: 'unknown' as const,
        code: 'remote_outcome_unknown' as const,
        compensationAvailable: false as const,
      },
    };
    await expect(gmailArchiveTerminalizationRepository.terminalize(input)).resolves.toMatchObject({
      ok: true,
      created: true,
    });
    await getPool().query(
      `INSERT INTO execution_results (id, plan_id, success, outputs, error, rollback_available)
       VALUES ($1, $2, false, '{}', 'remote_rejected', false)`,
      [id('97', 100), fixture.prepared.plan.id],
    );
    await expect(gmailArchiveTerminalizationRepository.terminalize(input)).resolves.toEqual({
      ok: false,
      error: 'idempotency_conflict',
    });
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: fixture.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
  }, 120_000);

  it('replays through a valid later feedback continuation without adding artifacts', async () => {
    const fixture = await createClaimedProposal(101);
    const input = {
      command: fixture.command,
      result: {
        outcome: 'known_failure' as const,
        code: 'remote_rejected' as const,
        compensationAvailable: false as const,
      },
    };
    const terminalized = await gmailArchiveTerminalizationRepository.terminalize(input);
    expect(terminalized).toMatchObject({ ok: true, created: true });
    if (!terminalized.ok) {
      throw new Error('Feedback continuation fixture failed.');
    }
    const terminalContent = terminalized.terminalization.revision.content;
    if (terminalContent.version !== 2) {
      throw new Error('Feedback continuation fixture failed.');
    }
    await withTransaction(async (client) => {
      const feedback = (await client.query<Record<string, unknown>>(
        `INSERT INTO feedback_events (id, user_id, decision_id, type, data)
         VALUES ($1, $2, $3, 'approval', '{}') RETURNING *`,
        [id('96', 101), userId, fixture.proposal.decision.id],
      )).rows[0]!;
      const content: JoinedDecisionReceiptContentV2 = {
        ...terminalContent,
        stage: 'feedback_recorded',
        feedbackEvents: [decisionReceiptRowArtifactRefV1('feedback', feedback)],
      };
      const appended = await decisionReceiptLifecycleRepository.appendForUser(client, userId, {
        eventId: feedback['id'] as string,
        eventKind: 'feedback_recorded',
        expectedPreviousDigest: terminalized.terminalization.revision.revision_digest,
        content,
        receiptId: fixture.prepared.receipt.id,
      });
      expect(appended).toMatchObject({ success: true, created: true, revision: { sequence: 8 } });
    });
    const before = await artifactCounts(fixture.proposal.decision.id, fixture.proposal.approval.id);
    await expect(gmailArchiveTerminalizationRepository.terminalize(input)).resolves.toMatchObject({
      ok: true,
      created: false,
      terminalization: { revision: { sequence: 7 } },
    });
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: fixture.proposal.approval.id,
    })).resolves.toEqual({ ok: true, claimed: false, state: 'terminal', command: null });
    await expect(artifactCounts(
      fixture.proposal.decision.id,
      fixture.proposal.approval.id,
    )).resolves.toEqual(before);
  }, 120_000);

  it('terminalizes after connector evidence is cascaded post-claim', async () => {
    // Use a dedicated owner so earlier fail-closed cases can retain their
    // intentionally malformed graphs without polluting this portable export.
    const portableUserId = id('11', 3);
    const portableAccountId = id('22', 3);
    await seedOwner(portableUserId, portableAccountId, id('55', 3), 'portable-owner@example.test');
    const fixture = await createClaimedProposal(102, portableUserId, portableAccountId);
    await getPool().query(
      'DELETE FROM connected_accounts WHERE id = $1 AND user_id = $2',
      [portableAccountId, portableUserId],
    );
    const evidence = await getPool().query<{ refs: string; signals: string }>(`SELECT
      (SELECT count(*)::STRING FROM gmail_message_refs WHERE id = $1) AS refs,
      (SELECT count(*)::STRING FROM signals WHERE resource_ref_id = $1) AS signals`,
    [fixture.proposal.messageRefId]);
    expect(evidence.rows[0]).toEqual({ refs: '0', signals: '0' });
    const terminalized = await gmailArchiveTerminalizationRepository.terminalize({
      command: fixture.command,
      result: {
        outcome: 'known_failure',
        code: 'remote_rejected',
        compensationAvailable: false,
      },
    });
    expect(terminalized).toMatchObject({
      ok: true,
      created: true,
      terminalization: { status: 'failed' },
    });
    if (!terminalized.ok) throw new Error('Portable terminal fixture failed.');

    const backup = await collectBackup(portableUserId);
    expect(backup).toMatchObject({ success: true });
    if (!backup.success) throw new Error(`Terminal backup failed: ${backup.message}`);
    expect(validateBackupData(backup.data)).toEqual([]);

    await getPool().query('TRUNCATE TABLE users CASCADE');
    await expect(restoreBackup(backup.data)).resolves.toMatchObject({ success: true });
    const restored = await getPool().query<{
      explanations: string;
      revisions: string;
      trusted: string;
    }>(`SELECT
      (SELECT count(*)::STRING FROM explanation_records WHERE decision_id = $1) AS explanations,
      (SELECT count(*)::STRING FROM decision_receipt_revisions revision
        JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
       WHERE receipt.decision_id = $1) AS revisions,
      (SELECT count(*)::STRING FROM decision_receipt_revisions revision
        JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
       WHERE receipt.decision_id = $1 AND revision.trusted = true) AS trusted`,
    [fixture.proposal.decision.id]);
    expect(restored.rows[0]).toEqual({ explanations: '3', revisions: '7', trusted: '0' });
    const restoredExplanation = await getPool().query<{ evidence_used: unknown }>(
      'SELECT evidence_used FROM explanation_records WHERE id = $1 AND decision_id = $2',
      [terminalized.terminalization.executionExplanation.id, fixture.proposal.decision.id],
    );
    expect(parseGmailArchiveTerminalExplanationEvidence(
      restoredExplanation.rows[0]?.evidence_used,
    )).toEqual({
      outcome: 'known_failure',
      code: 'remote_rejected',
      compensationAvailable: false,
    });
  }, 120_000);
});
