import { createHash } from 'node:crypto';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { query, withTransaction } from '../connection.js';
import type { ConnectedAccountRow } from '../types.js';

interface VerifiedConnectedAccountInput {
  userId: string;
  provider: string;
  providerSubject: string;
  accountDisplay: string;
  scopes: string[];
}

interface UnverifiedConnectedAccountInput {
  userId: string;
  provider: string;
  accountDisplay: string;
  scopes: string[];
}

async function execute<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient | undefined,
  sql: string,
  params: unknown[],
): Promise<QueryResult<T>> {
  return client ? client.query<T>(sql, params) : query<T>(sql, params);
}

/** Provider subjects are stable identifiers but remain pseudonymous at rest. */
export function digestProviderSubject(provider: string, providerSubject: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const trimmedSubject = providerSubject.trim();
  if (
    !normalizedProvider || !trimmedSubject || trimmedSubject.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(trimmedSubject)
  ) {
    throw new Error('Provider and verified provider subject must be bounded, non-empty strings.');
  }
  // Microsoft object ids are GUIDs and case-insensitive. Google `sub` is an
  // opaque case-sensitive string (normally decimal), so do not lowercase it.
  const normalizedSubject = normalizedProvider === 'microsoft'
    ? trimmedSubject.toLowerCase()
    : trimmedSubject;
  return createHash('sha256')
    .update(normalizedProvider)
    .update('\0')
    .update(normalizedSubject)
    .digest('hex');
}

export function canonicalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

export const connectedAccountRepository = {
  async upsertVerified(
    input: VerifiedConnectedAccountInput,
    client?: PoolClient,
  ): Promise<ConnectedAccountRow> {
    const provider = input.provider.trim().toLowerCase();
    const digest = digestProviderSubject(provider, input.providerSubject);
    const scopes = canonicalizeScopes(input.scopes);
    const result = await execute<ConnectedAccountRow>(client,
      `INSERT INTO connected_accounts (
         user_id, provider, account_id, provider_subject_digest,
         account_display, scopes, identity_verified, is_active,
         disconnected_at, updated_at
       )
       VALUES ($1, $2, $3, $3, $4, $5, true, true, NULL, now())
       ON CONFLICT (user_id, provider, provider_subject_digest)
         WHERE provider_subject_digest IS NOT NULL
       DO UPDATE SET
         account_display = EXCLUDED.account_display,
         scopes = EXCLUDED.scopes,
         identity_verified = true,
         is_active = true,
         disconnected_at = NULL,
         updated_at = now()
       RETURNING *`,
      [input.userId, provider, digest, input.accountDisplay.trim(), scopes],
    );
    return result.rows[0]!;
  },

  async createUnverified(
    input: UnverifiedConnectedAccountInput,
    client?: PoolClient,
  ): Promise<ConnectedAccountRow> {
    const result = await execute<ConnectedAccountRow>(client,
      `INSERT INTO connected_accounts (
         user_id, provider, account_id, account_display, scopes,
         identity_verified, is_active, updated_at
       )
       VALUES ($1, $2, 'legacy:' || gen_random_uuid()::STRING, $3, $4, false, true, now())
       RETURNING *`,
      [
        input.userId,
        input.provider.trim().toLowerCase(),
        input.accountDisplay.trim(),
        canonicalizeScopes(input.scopes),
      ],
    );
    return result.rows[0]!;
  },

  async findOwnedActive(
    userId: string,
    connectorAccountId: string,
    provider: string,
    client?: PoolClient,
  ): Promise<ConnectedAccountRow | null> {
    const result = await execute<ConnectedAccountRow>(client,
      `SELECT * FROM connected_accounts
        WHERE id = $1 AND user_id = $2 AND provider = $3 AND is_active = true`,
      [connectorAccountId, userId, provider],
    );
    return result.rows[0] ?? null;
  },

  async deactivateForTokenAccount(
    userId: string,
    provider: string,
    accountEmail: string,
    client?: PoolClient,
  ): Promise<number> {
    const result = await execute(client,
      `UPDATE connected_accounts AS ca
          SET is_active = false, disconnected_at = now(), updated_at = now()
        WHERE ca.user_id = $1 AND ca.provider = $2
          AND ca.id IN (
            SELECT connector_account_id FROM oauth_tokens
             WHERE user_id = $1 AND provider = $2 AND lower(account_email) = lower($3)
          )`,
      [userId, provider, accountEmail],
    );
    return result.rowCount ?? 0;
  },

  async deactivateAllForProvider(
    userId: string,
    provider: string,
    client?: PoolClient,
  ): Promise<number> {
    const result = await execute(client,
      `UPDATE connected_accounts AS ca
          SET is_active = false, disconnected_at = now(), updated_at = now()
        WHERE ca.user_id = $1 AND ca.provider = $2 AND ca.is_active = true`,
      [userId, provider],
    );
    return result.rowCount ?? 0;
  },

  async deactivateAndDeleteAccount(
    userId: string,
    provider: string,
    accountEmail: string,
  ): Promise<boolean> {
    return withTransaction(async (client) => {
      await client.query(
        `DELETE FROM connector_health AS h
          WHERE h.user_id = $1 AND EXISTS (
            SELECT 1 FROM oauth_tokens AS t
             WHERE t.user_id = $1 AND t.provider = $2
               AND lower(t.account_email) = lower($3)
               AND h.connector_name IN (
                 'gmail:' || t.connector_account_id::STRING,
                 'google-calendar:' || t.connector_account_id::STRING,
                 'outlook_mail:' || t.connector_account_id::STRING,
                 'outlook_calendar:' || t.connector_account_id::STRING
               )
          )`,
        [userId, provider, accountEmail],
      );
      await this.deactivateForTokenAccount(userId, provider, accountEmail, client);
      const result = await client.query(
        'DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = $2 AND lower(account_email) = lower($3)',
        [userId, provider, accountEmail],
      );
      return (result.rowCount ?? 0) > 0;
    });
  },
};

export type { VerifiedConnectedAccountInput, UnverifiedConnectedAccountInput };
