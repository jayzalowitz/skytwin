import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withTransaction } from '../connection.js';
import type { CredentialDispatchLeaseRow, OAuthTokenRow } from '../types.js';

const LEASE_TTL_MS = 5 * 60_000;
const ACTIVE_STATES = "('request_started', 'ambiguous')";

export interface StartExecutionDispatchInput {
  userId: string;
  decisionId: string;
  actionId: string;
  executionPlanId: string;
  adapterName: string;
  mcpServerId?: string;
  mcpToolName?: string;
  credentialProvider?: string;
  expectedAuthorityRevision: string;
  expectedPolicyAuthorityRevision: string;
  expectedAdmissionAuthorityId: string;
  expectedAdmissionAuthorityUpdatedAt: string;
  now?: Date;
  ttlMs?: number;
}

export interface ExecutionDispatchGrant {
  capability: string;
  leaseGeneration: string;
  expiresAt: Date;
}

export interface CredentialMutationLeaseProof {
  userId: string;
  provider: string;
  executionPlanId: string;
  capability: string;
  leaseGeneration: string;
}

export type StartExecutionDispatchResult =
  | { success: true; grant: ExecutionDispatchGrant }
  | { success: false; code: 'authority_revoked' | 'dispatch_replayed'; error: string };

export interface BindCredentialDispatchInput {
  userId: string;
  provider: string;
  accountEmail?: string;
  decisionId: string;
  actionId: string;
  executionPlanId: string;
  capability: string;
  leaseGeneration: string;
  expectedOAuthTokenId: string;
  expectedCredentialRevision: string;
  expectedVaultGeneration?: string;
  now?: Date;
}

export interface CredentialDispatchGrant extends ExecutionDispatchGrant {
  accountEmail: string;
  oauthTokenId: string;
}

export type BindCredentialDispatchResult =
  | { success: true; grant: CredentialDispatchGrant }
  | { success: false; code: 'credential_unavailable' | 'authority_revoked' | 'dispatch_replayed'; error: string };

/** Compatibility input for callers that atomically claim and bind in one API. */
export interface StartCredentialDispatchInput extends Omit<StartExecutionDispatchInput,
  'adapterName' | 'expectedAdmissionAuthorityId' | 'expectedAdmissionAuthorityUpdatedAt'> {
  provider: string;
  accountEmail?: string;
  expectedOAuthTokenId: string;
  expectedCredentialRevision: string;
  expectedVaultGeneration?: string;
  expectedAdmissionAuthorityId?: string;
  expectedAdmissionAuthorityUpdatedAt?: string;
}

export type StartCredentialDispatchResult = BindCredentialDispatchResult;
export type CredentialDispatchTerminalState = 'completed' | 'failed' | 'ambiguous';

interface DispatchTokenRow extends OAuthTokenRow {
  encrypted_access_token?: Buffer | null;
}

interface AuthorityRow {
  authority_kind: 'admission' | 'receipt';
  authority_id: string;
  authority_updated_at: Date;
}

function hashCapability(capability: string): string {
  return createHash('sha256').update(capability, 'utf8').digest('hex');
}

