import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskAssessor } from '@skytwin/decision-engine';
import { verifyJoinedDecisionReceiptChain } from '@skytwin/shared-types';
import { closePool, getPool, withTransaction } from '../connection.js';
import { decisionReceiptLifecycleRepository } from '../repositories/decision-receipt-lifecycle.js';
import { up } from '../migrations/001-initial.js';
import { gmailArchiveApprovalResponseRepository } from '../repositories/gmail-archive-approval-response-repository.js';
import {
  buildGmailArchiveProposalCandidate,
  gmailArchiveProposalRepository,
} from '../repositories/gmail-archive-proposal-repository.js';
import { gmailMessageRefRepository } from '../repositories/gmail-message-ref-repository.js';

const cockroachAvailable = spawnSync('cockroach', ['version'], { encoding: 'utf8' }).status === 0;
const userId = '11000000-0000-4000-8000-000000000001';
const otherUserId = '11000000-0000-4000-8000-000000000002';
const accountId = '22000000-0000-4000-8000-000000000001';

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

describe.runIf(cockroachAvailable)('gmailArchiveApprovalResponseRepository on CockroachDB', () => {
  let cockroach: ChildProcess | undefined;
  let previousDatabaseUrl: string | undefined;

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
      `INSERT INTO users (id, email, name) VALUES
       ($1, 'admission-owner@example.test', 'Admission Owner'),
       ($2, 'other-owner@example.test', 'Other Owner')`,
      [userId, otherUserId],
    );
    await getPool().query(
      `INSERT INTO connected_accounts (
         id, user_id, provider, account_id, scopes, is_active,
         provider_subject_digest, account_display, identity_verified
       ) VALUES ($2, $1, 'google', 'owned-account', ARRAY[]::STRING[], true,
         $3, 'Owned account', true)`,
      [userId, accountId, 'a'.repeat(64)],
    );
  }, 300_000);

  afterAll(async () => {
    await closePool();
    if (previousDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previousDatabaseUrl;
    cockroach?.kill('SIGTERM');
  });

  async function createProposal(suffix: number) {
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
      [userId, accountId, messageRefId, `native-${suffix}`, `source-${suffix}`],
    );
    await getPool().query(
      `INSERT INTO signals (
         id, user_id, source, type, domain, data, timestamp,
         source_signal_id, connector_account_id, resource_ref_id
       ) VALUES ($4, $1, 'gmail', 'email', 'email', '{}', now(), $5, $2, $3)`,
      [userId, accountId, messageRefId, signalId, `source-${suffix}`],
    );
    const candidate = buildGmailArchiveProposalCandidate(decisionId, candidateId, messageRefId);
    const proposal = await gmailArchiveProposalRepository.persist({
      userId,
      connectorAccountId: accountId,
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
});
