import { loadConfig } from '@skytwin/config';
import {
  credentialDispatchLeaseRepository,
  credentialVaultMetaRepository,
  encryptColumn,
  oauthRepository,
  readColumn,
  serviceCredentialRepository,
} from '@skytwin/db';
import type { VaultKeyProvider } from '@skytwin/db';

export interface CredentialResult {
  success: true;
  accessToken: string;
  oauthTokenId?: string;
  credentialRevision?: string;
  accountEmail?: string;
  vaultGeneration?: string;
}

export interface CredentialError {
  success: false;
  error: string;
}

export type CredentialOutcome = CredentialResult | CredentialError;

export interface CredentialDispatchInput {
  userId: string;
  provider: string;
  accountEmail?: string;
  decisionId: string;
  actionId: string;
  executionPlanId: string;
  authorityRevision: string;
  policyAuthorityRevision: string;
}

export interface CredentialDispatchResult extends CredentialResult {
  capability: string;
  leaseGeneration: string;
  executionPlanId: string;
  userId: string;
}

export type CredentialDispatchOutcome = CredentialDispatchResult | CredentialError;

export interface CredentialProvider {
  getAccessToken(userId: string, provider: string, accountEmail?: string): Promise<CredentialOutcome>;
  startDispatch?(input: CredentialDispatchInput): Promise<CredentialDispatchOutcome>;
  terminalizeDispatch?(
    grant: CredentialDispatchResult,
    state: 'completed' | 'failed' | 'ambiguous',
  ): Promise<boolean>;
}

export interface CredentialAuditPort {
  recordAccess(input: {
    userId: string;
    actor: string;
    action: 'decrypt_oauth_token';
    resourceType: 'oauth_token';
    resourceId: string | null;
  }): void | Promise<void>;
}

export class DbCredentialProvider implements CredentialProvider {
  // Per-user+provider lock to prevent concurrent refresh races
  private readonly refreshLocks = new Map<string, Promise<CredentialOutcome>>();

  constructor(
    private readonly keyProvider: VaultKeyProvider | null = null,
    private readonly auditLog: CredentialAuditPort | null = null,
    private readonly auditActor = 'unknown',
  ) {}