async function markOverdueLeasesAmbiguous(
  client: import('pg').PoolClient,
  input: { userId?: string; oauthTokenId?: string },
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE credential_dispatch_leases
       SET state = 'ambiguous'
     WHERE state = 'request_started' AND expires_at <= $1
       AND ($2::UUID IS NULL OR user_id = $2)
       AND ($3::UUID IS NULL OR oauth_token_id = $3)`,
    [now, input.userId ?? null, input.oauthTokenId ?? null],
  );
}

/**
 * Authorize a credential migration/refresh that belongs to the exact generic
 * request-start claim which already fences every competing mutation. The
 * plaintext capability is hashed for comparison and never persisted.
 */
export async function authorizeCredentialMutationWithClient(
  client: import('pg').PoolClient,
  input: CredentialMutationLeaseProof & { oauthTokenId: string; now?: Date },
): Promise<{ authorized: boolean; retryAfter: Date | null }> {
  const now = input.now ?? new Date();
  await markOverdueLeasesAmbiguous(client, { userId: input.userId }, now);
  const own = await client.query<{ id: string }>(
    `SELECT id FROM credential_dispatch_leases
      WHERE user_id = $1 AND execution_plan_id = $2
        AND capability_hash = $3 AND lease_generation = $4
        AND state = 'request_started' AND expires_at > $5
        AND (oauth_token_id IS NULL OR oauth_token_id = $6)
        AND provider = $7
      FOR UPDATE`,
    [input.userId, input.executionPlanId, hashCapability(input.capability),
      input.leaseGeneration, now, input.oauthTokenId, input.provider],
  );
  const leaseId = own.rows[0]?.id;
  if (!leaseId) return { authorized: false, retryAfter: null };

  const conflicts = await client.query<{ active_count: string; retry_after: Date | null }>(
    `SELECT count(*) AS active_count,
            max(CASE WHEN state = 'request_started' AND expires_at > $4
                     THEN expires_at END) AS retry_after
      FROM credential_dispatch_leases
      WHERE user_id = $1 AND id <> $2
        AND (oauth_token_id = $3 OR (oauth_token_id IS NULL AND provider = $5))
        AND state IN ('request_started', 'ambiguous')`,
    [input.userId, leaseId, input.oauthTokenId, now, input.provider],
  );
  return {
    authorized: Number(conflicts.rows[0]?.active_count ?? 0) === 0,
    retryAfter: conflicts.rows[0]?.retry_after ?? null,
  };
}

/** Cross-process request-start fence for every execution adapter. */
export const executionDispatchLeaseRepository = {
  async start(input: StartExecutionDispatchInput): Promise<StartExecutionDispatchResult> {
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
      // Replay wins over mutable authority checks. A concurrent process may
      // already have crossed the request-start boundary for this exact plan;
      // a later pause/policy change must not let a retry report no-effect.
      await markOverdueLeasesAmbiguous(client, { userId: input.userId }, now);
      const prior = await client.query(
        'SELECT id FROM credential_dispatch_leases WHERE execution_plan_id = $1',
        [input.executionPlanId],
      );
      if (prior.rows[0]) {
        return { success: false, code: 'dispatch_replayed', error: 'This execution plan already consumed its dispatch capability.' };
      }
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

      if (input.adapterName === 'mcp-host') {
        if (!input.mcpServerId || !input.mcpToolName) {
          return { success: false, code: 'authority_revoked', error: 'Exact MCP execution authority is required.' };
        }
        const server = await client.query(
          `SELECT id FROM mcp_servers
            WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [input.mcpServerId, input.userId],
        );
        const pending = await client.query(
          `SELECT 1 FROM pending_skill_opt_ins
            WHERE server_id = $1 AND skill_name = $2
              AND accepted_at IS NULL
            LIMIT 1`,
          [input.mcpServerId, input.mcpToolName],
        );
        if (!server.rows[0] || pending.rows[0]) {
          return { success: false, code: 'authority_revoked', error: 'MCP tool authorization changed before request start.' };
        }
      }

      const authority = await client.query<AuthorityRow>(
        `SELECT 'admission' AS authority_kind, b.id AS authority_id,
                b.updated_at AS authority_updated_at
           FROM execution_admission_barriers b
           JOIN execution_plans ep ON ep.id = b.execution_plan_id
             AND ep.decision_id = b.decision_id AND ep.action_id = b.action_id
          WHERE b.user_id = $1 AND b.decision_id = $2 AND b.action_id = $3
            AND b.execution_plan_id = $4 AND b.status = 'in_progress'
            AND ep.status = 'running'
         UNION ALL
         SELECT 'receipt' AS authority_kind, g.decision_id AS authority_id,
                g.updated_at AS authority_updated_at
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
      if (!authority.rows[0] ||
          authority.rows[0].authority_id !== input.expectedAdmissionAuthorityId ||
          authority.rows[0].authority_updated_at.toISOString() !==
            input.expectedAdmissionAuthorityUpdatedAt) {
        return { success: false, code: 'authority_revoked', error: 'Execution authority is unavailable.' };
      }

      if (input.credentialProvider) {
        const resolving = await client.query(
          `SELECT id FROM credential_dispatch_leases
            WHERE user_id = $1 AND provider = $2
              AND state IN ('request_started', 'ambiguous')
            LIMIT 1`,
          [input.userId, input.credentialProvider],
        );
        if (resolving.rows[0]) {
          return {
            success: false,
            code: 'authority_revoked',
            error: 'Credential dispatch is already active for this provider.',
          };
        }
      }

      const inserted = await client.query<CredentialDispatchLeaseRow>(
        `INSERT INTO credential_dispatch_leases (
           user_id, adapter_name, provider, mcp_server_id, mcp_tool_name,
           execution_authority_revision, policy_authority_revision,
           action_id, decision_id, execution_plan_id,
           authority_kind, authority_id, authority_updated_at,
           capability_hash, lease_generation, state,
           acquired_at, request_started_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, 'request_started', $16, $16, $17
         ) RETURNING *`,
        [input.userId, input.adapterName, input.credentialProvider ?? null,
          input.mcpServerId ?? null, input.mcpToolName ?? null,
          input.expectedAuthorityRevision, input.expectedPolicyAuthorityRevision,
          input.actionId, input.decisionId, input.executionPlanId,
          authority.rows[0].authority_kind, authority.rows[0].authority_id,
          authority.rows[0].authority_updated_at, capabilityHash, leaseGeneration,
          now, expiresAt],
      );
      if (!inserted.rows[0]) throw new Error('Execution dispatch lease was not persisted.');
      return { success: true, grant: { capability, leaseGeneration, expiresAt } };
    });
  },

  async bindCredential(input: BindCredentialDispatchInput): Promise<BindCredentialDispatchResult> {
    const now = input.now ?? new Date();
    return withTransaction(async (client) => {
      const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
      if (!owner.rows[0]) {
        return { success: false, code: 'authority_revoked', error: 'Execution owner is unavailable.' };
      }
      await markOverdueLeasesAmbiguous(client, { userId: input.userId }, now);
      const lease = await client.query<CredentialDispatchLeaseRow>(
        `SELECT * FROM credential_dispatch_leases
          WHERE user_id = $1 AND decision_id = $2 AND action_id = $3
            AND execution_plan_id = $4 AND capability_hash = $5
            AND lease_generation = $6 AND state = 'request_started'
          FOR UPDATE`,
        [input.userId, input.decisionId, input.actionId, input.executionPlanId,
          hashCapability(input.capability), input.leaseGeneration],
      );
      const leaseRow = lease.rows[0];
      if (!leaseRow || leaseRow.oauth_token_id !== null) {
        return { success: false, code: 'dispatch_replayed', error: 'Dispatch capability is unavailable.' };
      }
      if (leaseRow.provider !== input.provider) {
        return {
          success: false,
          code: 'credential_unavailable',
          error: 'Dispatch capability is not authorized for this credential provider.',
        };
      }

      const vault = await client.query<{ vault_state: 'locked' | 'unlocked'; vault_generation: string }>(
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

      const token = await client.query<DispatchTokenRow>(
        `SELECT * FROM oauth_tokens
          WHERE id = $1 AND user_id = $2 AND provider = $3
            AND credential_revision = $4
            AND ($5::STRING IS NULL OR account_email = $5)
          ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [input.expectedOAuthTokenId, input.userId, input.provider,
          input.expectedCredentialRevision, input.accountEmail ?? null],
      );
      const row = token.rows[0];
      if (!row || row.dispatch_state !== 'active' || row.expires_at <= now) {
        return { success: false, code: 'credential_unavailable', error: `No active ${input.provider} credential is available for dispatch.` };
      }

      const updated = await client.query(
        `UPDATE credential_dispatch_leases
            SET oauth_token_id = $7, provider = $8, account_email = $9,
                credential_revision = $10, credential_generation = $11,
                vault_generation = $12
          WHERE user_id = $1 AND decision_id = $2 AND action_id = $3
            AND execution_plan_id = $4 AND capability_hash = $5
            AND lease_generation = $6 AND state = 'request_started'
            AND oauth_token_id IS NULL RETURNING id`,
        [input.userId, input.decisionId, input.actionId, input.executionPlanId,
          hashCapability(input.capability), input.leaseGeneration, row.id, row.provider,
          row.account_email, row.credential_revision, row.dispatch_generation,
          vaultRow?.vault_generation ?? null],
      );
      if (!updated.rows[0]) {
        return { success: false, code: 'dispatch_replayed', error: 'Dispatch capability is unavailable.' };
      }
      return {
        success: true,
        grant: {
          accountEmail: row.account_email,
          oauthTokenId: row.id,
          capability: input.capability,
          leaseGeneration: input.leaseGeneration,
          expiresAt: leaseRow.expires_at,
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
      const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
      if (!owner.rows[0]) return false;
      const result = await client.query(
        `UPDATE credential_dispatch_leases SET state = $5, terminal_at = $6
          WHERE user_id = $1 AND execution_plan_id = $2
            AND capability_hash = $3 AND lease_generation = $4
            AND state IN ('request_started', 'ambiguous') RETURNING id`,
        [input.userId, input.executionPlanId, hashCapability(input.capability),
          input.leaseGeneration, input.state, now],
      );
      return !!result.rows[0];
    });
  },

};

