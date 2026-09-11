import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskAssessor } from '@skytwin/decision-engine';
import { closePool, getPool } from '../connection.js';
import { up } from '../migrations/001-initial.js';
import {
  buildGmailArchiveProposalCandidate,
  gmailArchiveProposalRepository,
} from '../repositories/gmail-archive-proposal-repository.js';
import { gmailMessageRefRepository } from '../repositories/gmail-message-ref-repository.js';

const cockroachAvailable = spawnSync('cockroach', ['version'], { encoding: 'utf8' }).status === 0;

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

describe.runIf(cockroachAvailable)('gmailArchiveProposalRepository on CockroachDB', () => {
  const userId = '10000000-0000-4000-8000-000000000001';
  const otherUserId = '10000000-0000-4000-8000-000000000002';
  const accountId = '20000000-0000-4000-8000-000000000001';
  const messageRefId = '30000000-0000-4000-8000-000000000001';
  const signalId = '40000000-0000-4000-8000-000000000001';
  const concurrentMessageRefId = '30000000-0000-4000-8000-000000000002';
  const concurrentSignalId = '40000000-0000-4000-8000-000000000002';
  const secondAccountId = '20000000-0000-4000-8000-000000000002';
  const secondMessageRefId = '30000000-0000-4000-8000-000000000003';
  const secondSignalId = '40000000-0000-4000-8000-000000000003';
  const decisionId = '60000000-0000-4000-8000-000000000001';
  const candidateId = '70000000-0000-4000-8000-000000000001';
  let cockroach: ChildProcess | undefined;
  let previousDatabaseUrl: string | undefined;

  function buildInput(options: {
    connectorAccountId: string;
    messageRefId: string;
    signalId: string;
    decisionId: string;
    candidateId: string;
  }) {
    const candidate = buildGmailArchiveProposalCandidate(
      options.decisionId,
      options.candidateId,
      options.messageRefId,
    );
    const assessment = new RiskAssessor().assess(candidate);
    return {
      userId,
      connectorAccountId: options.connectorAccountId,
      messageRefId: options.messageRefId,
      signalId: options.signalId,
      proposal: {
        candidate,
        riskAssessment: {
          ...assessment,
          assessedAt: new Date('2026-09-11T12:00:00Z'),
        },
      },
    };
  }

  const input = buildInput({
    connectorAccountId: accountId,
    messageRefId,
    signalId,
    decisionId,
    candidateId,
  });

  beforeAll(async () => {
    const sqlPort = await reservePort(25_000 + (process.pid % 3_000));
    const httpPort = await reservePort(45_000 + (process.pid % 3_000));
    cockroach = spawn('cockroach', [
      'start-single-node', '--insecure', `--listen-addr=127.0.0.1:${sqlPort}`,
      `--http-addr=127.0.0.1:${httpPort}`, '--store=type=mem,size=0.15',
      '--logtostderr=ERROR',
    ], { stdio: 'ignore' });
    await waitForCockroach(sqlPort, cockroach);
    previousDatabaseUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = `postgresql://root@127.0.0.1:${sqlPort}/defaultdb?sslmode=disable`;
    await up();

    const pool = getPool();
    await pool.query(
      `INSERT INTO users (id, email, name) VALUES
         ($1, 'proposal-owner@example.test', 'Proposal Owner'),
         ($2, 'other-owner@example.test', 'Other Owner')`,
      [userId, otherUserId],
    );
    await pool.query(
      `INSERT INTO connected_accounts (
         id, user_id, provider, account_id, scopes, is_active,
         provider_subject_digest, account_display, identity_verified
       ) VALUES ($2, $1, 'google', 'owned-account', ARRAY[]::STRING[], true,
         $3, 'Owned account', true)`,
      [userId, accountId, 'a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO gmail_message_refs (
         id, user_id, connector_account_id, provider, provider_message_id,
         provider_thread_id, source_signal_id, authoring_tier,
         last_observed_inbox, first_observed_at, last_observed_at
       ) VALUES ($3, $1, $2, 'google', 'native-message', NULL, 'owned-source',
         'inbox_automated', true, '2026-09-11T12:00:00Z', '2026-09-11T12:00:00Z')`,
      [userId, accountId, messageRefId],
    );
    await pool.query(
      `INSERT INTO signals (
         id, user_id, source, type, domain, data, timestamp,
         source_signal_id, connector_account_id, resource_ref_id
       ) VALUES ($4, $1, 'gmail', 'email', 'email', '{}', '2026-09-11T12:00:00Z',
         'owned-source', $2, $3)`,
      [userId, accountId, messageRefId, signalId],
    );
  }, 120_000);

  afterAll(async () => {
    await closePool();
    if (previousDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previousDatabaseUrl;
    cockroach?.kill('SIGTERM');
  });

  it('atomically persists one exact graph and returns that graph on replay', async () => {
    const first = await gmailArchiveProposalRepository.persist(input);
    const replay = await gmailArchiveProposalRepository.persist(input);

    expect(first).toMatchObject({ ok: true, created: true });
    expect(replay).toMatchObject({ ok: true, created: false });
    if (!first.ok || !replay.ok) return;
    expect(replay.proposal.decision.id).toBe(first.proposal.decision.id);
    expect(first.proposal.decision).toMatchObject({
      id: decisionId,
      signal_id: signalId,
      raw_event: { signalId, messageRefId },
    });
    expect(first.proposal.candidate.id).toBe(candidateId);
    expect(JSON.stringify(first.proposal.revisions)).not.toContain('owned-source');
    expect(first.proposal.candidate.parameters).toEqual({
      schema: 'gmail_inbox_mutation_v1',
      messageRefId,
      operation: 'archive',
      domain: 'email',
      costZeroIntent: 'verified_zero',
      provenance: 'untrusted_external',
    });
    expect(first.proposal.candidate.risk_assessment).toEqual({
      actionId: first.proposal.candidate.id,
      overallTier: input.proposal.riskAssessment.overallTier,
      dimensions: input.proposal.riskAssessment.dimensions,
      reasoning: input.proposal.riskAssessment.reasoning,
      assessedAt: '2026-09-11T12:00:00.000Z',
    });
    const counts = await getPool().query<{ decisions: string; candidates: string; outcomes: string;
      explanations: string; barriers: string; approvals: string; receipts: string; revisions: string }>(
      `SELECT
        (SELECT count(*) FROM decisions) AS decisions,
        (SELECT count(*) FROM candidate_actions) AS candidates,
        (SELECT count(*) FROM decision_outcomes) AS outcomes,
        (SELECT count(*) FROM explanation_records) AS explanations,
        (SELECT count(*) FROM pre_effect_barriers) AS barriers,
        (SELECT count(*) FROM approval_requests) AS approvals,
        (SELECT count(*) FROM decision_receipts) AS receipts,
        (SELECT count(*) FROM decision_receipt_revisions) AS revisions`,
    );
    expect(counts.rows[0]).toEqual({
      decisions: '1', candidates: '1', outcomes: '1', explanations: '1',
      barriers: '1', approvals: '1', receipts: '1', revisions: '3',
    });
  });

  it('converges concurrent first writes on one committed graph', async () => {
    await getPool().query(
      `INSERT INTO gmail_message_refs (
         id, user_id, connector_account_id, provider, provider_message_id,
         provider_thread_id, source_signal_id, authoring_tier,
         last_observed_inbox, first_observed_at, last_observed_at
       ) VALUES ($3, $1, $2, 'google', 'native-message-2', NULL, 'owned-source-2',
         'inbox_newsletter', true, '2026-09-11T13:00:00Z', '2026-09-11T13:00:00Z')`,
      [userId, accountId, concurrentMessageRefId],
    );
    await getPool().query(
      `INSERT INTO signals (
         id, user_id, source, type, domain, data, timestamp,
         source_signal_id, connector_account_id, resource_ref_id
       ) VALUES ($4, $1, 'gmail', 'email', 'email', '{}', '2026-09-11T13:00:00Z',
         'owned-source-2', $2, $3)`,
      [userId, accountId, concurrentMessageRefId, concurrentSignalId],
    );
    const concurrentInput = buildInput({
      connectorAccountId: accountId,
      messageRefId: concurrentMessageRefId,
      signalId: concurrentSignalId,
      decisionId: '60000000-0000-4000-8000-000000000002',
      candidateId: '70000000-0000-4000-8000-000000000002',
    });

    const results = await Promise.all(Array.from(
      { length: 4 },
      () => gmailArchiveProposalRepository.persist(concurrentInput),
    ));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(new Set(results.flatMap((result) => result.ok ? [result.proposal.decision.id] : [])).size).toBe(1);
    const graphCount = await getPool().query<{ decisions: string; revisions: string }>(
      `SELECT
        (SELECT count(*) FROM decisions WHERE signal_id = $1) AS decisions,
        (SELECT count(*) FROM decision_receipt_revisions revision
          JOIN decision_receipts receipt ON receipt.id = revision.receipt_id
          JOIN decisions decision ON decision.id = receipt.decision_id
         WHERE decision.signal_id = $1) AS revisions`,
      [concurrentSignalId],
    );
    expect(graphCount.rows[0]).toEqual({ decisions: '1', revisions: '3' });
  });

  it('keeps equal connector source IDs isolated across two owned accounts', async () => {
    const scope = 'https://www.googleapis.com/auth/gmail.modify';
    const pool = getPool();
    await pool.query(
      `INSERT INTO connected_accounts (
         id, user_id, provider, account_id, scopes, is_active,
         provider_subject_digest, account_display, identity_verified
       ) VALUES ($2, $1, 'google', 'second-owned-account', ARRAY[$3]::STRING[], true,
         $4, 'Second owned account', true)`,
      [userId, secondAccountId, scope, 'b'.repeat(64)],
    );
    await pool.query('UPDATE connected_accounts SET scopes = ARRAY[$1]::STRING[] WHERE id = $2', [scope, accountId]);
    await pool.query(
      `INSERT INTO gmail_message_refs (
         id, user_id, connector_account_id, provider, provider_message_id,
         provider_thread_id, source_signal_id, authoring_tier,
         last_observed_inbox, first_observed_at, last_observed_at
       ) VALUES ($3, $1, $2, 'google', 'native-message-second-account', NULL, 'owned-source',
         'inbox_automated', true, '2026-09-11T14:00:00Z', '2026-09-11T14:00:00Z')`,
      [userId, secondAccountId, secondMessageRefId],
    );
    await pool.query(
      `INSERT INTO signals (
         id, user_id, source, type, domain, data, timestamp,
         source_signal_id, connector_account_id, resource_ref_id
       ) VALUES ($4, $1, 'gmail', 'email', 'email', '{}', '2026-09-11T14:00:00Z',
         'owned-source', $2, $3)`,
      [userId, secondAccountId, secondMessageRefId, secondSignalId],
    );
    await pool.query(
      `INSERT INTO oauth_tokens (
         id, user_id, provider, access_token, refresh_token, expires_at, scopes,
         account_email, account_provider_id, connector_account_id
       ) VALUES
         ('50000000-0000-4000-8000-000000000001', $1, 'google', NULL, NULL,
          now() + INTERVAL '1 hour', ARRAY[$2]::STRING[], 'first@example.test', 'first', $3),
         ('50000000-0000-4000-8000-000000000002', $1, 'google', NULL, NULL,
          now() + INTERVAL '1 hour', ARRAY[$2]::STRING[], 'second@example.test', 'second', $4)`,
      [userId, scope, accountId, secondAccountId],
    );

    const second = await gmailArchiveProposalRepository.persist(buildInput({
      connectorAccountId: secondAccountId,
      messageRefId: secondMessageRefId,
      signalId: secondSignalId,
      decisionId: '60000000-0000-4000-8000-000000000003',
      candidateId: '70000000-0000-4000-8000-000000000003',
    }));
    expect(second).toMatchObject({ ok: true, created: true });
    if (!second.ok) return;
    expect(second.proposal.decision).toMatchObject({
      signal_id: secondSignalId,
      raw_event: { signalId: secondSignalId, messageRefId: secondMessageRefId },
    });
    expect(JSON.stringify(second.proposal.revisions)).not.toContain('owned-source');
    const firstDecision = await pool.query<{ id: string }>(
      'SELECT id FROM decisions WHERE user_id = $1 AND signal_id = $2',
      [userId, signalId],
    );
    await pool.query(
      `UPDATE pre_effect_barriers SET status = 'in_progress'
        WHERE decision_id = ANY($1::UUID[])`,
      [[firstDecision.rows[0]!.id, second.proposal.decision.id]],
    );
    const firstBarrier = await pool.query<{ id: string }>(
      'SELECT id FROM pre_effect_barriers WHERE decision_id = $1',
      [firstDecision.rows[0]!.id],
    );

    const firstTarget = await gmailMessageRefRepository.resolveInboxMutationTarget({
      userId,
      admissionId: firstBarrier.rows[0]!.id,
      messageRefId,
      operation: 'archive',
    });
    const secondTarget = await gmailMessageRefRepository.resolveInboxMutationTarget({
      userId,
      admissionId: second.proposal.barrier.id,
      messageRefId: secondMessageRefId,
      operation: 'archive',
    });
    expect(firstTarget).toEqual({ connectorAccountId: accountId, providerMessageId: 'native-message' });
    expect(secondTarget).toEqual({
      connectorAccountId: secondAccountId,
      providerMessageId: 'native-message-second-account',
    });
    await expect(gmailMessageRefRepository.resolveInboxMutationTarget({
      userId,
      admissionId: firstBarrier.rows[0]!.id,
      messageRefId: secondMessageRefId,
      operation: 'archive',
    })).resolves.toBeNull();
    await expect(gmailMessageRefRepository.resolveInboxMutationTarget({
      userId,
      admissionId: second.proposal.barrier.id,
      messageRefId,
      operation: 'archive',
    })).resolves.toBeNull();
  });

  it('rejects cross-owner and no-longer-Inbox evidence without writes', async () => {
    await expect(gmailArchiveProposalRepository.persist({ ...input, userId: otherUserId })).resolves.toEqual({
      ok: false,
      error: 'evidence_not_found',
    });
    await getPool().query('UPDATE gmail_message_refs SET last_observed_inbox = false WHERE id = $1', [messageRefId]);
    await expect(gmailArchiveProposalRepository.persist(input)).resolves.toEqual({
      ok: false,
      error: 'evidence_not_found',
    });
    const decisions = await getPool().query<{ count: string }>('SELECT count(*) FROM decisions');
    expect(decisions.rows[0]?.count).toBe('3');
  });
});
