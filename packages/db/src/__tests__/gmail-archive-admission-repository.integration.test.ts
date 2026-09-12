import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskAssessor } from '@skytwin/decision-engine';
import {
  joinedDecisionReceiptContentDigest,
  joinedDecisionReceiptRevisionDigest,
  verifyJoinedDecisionReceiptChain,
  type JoinedDecisionReceiptContent,
  type JoinedDecisionReceiptContentV2,
} from '@skytwin/shared-types';
import { closePool, getPool, withTransaction } from '../connection.js';
import { collectBackup, restoreBackup, validateBackupData } from '../backup/backup.js';
import { decisionReceiptLifecycleRepository } from '../repositories/decision-receipt-lifecycle.js';
import {
  decisionReceiptBarrierRefV1,
  decisionReceiptRowArtifactRefV1,
} from '../repositories/decision-receipt-artifacts.js';
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
  gmailArchiveDispatchGateRepository,
  gmailArchiveDispatchGateTestHooks,
} from '../repositories/gmail-archive-dispatch-gate-repository.js';
import { gmailArchiveRecoveryRepository } from '../repositories/gmail-archive-recovery-repository.js';
import {
  gmailArchiveRecoveryLeaseRepository,
  gmailArchiveRecoveryLeaseTestHooks,
} from '../repositories/gmail-archive-recovery-lease-repository.js';
import { gmailInboxObservationTargetRepository } from '../repositories/gmail-inbox-observation-target-repository.js';
import {
  gmailArchiveReconciliationRepository,
  gmailArchiveReconciliationTestHooks,
  parseGmailArchiveReconciliationExplanationEvidence,
} from '../repositories/gmail-archive-reconciliation-repository.js';
import {
  gmailArchiveTerminalizationRepository,
  gmailArchiveTerminalizationTestHooks,
  parseGmailArchiveTerminalExplanationBinding,
  parseGmailArchiveTerminalExplanationEvidence,
} from '../repositories/gmail-archive-terminalization-repository.js';
import {
  buildGmailArchiveProposalCandidate,
  gmailArchiveProposalRepository,
} from '../repositories/gmail-archive-proposal-repository.js';
import { gmailMessageRefRepository } from '../repositories/gmail-message-ref-repository.js';
import type { PreEffectBarrierRow } from '../repositories/pre-effect-barrier-repository.js';

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