/** Legacy combined entry point retained for direct repository consumers. */
export const credentialDispatchLeaseRepository = {
  async start(input: StartCredentialDispatchInput): Promise<StartCredentialDispatchResult> {
    let authorityId = input.expectedAdmissionAuthorityId;
    let authorityUpdatedAt = input.expectedAdmissionAuthorityUpdatedAt;
    if (!authorityId || !authorityUpdatedAt) {
      const current = await withTransaction(async (client) => client.query<AuthorityRow>(
        `SELECT 'admission' AS authority_kind, b.id AS authority_id,
                b.updated_at AS authority_updated_at
           FROM execution_admission_barriers b
          WHERE b.user_id = $1 AND b.decision_id = $2 AND b.action_id = $3
            AND b.execution_plan_id = $4 AND b.status = 'in_progress'
         UNION ALL
         SELECT 'receipt' AS authority_kind, g.decision_id AS authority_id,
                g.updated_at AS authority_updated_at
           FROM decision_ingest_guards g
           JOIN decisions d ON d.id = g.decision_id AND d.user_id = $1
          WHERE g.decision_id = $2 AND g.selected_action_id = $3
            AND g.source_execution_plan_id = $4 AND g.effect_state = 'running'
         LIMIT 1`,
        [input.userId, input.decisionId, input.actionId, input.executionPlanId],
      ));
      authorityId = current.rows[0]?.authority_id;
      authorityUpdatedAt = current.rows[0]?.authority_updated_at.toISOString();
    }
    if (!authorityId || !authorityUpdatedAt) {
      return { success: false, code: 'authority_revoked', error: 'Execution authority is unavailable.' };
    }
    const started = await executionDispatchLeaseRepository.start({
      ...input,
      adapterName: 'direct',
      credentialProvider: input.provider,
      expectedAdmissionAuthorityId: authorityId,
      expectedAdmissionAuthorityUpdatedAt: authorityUpdatedAt,
    });
    if (!started.success) return started;
    const bound = await executionDispatchLeaseRepository.bindCredential({
      ...input,
      capability: started.grant.capability,
      leaseGeneration: started.grant.leaseGeneration,
    });
    if (!bound.success) {
      await executionDispatchLeaseRepository.terminalize({
        userId: input.userId,
        executionPlanId: input.executionPlanId,
        capability: started.grant.capability,
        leaseGeneration: started.grant.leaseGeneration,
        state: 'failed',
      });
    }
    return bound;
  },
  terminalize: executionDispatchLeaseRepository.terminalize,
};

