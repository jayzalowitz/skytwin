import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withTransaction } from '../connection.js';
import type { CredentialDispatchLeaseRow, OAuthTokenRow } from '../types.js';

const LEASE_TTL_MS = 5 * 60_000;
const ACTIVE_STATES = "('request_started', 'ambiguous')";

export interface StartCredentialDispatchInput {
  userId: string;
  provider: string;
  accountEmail?: string;
  decisionId: string;
  actionId: string;
  executionPlanId: string;
  expectedOAuthTokenId: string;
  expectedCredentialRevision: string;
  expectedAuthorityRevision: string;
  expectedPolicyAuthorityRevision: string;
  expectedVaultGeneration?: string;
  now?: Date;
  ttlMs?: number;
}

export interface CredentialDispatchGrant {
  accountEmail: string;
  oauthTokenId: string;
  capability: string;
  leaseGeneration: string;
  expiresAt: Date;
}

export type StartCredentialDispatchResult =
  | { success: true; grant: CredentialDispatchGrant }
  | {
      success: false;
      code: 'credential_unavailable' | 'authority_revoked' | 'dispatch_replayed';
      error: string;
    };

export type CredentialDispatchTerminalState = 'completed' | 'failed' | 'ambiguous';

interface DispatchTokenRow extends OAuthTokenRow {
  encrypted_access_token?: Buffer | null;
}

interface AuthorityRow {
  authority_kind: 'admission' | 'receipt';
  authority_id: string;
}

function hashCapability(capability: string): string {
  return createHash('sha256').update(capability, 'utf8').digest('hex');
}