  private recordDecrypt(userId: string, resourceId: string | null): void {
    if (!this.auditLog) return;
    try {
      const pending = this.auditLog.recordAccess({
        userId,
        actor: this.auditActor,
        action: 'decrypt_oauth_token',
        resourceType: 'oauth_token',
        resourceId,
      });
      if (pending && typeof (pending as Promise<void>).catch === 'function') {
        void (pending as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Audit is best-effort and must not turn a successful decrypt into a
      // dispatch denial, matching DbTokenStore's established contract.
    }
  }

  async getAccessToken(
    userId: string,
    provider: string,
    accountEmail?: string,
  ): Promise<CredentialOutcome> {
    return this.getAccessTokenInternal(userId, provider, accountEmail, true);
  }

  private async getAccessTokenInternal(
    userId: string,
    provider: string,
    accountEmail: string | undefined,
    allowPlaintextMigration: boolean,
  ): Promise<CredentialOutcome> {
    const token = accountEmail
      ? await oauthRepository.getTokenByAccount(userId, provider, accountEmail)
      : await oauthRepository.getToken(userId, provider);
    if (!token) {
      return { success: false, error: `No OAuth token found for ${provider}. Connect the account first.` };
    }

    const key = this.keyProvider?.get(userId) ?? null;
    const vaultOwned = Boolean(token.encrypted_access_token || token.encrypted_refresh_token);
    const vaultMeta = await credentialVaultMetaRepository.getForUser(userId);
    if ((vaultOwned && !vaultMeta) || (vaultMeta && (vaultMeta.vault_state !== 'unlocked' ||
        this.keyProvider?.getGeneration?.(userId) !== vaultMeta.vault_generation))) {
      return { success: false, error: 'OAuth credential is unavailable while the credential vault is locked.' };
    }
    if (vaultOwned && key === null) {
      return { success: false, error: 'OAuth credential is encrypted; unlock the credential vault first.' };
    }
    if (this.keyProvider && key === null && !vaultOwned && vaultMeta) {
      return { success: false, error: 'OAuth credential is unavailable while the credential vault is locked.' };
    }
    // Once a vault exists it is the only durable credential authority. Migrate
    // a complete legacy plaintext row under the exact row revision, live vault
    // generation, and current key version before returning or refreshing it.
    // A failed CAS may mean reconnect, rotation, disconnect, or a lease won;
    // none of those permit use of the material read above.
    if (!vaultOwned && vaultMeta) {
      if (!allowPlaintextMigration || key === null || !token.id ||
          !token.credential_revision || !token.access_token || !token.refresh_token ||
          !oauthRepository.updateEncryptedIfCurrent) {
        return { success: false, error: 'OAuth credential could not be migrated into the credential vault.' };
      }
      const migrated = await oauthRepository.updateEncryptedIfCurrent({
        id: token.id,
        userId,
        provider,
        expectedCredentialRevision: token.credential_revision,
        expectedVaultGeneration: vaultMeta.vault_generation,
        encryptedAccessToken: encryptColumn(token.access_token, key),
        encryptedRefreshToken: encryptColumn(token.refresh_token, key),
        iv: Buffer.alloc(0),
        tag: Buffer.alloc(0),
        keyVersion: vaultMeta.current_key_version,
      });
      if (!migrated) {
        return { success: false, error: 'OAuth credential changed while vault migration was in flight.' };
      }
      return this.getAccessTokenInternal(userId, provider, accountEmail, false);
    }
    // Encryption is a row-wide authority boundary. A partially migrated row
    // must never use a stale plaintext sibling alongside encrypted material.
    const access = readColumn(
      token.encrypted_access_token,
      vaultOwned ? null : token.access_token,
      key,
    );
    if (!access.success) {
      return { success: false, error: 'OAuth credential is encrypted; unlock the credential vault first.' };
    }
    if (token.encrypted_access_token) this.recordDecrypt(userId, token.id ?? null);
    if (access.value && token.expires_at.getTime() > Date.now() + 60_000) {
      return {
        success: true,
        accessToken: access.value,
        ...(token.id && token.credential_revision
          ? {
              oauthTokenId: token.id,
              credentialRevision: token.credential_revision,
              accountEmail: token.account_email,
              ...(vaultMeta ? { vaultGeneration: vaultMeta.vault_generation } : {}),
            }
          : {}),
      };
    }

    if (provider !== 'google') {
      return { success: false, error: `OAuth refresh is not implemented for ${provider}. Reconnect the account.` };
    }

    const refresh = readColumn(
      token.encrypted_refresh_token,
      vaultOwned ? null : token.refresh_token,
      key,
    );
    if (!refresh.success || !refresh.value) {
      return { success: false, error: 'Google OAuth token is expired and has no refresh token. Reconnect Google.' };
    }

    // Serialize concurrent refresh requests for the same user+provider
    const lockKey = `${userId}:${provider}:${accountEmail ?? ''}`;
    const existing = this.refreshLocks.get(lockKey);
    if (existing) return existing;

    const scopes = Array.isArray(token.scopes) ? token.scopes : token.scopes ? [token.scopes] : [];
    const refreshPromise = this.doGoogleRefresh({
      userId,
      provider,
      rowId: token.id,
      expectedAccessToken: token.access_token,
      expectedCredentialRevision: token.credential_revision,
      refreshToken: refresh.value,
      encrypted: vaultOwned,
      key,
      scopes,
      vaultGeneration: vaultMeta?.vault_generation,
    })
      .finally(() => this.refreshLocks.delete(lockKey));
    this.refreshLocks.set(lockKey, refreshPromise);
    return refreshPromise;
  }

  async startDispatch(input: CredentialDispatchInput): Promise<CredentialDispatchOutcome> {
    // Refresh may involve network I/O, so it happens before the DB request-start
    // claim. The claim then re-reads and binds the exact current row revision.
    const ready = await this.getAccessToken(input.userId, input.provider, input.accountEmail);
    if (!ready.success) return ready;
    if (!ready.oauthTokenId || !ready.credentialRevision) {
      return { success: false, error: 'OAuth credential is missing required dispatch identity.' };
    }
    const started = await credentialDispatchLeaseRepository.start({
      ...input,
      accountEmail: input.accountEmail ?? ready.accountEmail,
      expectedOAuthTokenId: ready.oauthTokenId,
      expectedCredentialRevision: ready.credentialRevision,
      expectedAuthorityRevision: input.authorityRevision,
      expectedPolicyAuthorityRevision: input.policyAuthorityRevision,
      expectedVaultGeneration: ready.vaultGeneration,
    });
    if (!started.success) return { success: false, error: started.error };
    // A process-local key session can expire while the DB request-start claim
    // is awaiting commit. Recheck synchronously after that final await and do
    // not hand materialized plaintext to the adapter if this exact vault
    // generation is no longer live in this process. The provider request has
    // not started, so this lease can be terminalized as a known no-effect.
    if (ready.vaultGeneration && (!this.keyProvider?.get(input.userId) ||
        this.keyProvider.getGeneration?.(input.userId) !== ready.vaultGeneration)) {
      await credentialDispatchLeaseRepository.terminalize({
        userId: input.userId,
        executionPlanId: input.executionPlanId,
        capability: started.grant.capability,
        leaseGeneration: started.grant.leaseGeneration,
        state: 'failed',
      });
      return {
        success: false,
        error: 'OAuth credential is unavailable while the credential vault is locked.',
      };
    }
    return {
      success: true,
      accessToken: ready.accessToken,
      capability: started.grant.capability,
      leaseGeneration: started.grant.leaseGeneration,
      executionPlanId: input.executionPlanId,
      userId: input.userId,
    };
  }

  async terminalizeDispatch(
    grant: CredentialDispatchResult,
    state: 'completed' | 'failed' | 'ambiguous',
  ): Promise<boolean> {
    return credentialDispatchLeaseRepository.terminalize({
      userId: grant.userId,
      executionPlanId: grant.executionPlanId,
      capability: grant.capability,
      leaseGeneration: grant.leaseGeneration,
      state,
    });
  }

  private async doGoogleRefresh(input: {
    userId: string;
    provider: string;
    rowId: string;
    expectedAccessToken: string | null;
    expectedCredentialRevision: string;
    refreshToken: string;
    encrypted: boolean;
    key: Buffer | null;
    scopes: string[];
    vaultGeneration?: string;
  }): Promise<CredentialOutcome> {
    const googleConfig = await this.getGoogleOAuthConfig();
    if (!googleConfig.success) return googleConfig;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: googleConfig.clientId,
        client_secret: googleConfig.clientSecret,
        refresh_token: input.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `Google OAuth refresh failed: HTTP ${response.status} ${body}` };
    }

    const payload = await response.json() as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };

    if (!payload.access_token) {
      return { success: false, error: 'Google OAuth refresh response did not include an access token.' };
    }

    const expiresAt = new Date(Date.now() + (payload.expires_in ?? 3600) * 1000);
    const saved = input.encrypted && input.key
      ? await oauthRepository.rotateEncryptedTokenIfCurrent({
          id: input.rowId,
          userId: input.userId,
          provider: input.provider,
          expectedCredentialRevision: input.expectedCredentialRevision,
          expectedVaultGeneration: input.vaultGeneration!,
          encryptedAccessToken: encryptColumn(payload.access_token, input.key),
          ...(payload.refresh_token
            ? { encryptedRefreshToken: encryptColumn(payload.refresh_token, input.key) }
            : {}),
          expiresAt,
        })
      : await oauthRepository.rotateTokenIfCurrent({
          id: input.rowId,
          userId: input.userId,
          provider: input.provider,
          expectedAccessToken: input.expectedAccessToken,
          expectedRefreshToken: input.refreshToken,
          expectedCredentialRevision: input.expectedCredentialRevision,
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token ?? input.refreshToken,
          expiresAt,
          scopes: input.scopes,
        });

    if (!saved) {
      return {
        success: false,
        error: 'OAuth credential changed or disconnected while refresh was in flight. Reconnect and retry.',
      };
    }
    return {
      success: true,
      accessToken: payload.access_token,
      ...(saved.id && saved.credential_revision
        ? {
            oauthTokenId: saved.id,
            credentialRevision: saved.credential_revision,
            accountEmail: saved.account_email,
            ...(input.vaultGeneration ? { vaultGeneration: input.vaultGeneration } : {}),
          }
        : {}),
    };
  }

  private async getGoogleOAuthConfig(): Promise<{ success: true; clientId: string; clientSecret: string } | CredentialError> {
    const config = loadConfig();
    let clientId = config.googleClientId;
    let clientSecret = config.googleClientSecret;

    if (!clientId || !clientSecret) {
      const dbCreds = await serviceCredentialRepository.getAsMap('google');
      clientId = clientId || dbCreds['client_id'] || '';
      clientSecret = clientSecret || dbCreds['client_secret'] || '';
    }

    if (!clientId || !clientSecret) {
      return { success: false, error: 'Google OAuth client credentials are not configured.' };
    }

    return { success: true, clientId, clientSecret };
  }
}

export class NoopCredentialProvider implements CredentialProvider {
  async getAccessToken(_userId: string, provider: string): Promise<CredentialOutcome> {
    return { success: false, error: `No credential provider configured for ${provider}.` };
  }


  async startDispatch(input: CredentialDispatchInput): Promise<CredentialDispatchOutcome> {
    return { success: false, error: `No credential provider configured for ${input.provider}.` };
  }

  async terminalizeDispatch(
    _grant: CredentialDispatchResult,
    _state: 'completed' | 'failed' | 'ambiguous',
  ): Promise<boolean> {
    return false;
  }
}