export async function expireCredentialDispatchLeasesWithClient(
  client: import('pg').PoolClient,
  oauthTokenId: string,
  now = new Date(),
): Promise<void> {
  await markOverdueLeasesAmbiguous(client, { oauthTokenId }, now);
}

export async function hasActiveCredentialDispatchWithClient(
  client: import('pg').PoolClient,
  input: { oauthTokenId?: string; userId?: string; provider?: string; accountEmail?: string },
): Promise<{ active: boolean; retryAfter: Date | null }> {
  const result = await client.query<{ active_count: string; retry_after: Date | null }>(
    `SELECT count(*) AS active_count,
            max(CASE WHEN state = 'request_started' AND expires_at > now() THEN expires_at END) AS retry_after
       FROM credential_dispatch_leases
      WHERE state IN ${ACTIVE_STATES}
        AND ($1::UUID IS NULL OR oauth_token_id = $1 OR
             (oauth_token_id IS NULL AND user_id = COALESCE(
               $2::UUID, (SELECT user_id FROM oauth_tokens WHERE id = $1)
             )))
        AND ($2::UUID IS NULL OR user_id = $2)
        AND ($3::STRING IS NULL OR provider = $3)
        AND ($4::STRING IS NULL OR account_email = $4 OR account_email IS NULL)`,
    [input.oauthTokenId ?? null, input.userId ?? null,
      input.provider ?? null, input.accountEmail ?? null],
  );
  const retryAfter = result.rows[0]?.retry_after ?? null;
  return { active: Number(result.rows[0]?.active_count ?? 0) > 0, retryAfter };
}