async function markOverdueLeasesAmbiguous(
  client: import('pg').PoolClient,
  oauthTokenId: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE credential_dispatch_leases
       SET state = 'ambiguous'
     WHERE oauth_token_id = $1 AND state = 'request_started' AND expires_at <= $2`,
    [oauthTokenId, now],
  );
}

/**
 * Cross-process credential request-start fence.
 *
 * The insert commits before the caller receives the access token. That commit
 * is the linearization point: a credential mutation either wins the token-row
 * lock first (and this claim fails) or sees this live lease and must refuse.
 * No transaction remains open while the provider request is in flight.
 */
export const credentialDispatchLeaseRepository = {
  async start(input: StartCredentialDispatchInput): Promise<StartCredentialDispatchResult> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + Math.max(1_000, input.ttlMs ?? LEASE_TTL_MS));
    const capability = randomBytes(32).toString('base64url');
    const capabilityHash = hashCapability(capability);
    const leaseGeneration = randomUUID();

    return withTransaction(async (client) => {
      const owner = await client.query<{
        id: string;
        autonomy_settings: Record<string, unknown>;
        execution_authority_revision: string;
      }>(
        `SELECT id, autonomy_settings, execution_authority_revision
           FROM users WHERE id = $1 FOR UPDATE`,
        [input.userId],
      );
      if (!owner.rows[0] || owner.rows[0].autonomy_settings?.['paused'] === true ||
          owner.rows[0].execution_authority_revision !== input.expectedAuthorityRevision) {
        return { success: false, code: 'authority_revoked', error: 'Execution owner is unavailable.' };
      }

      const policyAuthority = await client.query<{ revision: string }>(
        `SELECT revision FROM execution_policy_authority
          WHERE singleton = true FOR UPDATE`,
      );
      if (policyAuthority.rows[0]?.revision !== input.expectedPolicyAuthorityRevision) {
        return { success: false, code: 'authority_revoked', error: 'Execution policy changed before request start.' };
      }

      const vault = await client.query<{
        vault_state: 'locked' | 'unlocked';
        vault_generation: string;
      }>(
        `SELECT vault_state, vault_generation
           FROM user_credential_vault_meta WHERE user_id = $1 FOR UPDATE`,
        [input.userId],
      );
      const vaultRow = vault.rows[0];
      if ((vaultRow && (vaultRow.vault_state !== 'unlocked' ||
          vaultRow.vault_generation !== input.expectedVaultGeneration)) ||
          (!vaultRow && input.expectedVaultGeneration !== undefined)) {
        return { success: false, code: 'credential_unavailable', error: 'Credential vault session is stale.' };
      }

      const authority = await client.query<AuthorityRow>(
        `SELECT 'admission' AS authority_kind, b.id AS authority_id
           FROM execution_admission_barriers b
           JOIN execution_plans ep ON ep.id = b.execution_plan_id
             AND ep.decision_id = b.decision_id AND ep.action_id = b.action_id
          WHERE b.user_id = $1 AND b.decision_id = $2 AND b.action_id = $3
            AND b.execution_plan_id = $4 AND b.status = 'in_progress'
            AND ep.status = 'running'
         UNION ALL
         SELECT 'receipt' AS authority_kind, g.decision_id AS authority_id
           FROM decision_ingest_guards g
           JOIN decisions d ON d.id = g.decision_id AND d.user_id = $1
           JOIN execution_plans ep ON ep.id = g.source_execution_plan_id
             AND ep.decision_id = g.decision_id AND ep.action_id = g.selected_action_id
          WHERE g.decision_id = $2 AND g.selected_action_id = $3
            AND g.source_execution_plan_id = $4 AND g.effect_state = 'running'
            AND ep.status = 'running'
         LIMIT 1`,
        [input.userId, input.decisionId, input.actionId, input.executionPlanId],
      );
      if (!authority.rows[0]) {
        return { success: false, code: 'authority_revoked', error: 'Execution authority is unavailable.' };
      }

      const token = await client.query<DispatchTokenRow>(
        `SELECT * FROM oauth_tokens
          WHERE id = $1 AND user_id = $2 AND provider = $3
            AND credential_revision = $4
            AND ($5::STRING IS NULL OR account_email = $5)
          ORDER BY updated_at DESC LIMIT 1
          FOR UPDATE`,
        [input.expectedOAuthTokenId, input.userId, input.provider,
          input.expectedCredentialRevision, input.accountEmail ?? null],
      );
      const row = token.rows[0];
      if (!row || row.dispatch_state !== 'active' || row.expires_at <= now) {
        return {
          success: false,
          code: 'credential_unavailable',
          error: `No active ${input.provider} credential is available for dispatch.`,
        };
      }

      await markOverdueLeasesAmbiguous(client, row.id, now);
      const prior = await client.query(
        'SELECT id FROM credential_dispatch_leases WHERE execution_plan_id = $1',
        [input.executionPlanId],
      );
      if (prior.rows[0]) {
        return {
          success: false,
          code: 'dispatch_replayed',
          error: 'This execution plan already consumed its credential dispatch capability.',
        };
      }

      const inserted = await client.query<CredentialDispatchLeaseRow>(
        `INSERT INTO credential_dispatch_leases (
           user_id, oauth_token_id, provider, account_email,
           credential_revision, credential_generation, vault_generation,
           policy_authority_revision,
           action_id, decision_id, execution_plan_id,
           authority_kind, authority_id, capability_hash, lease_generation,
           state, acquired_at, request_started_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15, 'request_started', $16, $16, $17
         ) RETURNING *`,
        [input.userId, row.id, row.provider, row.account_email,
          row.credential_revision, row.dispatch_generation, vaultRow?.vault_generation ?? null,
          input.expectedPolicyAuthorityRevision,
          input.actionId, input.decisionId, input.executionPlanId,
          authority.rows[0].authority_kind, authority.rows[0].authority_id,
          capabilityHash, leaseGeneration, now, expiresAt],
      );
      if (!inserted.rows[0]) throw new Error('Credential dispatch lease was not persisted.');
      return {
        success: true,
        grant: {
          accountEmail: row.account_email,
          oauthTokenId: row.id,
          capability,
          leaseGeneration,
          expiresAt,
        },
      };
    });
  },

  async terminalize(input: {
    userId: string;
    executionPlanId: string;
    capability: string;
    leaseGeneration: string;
    state: CredentialDispatchTerminalState;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    return withTransaction(async (client) => {
      const owner = await client.query(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [input.userId],
      );
      if (!owner.rows[0]) return false;
      const result = await client.query(
        `UPDATE credential_dispatch_leases
            SET state = $5, terminal_at = $6
          WHERE user_id = $1 AND execution_plan_id = $2
            AND capability_hash = $3 AND lease_generation = $4
            AND state IN ('request_started', 'ambiguous')
          RETURNING id`,
        [input.userId, input.executionPlanId, hashCapability(input.capability),
          input.leaseGeneration, input.state, now],
      );
      return !!result.rows[0];
    });
  },
};

export async function expireCredentialDispatchLeasesWithClient(
  client: import('pg').PoolClient,
  oauthTokenId: string,
  now = new Date(),
): Promise<void> {
  await markOverdueLeasesAmbiguous(client, oauthTokenId, now);
}

export async function hasActiveCredentialDispatchWithClient(
  client: import('pg').PoolClient,
  input: { oauthTokenId?: string; userId?: string; provider?: string; accountEmail?: string },
): Promise<{ active: boolean; retryAfter: Date | null }> {
  const result = await client.query<{ active_count: string; retry_after: Date | null }>(
    `SELECT count(*) AS active_count,
            max(CASE WHEN state = 'request_started' AND expires_at > now()
                     THEN expires_at END) AS retry_after
       FROM credential_dispatch_leases
      WHERE state IN ${ACTIVE_STATES}
        AND ($1::UUID IS NULL OR oauth_token_id = $1)
        AND ($2::UUID IS NULL OR user_id = $2)
        AND ($3::STRING IS NULL OR provider = $3)
        AND ($4::STRING IS NULL OR account_email = $4)`,
    [input.oauthTokenId ?? null, input.userId ?? null,
      input.provider ?? null, input.accountEmail ?? null],
  );
  const retryAfter = result.rows[0]?.retry_after ?? null;
  return { active: Number(result.rows[0]?.active_count ?? 0) > 0, retryAfter };
}
