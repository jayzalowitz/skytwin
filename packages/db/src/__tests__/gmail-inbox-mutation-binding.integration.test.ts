import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';

const cockroachAvailable =
  spawnSync('cockroach', ['version'], { encoding: 'utf8' }).status === 0;

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

describe.runIf(cockroachAvailable)('Gmail Inbox mutation binding on CockroachDB', () => {
  it('enforces the admission matrix and preserves newer observations', async () => {
    const sqlPort = await reservePort(21_000 + (process.pid % 4_000));
    const httpPort = await reservePort(41_000 + (process.pid % 4_000));
    const scope = 'https://www.googleapis.com/auth/gmail.modify';
    const userId = '00000000-0000-4000-8000-000000000001';
    const accountA = '10000000-0000-4000-8000-000000000001';
    const accountB = '10000000-0000-4000-8000-000000000002';
    const accountC = '10000000-0000-4000-8000-000000000003';
    const refA = '20000000-0000-4000-8000-000000000001';
    const refB = '20000000-0000-4000-8000-000000000002';
    const refC = '20000000-0000-4000-8000-000000000003';
    const decisionId = '30000000-0000-4000-8000-000000000001';
    const candidateId = '40000000-0000-4000-8000-000000000001';
    const barrierId = '50000000-0000-4000-8000-000000000001';
    const setup = `
      CREATE TABLE connected_accounts (
        id UUID PRIMARY KEY, user_id UUID NOT NULL, provider STRING NOT NULL,
        scopes STRING[] NOT NULL, is_active BOOL NOT NULL, identity_verified BOOL NOT NULL
      );
      CREATE TABLE oauth_tokens (
        connector_account_id UUID NOT NULL, user_id UUID NOT NULL,
        provider STRING NOT NULL, scopes STRING[] NOT NULL
      );
      CREATE TABLE gmail_message_refs (
        id UUID PRIMARY KEY, user_id UUID NOT NULL, connector_account_id UUID NOT NULL,
        provider STRING NOT NULL, provider_message_id STRING NOT NULL, source_signal_id STRING NOT NULL,
        last_observed_inbox BOOL NOT NULL, last_observed_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE signals (
        id UUID PRIMARY KEY, user_id UUID NOT NULL, source STRING NOT NULL,
        source_signal_id STRING, resource_ref_id UUID, connector_account_id UUID
      );
      CREATE TABLE decisions (
        id UUID PRIMARY KEY, user_id UUID NOT NULL, signal_id STRING, raw_event JSONB NOT NULL
      );
      CREATE TABLE candidate_actions (
        id UUID PRIMARY KEY, decision_id UUID NOT NULL, action_type STRING NOT NULL,
        parameters JSONB NOT NULL
      );
      CREATE TABLE pre_effect_barriers (
        id UUID PRIMARY KEY, user_id UUID NOT NULL, status STRING NOT NULL,
        effect_type STRING NOT NULL, decision_id UUID, action_id UUID
      );

      INSERT INTO connected_accounts VALUES
        ('${accountA}', '${userId}', 'google', ARRAY['${scope}'], true, true),
        ('${accountB}', '${userId}', 'google', ARRAY['${scope}'], true, true),
        ('${accountC}', '00000000-0000-4000-8000-000000000002', 'google', ARRAY['${scope}'], true, true);
      INSERT INTO oauth_tokens VALUES
        ('${accountA}', '${userId}', 'google', ARRAY['${scope}']),
        ('${accountB}', '${userId}', 'google', ARRAY['${scope}']),
        ('${accountC}', '00000000-0000-4000-8000-000000000002', 'google', ARRAY['${scope}']);
      INSERT INTO gmail_message_refs VALUES
        ('${refA}', '${userId}', '${accountA}', 'google', 'native-a', 'same-source', true,
         '2026-09-11T13:00:00Z', '2026-09-11T13:00:00Z'),
        ('${refB}', '${userId}', '${accountB}', 'google', 'native-b', 'same-source', true,
         '2026-09-11T13:00:00Z', '2026-09-11T13:00:00Z'),
        ('${refC}', '00000000-0000-4000-8000-000000000002', '${accountC}', 'google', 'native-c',
         'same-source', true,
         '2026-09-11T13:00:00Z', '2026-09-11T13:00:00Z');
      INSERT INTO signals VALUES
        ('60000000-0000-4000-8000-000000000001', '${userId}', 'gmail', 'same-source', '${refA}', '${accountA}'),
        ('60000000-0000-4000-8000-000000000002', '${userId}', 'gmail', 'same-source', '${refB}', '${accountB}'),
        ('60000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002',
         'gmail', 'same-source', '${refC}', '${accountC}');
      INSERT INTO decisions VALUES
        ('${decisionId}', '${userId}', 'same-source', '{"messageRefId":"${refA}"}');
      INSERT INTO candidate_actions VALUES
        ('${candidateId}', '${decisionId}', 'archive_email',
         '{"schema":"gmail_inbox_mutation_v1","messageRefId":"${refA}","operation":"archive"}');
      INSERT INTO pre_effect_barriers VALUES
        ('${barrierId}', '${userId}', 'in_progress', 'event_execution', '${decisionId}', '${candidateId}');
    `;
    // Semantic live fixture for the repository query. The adjacent unit test
    // asserts its security predicates stay aligned with the implementation.
    const resolver = (
      messageRefId: string,
      parametersRefId: string,
      operation: 'archive' | 'restore' = 'archive',
    ) => `
      SELECT ref.connector_account_id, ref.provider_message_id
        FROM pre_effect_barriers AS barrier
        JOIN candidate_actions AS candidate ON candidate.id = barrier.action_id
        JOIN decisions AS decision
          ON decision.id = barrier.decision_id
         AND decision.id = candidate.decision_id
         AND decision.user_id = barrier.user_id
        JOIN signals AS signal
          ON signal.user_id = decision.user_id
         AND signal.source = 'gmail'
         AND signal.source_signal_id = decision.signal_id
        JOIN gmail_message_refs AS ref
          ON ref.id = signal.resource_ref_id
         AND ref.id = '${messageRefId}'
         AND ref.user_id = signal.user_id
         AND ref.connector_account_id = signal.connector_account_id
         AND ref.source_signal_id = signal.source_signal_id
        JOIN connected_accounts AS account
          ON account.id = ref.connector_account_id
         AND account.user_id = ref.user_id
         AND account.provider = ref.provider
        JOIN oauth_tokens AS token
          ON token.connector_account_id = account.id
         AND token.user_id = account.user_id
         AND token.provider = account.provider
       WHERE barrier.id = '${barrierId}' AND barrier.user_id = '${userId}'
         AND barrier.status = 'in_progress' AND barrier.effect_type = 'event_execution'
         AND (
           ('${operation}' = 'archive' AND candidate.action_type = 'archive_email') OR
           ('${operation}' = 'restore' AND candidate.action_type = 'restore_email')
         )
         AND candidate.parameters = '{"schema":"gmail_inbox_mutation_v1","messageRefId":"${parametersRefId}","operation":"${operation}"}'::JSONB
         AND decision.raw_event->>'messageRefId' = ref.id::STRING
         AND ref.provider = 'google' AND account.is_active = true
         AND account.identity_verified = true
         AND '${scope}' = ANY(account.scopes) AND '${scope}' = ANY(token.scopes)
       LIMIT 2
    `;
    const canonical = (messageRefId: string) =>
      `'{"schema":"gmail_inbox_mutation_v1","messageRefId":"${messageRefId}","operation":"archive"}'::JSONB`;
    const observe = (observedAt: string, inbox: boolean) => `
      UPDATE gmail_message_refs
         SET last_observed_inbox = CASE
               WHEN '${observedAt}'::TIMESTAMPTZ > last_observed_at THEN ${inbox}
               ELSE last_observed_inbox
             END,
             last_observed_at = GREATEST(last_observed_at, '${observedAt}'::TIMESTAMPTZ),
             updated_at = CASE
               WHEN '${observedAt}'::TIMESTAMPTZ > last_observed_at THEN now()
               ELSE updated_at
             END
       WHERE id = '${refA}' AND user_id = '${userId}' AND connector_account_id = '${accountA}'
         AND provider = 'google' AND provider_message_id = 'native-a'
         AND '${observedAt}'::TIMESTAMPTZ > last_observed_at
    `;
    const verify = `
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 1 AS canonical_candidate_resolves;

      UPDATE candidate_actions SET parameters = ${canonical(refB)} WHERE id = '${candidateId}';
      SELECT (SELECT count(*) FROM (${resolver(refB, refB)})) = 0 AS same_source_cross_account_rejected;
      UPDATE candidate_actions SET parameters = ${canonical(refA)} WHERE id = '${candidateId}';

      UPDATE candidate_actions SET parameters = '{"schema":"gmail_inbox_mutation_v1","messageRefId":"${refA}","operation":"archive","extra":true}'
       WHERE id = '${candidateId}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 0 AS extra_parameter_rejected;
      UPDATE candidate_actions SET parameters = ${canonical(refA)} WHERE id = '${candidateId}';

      UPDATE candidate_actions SET parameters = '{"schema":"wrong","messageRefId":"${refA}","operation":"archive"}'
       WHERE id = '${candidateId}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 0 AS wrong_schema_rejected;
      UPDATE candidate_actions SET parameters = ${canonical(refA)} WHERE id = '${candidateId}';

      UPDATE candidate_actions
         SET parameters = '{"schema":"gmail_inbox_mutation_v1","messageRefId":"${refA}","operation":"restore"}'
       WHERE id = '${candidateId}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA, 'restore')})) = 0
        AS archive_action_cannot_authorize_restore;
      UPDATE candidate_actions SET action_type = 'restore_email' WHERE id = '${candidateId}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA, 'restore')})) = 1
        AS restore_action_authorizes_restore;
      UPDATE candidate_actions SET parameters = ${canonical(refA)} WHERE id = '${candidateId}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 0
        AS restore_action_cannot_authorize_archive;
      UPDATE candidate_actions SET action_type = 'archive_email' WHERE id = '${candidateId}';

      UPDATE pre_effect_barriers SET effect_type = 'memory_execution' WHERE id = '${barrierId}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 0 AS wrong_effect_rejected;
      UPDATE pre_effect_barriers SET effect_type = 'event_execution' WHERE id = '${barrierId}';

      UPDATE pre_effect_barriers SET status = 'prepared' WHERE id = '${barrierId}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 0 AS wrong_status_rejected;
      UPDATE pre_effect_barriers SET status = 'in_progress' WHERE id = '${barrierId}';

      UPDATE connected_accounts SET is_active = false WHERE id = '${accountA}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 0 AS disconnected_rejected;
      UPDATE connected_accounts SET is_active = true, identity_verified = false WHERE id = '${accountA}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 0 AS unverified_rejected;
      UPDATE connected_accounts SET identity_verified = true, scopes = ARRAY['prefix:${scope}:suffix'] WHERE id = '${accountA}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 0 AS missing_account_scope_rejected;
      UPDATE connected_accounts SET scopes = ARRAY['${scope}'] WHERE id = '${accountA}';

      UPDATE oauth_tokens SET scopes = ARRAY['prefix:${scope}:suffix'] WHERE connector_account_id = '${accountA}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 0 AS missing_token_scope_rejected;
      UPDATE oauth_tokens SET scopes = ARRAY['${scope}'] WHERE connector_account_id = '${accountA}';

      UPDATE gmail_message_refs SET source_signal_id = 'corrupt-source' WHERE id = '${refA}';
      SELECT (SELECT count(*) FROM (${resolver(refA, refA)})) = 0 AS corrupt_source_binding_rejected;
      UPDATE gmail_message_refs SET source_signal_id = 'same-source' WHERE id = '${refA}';

      UPDATE candidate_actions SET parameters = ${canonical(refC)} WHERE id = '${candidateId}';
      UPDATE decisions SET raw_event = '{"messageRefId":"${refC}"}' WHERE id = '${decisionId}';
      SELECT (SELECT count(*) FROM (${resolver(refC, refC)})) = 0 AS cross_owner_rejected;
      UPDATE candidate_actions SET parameters = ${canonical(refA)} WHERE id = '${candidateId}';
      UPDATE decisions SET raw_event = '{"messageRefId":"${refA}"}' WHERE id = '${decisionId}';

      ${observe('2026-09-11T12:59:59.999Z', false)};
      ${observe('2026-09-11T13:00:00Z', false)};
      SELECT last_observed_inbox = true AND last_observed_at = '2026-09-11T13:00:00Z'::TIMESTAMPTZ
        AS stale_equal_preserved FROM gmail_message_refs WHERE id = '${refA}';
      ${observe('2026-09-11T13:00:00.001Z', false)};
      SELECT last_observed_inbox = false AND last_observed_at = '2026-09-11T13:00:00.001Z'::TIMESTAMPTZ
        AS newer_accepted FROM gmail_message_refs WHERE id = '${refA}';
    `;
    const result = spawnSync('cockroach', [
      'demo', '--empty', '--insecure', `--sql-port=${sqlPort}`, `--http-port=${httpPort}`,
      '--format=csv', '--execute', `${setup}\n${verify}`,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^t$/gm)).toHaveLength(17);
  }, 30_000);
});
