import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const cockroachAvailable = spawnSync('cockroach', ['version'], { encoding: 'utf8' }).status === 0;

describe.runIf(cockroachAvailable)('082 Gmail evidence upgrade on CockroachDB', () => {
  it('upgrades the pre-082 shape, preserves selected cursors, and installs exact revisions', () => {
    const migration = readFileSync(
      new URL('../migrations/088-gmail-evidence-foundation.sql', import.meta.url),
      'utf8',
    );
    const setup = `
      CREATE TABLE users (id UUID PRIMARY KEY);
      CREATE TABLE connected_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id),
        provider STRING NOT NULL, account_id STRING NOT NULL, scopes STRING[] NOT NULL DEFAULT ARRAY[]::STRING[],
        is_active BOOL NOT NULL DEFAULT true, connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, provider, account_id)
      );
      CREATE TABLE oauth_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id),
        provider STRING NOT NULL, account_email STRING NOT NULL, account_provider_id STRING,
        access_token STRING, refresh_token STRING, expires_at TIMESTAMPTZ NOT NULL,
        scopes STRING[] NOT NULL DEFAULT ARRAY[]::STRING[], encrypted_access_token BYTES,
        encrypted_refresh_token BYTES, encryption_iv BYTES, encryption_tag BYTES,
        encryption_key_version INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (user_id, provider, account_email)
      );
      CREATE TABLE connector_cursors (
        user_id UUID NOT NULL REFERENCES users(id), provider STRING NOT NULL, cursor_kind STRING NOT NULL,
        cursor_value STRING NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, provider, cursor_kind)
      );
      CREATE TABLE connector_health (
        user_id UUID NOT NULL REFERENCES users(id), connector_name STRING NOT NULL,
        status STRING NOT NULL, error_code STRING, last_success_at TIMESTAMPTZ,
        last_failure_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, connector_name)
      );
      CREATE TABLE signals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id),
        source STRING NOT NULL, type STRING NOT NULL, domain STRING NOT NULL,
        data JSONB NOT NULL DEFAULT '{}'::JSONB, timestamp TIMESTAMPTZ NOT NULL,
        retention_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO users VALUES
        ('00000000-0000-4000-8000-000000000001'),
        ('00000000-0000-4000-8000-000000000002'),
        ('00000000-0000-4000-8000-000000000003');
      INSERT INTO oauth_tokens (
        id, user_id, provider, account_email, access_token, refresh_token, expires_at, updated_at
      ) VALUES
        ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
         'google', 'old@example.com', 'a1', 'r1', now() + INTERVAL '1 hour', '2026-01-01'),
        ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
         'google', 'new@example.com', 'a2', 'r2', now() + INTERVAL '1 hour', '2026-02-01'),
        ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
         'google', 'one@example.com', 'a3', 'r3', now() + INTERVAL '1 hour', '2026-03-01'),
        ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
         'microsoft', 'outlook@example.com', 'a4', 'r4', now() + INTERVAL '1 hour', '2026-04-01');
      INSERT INTO connector_cursors VALUES
        ('00000000-0000-4000-8000-000000000001', 'gmail', 'history_id', 'multi-cursor', now()),
        ('00000000-0000-4000-8000-000000000002', 'gmail', 'history_id', 'one-cursor', now()),
        ('00000000-0000-4000-8000-000000000002', 'google_calendar', 'sync_token', 'calendar-cursor', now()),
        ('00000000-0000-4000-8000-000000000003', 'outlook', 'delta_link', 'outlook-mail-cursor', now()),
        ('00000000-0000-4000-8000-000000000003', 'outlook_calendar', 'delta_link', 'outlook-calendar-cursor', now());
    `;
    const verify = `
      SELECT
        (SELECT connector_account_id FROM connector_cursors WHERE cursor_value = 'multi-cursor')
          = '10000000-0000-4000-8000-000000000002'::UUID AS multi_cursor_preserved,
        (SELECT connector_account_id FROM connector_cursors WHERE cursor_value = 'one-cursor')
          = '20000000-0000-4000-8000-000000000001'::UUID AS one_cursor_preserved,
        (SELECT connector_account_id FROM connector_cursors WHERE cursor_value = 'calendar-cursor')
          = '20000000-0000-4000-8000-000000000001'::UUID AS calendar_cursor_preserved,
        (SELECT connector_account_id FROM connector_cursors WHERE cursor_value = 'outlook-mail-cursor')
          = '30000000-0000-4000-8000-000000000001'::UUID AS outlook_mail_cursor_preserved,
        (SELECT connector_account_id FROM connector_cursors WHERE cursor_value = 'outlook-calendar-cursor')
          = '30000000-0000-4000-8000-000000000001'::UUID AS outlook_calendar_cursor_preserved,
        (SELECT count(*) FROM connector_health WHERE error_code = 'identity_verification_required') = 4
          AS reconnect_visible,
        EXISTS (
          SELECT 1 FROM connector_health
          WHERE connector_name = 'outlook_mail:30000000-0000-4000-8000-000000000001'
        ) AS microsoft_reconnect_visible,
        (SELECT count(*) FROM oauth_tokens WHERE credential_revision IS NOT NULL) = 4
          AS revisions_installed,
        EXISTS (
          SELECT 1 FROM [SHOW CONSTRAINTS FROM connected_accounts]
          WHERE constraint_name = 'connected_accounts_verified_subject_chk'
        ) AS proof_check_installed,
        EXISTS (
          SELECT 1 FROM [SHOW COLUMNS FROM gmail_message_refs]
          WHERE column_name = 'last_observed_inbox' AND is_nullable = false
        ) AS inbox_not_null;
    `;
    const result = spawnSync(
      'cockroach',
      [
        'demo',
        '--empty',
        '--insecure',
        // Vitest runs integration files concurrently. Keep this fixture off
        // cockroach demo's default ports so it cannot collide with another
        // live migration test in the same package run.
        '--sql-port=26657',
        '--http-port=18082',
        '--format=csv',
        '--execute',
        `${setup}\n${migration}\n${verify}`,
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('t,t,t,t,t,t,t,t,t,t');
  }, 30_000);
});