async function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('concurrent operation timed out')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pauseTransactionAfterQuery(
  pattern: RegExp,
  onPaused: () => void,
  resume: Promise<void>,
) {
  return async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> =>
    withTransaction(async (client) => {
      let paused = false;
      const wrapped = new Proxy(client, {
        get(target, property, receiver): unknown {
          if (property !== 'query') {
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (text: string, values?: unknown[]) => {
            const result = await target.query(text, values);
            if (!paused && pattern.test(text.replace(/\s+/g, ' '))) {
              paused = true;
              onPaused();
              await resume;
            }
            return result;
          };
        },
      });
      return callback(wrapped);
    });
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

  async function seedRecoveryOwner(suffix: number) {
    const ownerUserId = id('11', 100 + suffix);
    const ownerAccountId = id('22', 100 + suffix);
    await seedOwner(
      ownerUserId,
      ownerAccountId,
      id('55', 100 + suffix),
      `recovery-${suffix}@example.test`,
    );
    return { ownerUserId, ownerAccountId };
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
    dispatch = false,
  ) {
    const fixture = await createPreparedProposal(suffix, ownerUserId, ownerAccountId);
    const claimed = await gmailArchiveClaimRepository.claim({
      userId: ownerUserId,
      approvalId: fixture.proposal.approval.id,
    });
    expect(claimed).toMatchObject({ ok: true, claimed: true });
    if (!claimed.ok || !claimed.claimed) throw new Error('Terminal fixture was not claimed.');
    if (dispatch) {
      await expect(enterDispatchGate(claimed.command)).resolves.toEqual({
        status: 'entered',
      });
    }
    return { ...fixture, command: claimed.command };
  }

  function mutationBinding(command: {
    userId: string;
    admissionId: string;
    messageRefId: string;
  }) {
    return {
      userId: command.userId,
      admissionId: command.admissionId,
      messageRefId: command.messageRefId,
    };
  }

  function recoveryFence(lease: {
    userId: string;
    approvalId: string;
    admissionId: string;
    messageRefId: string;
    workKind: 'resume_preparation' | 'resume_claim' | 'reconcile_pre_dispatch' | 'observe_dispatch';
    barrierStatus: 'reserved' | 'prepared' | 'in_progress';
    attemptPhase: 'pre_dispatch' | 'dispatch_may_have_started' | null;
    phaseChangedAt: string;
    leaseToken: string;
    generation: number;
  }) {
    return {
      userId: lease.userId,
      approvalId: lease.approvalId,
      admissionId: lease.admissionId,
      messageRefId: lease.messageRefId,
      workKind: lease.workKind,
      barrierStatus: lease.barrierStatus,
      attemptPhase: lease.attemptPhase,
      phaseChangedAt: lease.phaseChangedAt,
      leaseToken: lease.leaseToken,
      generation: lease.generation,
    };
  }

  async function currentMutationTarget(command: Parameters<
    typeof gmailMessageRefRepository.resolveInboxMutationTarget
  >[0]) {
    const target = await gmailMessageRefRepository.resolveInboxMutationTarget(command);
    if (!target) throw new Error('Mutation target was not observable.');
    return target;
  }

  async function enterDispatchGate(command: Parameters<
    typeof gmailArchiveDispatchGateRepository.enter
  >[0]) {
    return gmailArchiveDispatchGateRepository.enter(command, await currentMutationTarget(command));
  }

  async function ageClaimedAttempt(admissionId: string): Promise<string> {
    const aged = await getPool().query<{ updated_at: Date }>(
      `UPDATE pre_effect_barriers
          SET updated_at = date_trunc('milliseconds', now() - INTERVAL '10 minutes')
        WHERE id = $1
        RETURNING updated_at`,
      [admissionId],
    );
    const changedAt = aged.rows[0]?.updated_at;
    if (!changedAt) throw new Error('Claimed attempt was not aged.');
    return changedAt.toISOString();
  }

  async function setRecoveryAnchor(
    admissionId: string,
    column: 'created_at' | 'updated_at',
    timestamp = '2026-09-12T12:00:00.123456Z',
  ): Promise<void> {
    await getPool().query(
      `UPDATE pre_effect_barriers SET ${column} = $2::TIMESTAMPTZ WHERE id = $1`,
      [admissionId, timestamp],
    );
    if (column === 'updated_at') await rehashPreparedBarrierAnchor(admissionId);
  }

  async function rehashPreparedBarrierAnchor(admissionId: string): Promise<void> {
    const barrier = (await getPool().query<PreEffectBarrierRow>(
      'SELECT * FROM pre_effect_barriers WHERE id = $1',
      [admissionId],
    )).rows[0];
    if (!barrier || barrier.status !== 'prepared' || !barrier.decision_id) return;
    const receipt = (await getPool().query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM decision_receipts WHERE decision_id = $1',
      [barrier.decision_id],
    )).rows[0];
    if (!receipt) throw new Error('Prepared receipt was not found for anchor rewrite.');
    const revisions = (await getPool().query<{
      id: string;
      sequence: string;
      event_key: string;
      revision_digest: string;
      content: JoinedDecisionReceiptContent;
    }>(
      `SELECT id, sequence, event_key, revision_digest, content
         FROM decision_receipt_revisions
        WHERE receipt_id = $1 ORDER BY sequence ASC`,
      [receipt.id],
    )).rows;
    const barrierRef = decisionReceiptBarrierRefV1(barrier);
    let previousDigest: string | null = null;
    for (const revision of revisions) {
      const sequence = Number(revision.sequence);
      let content = revision.content;
      if (sequence >= 5) {
        const mutable = structuredClone(revision.content) as unknown as Record<string, unknown>;
        mutable['barrier'] = barrierRef;
        const evaluations = mutable['policyEvaluations'];
        if (Array.isArray(evaluations)) {
          for (const evaluation of evaluations) {
            if (evaluation && typeof evaluation === 'object' &&
                ((evaluation as Record<string, unknown>)['barrier'] as { id?: unknown } | undefined)
                  ?.id === admissionId) {
              (evaluation as Record<string, unknown>)['barrier'] = barrierRef;
            }
          }
        }
        content = mutable as unknown as JoinedDecisionReceiptContent;
      }
      const contentDigest = joinedDecisionReceiptContentDigest(content);
      const revisionDigest = joinedDecisionReceiptRevisionDigest({
        revisionId: revision.id,
        receiptId: receipt.id,
        decisionId: barrier.decision_id,
        userId: receipt.user_id,
        sequence,
        eventKey: revision.event_key as Parameters<typeof joinedDecisionReceiptRevisionDigest>[0]['eventKey'],
        previousDigest,
        contentDigest,
      });
      await getPool().query(
        `UPDATE decision_receipt_revisions
            SET previous_digest = $2, content_digest = $3, revision_digest = $4, content = $5::JSONB
          WHERE id = $1`,
        [revision.id, previousDigest, contentDigest, revisionDigest, JSON.stringify(content)],
      );
      previousDigest = revisionDigest;
    }
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
      attempt_state: Record<string, unknown>;
      plan_status: string;
      revisions: string;
      results: string;
      events: string;
    }>(
      `SELECT barrier.status AS barrier_status, barrier.effect_result AS attempt_state,
         plan.status AS plan_status,
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
      attempt_state: { schema: 'gmail_archive_attempt_v1', phase: 'pre_dispatch' },
      plan_status: 'in_progress',
      revisions: '6',
      results: '0',
      events: '0',
    });
    await expect(gmailMessageRefRepository.resolveInboxMutationTarget(winner.command)).resolves.toEqual({
      connectorAccountId: accountId,
      credentialRevision: expect.any(String),
      providerMessageId: 'native-40',
    });
    await expect(gmailArchiveClaimRepository.claim(input)).resolves.toEqual({
      ok: true,
      claimed: false,
      state: 'in_progress',
      command: null,
    });
  }, 120_000);

  it('admits exactly one concurrent dispatch gate and preserves the exact durable phase', async () => {
    const fixture = await createClaimedProposal(64);
    const target = await currentMutationTarget(fixture.command);
    const results = await Promise.all([
      gmailArchiveDispatchGateRepository.enter(fixture.command, target),
      gmailArchiveDispatchGateRepository.enter(fixture.command, target),
    ]);
    expect(results.filter((result) => result.status === 'entered')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'not_admitted')).toHaveLength(1);
    await expect(gmailArchiveDispatchGateRepository.enter(fixture.command, target)).resolves.toEqual({
      status: 'not_admitted',
    });
    const durable = await getPool().query<{ status: string; effect_result: Record<string, unknown> }>(
      'SELECT status, effect_result FROM pre_effect_barriers WHERE id = $1',
      [fixture.command.admissionId],
    );
    expect(durable.rows[0]).toEqual({
      status: 'in_progress',
      effect_result: {
        schema: 'gmail_archive_attempt_v1',
        phase: 'dispatch_may_have_started',
      },
    });
  }, 120_000);

  it('keeps a stale dispatch target before the uncertainty boundary across authority drift', async () => {
    const authorityUserId = id('11', 16);
    const authorityAccountId = id('22', 16);
    await seedOwner(
      authorityUserId,
      authorityAccountId,
      id('55', 16),
      'mutation-gate-authority@example.test',
    );
    const fixture = await createClaimedProposal(130, authorityUserId, authorityAccountId);
    const staleTarget = await currentMutationTarget(fixture.command);
    const cases: Array<{
      name: string;
      mutate: () => Promise<unknown>;
      restore: () => Promise<unknown>;
    }> = [
      {
        name: 'inactive account',
        mutate: () => getPool().query(
          'UPDATE connected_accounts SET is_active = false WHERE id = $1', [authorityAccountId],
        ),
        restore: () => getPool().query(
          'UPDATE connected_accounts SET is_active = true WHERE id = $1', [authorityAccountId],
        ),
      },
      {
        name: 'unverified account',
        mutate: () => getPool().query(
          'UPDATE connected_accounts SET identity_verified = false WHERE id = $1', [authorityAccountId],
        ),
        restore: () => getPool().query(
          'UPDATE connected_accounts SET identity_verified = true WHERE id = $1', [authorityAccountId],
        ),
      },
      {
        name: 'disconnected account',
        mutate: () => getPool().query(
          'UPDATE connected_accounts SET disconnected_at = now() WHERE id = $1', [authorityAccountId],
        ),
        restore: () => getPool().query(
          'UPDATE connected_accounts SET disconnected_at = NULL WHERE id = $1', [authorityAccountId],
        ),
      },
      {
        name: 'account scope replacement',
        mutate: () => getPool().query(
          `UPDATE connected_accounts SET scopes = ARRAY['gmail.readonly']::STRING[] WHERE id = $1`,
          [authorityAccountId],
        ),
        restore: () => getPool().query(
          'UPDATE connected_accounts SET scopes = ARRAY[$2]::STRING[] WHERE id = $1',
          [authorityAccountId, gmailModifyScope],
        ),
      },
      {
        name: 'token scope replacement',
        mutate: () => getPool().query(
          `UPDATE oauth_tokens SET scopes = ARRAY['gmail.readonly']::STRING[]
            WHERE connector_account_id = $1`,
          [authorityAccountId],
        ),
        restore: () => getPool().query(
          `UPDATE oauth_tokens SET scopes = ARRAY[$2]::STRING[] WHERE connector_account_id = $1`,
          [authorityAccountId, gmailModifyScope],
        ),
      },
      {
        name: 'credential revision rotation',
        mutate: () => getPool().query(
          'UPDATE oauth_tokens SET credential_revision = gen_random_uuid() WHERE connector_account_id = $1',
          [authorityAccountId],
        ),
        restore: () => getPool().query(
          'UPDATE oauth_tokens SET credential_revision = $2 WHERE connector_account_id = $1',
          [authorityAccountId, staleTarget.credentialRevision],
        ),
      },
      {
        name: 'native target replacement',
        mutate: () => getPool().query(
          `UPDATE gmail_message_refs SET provider_message_id = 'replacement-native-130' WHERE id = $1`,
          [fixture.command.messageRefId],
        ),
        restore: () => getPool().query(
          `UPDATE gmail_message_refs SET provider_message_id = 'native-130' WHERE id = $1`,
          [fixture.command.messageRefId],
        ),
      },
      {
        name: 'source binding replacement',
        mutate: () => getPool().query(
          `UPDATE gmail_message_refs SET source_signal_id = 'replacement-source-130' WHERE id = $1`,
          [fixture.command.messageRefId],
        ),
        restore: () => getPool().query(
          `UPDATE gmail_message_refs SET source_signal_id = 'source-130' WHERE id = $1`,
          [fixture.command.messageRefId],
        ),
      },
    ];

    for (const testCase of cases) {
      await testCase.mutate();
      await expect(gmailArchiveDispatchGateRepository.enter(
        fixture.command,
        staleTarget,
      ), testCase.name).resolves.toEqual({ status: 'not_admitted' });
      const durable = await getPool().query<{ effect_result: Record<string, unknown> }>(
        'SELECT effect_result FROM pre_effect_barriers WHERE id = $1',
        [fixture.command.admissionId],
      );
      expect(durable.rows[0]?.effect_result, testCase.name).toEqual({
        schema: 'gmail_archive_attempt_v1', phase: 'pre_dispatch',
      });
      await testCase.restore();
    }

    await expect(gmailArchiveDispatchGateRepository.enter(
      fixture.command,
      staleTarget,
    )).resolves.toEqual({ status: 'entered' });
  }, 120_000);

  it('rolls back a 40001 dispatch transition and retries the whole gate transaction', async () => {
    const fixture = await createClaimedProposal(69);
    const target = await currentMutationTarget(fixture.command);
    let attempts = 0;
    const result = await gmailArchiveDispatchGateTestHooks.enterWithTransition(
      fixture.command,
      target,
      async (client, command, targetSnapshot) => {
        const entered = await gmailArchiveDispatchGateTestHooks.transition(
          client,
          command,
          targetSnapshot,
        );
        attempts += 1;
        if (attempts === 1) {
          expect(entered).toEqual({ status: 'entered' });
          const inside = await client.query<{ phase: string }>(
            `SELECT effect_result->>'phase' AS phase FROM pre_effect_barriers WHERE id = $1`,
            [fixture.command.admissionId],
          );
          expect(inside.rows[0]?.phase).toBe('dispatch_may_have_started');
          throw Object.assign(new Error('restart after dispatch CAS'), { code: '40001' });
        }
        return entered;
      },
    );
    expect(result).toEqual({ status: 'entered' });
    expect(attempts).toBe(2);
  }, 120_000);

  it('uses B1 phase time and DB clock to expose a frozen abandoned-claim command without writes', async () => {
    const fixture = await createClaimedProposal(106);
    const input = { userId, approvalId: fixture.proposal.approval.id };
    const before = await artifactCounts(fixture.proposal.decision.id, input.approvalId);
    await expect(gmailArchiveRecoveryRepository.query(input)).resolves.toEqual({
      ok: true,
      status: 'not_due',
      recovery: null,
    });
    await getPool().query(
      `UPDATE pre_effect_barriers SET updated_at = now() - INTERVAL '5 minutes 1 second'
        WHERE id = $1`,
      [fixture.command.admissionId],
    );
    const recovered = await gmailArchiveRecoveryRepository.query(input);
    expect(recovered).toMatchObject({
      ok: true,
      status: 'eligible',
      recovery: {
        command: fixture.command,
        phase: 'pre_dispatch',
      },
    });
    if (!recovered.ok || recovered.status !== 'eligible') {
      throw new Error('Expected an eligible abandoned claim.');
    }
    expect(new Date(recovered.recovery.phaseChangedAt).toISOString())
      .toBe(recovered.recovery.phaseChangedAt);
    expect(Object.isFrozen(recovered.recovery)).toBe(true);
    expect(Object.isFrozen(recovered.recovery.command)).toBe(true);
    expect(Object.keys(recovered.recovery.command).sort())
      .toEqual(['admissionId', 'messageRefId', 'operation', 'userId']);
    expect(await artifactCounts(fixture.proposal.decision.id, input.approvalId)).toEqual(before);
  }, 120_000);

  it('recovers the exact dispatch boundary and durable command after connector evidence cascades', async () => {
    const portableUserId = id('11', 4);
    const portableAccountId = id('22', 4);
    await seedOwner(portableUserId, portableAccountId, id('55', 4), 'recovery-owner@example.test');
    const fixture = await createClaimedProposal(107, portableUserId, portableAccountId, true);
    await getPool().query(
      'DELETE FROM connected_accounts WHERE id = $1 AND user_id = $2',
      [portableAccountId, portableUserId],
    );
    await getPool().query(
      `UPDATE pre_effect_barriers SET updated_at = now() - INTERVAL '6 minutes' WHERE id = $1`,
      [fixture.command.admissionId],
    );
    const recovered = await gmailArchiveRecoveryRepository.query({
      userId: portableUserId,
      approvalId: fixture.proposal.approval.id,
    });
    expect(recovered).toMatchObject({
      ok: true,
      status: 'eligible',
      recovery: {
        command: fixture.command,
        phase: 'dispatch_may_have_started',
      },
    });
    const connectorEvidence = await getPool().query<{ refs: string; signals: string }>(`SELECT
      (SELECT count(*)::STRING FROM gmail_message_refs WHERE id = $1) AS refs,
      (SELECT count(*)::STRING FROM signals WHERE resource_ref_id = $1) AS signals`,
    [fixture.proposal.messageRefId]);
    expect(connectorEvidence.rows[0]).toEqual({ refs: '0', signals: '0' });
  }, 120_000);

  it('distinguishes legacy markers, owner misses, graph conflicts, and canonical terminals', async () => {
    const legacy = await createClaimedProposal(108);
    await getPool().query(
      `UPDATE pre_effect_barriers
          SET effect_result = '{}'::JSONB, updated_at = now() - INTERVAL '6 minutes'
        WHERE id = $1`,
      [legacy.command.admissionId],
    );
    await expect(gmailArchiveRecoveryRepository.query({
      userId,
      approvalId: legacy.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'legacy_untracked' });
    await expect(gmailArchiveRecoveryRepository.query({
      userId: otherUserId,
      approvalId: legacy.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'not_found' });

    const tampered = await createClaimedProposal(109);
    await getPool().query(
      `UPDATE decision_receipt_revisions SET trusted = false
        WHERE receipt_id = $1 AND sequence = 6`,
      [tampered.prepared.receipt.id],
    );
    await getPool().query(
      `UPDATE pre_effect_barriers SET updated_at = now() - INTERVAL '6 minutes' WHERE id = $1`,
      [tampered.command.admissionId],
    );
    await expect(gmailArchiveRecoveryRepository.query({
      userId,
      approvalId: tampered.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'integrity_conflict' });

    const terminal = await createClaimedProposal(110);
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: terminal.command,
      result: {
        outcome: 'known_failure',
        code: 'preflight_unavailable',
        compensationAvailable: false,
        binding: mutationBinding(terminal.command),
      },
    })).resolves.toMatchObject({ ok: true, created: true });
    await expect(gmailArchiveRecoveryRepository.query({
      userId,
      approvalId: terminal.proposal.approval.id,
    })).resolves.toEqual({ ok: true, status: 'terminal', recovery: null });
    await getPool().query(
      `UPDATE decision_receipt_revisions SET trusted = false
        WHERE receipt_id = $1 AND sequence = 7`,
      [terminal.prepared.receipt.id],
    );
    await expect(gmailArchiveRecoveryRepository.query({
      userId,
      approvalId: terminal.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'integrity_conflict' });
  }, 120_000);

  it('resolves only a grace-due dispatch-uncertain graph to its live verified Gmail target', async () => {
    const fixture = await createClaimedProposal(111);
    const observation = {
      userId: fixture.command.userId,
      admissionId: fixture.command.admissionId,
      messageRefId: fixture.command.messageRefId,
      operation: 'observe_inbox' as const,
    };
    await expect(gmailInboxObservationTargetRepository.resolve(observation)).resolves.toBeNull();
    await expect(enterDispatchGate(fixture.command)).resolves.toEqual({
      status: 'entered',
    });
    await expect(gmailInboxObservationTargetRepository.resolve(observation)).resolves.toBeNull();
    await getPool().query(
      `UPDATE pre_effect_barriers SET updated_at = now() - INTERVAL '6 minutes' WHERE id = $1`,
      [fixture.command.admissionId],
    );

    const resolved = await gmailInboxObservationTargetRepository.resolve(observation);
    expect(resolved).toEqual({
      connectorAccountId: accountId,
      credentialRevision: expect.any(String),
      providerMessageId: 'native-111',
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    await expect(gmailInboxObservationTargetRepository.resolve({
      ...observation,
      admissionId: id('88', 111),
    })).resolves.toBeNull();
    await expect(gmailInboxObservationTargetRepository.resolve({
      ...observation,
      messageRefId: id('33', 999),
    })).resolves.toBeNull();
    await expect(gmailInboxObservationTargetRepository.resolve({
      ...observation,
      userId: otherUserId,
    })).resolves.toBeNull();

    const alternateAccountId = id('22', 6);
    await getPool().query(
      `INSERT INTO connected_accounts (
         id, user_id, provider, account_id, scopes, is_active,
         provider_subject_digest, account_display, identity_verified
       ) VALUES ($2, $1, 'google', 'alternate-owned-account', ARRAY[$3]::STRING[], true,
         $4, 'Alternate owned account', true)`,
      [userId, alternateAccountId, gmailModifyScope, 'b'.repeat(64)],
    );
    await getPool().query(
      `INSERT INTO oauth_tokens (
         id, user_id, provider, access_token, refresh_token, expires_at, scopes,
         account_email, account_provider_id, connector_account_id
       ) VALUES ($2, $1, 'google', NULL, NULL, now() + INTERVAL '1 hour',
         ARRAY[$3]::STRING[], 'alternate@example.test', 'alternate', $4)`,
      [userId, id('55', 6), gmailModifyScope, alternateAccountId],
    );
    const alternate = await createProposal(118, userId, alternateAccountId);
    await expect(gmailInboxObservationTargetRepository.resolve({
      ...observation,
      messageRefId: alternate.messageRefId,
    })).resolves.toBeNull();
  }, 120_000);

  it('rejects legacy, terminal, and receipt-tampered durable graphs for observation', async () => {
    const legacy = await createClaimedProposal(112, userId, accountId, true);
    const legacyObservation = {
      userId,
      admissionId: legacy.command.admissionId,
      messageRefId: legacy.command.messageRefId,
      operation: 'observe_inbox' as const,
    };
    await getPool().query(
      `UPDATE pre_effect_barriers
          SET effect_result = '{}'::JSONB, updated_at = now() - INTERVAL '6 minutes'
        WHERE id = $1`,
      [legacy.command.admissionId],
    );
    await expect(gmailInboxObservationTargetRepository.resolve(legacyObservation)).resolves.toBeNull();

    const terminal = await createClaimedProposal(113, userId, accountId, true);
    await getPool().query(
      `UPDATE pre_effect_barriers SET updated_at = now() - INTERVAL '6 minutes' WHERE id = $1`,
      [terminal.command.admissionId],
    );
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: terminal.command,
      result: {
        outcome: 'unknown',
        code: 'remote_outcome_unknown',
        compensationAvailable: false,
        binding: mutationBinding(terminal.command),
      },
    })).resolves.toMatchObject({ ok: true, created: true });
    await expect(gmailInboxObservationTargetRepository.resolve({
      userId,
      admissionId: terminal.command.admissionId,
      messageRefId: terminal.command.messageRefId,
      operation: 'observe_inbox',
    })).resolves.toBeNull();

    const tampered = await createClaimedProposal(114, userId, accountId, true);
    await getPool().query(
      `UPDATE pre_effect_barriers SET updated_at = now() - INTERVAL '6 minutes' WHERE id = $1`,
      [tampered.command.admissionId],
    );
    await getPool().query(
      `UPDATE decision_receipt_revisions SET trusted = false
        WHERE receipt_id = $1 AND sequence = 6`,
      [tampered.prepared.receipt.id],
    );
    await expect(gmailInboxObservationTargetRepository.resolve({
      userId,
      admissionId: tampered.command.admissionId,
      messageRefId: tampered.command.messageRefId,
      operation: 'observe_inbox',
    })).resolves.toBeNull();
  }, 120_000);

  it('requires a current active verified account and exact account/token Gmail scope', async () => {
    const authorityUserId = id('11', 5);
    const authorityAccountId = id('22', 5);
    await seedOwner(
      authorityUserId,
      authorityAccountId,
      id('55', 5),
      'observation-authority@example.test',
    );
    const fixture = await createClaimedProposal(115, authorityUserId, authorityAccountId, true);
    const observation = {
      userId: authorityUserId,
      admissionId: fixture.command.admissionId,
      messageRefId: fixture.command.messageRefId,
      operation: 'observe_inbox' as const,
    };
    await getPool().query(
      `UPDATE pre_effect_barriers SET updated_at = now() - INTERVAL '6 minutes' WHERE id = $1`,
      [fixture.command.admissionId],
    );
    await expect(gmailInboxObservationTargetRepository.resolve(observation)).resolves.toMatchObject({
      connectorAccountId: authorityAccountId,
    });

    for (const [column, value] of [
      ['is_active', false],
      ['identity_verified', false],
    ] as const) {
      await getPool().query(
        `UPDATE connected_accounts SET ${column} = $2 WHERE id = $1`,
        [authorityAccountId, value],
      );
      await expect(gmailInboxObservationTargetRepository.resolve(observation)).resolves.toBeNull();
      await getPool().query(
        `UPDATE connected_accounts SET ${column} = true WHERE id = $1`,
        [authorityAccountId],
      );
    }
    await getPool().query(
      'UPDATE connected_accounts SET disconnected_at = now() WHERE id = $1',
      [authorityAccountId],
    );
    await expect(gmailInboxObservationTargetRepository.resolve(observation)).resolves.toBeNull();
    await getPool().query(
      'UPDATE connected_accounts SET disconnected_at = NULL WHERE id = $1',
      [authorityAccountId],
    );
    await getPool().query(
      `UPDATE connected_accounts SET scopes = ARRAY['gmail.readonly']::STRING[] WHERE id = $1`,
      [authorityAccountId],
    );
    await expect(gmailInboxObservationTargetRepository.resolve(observation)).resolves.toBeNull();
    await getPool().query(
      'UPDATE connected_accounts SET scopes = ARRAY[$2]::STRING[] WHERE id = $1',
      [authorityAccountId, gmailModifyScope],
    );
    await getPool().query(
      `UPDATE oauth_tokens SET scopes = ARRAY['gmail.readonly']::STRING[]
        WHERE connector_account_id = $1`,
      [authorityAccountId],
    );
    await expect(gmailInboxObservationTargetRepository.resolve(observation)).resolves.toBeNull();
    await getPool().query(
      'UPDATE oauth_tokens SET scopes = ARRAY[$2]::STRING[] WHERE connector_account_id = $1',
      [authorityAccountId, gmailModifyScope],
    );
    await expect(gmailInboxObservationTargetRepository.resolve(observation)).resolves.toMatchObject({
      connectorAccountId: authorityAccountId,
    });
    await getPool().query(
      'DELETE FROM oauth_tokens WHERE connector_account_id = $1',
      [authorityAccountId],
    );
    await expect(gmailInboxObservationTargetRepository.resolve(observation)).resolves.toBeNull();
    await getPool().query(
      `INSERT INTO oauth_tokens (
         id, user_id, provider, access_token, refresh_token, expires_at, scopes,
         account_email, account_provider_id, connector_account_id
       ) VALUES ($2, $1, 'google', NULL, NULL, now() + INTERVAL '1 hour',
         ARRAY[$3]::STRING[], 'observation-authority@example.test', 'observation-authority', $4)`,
      [authorityUserId, id('55', 115), gmailModifyScope, authorityAccountId],
    );
    await getPool().query(
      'DELETE FROM connected_accounts WHERE id = $1 AND user_id = $2',
      [authorityAccountId, authorityUserId],
    );
    await expect(gmailInboxObservationTargetRepository.resolve(observation)).resolves.toBeNull();
  }, 120_000);

  it('rejects source-binding drift and reflects a fresh opaque provider target for race comparison', async () => {
    const sourceDrift = await createClaimedProposal(116, userId, accountId, true);
    await getPool().query(
      `UPDATE pre_effect_barriers SET updated_at = now() - INTERVAL '6 minutes' WHERE id = $1`,
      [sourceDrift.command.admissionId],
    );
    await getPool().query(
      `UPDATE signals SET source_signal_id = 'drifted-observation-source' WHERE resource_ref_id = $1`,
      [sourceDrift.command.messageRefId],
    );
    await expect(gmailInboxObservationTargetRepository.resolve({
      userId,
      admissionId: sourceDrift.command.admissionId,
      messageRefId: sourceDrift.command.messageRefId,
      operation: 'observe_inbox',
    })).resolves.toBeNull();

    const changed = await createClaimedProposal(117, userId, accountId, true);
    await getPool().query(
      `UPDATE pre_effect_barriers SET updated_at = now() - INTERVAL '6 minutes' WHERE id = $1`,
      [changed.command.admissionId],
    );
    const changedObservation = {
      userId,
      admissionId: changed.command.admissionId,
      messageRefId: changed.command.messageRefId,
      operation: 'observe_inbox' as const,
    };
    const initial = await gmailInboxObservationTargetRepository.resolve(changedObservation);
    await getPool().query(
      `UPDATE gmail_message_refs SET provider_message_id = 'native-replaced-117' WHERE id = $1`,
      [changed.command.messageRefId],
    );
    const current = await gmailInboxObservationTargetRepository.resolve(changedObservation);
    expect(initial).toMatchObject({ providerMessageId: 'native-117' });
    expect(current).toMatchObject({ providerMessageId: 'native-replaced-117' });
    expect(current).not.toEqual(initial);
  }, 120_000);

  it('rejects legacy marker-free and receipt-tampered dispatch attempts', async () => {
    const legacy = await createClaimedProposal(65);
    const legacyTarget = await currentMutationTarget(legacy.command);
    await getPool().query(
      `UPDATE pre_effect_barriers SET effect_result = '{}'::JSONB WHERE id = $1`,
      [legacy.command.admissionId],
    );
    await expect(gmailArchiveDispatchGateRepository.enter(legacy.command, legacyTarget)).resolves.toEqual({
      status: 'conflict',
    });
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: legacy.proposal.approval.id,
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const tampered = await createClaimedProposal(66);
    const tamperedTarget = await currentMutationTarget(tampered.command);
    await getPool().query(
      'UPDATE decision_receipt_revisions SET trusted = false WHERE receipt_id = $1 AND sequence = 6',
      [tampered.prepared.receipt.id],
    );
    await expect(gmailArchiveDispatchGateRepository.enter(
      tampered.command,
      tamperedTarget,
    )).resolves.toEqual({
      status: 'conflict',
    });
    const unchanged = await getPool().query<{ effect_result: Record<string, unknown> }>(
      'SELECT effect_result FROM pre_effect_barriers WHERE id = $1',
      [tampered.command.admissionId],
    );
    expect(unchanged.rows[0]?.effect_result).toEqual({
      schema: 'gmail_archive_attempt_v1', phase: 'pre_dispatch',
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
    const fixture = await createClaimedProposal(suffix, userId, accountId, effect !== 'already_in_state');
    const result = {
      outcome: 'confirmed' as const,
      operation: 'archive' as const,
      inbox: false as const,
      effect,
      compensationAvailable: false as const,
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      binding: mutationBinding(fixture.command),
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
    expect(parseGmailArchiveTerminalExplanationBinding(
      terminalized.terminalization.executionExplanation.evidence_used,
    )?.attemptPhase).toBe(effect === 'already_in_state' ? 'pre_dispatch' : 'dispatch_may_have_started');
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

  it('rejects terminal results that contradict the durable dispatch phase', async () => {
    const beforeDispatch = await createClaimedProposal(67);
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: beforeDispatch.command,
      result: {
        outcome: 'confirmed', operation: 'archive', inbox: false, effect: 'changed',
        compensationAvailable: false, observedAt: new Date(Date.now() - 1_000).toISOString(),
        binding: mutationBinding(beforeDispatch.command),
      },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const afterDispatch = await createClaimedProposal(68, userId, accountId, true);
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: afterDispatch.command,
      result: {
        outcome: 'known_failure', code: 'preflight_unavailable', compensationAvailable: false,
        binding: mutationBinding(afterDispatch.command),
      },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
  }, 120_000);

  it.each([
    'not_admitted',
    'admission_unavailable',
    'credentials_unavailable',
    'preflight_unavailable',
    'remote_rejected',
  ] as const)('terminalizes known failure %s with only the safe enum', async (code) => {
    const suffix = 80 + [
      'not_admitted',
      'admission_unavailable',
      'credentials_unavailable',
      'preflight_unavailable',
      'remote_rejected',
    ].indexOf(code);
    const fixture = await createClaimedProposal(suffix);
    const result = {
      outcome: 'known_failure' as const,
      code,
      compensationAvailable: false as const,
      binding: mutationBinding(fixture.command),
    };
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
          outputs: {
            schema: 'gmail_archive_terminal_result_v3',
            attemptPhase: 'pre_dispatch',
            outcome: 'known_failure',
            code,
          },
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
    expect(parseGmailArchiveTerminalExplanationBinding(
      terminalized.terminalization.executionExplanation.evidence_used,
    )?.attemptPhase).toBe('pre_dispatch');
    if (code === 'remote_rejected') {
      expect(terminalized.terminalization.executionExplanation.what_happened)
        .not.toContain('before any mutation');
    } else {
      expect(terminalized.terminalization.executionExplanation.what_happened)
        .toContain('before any mutation');
    }
  }, 120_000);

  it('does not terminalize unbound invalid-command output for a canonical command', async () => {
    const fixture = await createClaimedProposal(86);
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: fixture.command,
      result: {
        outcome: 'known_failure',
        code: 'invalid_command',
        compensationAvailable: false,
      },
    })).resolves.toEqual({ ok: false, error: 'invalid_input' });
  }, 120_000);

  it('terminalizes an unknown remote outcome without fabricating a result row', async () => {
    const fixture = await createClaimedProposal(90, userId, accountId, true);
    const result = {
      outcome: 'unknown' as const,
      code: 'remote_outcome_unknown' as const,
      compensationAvailable: false as const,
      binding: mutationBinding(fixture.command),
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
    expect(parseGmailArchiveTerminalExplanationBinding(
      terminalized.terminalization.executionExplanation.evidence_used,
    )?.attemptPhase).toBe('dispatch_may_have_started');
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
    const donor = await createClaimedProposal(91, userId, accountId, true);
    const donorResult = {
      outcome: 'confirmed' as const,
      operation: 'archive' as const,
      inbox: false as const,
      effect: 'changed' as const,
      compensationAvailable: false as const,
      observedAt: new Date(Date.now() - 2_000).toISOString(),
      binding: mutationBinding(donor.command),
    };
    const donorTerminal = await gmailArchiveTerminalizationRepository.terminalize({
      command: donor.command,
      result: donorResult,
    });
    expect(donorTerminal).toMatchObject({ ok: true, created: true });
    if (!donorTerminal.ok || !donorTerminal.terminalization.executionResult) {
      throw new Error('Rollback donor did not create an execution result.');
    }

    const target = await createClaimedProposal(92, userId, accountId, true);
    const before = await artifactCounts(target.proposal.decision.id, target.proposal.approval.id);
    await expect(gmailArchiveTerminalizationTestHooks.terminalizeWithTransition(
      {
        command: target.command,
        result: {
          ...donorResult,
          observedAt: new Date(Date.now() - 1_000).toISOString(),
          binding: mutationBinding(target.command),
        },
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
    const fixture = await createClaimedProposal(103, userId, accountId, true);
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
          binding: mutationBinding(fixture.command),
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
        binding: mutationBinding(same.command),
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
        result: {
          ...sameInput.result,
          code: 'remote_rejected',
          binding: mutationBinding(different.command),
        },
      }),
      gmailArchiveTerminalizationRepository.terminalize({
        command: different.command,
        result: {
          ...sameInput.result,
          code: 'preflight_unavailable',
          binding: mutationBinding(different.command),
        },
      }),
    ]);
    expect(differentResults.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(differentResults.filter(
      (result) => !result.ok && result.error === 'idempotency_conflict',
    )).toHaveLength(1);
  }, 120_000);

  it('rejects crossed canonical results of every class concurrently without durable writes', async () => {
    const targetFixture = await createClaimedProposal(131);
    const donorFixture = await createClaimedProposal(132);
    const before = await artifactCounts(
      targetFixture.proposal.decision.id,
      targetFixture.proposal.approval.id,
    );
    const donorBinding = mutationBinding(donorFixture.command);
    const results = await Promise.all([
      gmailArchiveTerminalizationRepository.terminalize({
        command: targetFixture.command,
        result: {
          outcome: 'confirmed', operation: 'archive', inbox: false, effect: 'already_in_state',
          compensationAvailable: false,
          observedAt: new Date(Date.now() - 1_000).toISOString(),
          binding: donorBinding,
        },
      }),
      gmailArchiveTerminalizationRepository.terminalize({
        command: targetFixture.command,
        result: {
          outcome: 'known_failure', code: 'preflight_unavailable',
          compensationAvailable: false, binding: donorBinding,
        },
      }),
      gmailArchiveTerminalizationRepository.terminalize({
        command: targetFixture.command,
        result: {
          outcome: 'unknown', code: 'remote_outcome_unknown',
          compensationAvailable: false, binding: donorBinding,
        },
      }),
    ]);

    expect(results).toEqual([
      { ok: false, error: 'invalid_input' },
      { ok: false, error: 'invalid_input' },
      { ok: false, error: 'invalid_input' },
    ]);
    await expect(artifactCounts(
      targetFixture.proposal.decision.id,
      targetFixture.proposal.approval.id,
    )).resolves.toEqual(before);
    const barrier = await getPool().query<{ status: string; effect_result: Record<string, unknown> }>(
      'SELECT status, effect_result FROM pre_effect_barriers WHERE id = $1',
      [targetFixture.command.admissionId],
    );
    expect(barrier.rows[0]).toEqual({
      status: 'in_progress',
      effect_result: { schema: 'gmail_archive_attempt_v1', phase: 'pre_dispatch' },
    });
  }, 120_000);

  it('binds terminalization to the exact winning command and owner', async () => {
    const fixture = await createClaimedProposal(93);
    const resultFor = (attemptCommand: typeof fixture.command) => ({
      outcome: 'known_failure' as const,
      code: 'remote_rejected' as const,
      compensationAvailable: false as const,
      binding: mutationBinding(attemptCommand),
    });
    const wrongOwner = { ...fixture.command, userId: otherUserId };
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: wrongOwner,
      result: resultFor(wrongOwner),
    })).resolves.toEqual({ ok: false, error: 'not_found' });
    const wrongMessage = { ...fixture.command, messageRefId: id('33', 999) };
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: wrongMessage,
      result: resultFor(wrongMessage),
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    const wrongAdmission = { ...fixture.command, admissionId: id('12', 999) };
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: wrongAdmission,
      result: resultFor(wrongAdmission),
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
      result: {
        outcome: 'known_failure', code: 'remote_rejected', compensationAvailable: false,
        binding: mutationBinding(untrusted.command),
      },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const attempted = await createClaimedProposal(95);
    await getPool().query(
      `INSERT INTO execution_events (id, plan_id, event_type, payload)
       VALUES ($1, $2, 'started', '{}')`,
      [id('98', 95), attempted.prepared.plan.id],
    );
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: attempted.command,
      result: {
        outcome: 'known_failure', code: 'remote_rejected', compensationAvailable: false,
        binding: mutationBinding(attempted.command),
      },
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
        binding: mutationBinding(fixture.command),
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
    const fixture = await createClaimedProposal(100, userId, accountId, true);
    const input = {
      command: fixture.command,
      result: {
        outcome: 'unknown' as const,
        code: 'remote_outcome_unknown' as const,
        compensationAvailable: false as const,
        binding: mutationBinding(fixture.command),
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
        binding: mutationBinding(fixture.command),
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

  it('atomically reconciles a pre-dispatch interruption as a known no-request failure', async () => {
    const fixture = await createClaimedProposal(120);
    const staleTarget = await currentMutationTarget(fixture.command);
    const phaseChangedAt = await ageClaimedAttempt(fixture.command.admissionId);
    const input = {
      command: { ...fixture.command, operation: 'reconcile_archive' as const },
      phase: 'pre_dispatch' as const,
      phaseChangedAt,
      evidence: { kind: 'interrupted_before_dispatch' as const },
    };
    const recovery = await gmailArchiveRecoveryRepository.query({
      userId,
      approvalId: fixture.proposal.approval.id,
    });
    if (!recovery.ok || recovery.status !== 'eligible') {
      throw new Error(`Recovery fixture is not eligible: ${JSON.stringify(recovery)}`);
    }
    const [first, concurrent] = await Promise.all([
      gmailArchiveReconciliationRepository.reconcile(input),
      gmailArchiveReconciliationRepository.reconcile(input),
    ]);
    if (!first.ok || !concurrent.ok) {
      throw new Error(`Concurrent reconciliation failed: ${JSON.stringify([first, concurrent])}`);
    }
    expect([first, concurrent].filter((result) => result.ok && result.created)).toHaveLength(1);
    expect([first, concurrent].every((result) => result.ok)).toBe(true);
    const terminalized = [first, concurrent].find((result) => result.ok && result.created);
    if (!terminalized?.ok) throw new Error('Pre-dispatch reconciliation failed.');
    expect(terminalized.reconciliation).toMatchObject({
      status: 'failed',
      barrier: {
        status: 'failed',
        failure_reason: 'recovery_interrupted_before_dispatch',
      },
      plan: { status: 'failed' },
      executionResult: {
        success: false,
        error: 'recovery_interrupted_before_dispatch',
        rollback_available: false,
      },
      revision: {
        sequence: 7,
        disposition: 'failed',
        execution_disposition: 'failed',
      },
    });
    expect(parseGmailArchiveReconciliationExplanationEvidence(
      terminalized.reconciliation.executionExplanation.evidence_used,
    )).toEqual({
      schema: 'gmail_archive_reconciliation_terminal_v1',
      attemptPhase: 'pre_dispatch',
      phaseChangedAt,
      outcome: 'failed',
      code: 'recovery_interrupted_before_dispatch',
      compensationAvailable: false,
      evidence: { kind: 'interrupted_before_dispatch' },
    });
    expect(terminalized.reconciliation.executionExplanation.what_happened)
      .toContain('before any Gmail mutation request began');
    const terminalAt = terminalized.reconciliation.revision.created_at.getTime();
    expect(terminalized.reconciliation.barrier.updated_at.getTime()).toBe(terminalAt);
    expect(terminalized.reconciliation.plan.updated_at.getTime()).toBe(terminalAt);
    expect(terminalized.reconciliation.executionResult?.completed_at.getTime()).toBe(terminalAt);
    expect(terminalized.reconciliation.executionExplanation.created_at.getTime()).toBe(terminalAt);
    const before = await artifactCounts(
      fixture.proposal.decision.id,
      fixture.proposal.approval.id,
    );
    await expect(gmailArchiveReconciliationRepository.reconcile(input)).resolves.toMatchObject({
      ok: true,
      created: false,
      reconciliation: { status: 'failed', revision: { sequence: 7 } },
    });
    await expect(gmailArchiveRecoveryRepository.query({
      userId,
      approvalId: fixture.proposal.approval.id,
    })).resolves.toEqual({ ok: true, status: 'terminal', recovery: null });
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: fixture.proposal.approval.id,
    })).resolves.toEqual({ ok: true, claimed: false, state: 'terminal', command: null });
    await expect(gmailArchiveDispatchGateRepository.enter(
      fixture.command,
      staleTarget,
    )).resolves.toEqual({
      status: 'not_admitted',
    });
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: fixture.command,
      result: {
        outcome: 'known_failure',
        code: 'preflight_unavailable',
        compensationAvailable: false,
        binding: mutationBinding(fixture.command),
      },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    await expect(artifactCounts(
      fixture.proposal.decision.id,
      fixture.proposal.approval.id,
    )).resolves.toEqual(before);
    const reconciliationContent = terminalized.reconciliation.revision.content;
    if (reconciliationContent.version !== 2) throw new Error('Expected terminal receipt v2.');
    await withTransaction(async (client) => {
      const feedback = (await client.query<Record<string, unknown>>(
        `INSERT INTO feedback_events (id, user_id, decision_id, type, data)
         VALUES ($1, $2, $3, 'approval', '{}') RETURNING *`,
        [id('96', 120), userId, fixture.proposal.decision.id],
      )).rows[0]!;
      const content: JoinedDecisionReceiptContentV2 = {
        ...reconciliationContent,
        stage: 'feedback_recorded',
        feedbackEvents: [decisionReceiptRowArtifactRefV1('feedback', feedback)],
      };
      const appended = await decisionReceiptLifecycleRepository.appendForUser(client, userId, {
        eventId: feedback['id'] as string,
        eventKind: 'feedback_recorded',
        expectedPreviousDigest: terminalized.reconciliation.revision.revision_digest,
        content,
        receiptId: fixture.prepared.receipt.id,
      });
      expect(appended).toMatchObject({ success: true, created: true, revision: { sequence: 8 } });
    });
    const afterFeedback = await artifactCounts(
      fixture.proposal.decision.id,
      fixture.proposal.approval.id,
    );
    await expect(gmailArchiveReconciliationRepository.reconcile(input)).resolves.toMatchObject({
      ok: true,
      created: false,
      reconciliation: { revision: { sequence: 7 } },
    });
    await expect(gmailArchiveClaimRepository.claim({
      userId,
      approvalId: fixture.proposal.approval.id,
    })).resolves.toEqual({ ok: true, claimed: false, state: 'terminal', command: null });
    await expect(artifactCounts(
      fixture.proposal.decision.id,
      fixture.proposal.approval.id,
    )).resolves.toEqual(afterFeedback);
  }, 120_000);

  it.each([
    ['outside Inbox', false, null, 121],
    ['in Inbox', true, null, 122],
    ['unavailable', null, 'observation_unavailable', 123],
  ] as const)(
    'reconciles dispatch-started evidence %s as causal unknown without a result row',
    async (_label, inbox, unavailableCode, suffix) => {
      const fixture = await createClaimedProposal(suffix, userId, accountId, true);
      const phaseChangedAt = await ageClaimedAttempt(fixture.command.admissionId);
      const binding = {
        userId,
        admissionId: fixture.command.admissionId,
        messageRefId: fixture.command.messageRefId,
      };
      const evidence = inbox === null
        ? {
            kind: 'mailbox_observation_unavailable' as const,
            binding,
            code: unavailableCode!,
          }
        : {
            kind: 'mailbox_observed' as const,
            binding,
            inbox,
            observedAt: new Date(Date.now() - 1_000).toISOString(),
          };
      const input = {
        command: { ...fixture.command, operation: 'reconcile_archive' as const },
        phase: 'dispatch_may_have_started' as const,
        phaseChangedAt,
        evidence,
      };
      const recovery = await gmailArchiveRecoveryRepository.query({
        userId,
        approvalId: fixture.proposal.approval.id,
      });
      if (!recovery.ok || recovery.status !== 'eligible') {
        throw new Error(`Recovery fixture is not eligible: ${JSON.stringify(recovery)}`);
      }
      const terminalized = await gmailArchiveReconciliationRepository.reconcile(input);
      if (!terminalized.ok) {
        throw new Error(`Dispatch reconciliation failed: ${terminalized.error}`);
      }
      expect(terminalized).toMatchObject({
        ok: true,
        created: true,
        reconciliation: {
          status: 'unknown',
          barrier: {
            status: 'unknown',
            failure_reason: 'recovery_causal_outcome_unknown',
          },
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
      if (!terminalized.ok) throw new Error('Dispatch-started reconciliation failed.');
      const retained = parseGmailArchiveReconciliationExplanationEvidence(
        terminalized.reconciliation.executionExplanation.evidence_used,
      );
      expect(retained).toMatchObject({
        schema: 'gmail_archive_reconciliation_terminal_v1',
        attemptPhase: 'dispatch_may_have_started',
        phaseChangedAt,
        outcome: 'unknown',
        code: 'recovery_causal_outcome_unknown',
        evidence,
      });
      expect(retained).not.toHaveProperty('effect');
      expect(terminalized.reconciliation.executionExplanation.what_happened)
        .toContain('unknown outcome');
      if (inbox !== null) {
        expect(terminalized.reconciliation.executionExplanation.what_happened)
          .toContain('does not establish what caused that state');
      }
      const counts = await getPool().query<{ results: string; events: string }>(
        `SELECT
           (SELECT count(*)::STRING FROM execution_results WHERE plan_id = $1) AS results,
           (SELECT count(*)::STRING FROM execution_events WHERE plan_id = $1) AS events`,
        [fixture.prepared.plan.id],
      );
      expect(counts.rows[0]).toEqual({ results: '0', events: '0' });
      await expect(gmailArchiveReconciliationRepository.reconcile(input)).resolves.toMatchObject({
        ok: true,
        created: false,
        reconciliation: { status: 'unknown', executionResult: null },
      });
      const conflictingEvidence = inbox === false
        ? { ...evidence, inbox: true }
        : {
            kind: 'mailbox_observation_unavailable' as const,
            binding,
            code: 'observation_rejected' as const,
          };
      await expect(gmailArchiveReconciliationRepository.reconcile({
        ...input,
        evidence: conflictingEvidence,
      })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
      await expect(gmailArchiveClaimRepository.claim({
        userId,
        approvalId: fixture.proposal.approval.id,
      })).resolves.toEqual({ ok: true, claimed: false, state: 'terminal', command: null });
    },
    120_000,
  );

  it('rejects cross-owner, wrong admission, wrong message, phase, timestamp, and cross-schema replay', async () => {
    const authority = await createClaimedProposal(124);
    const phaseChangedAt = await ageClaimedAttempt(authority.command.admissionId);
    const base = {
      command: { ...authority.command, operation: 'reconcile_archive' as const },
      phase: 'pre_dispatch' as const,
      phaseChangedAt,
      evidence: { kind: 'interrupted_before_dispatch' as const },
    };
    await expect(gmailArchiveReconciliationRepository.reconcile({
      ...base,
      command: { ...base.command, userId: otherUserId },
    })).resolves.toEqual({ ok: false, error: 'not_found' });
    await expect(gmailArchiveReconciliationRepository.reconcile({
      ...base,
      command: { ...base.command, admissionId: id('99', 124) },
    })).resolves.toEqual({ ok: false, error: 'not_found' });
    await expect(gmailArchiveReconciliationRepository.reconcile({
      ...base,
      command: { ...base.command, messageRefId: id('99', 125) },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    await expect(gmailArchiveReconciliationRepository.reconcile({
      ...base,
      phase: 'dispatch_may_have_started',
      evidence: {
        kind: 'mailbox_observation_unavailable',
        binding: {
          userId,
          admissionId: authority.command.admissionId,
          messageRefId: authority.command.messageRefId,
        },
        code: 'observation_unavailable',
      },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    await expect(gmailArchiveReconciliationRepository.reconcile({
      ...base,
      phaseChangedAt: new Date(Date.parse(phaseChangedAt) - 1_000).toISOString(),
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });

    const crossSchema = await createClaimedProposal(125, userId, accountId, true);
    const crossPhaseChangedAt = await ageClaimedAttempt(crossSchema.command.admissionId);
    await expect(gmailArchiveTerminalizationRepository.terminalize({
      command: crossSchema.command,
      result: {
        outcome: 'unknown',
        code: 'remote_outcome_unknown',
        compensationAvailable: false,
        binding: mutationBinding(crossSchema.command),
      },
    })).resolves.toMatchObject({ ok: true, created: true });
    await expect(gmailArchiveReconciliationRepository.reconcile({
      command: { ...crossSchema.command, operation: 'reconcile_archive' },
      phase: 'dispatch_may_have_started',
      phaseChangedAt: crossPhaseChangedAt,
      evidence: {
        kind: 'mailbox_observation_unavailable',
        binding: {
          userId,
          admissionId: crossSchema.command.admissionId,
          messageRefId: crossSchema.command.messageRefId,
        },
        code: 'observation_unavailable',
      },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
  }, 120_000);

  it('loses cleanly when the durable attempt advances after the recovery snapshot', async () => {
    const fixture = await createClaimedProposal(126);
    const phaseChangedAt = await ageClaimedAttempt(fixture.command.admissionId);
    await expect(enterDispatchGate(fixture.command)).resolves.toEqual({
      status: 'entered',
    });
    await expect(gmailArchiveReconciliationRepository.reconcile({
      command: { ...fixture.command, operation: 'reconcile_archive' },
      phase: 'pre_dispatch',
      phaseChangedAt,
      evidence: { kind: 'interrupted_before_dispatch' },
    })).resolves.toEqual({ ok: false, error: 'idempotency_conflict' });
    const durable = await getPool().query<{
      status: string;
      effect_result: Record<string, unknown>;
      results: string;
      revisions: string;
    }>(
      `SELECT barrier.status, barrier.effect_result,
        (SELECT count(*)::STRING FROM execution_results WHERE plan_id = $2) AS results,
        (SELECT count(*)::STRING FROM decision_receipt_revisions WHERE receipt_id = $3) AS revisions
       FROM pre_effect_barriers barrier WHERE barrier.id = $1`,
      [fixture.command.admissionId, fixture.prepared.plan.id, fixture.prepared.receipt.id],
    );
    expect(durable.rows[0]).toMatchObject({
      status: 'in_progress',
      effect_result: {
        schema: 'gmail_archive_attempt_v1',
        phase: 'dispatch_may_have_started',
      },
      results: '0',
      revisions: '6',
    });
  }, 120_000);

  it('rolls back a post-write 40001 and retries with one stable reconciliation graph', async () => {
    const fixture = await createClaimedProposal(127);
    const phaseChangedAt = await ageClaimedAttempt(fixture.command.admissionId);
    const stableIds = {
      explanationId: id('94', 127),
      resultId: id('95', 127),
      revisionId: id('96', 127),
    };
    let transitions = 0;
    const terminalized = await gmailArchiveReconciliationTestHooks.reconcileWithTransition(
      {
        command: { ...fixture.command, operation: 'reconcile_archive' },
        phase: 'pre_dispatch',
        phaseChangedAt,
        evidence: { kind: 'interrupted_before_dispatch' },
      },
      async (client, input, stable) => {
        const result = await gmailArchiveReconciliationTestHooks.transition(client, input, stable);
        transitions += 1;
        if (transitions === 1) {
          throw Object.assign(new Error('restart after reconciliation writes'), { code: '40001' });
        }
        return result;
      },
      (persistedAt) => ({ ...stableIds, persistedAt }),
    );
    expect(transitions).toBe(2);
    expect(terminalized).toMatchObject({
      ok: true,
      created: true,
      reconciliation: {
        status: 'failed',
        executionExplanation: { id: stableIds.explanationId },
        executionResult: { id: stableIds.resultId },
        revision: { id: stableIds.revisionId, sequence: 7 },
      },
    });
    const durable = await getPool().query<{
      explanations: string;
      results: string;
      revisions: string;
      matching_explanations: string;
      matching_results: string;
      matching_revisions: string;
    }>(
      `SELECT
        (SELECT count(*)::STRING FROM explanation_records WHERE decision_id = $1) AS explanations,
        (SELECT count(*)::STRING FROM execution_results WHERE plan_id = $2) AS results,
        (SELECT count(*)::STRING FROM decision_receipt_revisions WHERE receipt_id = $3) AS revisions,
        (SELECT count(*)::STRING FROM explanation_records WHERE id = $4) AS matching_explanations,
        (SELECT count(*)::STRING FROM execution_results WHERE id = $5) AS matching_results,
        (SELECT count(*)::STRING FROM decision_receipt_revisions WHERE id = $6) AS matching_revisions`,
      [
        fixture.proposal.decision.id,
        fixture.prepared.plan.id,
        fixture.prepared.receipt.id,
        stableIds.explanationId,
        stableIds.resultId,
        stableIds.revisionId,
      ],
    );
    expect(durable.rows[0]).toEqual({
      explanations: '3',
      results: '1',
      revisions: '7',
      matching_explanations: '1',
      matching_results: '1',
      matching_revisions: '1',
    });
  }, 120_000);

  it('backs up, validates, and restores a bound mutation-terminal graph', async () => {
    const portableUserId = id('11', 7);
    const portableAccountId = id('22', 7);
    await seedOwner(
      portableUserId,
      portableAccountId,
      id('55', 7),
      'mutation-portable-owner@example.test',
    );
    const fixture = await createClaimedProposal(133, portableUserId, portableAccountId);
    const result = {
      outcome: 'known_failure' as const,
      code: 'preflight_unavailable' as const,
      compensationAvailable: false as const,
      binding: mutationBinding(fixture.command),
    };
    const terminalized = await gmailArchiveTerminalizationRepository.terminalize({
      command: fixture.command,
      result,
    });
    expect(terminalized).toMatchObject({ ok: true, created: true });
    if (!terminalized.ok) throw new Error('Portable mutation terminal fixture failed.');

    const backup = await collectBackup(portableUserId);
    expect(backup).toMatchObject({ success: true });
    if (!backup.success) throw new Error(`Terminal backup failed: ${backup.message}`);
    expect(validateBackupData(backup.data)).toEqual([]);

    await getPool().query('TRUNCATE TABLE users CASCADE');
    await expect(restoreBackup(backup.data)).resolves.toMatchObject({ success: true });
    const restoredExplanation = await getPool().query<{ evidence_used: unknown }>(
      'SELECT evidence_used FROM explanation_records WHERE id = $1 AND decision_id = $2',
      [terminalized.terminalization.executionExplanation.id, fixture.proposal.decision.id],
    );
    expect(parseGmailArchiveTerminalExplanationBinding(
      restoredExplanation.rows[0]?.evidence_used,
    )).toEqual({
      result,
      attemptPhase: 'pre_dispatch',
    });
  }, 120_000);

  it('backs up, validates, and restores a reconciled graph after connector evidence is removed', async () => {
    // Use a dedicated owner so earlier fail-closed cases can retain their
    // intentionally malformed graphs without polluting this portable export.
    const portableUserId = id('11', 3);
    const portableAccountId = id('22', 3);
    await seedOwner(portableUserId, portableAccountId, id('55', 3), 'portable-owner@example.test');
    const fixture = await createClaimedProposal(102, portableUserId, portableAccountId, true);
    const phaseChangedAt = await ageClaimedAttempt(fixture.command.admissionId);
    await getPool().query(
      'DELETE FROM connected_accounts WHERE id = $1 AND user_id = $2',
      [portableAccountId, portableUserId],
    );
    const evidence = await getPool().query<{ refs: string; signals: string }>(`SELECT
      (SELECT count(*)::STRING FROM gmail_message_refs WHERE id = $1) AS refs,
      (SELECT count(*)::STRING FROM signals WHERE resource_ref_id = $1) AS signals`,
    [fixture.proposal.messageRefId]);
    expect(evidence.rows[0]).toEqual({ refs: '0', signals: '0' });
    const terminalized = await gmailArchiveReconciliationRepository.reconcile({
      command: { ...fixture.command, operation: 'reconcile_archive' },
      phase: 'dispatch_may_have_started',
      phaseChangedAt,
      evidence: {
        kind: 'mailbox_observation_unavailable',
        binding: {
          userId: portableUserId,
          admissionId: fixture.command.admissionId,
          messageRefId: fixture.command.messageRefId,
        },
        code: 'not_observable',
      },
    });
    expect(terminalized).toMatchObject({
      ok: true,
      created: true,
      reconciliation: { status: 'unknown', executionResult: null },
    });
    if (!terminalized.ok) throw new Error('Portable reconciliation fixture failed.');

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
      [terminalized.reconciliation.executionExplanation.id, fixture.proposal.decision.id],
    );
    expect(parseGmailArchiveReconciliationExplanationEvidence(
      restoredExplanation.rows[0]?.evidence_used,
    )).toEqual({
      schema: 'gmail_archive_reconciliation_terminal_v1',
      attemptPhase: 'dispatch_may_have_started',
      phaseChangedAt,
      outcome: 'unknown',
      code: 'recovery_causal_outcome_unknown',
      compensationAvailable: false,
      evidence: {
        kind: 'mailbox_observation_unavailable',
        binding: {
          userId: portableUserId,
          admissionId: fixture.command.admissionId,
          messageRefId: fixture.command.messageRefId,
        },
        code: 'not_observable',
      },
    });
  }, 120_000);

  it('classifies and leases each canonical recovery stage with its exact DB anchor', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(1);
    const reservedProposal = await createProposal(150, ownerUserId, ownerAccountId);
    const approved = await gmailArchiveApprovalResponseRepository.respond({
      approvalId: reservedProposal.approval.id,
      userId: ownerUserId,
      action: 'approve',
    });
    expect(approved).toMatchObject({ ok: true, response: { reservedBarrier: { status: 'reserved' } } });
    if (!approved.ok || !approved.response.reservedBarrier) throw new Error('Reserved lease fixture failed.');
    await setRecoveryAnchor(approved.response.reservedBarrier.id, 'created_at');

    const prepared = await createPreparedProposal(151, ownerUserId, ownerAccountId);
    await setRecoveryAnchor(prepared.prepared.barrier.id, 'updated_at');
    const preDispatch = await createClaimedProposal(152, ownerUserId, ownerAccountId);
    await setRecoveryAnchor(
      preDispatch.command.admissionId,
      'updated_at',
      '2026-09-12T12:00:00.123Z',
    );
    const dispatch = await createClaimedProposal(153, ownerUserId, ownerAccountId, true);
    await setRecoveryAnchor(
      dispatch.command.admissionId,
      'updated_at',
      '2026-09-12T12:00:00.123Z',
    );

    const cases = [
      [reservedProposal.approval.id, 'resume_preparation', 'reserved', null, '2026-09-12T12:00:00.123456Z'],
      [prepared.proposal.approval.id, 'resume_claim', 'prepared', null, '2026-09-12T12:00:00.123456Z'],
      [preDispatch.proposal.approval.id, 'reconcile_pre_dispatch', 'in_progress', 'pre_dispatch', '2026-09-12T12:00:00.123Z'],
      [dispatch.proposal.approval.id, 'observe_dispatch', 'in_progress', 'dispatch_may_have_started', '2026-09-12T12:00:00.123Z'],
    ] as const;
    for (const [approvalId, workKind, barrierStatus, attemptPhase, phaseChangedAt] of cases) {
      const acquired = await gmailArchiveRecoveryLeaseRepository.acquire({
        userId: ownerUserId,
        approvalId,
        leaseMs: 60_000,
      });
      if (!acquired.ok) {
        throw new Error(`Recovery lease acquire failed for ${workKind} (${approvalId}): ${acquired.error}`);
      }
      expect(acquired).toMatchObject({
        ok: true,
        status: 'acquired',
        created: true,
        lease: {
          workKind,
          barrierStatus,
          attemptPhase,
          phaseChangedAt,
          generation: 1,
        },
      });
    }
  }, 120_000);

  it('shares preparation lock order with reserved recovery acquisition', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(18);
    const proposal = await createProposal(172, ownerUserId, ownerAccountId);
    const approved = await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId: ownerUserId,
      action: 'approve',
    });
    if (!approved.ok || !approved.response.reservedBarrier) {
      throw new Error('Concurrent preparation fixture was not reserved.');
    }
    await setRecoveryAnchor(approved.response.reservedBarrier.id, 'created_at');

    let releaseRecovery!: () => void;
    let authorityLocked!: () => void;
    const resumeRecovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const recoveryPaused = new Promise<void>((resolve) => { authorityLocked = resolve; });
    const acquisition = gmailArchiveRecoveryLeaseTestHooks.acquireWithTransition(
      {
        userId: ownerUserId,
        approvalId: proposal.approval.id,
        leaseMs: 60_000,
      },
      gmailArchiveRecoveryLeaseTestHooks.acquireTransition,
      pauseTransactionAfterQuery(
        /FROM decision_receipts WHERE user_id = \$1 AND decision_id = \$2 FOR UPDATE/,
        authorityLocked,
        resumeRecovery,
      ),
    );
    await within(recoveryPaused, 5_000);
    const preparation = gmailArchivePreparationRepository.prepare({
      userId: ownerUserId,
      approvalId: proposal.approval.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseRecovery();
    const [acquired, prepared] = await within(Promise.all([
      acquisition,
      preparation,
    ]), 20_000);

    expect(prepared).toMatchObject({
      ok: true,
      preparation: { status: 'prepared' },
    });
    expect(acquired).toMatchObject({ ok: true });
    if (!acquired.ok || (acquired.status !== 'acquired' && acquired.status !== 'not_due')) {
      throw new Error('Reserved recovery returned an unexpected concurrent result.');
    }
    const barrier = await getPool().query<{ status: string }>(
      'SELECT status FROM pre_effect_barriers WHERE id = $1',
      [approved.response.reservedBarrier.id],
    );
    expect(barrier.rows[0]?.status).toBe('prepared');
  }, 120_000);

  it('shares claim lock order with prepared recovery acquisition', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(19);
    const fixture = await createPreparedProposal(173, ownerUserId, ownerAccountId);
    await setRecoveryAnchor(fixture.prepared.barrier.id, 'updated_at');

    let releaseRecovery!: () => void;
    let authorityLocked!: () => void;
    const resumeRecovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const recoveryPaused = new Promise<void>((resolve) => { authorityLocked = resolve; });
    const acquisition = gmailArchiveRecoveryLeaseTestHooks.acquireWithTransition(
      {
        userId: ownerUserId,
        approvalId: fixture.proposal.approval.id,
        leaseMs: 60_000,
      },
      gmailArchiveRecoveryLeaseTestHooks.acquireTransition,
      pauseTransactionAfterQuery(
        /FROM decision_receipts WHERE user_id = \$1 AND decision_id = \$2 FOR UPDATE/,
        authorityLocked,
        resumeRecovery,
      ),
    );
    await within(recoveryPaused, 5_000);
    const claim = gmailArchiveClaimRepository.claim({
      userId: ownerUserId,
      approvalId: fixture.proposal.approval.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseRecovery();
    const [acquired, claimed] = await within(Promise.all([
      acquisition,
      claim,
    ]), 20_000);

    expect(claimed).toMatchObject({ ok: true, claimed: true });
    expect(acquired).toMatchObject({ ok: true });
    if (!acquired.ok || (acquired.status !== 'acquired' && acquired.status !== 'not_due')) {
      throw new Error('Prepared recovery returned an unexpected concurrent result.');
    }
    const barrier = await getPool().query<{ status: string }>(
      'SELECT status FROM pre_effect_barriers WHERE id = $1',
      [fixture.prepared.barrier.id],
    );
    expect(barrier.rows[0]?.status).toBe('in_progress');
  }, 120_000);

  it('has one concurrent holder and one fresh observation permit', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(2);
    const fixture = await createClaimedProposal(154, ownerUserId, ownerAccountId, true);
    await setRecoveryAnchor(
      fixture.command.admissionId,
      'updated_at',
      '2026-09-12T12:00:00.123Z',
    );
    const input = {
      userId: ownerUserId,
      approvalId: fixture.proposal.approval.id,
      leaseMs: 60_000,
    };
    const acquisitions = await Promise.all(
      Array.from({ length: 50 }, () => gmailArchiveRecoveryLeaseRepository.acquire(input)),
    );
    const winners = acquisitions.filter((result) => result.ok && result.status === 'acquired');
    if (winners.length === 0) {
      throw new Error(`No lease winner: ${JSON.stringify([...new Set(acquisitions.map((result) =>
        result.ok ? result.status : result.error))])}`);
    }
    expect(winners).toHaveLength(1);
    expect(acquisitions.filter((result) => result.ok && result.status === 'busy')).toHaveLength(49);
    const winner = winners[0];
    if (!winner?.ok || winner.status !== 'acquired') throw new Error('Lease concurrency had no winner.');

    const begins = await Promise.all(
      Array.from({ length: 50 }, () =>
        gmailArchiveRecoveryLeaseRepository.beginObservation(recoveryFence(winner.lease))),
    );
    const permits = begins.filter((result) => result.ok && result.status === 'permitted');
    expect(permits).toHaveLength(1);
    expect(begins.filter((result) => result.ok && result.status === 'already_started')).toHaveLength(49);
    const permitted = permits[0];
    if (!permitted?.ok || permitted.status !== 'permitted') throw new Error('No observation permit.');

    const barrierBefore = await getPool().query<{ updated_at: string }>(
      'SELECT updated_at::STRING FROM pre_effect_barriers WHERE id = $1',
      [fixture.command.admissionId],
    );
    await getPool().query(
      `UPDATE gmail_archive_recovery_leases
          SET acquired_at = date_trunc('milliseconds', now() - INTERVAL '2 minutes'),
              renewed_at = date_trunc('milliseconds', now() - INTERVAL '1 minute'),
              expires_at = date_trunc('milliseconds', now() - INTERVAL '1 second')
        WHERE admission_id = $1`,
      [fixture.command.admissionId],
    );
    await expect(gmailArchiveRecoveryLeaseRepository.acquire(input)).resolves.toEqual({
      ok: true,
      status: 'busy',
      lease: null,
    });
    const unavailableEvidence = {
      kind: 'mailbox_observation_unavailable' as const,
      binding: mutationBinding(fixture.command),
      code: 'observation_unavailable' as const,
    };
    await expect(gmailArchiveRecoveryLeaseRepository.recordObservation({
      permit: permitted.permit,
      evidence: unavailableEvidence,
    })).resolves.toMatchObject({ ok: true, recorded: true });
    await expect(gmailArchiveRecoveryLeaseRepository.recordObservation({
      permit: permitted.permit,
      evidence: unavailableEvidence,
    })).resolves.toEqual({ ok: true, recorded: false, evidence: unavailableEvidence });
    await expect(gmailArchiveRecoveryLeaseRepository.recordObservation({
      permit: permitted.permit,
      evidence: { ...unavailableEvidence, code: 'credentials_unavailable' },
    })).resolves.toEqual({ ok: false, error: 'evidence_conflict' });
    const preserved = await gmailArchiveRecoveryLeaseRepository.acquire(input);
    expect(preserved).toMatchObject({
      ok: true,
      status: 'acquired',
      created: false,
      lease: {
        generation: 2,
        observationState: 'evidence_recorded',
        observationAttemptId: permitted.permit.observationAttemptId,
        observationAuthorizedAt: permitted.permit.authorizedAt,
        observationDeadlineAt: permitted.permit.deadlineAt,
        evidence: unavailableEvidence,
      },
    });
    if (!preserved.ok || preserved.status !== 'acquired') throw new Error('Evidence was not retained.');
    await expect(gmailArchiveRecoveryLeaseRepository.beginObservation(
      recoveryFence(preserved.lease),
    )).resolves.toEqual({ ok: true, status: 'evidence_recorded', permit: null });
    const barrierAfter = await getPool().query<{ updated_at: string }>(
      'SELECT updated_at::STRING FROM pre_effect_barriers WHERE id = $1',
      [fixture.command.admissionId],
    );
    expect(barrierAfter.rows[0]?.updated_at).toBe(barrierBefore.rows[0]?.updated_at);
  }, 120_000);

  it('fences expired observations by recording unavailable instead of issuing another permit', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(3);
    const fixture = await createClaimedProposal(155, ownerUserId, ownerAccountId, true);
    await setRecoveryAnchor(
      fixture.command.admissionId,
      'updated_at',
      '2026-09-12T12:00:00.123Z',
    );
    const acquired = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: fixture.proposal.approval.id,
      leaseMs: 60_000,
    });
    if (!acquired.ok || acquired.status !== 'acquired') throw new Error('Takeover lease failed.');
    const begun = await gmailArchiveRecoveryLeaseRepository.beginObservation(recoveryFence(acquired.lease));
    if (!begun.ok || begun.status !== 'permitted') throw new Error('Takeover permit failed.');
    await getPool().query(
      `UPDATE gmail_archive_recovery_leases
          SET acquired_at = date_trunc('milliseconds', now() - INTERVAL '4 minutes'),
              renewed_at = date_trunc('milliseconds', now()),
              expires_at = date_trunc('milliseconds', now() + INTERVAL '1 minute'),
              observation_authorized_at = date_trunc('milliseconds', now() - INTERVAL '4 minutes'),
              observation_deadline_at = date_trunc('milliseconds', now() - INTERVAL '3 minutes')
        WHERE admission_id = $1`,
      [fixture.command.admissionId],
    );

    const takeover = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: fixture.proposal.approval.id,
      leaseMs: 60_000,
    });
    expect(takeover).toMatchObject({
      ok: true,
      status: 'acquired',
      created: false,
      lease: {
        generation: 2,
        observationState: 'evidence_recorded',
        evidence: {
          kind: 'mailbox_observation_unavailable',
          code: 'observation_unavailable',
        },
      },
    });
    if (!takeover.ok || takeover.status !== 'acquired') throw new Error('Takeover did not acquire.');
    await expect(gmailArchiveRecoveryLeaseRepository.beginObservation(recoveryFence(takeover.lease))).resolves.toEqual({
      ok: true,
      status: 'evidence_recorded',
      permit: null,
    });
    await expect(gmailArchiveRecoveryLeaseRepository.recordObservation({
      permit: begun.permit,
      evidence: {
        kind: 'mailbox_observation_unavailable',
        binding: mutationBinding(fixture.command),
        code: 'observation_unavailable',
      },
    })).resolves.toEqual({ ok: false, error: 'stale_lease' });
  }, 120_000);

  it('uses DB clock at the grace boundary and keeps stable IDs across a real 40001 rollback', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(4);
    const notDue = await createClaimedProposal(156, ownerUserId, ownerAccountId);
    await getPool().query(
      `UPDATE pre_effect_barriers
          SET updated_at = date_trunc('milliseconds', now() - INTERVAL '299.5 seconds')
        WHERE id = $1`,
      [notDue.command.admissionId],
    );
    await expect(gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: notDue.proposal.approval.id,
      leaseMs: 60_000,
    })).resolves.toEqual({ ok: true, status: 'not_due', lease: null });

    const retried = await createPreparedProposal(157, ownerUserId, ownerAccountId);
    await setRecoveryAnchor(retried.prepared.barrier.id, 'updated_at');
    let attempts = 0;
    const result = await gmailArchiveRecoveryLeaseTestHooks.acquireWithTransition(
      { userId: ownerUserId, approvalId: retried.proposal.approval.id, leaseMs: 60_000 },
      async (client, input, leaseToken) => {
        const acquired = await gmailArchiveRecoveryLeaseTestHooks.acquireTransition(
          client,
          input,
          leaseToken,
        );
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('forced restart'), { code: '40001' });
        return acquired;
      },
    );
    expect(result).toMatchObject({ ok: true, status: 'acquired', created: true });
    expect(attempts).toBe(2);
    const rows = await getPool().query<{ count: string; tokens: string }>(
      `SELECT count(*)::STRING AS count, count(DISTINCT lease_token)::STRING AS tokens
         FROM gmail_archive_recovery_leases WHERE admission_id = $1`,
      [retried.prepared.barrier.id],
    );
    expect(rows.rows[0]).toEqual({ count: '1', tokens: '1' });
  }, 120_000);

  it('repurposes active leases across valid forward stages and fences the old generation', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(6);
    const proposal = await createProposal(160, ownerUserId, ownerAccountId);
    const approved = await gmailArchiveApprovalResponseRepository.respond({
      approvalId: proposal.approval.id,
      userId: ownerUserId,
      action: 'approve',
    });
    if (!approved.ok || !approved.response.reservedBarrier) throw new Error('Forward-stage reserve failed.');
    await setRecoveryAnchor(approved.response.reservedBarrier.id, 'created_at');
    const reservedLease = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: proposal.approval.id,
      leaseMs: 300_000,
    });
    if (!reservedLease.ok || reservedLease.status !== 'acquired') throw new Error('Reserve lease failed.');

    const prepared = await gmailArchivePreparationRepository.prepare({
      userId: ownerUserId,
      approvalId: proposal.approval.id,
    });
    if (!prepared.ok || prepared.preparation.status !== 'prepared') throw new Error('Forward prepare failed.');
    await setRecoveryAnchor(prepared.preparation.barrier.id, 'updated_at');
    const preparedLease = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: proposal.approval.id,
      leaseMs: 300_000,
    });
    expect(preparedLease).toMatchObject({
      ok: true,
      status: 'acquired',
      created: false,
      lease: { workKind: 'resume_claim', generation: 2 },
    });
    await expect(gmailArchiveRecoveryLeaseRepository.renew(
      recoveryFence(reservedLease.lease),
      60_000,
    )).resolves.toMatchObject({ ok: true, status: 'not_due', lease: null });

    const claimed = await gmailArchiveClaimRepository.claim({
      userId: ownerUserId,
      approvalId: proposal.approval.id,
    });
    if (!claimed.ok || !claimed.claimed) throw new Error('Forward claim failed.');
    await setRecoveryAnchor(claimed.command.admissionId, 'updated_at', '2026-09-12T12:00:00.123Z');
    const preLease = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: proposal.approval.id,
      leaseMs: 300_000,
    });
    expect(preLease).toMatchObject({
      ok: true,
      status: 'acquired',
      created: false,
      lease: { workKind: 'reconcile_pre_dispatch', generation: 3 },
    });
    if (!preLease.ok || preLease.status !== 'acquired') throw new Error('Pre-dispatch lease failed.');
    await expect(enterDispatchGate(claimed.command)).resolves.toEqual({ status: 'entered' });
    await setRecoveryAnchor(claimed.command.admissionId, 'updated_at', '2026-09-12T12:00:00.456Z');
    const dispatchLease = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: proposal.approval.id,
      leaseMs: 300_000,
    });
    expect(dispatchLease).toMatchObject({
      ok: true,
      status: 'acquired',
      created: false,
      lease: { workKind: 'observe_dispatch', generation: 4 },
    });
    await expect(gmailArchiveRecoveryLeaseRepository.beginObservation(
      recoveryFence(preLease.lease),
    )).resolves.toEqual({ ok: false, error: 'invalid_input' });
  }, 120_000);

  it('renews without changing the barrier anchor and formats it identically outside UTC', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(7);
    const prepared = await createPreparedProposal(161, ownerUserId, ownerAccountId);
    await setRecoveryAnchor(prepared.prepared.barrier.id, 'updated_at');
    const acquired = await withTransaction(async (client) => {
      await client.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      return gmailArchiveRecoveryLeaseTestHooks.acquireTransition(
        client,
        { userId: ownerUserId, approvalId: prepared.proposal.approval.id, leaseMs: 60_000 },
        id('aa', 161),
      );
    });
    expect(acquired).toMatchObject({
      ok: true,
      status: 'acquired',
      lease: { phaseChangedAt: '2026-09-12T12:00:00.123456Z' },
    });
    if (!acquired.ok || acquired.status !== 'acquired') throw new Error('Timezone lease failed.');
    const before = await getPool().query<{ updated_at: string }>(
      'SELECT updated_at::STRING FROM pre_effect_barriers WHERE id = $1',
      [prepared.prepared.barrier.id],
    );
    await expect(gmailArchiveRecoveryLeaseRepository.renew(
      recoveryFence(acquired.lease),
      120_000,
    )).resolves.toMatchObject({ ok: true, status: 'acquired', created: false });
    const after = await getPool().query<{ updated_at: string }>(
      'SELECT updated_at::STRING FROM pre_effect_barriers WHERE id = $1',
      [prepared.prepared.barrier.id],
    );
    expect(after.rows[0]?.updated_at).toBe(before.rows[0]?.updated_at);
  }, 120_000);

  it('keeps operational leases independent of connector evidence and creates none for terminal work', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(8);
    const prepared = await createPreparedProposal(162, ownerUserId, ownerAccountId);
    await setRecoveryAnchor(prepared.prepared.barrier.id, 'updated_at');
    const acquired = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: prepared.proposal.approval.id,
      leaseMs: 60_000,
    });
    expect(acquired).toMatchObject({ ok: true, status: 'acquired' });
    if (!acquired.ok || acquired.status !== 'acquired') throw new Error('Backup lease was not acquired.');
    const backupWithLease = await collectBackup(ownerUserId);
    expect(backupWithLease).toMatchObject({ success: true });
    if (!backupWithLease.success) throw new Error('Backup with operational lease failed.');
    expect(JSON.stringify(backupWithLease.data)).not.toContain(acquired.lease.leaseToken);
    await getPool().query('DELETE FROM connected_accounts WHERE id = $1 AND user_id = $2', [
      ownerAccountId,
      ownerUserId,
    ]);
    const retained = await getPool().query<{ count: string }>(
      'SELECT count(*)::STRING AS count FROM gmail_archive_recovery_leases WHERE admission_id = $1',
      [prepared.prepared.barrier.id],
    );
    expect(retained.rows[0]?.count).toBe('1');

    const terminalOwner = await seedRecoveryOwner(9);
    const terminal = await createClaimedProposal(
      163,
      terminalOwner.ownerUserId,
      terminalOwner.ownerAccountId,
    );
    const terminalized = await gmailArchiveTerminalizationRepository.terminalize({
      command: terminal.command,
      result: {
        outcome: 'known_failure',
        code: 'preflight_unavailable',
        compensationAvailable: false,
        binding: mutationBinding(terminal.command),
      },
    });
    expect(terminalized).toMatchObject({ ok: true, created: true });
    await expect(gmailArchiveRecoveryLeaseRepository.acquire({
      userId: terminalOwner.ownerUserId,
      approvalId: terminal.proposal.approval.id,
      leaseMs: 60_000,
    })).resolves.toEqual({ ok: true, status: 'terminal', lease: null });
    const absent = await getPool().query<{ count: string }>(
      'SELECT count(*)::STRING AS count FROM gmail_archive_recovery_leases WHERE admission_id = $1',
      [terminal.command.admissionId],
    );
    expect(absent.rows[0]?.count).toBe('0');
  }, 120_000);

  it('acquires reserved, prepared, and dispatch recovery after connector evidence is gone', async () => {
    const reservedOwner = await seedRecoveryOwner(12);
    const reservedProposal = await createProposal(
      166,
      reservedOwner.ownerUserId,
      reservedOwner.ownerAccountId,
    );
    const reservedApproval = await gmailArchiveApprovalResponseRepository.respond({
      approvalId: reservedProposal.approval.id,
      userId: reservedOwner.ownerUserId,
      action: 'approve',
    });
    if (!reservedApproval.ok || !reservedApproval.response.reservedBarrier) {
      throw new Error('Detached reserved fixture failed.');
    }
    await setRecoveryAnchor(reservedApproval.response.reservedBarrier.id, 'created_at');
    await getPool().query('DELETE FROM connected_accounts WHERE id = $1 AND user_id = $2', [
      reservedOwner.ownerAccountId,
      reservedOwner.ownerUserId,
    ]);
    await getPool().query('DELETE FROM signals WHERE id = $1 AND user_id = $2', [
      id('44', 166),
      reservedOwner.ownerUserId,
    ]);
    await expect(gmailArchiveRecoveryLeaseRepository.acquire({
      userId: reservedOwner.ownerUserId,
      approvalId: reservedProposal.approval.id,
      leaseMs: 60_000,
    })).resolves.toMatchObject({
      ok: true,
      status: 'acquired',
      lease: { workKind: 'resume_preparation' },
    });

    const preparedOwner = await seedRecoveryOwner(13);
    const prepared = await createPreparedProposal(
      167,
      preparedOwner.ownerUserId,
      preparedOwner.ownerAccountId,
    );
    await setRecoveryAnchor(prepared.prepared.barrier.id, 'updated_at');
    await getPool().query('DELETE FROM connected_accounts WHERE id = $1 AND user_id = $2', [
      preparedOwner.ownerAccountId,
      preparedOwner.ownerUserId,
    ]);
    await getPool().query('DELETE FROM signals WHERE id = $1 AND user_id = $2', [
      id('44', 167),
      preparedOwner.ownerUserId,
    ]);
    await expect(gmailArchiveRecoveryLeaseRepository.acquire({
      userId: preparedOwner.ownerUserId,
      approvalId: prepared.proposal.approval.id,
      leaseMs: 60_000,
    })).resolves.toMatchObject({
      ok: true,
      status: 'acquired',
      lease: { workKind: 'resume_claim' },
    });

    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(10);
    const fixture = await createClaimedProposal(164, ownerUserId, ownerAccountId, true);
    await setRecoveryAnchor(
      fixture.command.admissionId,
      'updated_at',
      '2026-09-12T12:00:00.123Z',
    );
    await getPool().query('DELETE FROM connected_accounts WHERE id = $1 AND user_id = $2', [
      ownerAccountId,
      ownerUserId,
    ]);
    await getPool().query('DELETE FROM signals WHERE id = $1 AND user_id = $2', [
      id('44', 164),
      ownerUserId,
    ]);

    const acquired = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: fixture.proposal.approval.id,
      leaseMs: 60_000,
    });
    expect(acquired).toMatchObject({
      ok: true,
      status: 'acquired',
      created: true,
      lease: { workKind: 'observe_dispatch', phaseChangedAt: '2026-09-12T12:00:00.123Z' },
    });
    if (!acquired.ok || acquired.status !== 'acquired') throw new Error('Detached recovery lease failed.');
    const begun = await gmailArchiveRecoveryLeaseRepository.beginObservation(
      recoveryFence(acquired.lease),
    );
    expect(begun).toMatchObject({ ok: true, status: 'permitted' });
    if (!begun.ok || begun.status !== 'permitted') throw new Error('Detached observation was not permitted.');
    await expect(gmailArchiveRecoveryLeaseRepository.recordObservation({
      permit: begun.permit,
      evidence: {
        kind: 'mailbox_observation_unavailable',
        binding: mutationBinding(fixture.command),
        code: 'not_observable',
      },
    })).resolves.toMatchObject({ ok: true, recorded: true });
    const providerRows = await getPool().query<{
      accounts: string;
      refs: string;
      signals: string;
      tokens: string;
    }>(`SELECT
      (SELECT count(*)::STRING FROM connected_accounts WHERE user_id IN ($1, $2, $3)) AS accounts,
      (SELECT count(*)::STRING FROM gmail_message_refs WHERE user_id IN ($1, $2, $3)) AS refs,
      (SELECT count(*)::STRING FROM signals WHERE user_id IN ($1, $2, $3)) AS signals,
      (SELECT count(*)::STRING FROM oauth_tokens WHERE user_id IN ($1, $2, $3)) AS tokens`, [
      reservedOwner.ownerUserId,
      preparedOwner.ownerUserId,
      ownerUserId,
    ]);
    expect(providerRows.rows[0]).toEqual({ accounts: '0', refs: '0', signals: '0', tokens: '0' });
  }, 120_000);

  it('turns an expired same-attempt begin retry into unavailable evidence', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(11);
    const fixture = await createClaimedProposal(165, ownerUserId, ownerAccountId, true);
    await setRecoveryAnchor(
      fixture.command.admissionId,
      'updated_at',
      '2026-09-12T12:00:00.123Z',
    );
    const acquired = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: fixture.proposal.approval.id,
      leaseMs: 300_000,
    });
    if (!acquired.ok || acquired.status !== 'acquired') throw new Error('Retry lease failed.');
    let attempts = 0;
    let firstPermitId: string | null = null;
    const retried = await gmailArchiveRecoveryLeaseTestHooks.beginWithTransition(
      recoveryFence(acquired.lease),
      gmailArchiveRecoveryLeaseTestHooks.beginTransition,
      async (callback) => {
        const result = await withTransaction(callback);
        attempts += 1;
        if (attempts === 1) {
          const started = await getPool().query<{ observation_attempt_id: string }>(
            `SELECT observation_attempt_id
               FROM gmail_archive_recovery_leases WHERE admission_id = $1`,
            [fixture.command.admissionId],
          );
          firstPermitId = started.rows[0]?.observation_attempt_id ?? null;
          await getPool().query(
            `UPDATE gmail_archive_recovery_leases
                SET observation_authorized_at = date_trunc('milliseconds', now() - INTERVAL '4 minutes'),
                    observation_deadline_at = date_trunc('milliseconds', now() - INTERVAL '3 minutes')
              WHERE admission_id = $1`,
            [fixture.command.admissionId],
          );
          throw Object.assign(new Error('ambiguous retry after write'), { code: '40001' });
        }
        return result;
      },
    );
    expect(attempts).toBe(2);
    expect(firstPermitId).toMatch(/^[0-9a-f-]{36}$/);
    expect(retried).toEqual({ ok: true, status: 'evidence_recorded', permit: null });
    const stored = await getPool().query<{
      observation_attempt_id: string;
      observation_evidence: unknown;
    }>(
      `SELECT observation_attempt_id, observation_evidence
         FROM gmail_archive_recovery_leases WHERE admission_id = $1`,
      [fixture.command.admissionId],
    );
    expect(stored.rows[0]).toMatchObject({
      observation_attempt_id: firstPermitId,
      observation_evidence: {
        schema: 'gmail_archive_recovery_observation_v1',
        evidence: { kind: 'mailbox_observation_unavailable', code: 'observation_unavailable' },
      },
    });
    await expect(gmailArchiveRecoveryLeaseRepository.beginObservation(
      recoveryFence(acquired.lease),
    )).resolves.toEqual({ ok: true, status: 'evidence_recorded', permit: null });
  }, 120_000);

  it('samples wall-clock time after barrier and lease lock contention', async () => {
    const acquireOwner = await seedRecoveryOwner(14);
    const prepared = await createPreparedProposal(
      168,
      acquireOwner.ownerUserId,
      acquireOwner.ownerAccountId,
    );
    await setRecoveryAnchor(prepared.prepared.barrier.id, 'updated_at');
    let releaseBarrier!: () => void;
    let barrierLocked!: () => void;
    const barrierRelease = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const barrierReady = new Promise<void>((resolve) => { barrierLocked = resolve; });
    const barrierHolder = withTransaction(async (client) => {
      await client.query('SELECT id FROM pre_effect_barriers WHERE id = $1 FOR UPDATE', [
        prepared.prepared.barrier.id,
      ]);
      barrierLocked();
      await barrierRelease;
    });
    await barrierReady;
    const waitingAcquire = gmailArchiveRecoveryLeaseRepository.acquire({
      userId: acquireOwner.ownerUserId,
      approvalId: prepared.proposal.approval.id,
      leaseMs: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    releaseBarrier();
    await barrierHolder;
    const acquired = await waitingAcquire;
    expect(acquired).toMatchObject({ ok: true });
    const liveLease = await getPool().query<{
      acquired_at: Date;
      db_now: Date;
      expires_at: Date;
      live: boolean;
    }>(
      `SELECT acquired_at, expires_at, clock_timestamp() AS db_now,
              expires_at > clock_timestamp() AS live
         FROM gmail_archive_recovery_leases WHERE admission_id = $1`,
      [prepared.prepared.barrier.id],
    );
    if (acquired.ok && acquired.status === 'acquired') {
      expect(liveLease.rows[0]?.live).toBe(true);
    } else {
      expect(acquired).toEqual({ ok: true, status: 'busy', lease: null });
      expect(liveLease.rows[0]?.live).toBe(false);
    }

    const beginOwner = await seedRecoveryOwner(15);
    const dispatch = await createClaimedProposal(
      169,
      beginOwner.ownerUserId,
      beginOwner.ownerAccountId,
      true,
    );
    await setRecoveryAnchor(
      dispatch.command.admissionId,
      'updated_at',
      '2026-09-12T12:00:00.123Z',
    );
    const dispatchLease = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: beginOwner.ownerUserId,
      approvalId: dispatch.proposal.approval.id,
      leaseMs: 60_000,
    });
    if (!dispatchLease.ok || dispatchLease.status !== 'acquired') {
      throw new Error('Contended begin lease failed.');
    }
    const expiringLease = await getPool().query<{ expires_at: Date }>(
      `UPDATE gmail_archive_recovery_leases
          SET acquired_at = statement_timestamp() - INTERVAL '2 minutes',
              renewed_at = statement_timestamp() - INTERVAL '1 minute',
              expires_at = statement_timestamp() + INTERVAL '500 milliseconds'
        WHERE admission_id = $1
        RETURNING expires_at`,
      [dispatch.command.admissionId],
    );
    const expiresAt = expiringLease.rows[0]?.expires_at;
    if (!expiresAt) throw new Error('Contended begin lease was not shortened.');
    let releaseLease!: () => void;
    let leaseLocked!: () => void;
    const leaseRelease = new Promise<void>((resolve) => { releaseLease = resolve; });
    const leaseReady = new Promise<void>((resolve) => { leaseLocked = resolve; });
    const leaseHolder = withTransaction(async (client) => {
      await client.query('SELECT admission_id FROM gmail_archive_recovery_leases WHERE admission_id = $1 FOR UPDATE', [
        dispatch.command.admissionId,
      ]);
      leaseLocked();
      await leaseRelease;
    });
    await leaseReady;
    const waitingBegin = gmailArchiveRecoveryLeaseRepository.beginObservation(
      recoveryFence(dispatchLease.lease),
    );
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.max(0, expiresAt.getTime() - Date.now()) + 250,
    ));
    releaseLease();
    await leaseHolder;
    const beginResult = await waitingBegin;
    expect(beginResult).toMatchObject({ ok: true });
    const state = await getPool().query<{ observation_state: string }>(
      `SELECT observation_state
         FROM gmail_archive_recovery_leases WHERE admission_id = $1`,
      [dispatch.command.admissionId],
    );
    if (beginResult.ok && beginResult.status === 'permitted') {
      expect(state.rows[0]?.observation_state).toBe('started');
    } else {
      expect(beginResult).toEqual({ ok: true, status: 'evidence_recorded', permit: null });
      expect(state.rows[0]?.observation_state).toBe('evidence_recorded');
    }

    const recordOwner = await seedRecoveryOwner(17);
    const recordDispatch = await createClaimedProposal(
      171,
      recordOwner.ownerUserId,
      recordOwner.ownerAccountId,
      true,
    );
    await setRecoveryAnchor(
      recordDispatch.command.admissionId,
      'updated_at',
      '2026-09-12T12:00:00.123Z',
    );
    const reacquired = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: recordOwner.ownerUserId,
      approvalId: recordDispatch.proposal.approval.id,
      leaseMs: 60_000,
    });
    if (!reacquired.ok || reacquired.status !== 'acquired') {
      throw new Error('Expired contended lease was not fenced.');
    }
    const begun = await gmailArchiveRecoveryLeaseRepository.beginObservation(
      recoveryFence(reacquired.lease),
    );
    if (!begun.ok || begun.status !== 'permitted') throw new Error('Record contention permit failed.');
    const shortened = await getPool().query<{ observation_deadline_at: Date }>(
      `UPDATE gmail_archive_recovery_leases
          SET observation_deadline_at = date_trunc(
            'milliseconds', statement_timestamp() + INTERVAL '500 milliseconds'
          )
        WHERE admission_id = $1
        RETURNING observation_deadline_at`,
      [recordDispatch.command.admissionId],
    );
    const shortenedDeadline = shortened.rows[0]?.observation_deadline_at;
    if (!shortenedDeadline) throw new Error('Record deadline was not shortened.');
    const shortenedPermit = {
      ...begun.permit,
      deadlineAt: shortenedDeadline.toISOString(),
    };
    let releaseRecord!: () => void;
    let recordLocked!: () => void;
    const recordRelease = new Promise<void>((resolve) => { releaseRecord = resolve; });
    const recordReady = new Promise<void>((resolve) => { recordLocked = resolve; });
    const recordHolder = withTransaction(async (client) => {
      await client.query('SELECT admission_id FROM gmail_archive_recovery_leases WHERE admission_id = $1 FOR UPDATE', [
        recordDispatch.command.admissionId,
      ]);
      recordLocked();
      await recordRelease;
    });
    await recordReady;
    const waitingRecord = gmailArchiveRecoveryLeaseRepository.recordObservation({
      permit: shortenedPermit,
      evidence: {
        kind: 'mailbox_observation_unavailable',
        binding: mutationBinding(recordDispatch.command),
        code: 'observation_unavailable',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    releaseRecord();
    await recordHolder;
    await expect(waitingRecord).resolves.toMatchObject({ ok: true, recorded: true });
    const recorded = await getPool().query<{
      observation_evidence: unknown;
      observation_state: string;
    }>(
      `SELECT observation_state, observation_evidence
         FROM gmail_archive_recovery_leases WHERE admission_id = $1`,
      [recordDispatch.command.admissionId],
    );
    expect(recorded.rows[0]).toMatchObject({ observation_state: 'evidence_recorded' });

    const retryOwner = await seedRecoveryOwner(16);
    const retryPrepared = await createPreparedProposal(
      170,
      retryOwner.ownerUserId,
      retryOwner.ownerAccountId,
    );
    await setRecoveryAnchor(retryPrepared.prepared.barrier.id, 'updated_at');
    let acquireAttempts = 0;
    const retriedAcquire = await gmailArchiveRecoveryLeaseTestHooks.acquireWithTransition(
      {
        userId: retryOwner.ownerUserId,
        approvalId: retryPrepared.proposal.approval.id,
        leaseMs: 1_000,
      },
      gmailArchiveRecoveryLeaseTestHooks.acquireTransition,
      async (callback) => {
        const result = await withTransaction(callback);
        acquireAttempts += 1;
        if (acquireAttempts === 1) {
          await new Promise((resolve) => setTimeout(resolve, 1_200));
          throw Object.assign(new Error('retry after committed lease expired'), { code: '40001' });
        }
        return result;
      },
    );
    expect(acquireAttempts).toBe(2);
    expect(retriedAcquire).toMatchObject({
      ok: true,
      status: 'acquired',
      created: false,
      lease: { generation: 2 },
    });
    if (!retriedAcquire.ok || retriedAcquire.status !== 'acquired') {
      throw new Error('Expired same-token acquire retry did not recover.');
    }
    const retriedLive = await getPool().query<{ live: boolean }>(
      `SELECT expires_at > statement_timestamp() AS live
         FROM gmail_archive_recovery_leases WHERE admission_id = $1`,
      [retryPrepared.prepared.barrier.id],
    );
    expect(retriedLive.rows[0]?.live).toBe(true);
  }, 120_000);

  it('fails closed for proposal barriers, cross-owner authority, corrupt approval binding, and schema checks', async () => {
    const { ownerUserId, ownerAccountId } = await seedRecoveryOwner(5);
    const proposal = await createProposal(158, ownerUserId, ownerAccountId);
    await expect(gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: proposal.approval.id,
      leaseMs: 60_000,
    })).resolves.toEqual({ ok: false, error: 'not_found' });
    await expect(gmailArchiveRecoveryLeaseRepository.acquire({
      userId: otherUserId,
      approvalId: proposal.approval.id,
      leaseMs: 60_000,
    })).resolves.toEqual({ ok: false, error: 'not_found' });

    const prepared = await createPreparedProposal(159, ownerUserId, ownerAccountId);
    await setRecoveryAnchor(prepared.prepared.barrier.id, 'updated_at');
    const acquired = await gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: prepared.proposal.approval.id,
      leaseMs: 60_000,
    });
    expect(acquired).toMatchObject({ ok: true, status: 'acquired' });
    await getPool().query(
      'UPDATE gmail_archive_recovery_leases SET approval_id = $2 WHERE admission_id = $1',
      [prepared.prepared.barrier.id, id('88', 159)],
    );
    await expect(gmailArchiveRecoveryLeaseRepository.acquire({
      userId: ownerUserId,
      approvalId: prepared.proposal.approval.id,
      leaseMs: 60_000,
    })).resolves.toEqual({ ok: false, error: 'integrity_conflict' });

    await expect(getPool().query(
      `INSERT INTO gmail_archive_recovery_leases (
         admission_id, user_id, approval_id, message_ref_id, work_kind,
         barrier_status, attempt_phase, phase_changed_at, lease_token, generation,
         acquired_at, renewed_at, expires_at
       ) VALUES ($1, $2, $3, $4, 'resume_claim', 'reserved', NULL, now(), $5, 1,
         now(), now(), now() + INTERVAL '1 minute')`,
      [id('99', 1), ownerUserId, id('99', 2), id('99', 3), id('99', 4)],
    )).rejects.toMatchObject({ code: expect.stringMatching(/23503|23514/) });
  }, 120_000);
});
