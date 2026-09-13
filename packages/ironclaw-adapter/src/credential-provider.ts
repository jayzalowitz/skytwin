import { loadConfig } from '@skytwin/config';
import {
  executionDispatchLeaseRepository,
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

const credentialRequestBoundaries = new WeakMap<object, boolean>();

function markCredentialRequestBoundary<T extends CredentialOutcome>(
  outcome: T,
  requestStarted: boolean,
): T {
  credentialRequestBoundaries.set(outcome, requestStarted);
  return outcome;
}

/** Authenticated module-local fact; arbitrary provider-shaped objects cannot forge it. */
export function didCredentialRequestStart(outcome: CredentialOutcome): boolean | undefined {
  return credentialRequestBoundaries.get(outcome);
}

export interface CredentialDispatchInput {
  userId: string;
  provider: string;
  accountEmail?: string;
  decisionId: string;
  actionId: string;
  executionPlanId: string;
  authorityRevision: string;
  policyAuthorityRevision: string;
  dispatchCapability: string;
  dispatchLeaseGeneration: string;
}

export interface CredentialDispatchResult extends CredentialResult {
  capability: string;
  leaseGeneration: string;
  executionPlanId: string;
  userId: string;
}

export type CredentialDispatchOutcome = CredentialDispatchResult | CredentialError;

interface DispatchLeaseProof {
  userId: string;
  provider: string;
  executionPlanId: string;
  capability: string;
  leaseGeneration: string;
}

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
    dispatchProof?: DispatchLeaseProof,
  ): Promise<CredentialOutcome> {
    const token = accountEmail
      ? await oauthRepository.getTokenByAccount(userId, provider, accountEmail)
      : await oauthRepository.getToken(userId, provider);
    if (!token) {
      return markCredentialRequestBoundary(
        { success: false, error: `No OAuth token found for ${provider}. Connect the account first.` },
        false,
      );
    }

    const key = this.keyProvider?.get(userId) ?? null;
    const vaultOwned = Boolean(token.encrypted_access_token || token.encrypted_refresh_token);
    const vaultMeta = await credentialVaultMetaRepository.getForUser(userId);
    if ((vaultOwned && !vaultMeta) || (vaultMeta && (vaultMeta.vault_state !== 'unlocked' ||
        this.keyProvider?.getGeneration?.(userId) !== vaultMeta.vault_generation))) {
      return markCredentialRequestBoundary(
        { success: false, error: 'OAuth credential is unavailable while the credential vault is locked.' }, false,
      );
    }
    if (vaultOwned && key === null) {
      return markCredentialRequestBoundary(
        { success: false, error: 'OAuth credential is encrypted; unlock the credential vault first.' }, false,
      );
    }
    if (this.keyProvider && key === null && !vaultOwned && vaultMeta) {
      return markCredentialRequestBoundary(
        { success: false, error: 'OAuth credential is unavailable while the credential vault is locked.' }, false,
      );
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
        return markCredentialRequestBoundary(
          { success: false, error: 'OAuth credential could not be migrated into the credential vault.' }, false,
        );
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
        dispatchProof,
      });
      if (!migrated) {
        return markCredentialRequestBoundary(
          { success: false, error: 'OAuth credential changed while vault migration was in flight.' }, false,
        );
      }
      return this.getAccessTokenInternal(userId, provider, accountEmail, false, dispatchProof);
    }
    // Encryption is a row-wide authority boundary. A partially migrated row
    // must never use a stale plaintext sibling alongside encrypted material.
    const access = readColumn(
      token.encrypted_access_token,
      vaultOwned ? null : token.access_token,
      key,
    );
    if (!access.success) {
      return markCredentialRequestBoundary(
        { success: false, error: 'OAuth credential is encrypted; unlock the credential vault first.' }, false,
      );
    }
    if (token.encrypted_access_token) this.recordDecrypt(userId, token.id ?? null);
    if (access.value && token.expires_at.getTime() > Date.now() + 60_000) {
      return markCredentialRequestBoundary({
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
      }, false);
    }

    if (provider !== 'google') {
      return markCredentialRequestBoundary(
        { success: false, error: `OAuth refresh is not implemented for ${provider}. Reconnect the account.` }, false,
      );
    }

    const refresh = readColumn(
      token.encrypted_refresh_token,
      vaultOwned ? null : token.refresh_token,
      key,
    );
    if (!refresh.success || !refresh.value) {
      return markCredentialRequestBoundary(
        { success: false, error: 'Google OAuth token is expired and has no refresh token. Reconnect Google.' }, false,
      );
    }

    // Serialize concurrent refresh requests for the same user+provider
    // Alias callers (implicit newest-account selection vs explicit email)
    // must share one refresh request for the exact selected credential row.
    const lockKey = `${userId}:${provider}:${token.id}`;
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
      dispatchProof,
    })
      .finally(() => this.refreshLocks.delete(lockKey));
    this.refreshLocks.set(lockKey, refreshPromise);
    return refreshPromise;
  }

  async startDispatch(input: CredentialDispatchInput): Promise<CredentialDispatchOutcome> {
    // Refresh or plaintext migration runs under the already-committed generic
    // request-start capability. Its DB write must prove that exact capability;
    // the final bind then re-reads the resulting credential row revision.
    const dispatchProof = {
      userId: input.userId,
      provider: input.provider,
      executionPlanId: input.executionPlanId,
      capability: input.dispatchCapability,
      leaseGeneration: input.dispatchLeaseGeneration,
    };
    const ready = await this.getAccessTokenInternal(
      input.userId, input.provider, input.accountEmail, true, dispatchProof,
    );
    if (!ready.success) return ready;
    if (!ready.oauthTokenId || !ready.credentialRevision) {
      return markCredentialRequestBoundary(
        { success: false, error: 'OAuth credential is missing required dispatch identity.' },
        didCredentialRequestStart(ready) ?? false,
      );
    }
    const started = await executionDispatchLeaseRepository.bindCredential({
      userId: input.userId,
      provider: input.provider,
      accountEmail: input.accountEmail ?? ready.accountEmail,
      decisionId: input.decisionId,
      actionId: input.actionId,
      executionPlanId: input.executionPlanId,
      capability: input.dispatchCapability,
      leaseGeneration: input.dispatchLeaseGeneration,
      expectedOAuthTokenId: ready.oauthTokenId,
      expectedCredentialRevision: ready.credentialRevision,
      expectedVaultGeneration: ready.vaultGeneration,
    });
    if (!started.success) return markCredentialRequestBoundary({
      success: false,
      error: started.error,
    }, didCredentialRequestStart(ready) ?? false);
    // Recheck the process-local key session after the durable credential bind.
    // The router owns terminalization of the generic request-start lease.
    if (ready.vaultGeneration && (!this.keyProvider?.get(input.userId) ||
        this.keyProvider.getGeneration?.(input.userId) !== ready.vaultGeneration)) {
      return markCredentialRequestBoundary({
        success: false,
        error: 'OAuth credential is unavailable while the credential vault is locked.',
      }, didCredentialRequestStart(ready) ?? false);
    }
    return markCredentialRequestBoundary({
      success: true,
      accessToken: ready.accessToken,
      capability: started.grant.capability,
      leaseGeneration: started.grant.leaseGeneration,
      executionPlanId: input.executionPlanId,
      userId: input.userId,
    }, didCredentialRequestStart(ready) ?? false);
  }

  async terminalizeDispatch(
    grant: CredentialDispatchResult,
    state: 'completed' | 'failed' | 'ambiguous',
  ): Promise<boolean> {
    return executionDispatchLeaseRepository.terminalize({
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
    dispatchProof?: DispatchLeaseProof;
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
      return markCredentialRequestBoundary(
        { success: false, error: `Google OAuth refresh failed: HTTP ${response.status} ${body}` }, true,
      );
    }

    const payload = await response.json() as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };

    if (!payload.access_token) {
      return markCredentialRequestBoundary(
        { success: false, error: 'Google OAuth refresh response did not include an access token.' }, true,
      );
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
          dispatchProof: input.dispatchProof,
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
          dispatchProof: input.dispatchProof,
        });

    if (!saved) {
      return markCredentialRequestBoundary({
        success: false,
        error: 'OAuth credential changed or disconnected while refresh was in flight. Reconnect and retry.',
      }, true);
    }
    return markCredentialRequestBoundary({
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
    }, true);
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
      return markCredentialRequestBoundary(
        { success: false, error: 'Google OAuth client credentials are not configured.' }, false,
      );
    }

    return { success: true, clientId, clientSecret };
  }
}

export class NoopCredentialProvider implements CredentialProvider {
  async getAccessToken(_userId: string, provider: string): Promise<CredentialOutcome> {
    return markCredentialRequestBoundary(
      { success: false, error: `No credential provider configured for ${provider}.` }, false,
    );
  }


  async startDispatch(input: CredentialDispatchInput): Promise<CredentialDispatchOutcome> {
    return markCredentialRequestBoundary(
      { success: false, error: `No credential provider configured for ${input.provider}.` }, false,
    );
  }

  async terminalizeDispatch(
    _grant: CredentialDispatchResult,
    _state: 'completed' | 'failed' | 'ambiguous',
  ): Promise<boolean> {
    return false;
  }
}
