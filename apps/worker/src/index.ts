import { loadConfig } from '@skytwin/config';
import { RealIronClawAdapter } from '@skytwin/ironclaw-adapter';
import type { SignalConnector, RawSignal } from '@skytwin/connectors';
import {
  GmailConnector,
  GoogleCalendarConnector,
  DbTokenStore,
  OAuthRefreshError,
  type CursorStore,
  type LabelObserver,
  type GoogleOAuthConfig,
} from '@skytwin/connectors';
import {
  connectorCursorRepository,
  connectorHealthRepository,
  emailLabelRepository,
  forwardedSignalsRepository,
  oauthRepository,
  approvalRepository,
  ironClawToolRepository,
  serviceCredentialRepository,
  accessLogRepository,
} from '@skytwin/db';
import { withRetry, RetryableHttpError, CircuitBreaker, createLogger } from '@skytwin/core';
import { KeyCache } from '@skytwin/credential-vault';
import { SignalDeduper, DEFAULT_TTL_MS } from './signal-dedupe.js';
import { createPruneThrottle } from './label-signal-pruner.js';
import { runMetricsRollupJob } from './jobs/metrics-rollup.js';
import { runChangelogPollJob } from './jobs/changelog-poll.js';
import { runDomainExtractionJob } from './jobs/domain-extraction.js';
import { runFederationSyncJob } from './jobs/federation-sync.js';
import { runEmbeddingBackfillJob } from './jobs/embedding-backfill.js';
import { runTierBackfillJob } from './jobs/tier-backfill.js';
import { runRelationshipTierBackfillBatch } from './jobs/relationship-tier-scheduler.js';
import { runBriefingGeneratorJob } from './jobs/briefing-generator.js';
import { runPromotionEligibilityCheckJob } from './jobs/promotion-eligibility-check.js';
import { extractErrorCode } from './oauth-error-code.js';

const config = loadConfig();
const log = createLogger('worker');

/** Per-user circuit breakers to skip users with persistent failures. */
const userCircuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Worker-local KeyCache. Wired into every DbTokenStore the worker creates so
 * the read path can decrypt at-rest tokens AND the lazy-migration path can
 * fire (without setKeyCache, plaintext-token rows never get encrypted —
 * the at-rest encryption feature is dead weight).
 *
 * Cross-process unlock IPC is not yet implemented (see #212 follow-up): the
 * API process unlocks via passphrase but the worker process doesn't see that
 * derived key. Until that lands, this cache is empty and the worker behaves
 * exactly as it did before — plaintext tokens flow through, encrypted-only
 * rows surface as `credentials unavailable`. The wiring below ensures that
 * once IPC lands, the worker's DbTokenStore instances will decrypt and
 * lazy-migrate without any further code change.
 */
const workerKeyCache = new KeyCache({ ttlMs: 60 * 60 * 1000 });

/**
 * Persistent cursor for Gmail's History API. Survives worker restarts so
 * the connector polls deltas (`history.list?startHistoryId=…`) instead of
 * re-listing the inbox on every cycle.
 */
const gmailCursorStore: CursorStore = {
  async get(userId, provider, kind) {
    const row = await connectorCursorRepository.get(userId, provider, kind);
    return row?.cursor_value ?? null;
  },
  async save(userId, provider, kind, value) {
    await connectorCursorRepository.save(userId, provider, kind, value);
  },
};

/**
 * Sink for the per-user (sender, label) evidence the Gmail connector mines
 * from each fetched message. Issue #122 — wires the connector to
 * `email_label_signals`, which the decision-engine reads via
 * `LabelInferencePort` when proposing `label_email` candidates.
 */
const gmailLabelObserver: LabelObserver = {
  async recordObservations(userId, observations) {
    await emailLabelRepository.recordObservations(userId, observations);
  },
};

/**
 * Throttled per-user prune for `email_label_signals`. Issue #122 follow-up —
 * the table grows unbounded otherwise. Runs at most once per 24h per user
 * from the polling loop. Defaults: drop rows past 180-day TTL with count<3,
 * then enforce a 5000-row hard cap per user (defense vs. adversarial sender
 * cardinality). Errors are logged but never propagate — staying tidy is
 * best-effort, signal ingestion is not.
 */
const pruneLabelSignalsForUser = createPruneThrottle(
  async (userId) => {
    const result = await emailLabelRepository.pruneStaleSignals(userId);
    const total = result.deletedStale + result.deletedOverCap;
    if (total > 0) {
      log.info(`Pruned ${total} email_label_signals rows for user ${userId}`, {
        deletedStale: result.deletedStale,
        deletedOverCap: result.deletedOverCap,
      });
    }
    return total;
  },
  (userId, err) => {
    log.warn(`email_label_signals prune failed for user ${userId}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  },
);

/**
 * Dedup state survives restarts via forwarded_signals: the in-memory map
 * is hydrated at startup from the persistent ledger, and every mark()
 * write-throughs back to the table. Without this, `tsx watch` reloads
 * (or any worker crash/restart) cause every still-matching gmail thread
 * to re-emit and create duplicate approvals downstream — see #102.
 */
const signalDeduper = new SignalDeduper({
  persistence: {
    async mark(userId: string, signalKey: string): Promise<void> {
      await forwardedSignalsRepository.mark(userId, signalKey);
    },
  },
  onPersistenceError: (err, userId, signalKey) => {
    log.warn('Failed to persist signal dedupe entry', {
      userId,
      signalKey,
      error: err instanceof Error ? err.message : String(err),
    });
  },
});

function getCircuitBreaker(userId: string): CircuitBreaker {
  let breaker = userCircuitBreakers.get(userId);
  if (!breaker) {
    breaker = new CircuitBreaker(`user:${userId}`, {
      failureThreshold: 3,
      resetTimeoutMs: 300_000,   // 5 minutes
      backoffMultiplier: 2,
      maxResetTimeoutMs: 1_200_000, // 20 minutes
    });
    userCircuitBreakers.set(userId, breaker);
  }
  return breaker;
}

/**
 * SkyTwin Worker Process
 *
 * Polls signal connectors for new data and forwards signals to the
 * API for processing through the decision pipeline.
 *
 * Supports multiple users: for each user with active OAuth tokens,
 * the worker polls their connected services.
 */

let running = true;
let lastIronClawToolRefreshAt = 0;
const IRONCLAW_TOOL_REFRESH_MS = 15 * 60 * 1000;

interface UserConnectors {
  userId: string;
  connectors: SignalConnector[];
}

/**
 * Forward a signal to the API for processing, with retry on transient failures.
 */
async function forwardSignalToApi(signal: RawSignal, userId: string): Promise<void> {
  const url = `${config.apiBaseUrl}/api/events/ingest`;
  const body = JSON.stringify({
    ...signal.data,
    source: signal.source,
    type: signal.type,
    signalId: signal.id,
    userId,
  });

  await withRetry(async () => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!resp.ok) {
      if ([429, 500, 502, 503].includes(resp.status)) {
        throw new RetryableHttpError(resp.status, `API ingest failed: ${resp.status}`, null);
      }
      throw new Error(`API ingest failed: ${resp.status}`);
    }

    return resp;
  }, { maxRetries: 2, baseDelayMs: 500 });

  log.info(`Forwarded signal ${signal.id} (${signal.source}/${signal.type}) for user ${userId}`);
}

function hasForwardedSignal(signal: RawSignal, userId: string): boolean {
  return signalDeduper.has(signal, userId);
}

function markSignalForwarded(signal: RawSignal, userId: string): void {
  signalDeduper.mark(signal, userId);
}

/**
 * Poll connectors for a single user, guarded by per-user circuit breaker.
 */
async function pollUser(userConnectors: UserConnectors): Promise<void> {
  const breaker = getCircuitBreaker(userConnectors.userId);

  if (!breaker.canExecute()) {
    log.warn(`Skipping user ${userConnectors.userId} — circuit open, retry in ${Math.round(breaker.getTimeUntilRetryMs() / 1000)}s`, {
      retryInMs: breaker.getTimeUntilRetryMs(),
    });
    return;
  }

  let hadFailure = false;

  for (const connector of userConnectors.connectors) {
    // Per-connector flag so the heal at the bottom of this iteration
    // reflects THIS connector's outcome, not the loop-wide state. A
    // failing Gmail must not block the success heal for a working
    // Calendar (#377).
    let thisConnectorFailed = false;
    try {
      const signals = await connector.poll();
      for (const signal of signals) {
        if (hasForwardedSignal(signal, userConnectors.userId)) {
          continue;
        }
        await forwardSignalToApi(signal, userConnectors.userId);
        markSignalForwarded(signal, userConnectors.userId);
      }
    } catch (error) {
      hadFailure = true;
      thisConnectorFailed = true;

      if (error instanceof OAuthRefreshError && error.permanent) {
        log.error(`Permanent OAuth failure for user ${userConnectors.userId} on ${connector.name} — user must re-authorize`, {
          error: error.message,
          statusCode: error.statusCode,
        });
        // Record the needs-reauth state so the dashboard banner can
        // surface it (#377). Best-effort: a DB write failure here
        // must not break the existing circuit-breaker logic — the
        // worker continues either way; the log line is still the
        // operator's audit trail.
        try {
          await connectorHealthRepository.upsert({
            userId: userConnectors.userId,
            connectorName: connector.name,
            status: 'needs_reauth',
            errorCode: extractErrorCode(error.message) ?? 'invalid_grant',
            lastFailureAt: new Date(),
          });
        } catch (writeErr) {
          log.warn('connector_health upsert failed (needs_reauth) — continuing', {
            userId: userConnectors.userId,
            connector: connector.name,
            error: writeErr instanceof Error ? writeErr.message : String(writeErr),
          });
        }
        // Force-open circuit immediately — no point retrying a revoked token.
        // Stop once breaker transitions to open to avoid extending backoff.
        for (let i = 0; i < 3 && breaker.canExecute(); i++) {
          breaker.recordFailure();
        }
        return;
      }

      log.error(`Error polling ${connector.name} for user ${userConnectors.userId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Per-connector success heals the row (#377). Keyed on
    // thisConnectorFailed (not the loop-wide hadFailure) so a working
    // Calendar isn't stuck in 'needs_reauth' because Gmail failed in
    // the same cycle.
    if (!thisConnectorFailed) {
      try {
        await connectorHealthRepository.upsert({
          userId: userConnectors.userId,
          connectorName: connector.name,
          status: 'connected',
          errorCode: null,
          lastSuccessAt: new Date(),
        });
      } catch (writeErr) {
        log.warn('connector_health upsert failed (connected) — continuing', {
          userId: userConnectors.userId,
          connector: connector.name,
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
    }
  }

  if (hadFailure) {
    breaker.recordFailure();
  } else {
    breaker.recordSuccess();
  }

  // Opportunistic email_label_signals prune. Throttled internally to once
  // per 24h per user. Runs after the poll so it doesn't delay signal
  // forwarding; errors can't propagate (the throttle swallows them).
  await pruneLabelSignalsForUser(userConnectors.userId);
}

async function resolveGoogleConfig(): Promise<GoogleOAuthConfig | null> {
  let clientId = config.googleClientId;
  let clientSecret = config.googleClientSecret;
  let redirectUri = config.googleRedirectUri;

  // Layer 1: env/DB credentials (confidential web-server deployments).
  // clientSecret may be empty here — that's fine; we accept the PKCE-only
  // shape below.
  if (!clientId) {
    try {
      const dbCreds = await serviceCredentialRepository.getAsMap('google');
      clientId = clientId || dbCreds['client_id'] || '';
      clientSecret = clientSecret || dbCreds['client_secret'] || '';
      if (dbCreds['redirect_uri'] && redirectUri === 'http://localhost:3100/api/oauth/google/callback') {
        redirectUri = dbCreds['redirect_uri'];
      }
    } catch (error) {
      log.warn('Could not load Google OAuth credentials from DB', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Layer 2: bundled PKCE-only fallback (desktop installer default). Mirrors
  // apps/api/src/routes/oauth.ts:resolveGoogleConfig() so the worker can
  // refresh tokens minted by the bundled-client OAuth flow. PKCE refresh
  // omits client_secret entirely (verified in packages/connectors/src/oauth/
  // google-oauth.ts:refreshAccessToken — empty clientSecret is the PKCE
  // signal). Without this fallback, the grandma-grade default install
  // signs the user in (API has the bundled id) but the worker can't read
  // their inbox/calendar — tokens exist, nothing processes them.
  if (!clientId) {
    const bundled = process.env['SKYTWIN_DEFAULT_GOOGLE_CLIENT_ID'] ?? '';
    if (bundled) {
      clientId = bundled;
      clientSecret = '';
    }
  }

  if (!clientId) {
    log.warn('Google OAuth tokens exist, but no Google client ID is configured (env/DB/bundle all empty); skipping Google connectors');
    return null;
  }

  return { clientId, clientSecret, redirectUri };
}

async function connectUserConnectors(discovered: UserConnectors[]): Promise<UserConnectors[]> {
  const connectedUsers: UserConnectors[] = [];

  for (const uc of discovered) {
    const breaker = getCircuitBreaker(uc.userId);
    if (!breaker.canExecute()) {
      log.warn(`Skipping connector startup for user ${uc.userId} — circuit open, retry in ${Math.round(breaker.getTimeUntilRetryMs() / 1000)}s`, {
        retryInMs: breaker.getTimeUntilRetryMs(),
      });
      continue;
    }

    const connected: SignalConnector[] = [];
    for (const connector of uc.connectors) {
      try {
        await connector.connect();
        connected.push(connector);
        log.info(`Connected: ${connector.name} for user ${uc.userId}`);
      } catch (error) {
        if (error instanceof OAuthRefreshError && error.permanent) {
          log.error(`Permanent OAuth failure for user ${uc.userId} on ${connector.name} — user must re-authorize`, {
            error: error.message,
            statusCode: error.statusCode,
          });
          for (let i = 0; i < 3 && breaker.canExecute(); i++) {
            breaker.recordFailure();
          }
          break;
        }

        log.error(`Error connecting ${connector.name} for user ${uc.userId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        breaker.recordFailure();
      }
    }

    if (connected.length > 0) {
      connectedUsers.push({ userId: uc.userId, connectors: connected });
      breaker.recordSuccess();
    }
  }

  return connectedUsers;
}

/**
 * Discover users with active OAuth tokens and build their connectors.
 * Returns empty array if no users have connected accounts yet.
 */
async function discoverUsers(): Promise<UserConnectors[]> {
  try {
    const tokens = await oauthRepository.getUsersWithActiveTokens();
    if (tokens.length === 0) {
      return [];
    }

    // Group tokens by user
    const userTokens = new Map<string, typeof tokens>();
    for (const token of tokens) {
      const existing = userTokens.get(token.user_id) ?? [];
      existing.push(token);
      userTokens.set(token.user_id, existing);
    }

    let googleConfig: GoogleOAuthConfig | null | undefined;
    const result: UserConnectors[] = [];
    for (const [userId, userTokenList] of userTokens) {
      const connectors: SignalConnector[] = [];
      const hasGoogle = userTokenList.some((t) => t.provider === 'google');

      if (hasGoogle) {
        if (googleConfig === undefined) {
          googleConfig = await resolveGoogleConfig();
        }
        if (googleConfig) {
          const tokenStore = new DbTokenStore(oauthRepository, googleConfig);
          tokenStore.setKeyCache(workerKeyCache);
          // Audit-log every credential-vault decryption (#393). The
          // sink writes to access_log with actor='worker'; failures
          // are swallowed and logged at the call site so a CRDB blip
          // doesn't block legitimate OAuth refreshes.
          tokenStore.setAuditLog(
            { recordAccess: (input) => accessLogRepository.record(input) },
            'worker',
          );
          connectors.push(new GmailConnector(userId, tokenStore, gmailCursorStore, gmailLabelObserver));
          connectors.push(new GoogleCalendarConnector(userId, tokenStore, gmailCursorStore));
        }
      }

      if (connectors.length > 0) {
        result.push({ userId, connectors });
      }
    }

    return result;
  } catch (error) {
    log.error('Error discovering users', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// Worker runs in a separate process from the API, so it needs its own IronClaw adapter
// with independent circuit breaker state. This is intentional — the worker's view of
// IronClaw health should reflect the worker's own request patterns, not the API's.
let workerIronClawAdapter: RealIronClawAdapter | null = null;
function getWorkerIronClawAdapter(): RealIronClawAdapter {
  if (!workerIronClawAdapter) {
    workerIronClawAdapter = new RealIronClawAdapter({
      apiUrl: config.ironclawApiUrl!,
      webhookSecret: config.ironclawWebhookSecret!,
      gatewayToken: config.ironclawGatewayToken,
      ownerId: config.ironclawOwnerId,
      defaultChannel: config.ironclawDefaultChannel,
      preferChatCompletions: config.ironclawPreferChat,
    });
  }
  return workerIronClawAdapter;
}

async function refreshIronClawToolsIfDue(force = false): Promise<void> {
  if (!config.ironclawApiUrl || !config.ironclawWebhookSecret) return;
  const now = Date.now();
  if (!force && now - lastIronClawToolRefreshAt < IRONCLAW_TOOL_REFRESH_MS) return;
  lastIronClawToolRefreshAt = now;

  try {
    const adapter = getWorkerIronClawAdapter();
    const tools = await adapter.discoverTools();
    if (tools.length === 0) return;

    await ironClawToolRepository.upsertMany(tools.map((tool) => ({
      toolName: tool.name,
      description: tool.description,
      actionTypes: tool.actionTypes,
      requiresCredentials: tool.requiresCredentials,
    })));
    log.info(`Refreshed ${tools.length} IronClaw tool manifest(s)`);
  } catch (error) {
    log.warn('IronClaw tool refresh failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Main worker loop.
 */
async function main(): Promise<void> {
  log.info('Starting SkyTwin worker...');
  log.info(`API base URL: ${config.apiBaseUrl}`);
  log.info(`Poll interval: ${config.workerPollIntervalMs}ms`);

  // Hydrate the dedup window from the persistent ledger before we start
  // polling, so already-forwarded signals are recognised on the very first
  // poll after a restart. Failures are non-fatal: the worker can still run,
  // it'll just have its previous behaviour of re-emitting on reload.
  try {
    const rows = await forwardedSignalsRepository.listSince(DEFAULT_TTL_MS);
    signalDeduper.hydrate(
      rows.map((r) => ({
        userId: r.user_id,
        signalKey: r.signal_key,
        forwardedAt: r.forwarded_at,
      })),
    );
    log.info(`Hydrated dedupe ledger: ${rows.length} entries`);

    // Best-effort GC of expired rows so the table doesn't grow unbounded.
    const removed = await forwardedSignalsRepository.gcOlderThan(DEFAULT_TTL_MS);
    if (removed > 0) log.info(`GC'd ${removed} expired forwarded_signals rows`);
  } catch (error) {
    log.warn('Could not hydrate dedupe ledger — proceeding with empty state', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Detect startup hangs (discoverUsers or connect hanging on a broken DB/network)
  const startupTimer = setTimeout(() => {
    log.error('Worker startup timed out after 30s — possible hang in discoverUsers() or connect()');
    process.exit(1);
  }, 30_000);
  startupTimer.unref();

  // Discover users and set up connectors
  let userConnectors = await connectUserConnectors(await discoverUsers());
  if (userConnectors.length === 0) {
    log.info('No users with connected accounts yet — waiting for first connection');
  } else {
    log.info(`Tracking ${userConnectors.length} user(s)`);
  }
  await refreshIronClawToolsIfDue(true);

  clearTimeout(startupTimer);
  let pollCount = 0;
  let lastMetricsRollupAt = 0;
  const METRICS_ROLLUP_INTERVAL_MS = 60_000;
  let lastChangelogPollAt = 0;
  const CHANGELOG_POLL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  let lastDomainExtractionAt = 0;
  const DOMAIN_EXTRACTION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (#193 Child 1)
  let lastFederationSyncAt = 0;
  const FEDERATION_SYNC_INTERVAL_MS = 60 * 60 * 1000; // hourly (#194 Child 1)
  let lastEmbeddingBackfillAt = 0;
  // Drain the brain_embedding_jobs queue every 30 seconds (#197). The job is
  // backed by SELECT FOR UPDATE SKIP LOCKED so it's safe to run from
  // multiple worker instances simultaneously.
  const EMBEDDING_BACKFILL_INTERVAL_MS = 30_000;

  let lastTierBackfillAt = 0;
  // Backfill `metadata.authoringTier` on pages that predate Layer 1 of
  // #251. Hourly cadence is plenty — the find query is `metadata->>'authoringTier'
  // IS NULL` so once the corpus is fully tagged the worker becomes a no-op.
  // Batch size keeps each pass bounded; multiple passes converge the corpus
  // over a few hours for a heavy mailbox.
  const TIER_BACKFILL_INTERVAL_MS = 60 * 60 * 1000;

  let lastRelationshipTierBackfillAt = 0;
  // #282: the daily relationship-tier backfill no longer runs INSIDE the
  // poll loop's await chain. The poll loop only kicks off a batch (a
  // separate scheduler with bounded concurrency + per-user timeout —
  // see `relationship-tier-scheduler.ts`) and continues immediately.
  // `relationshipTierBackfillInFlight` is a single-flight guard so a
  // long-running batch (e.g. a cold-start pass on dozens of heavy
  // mailboxes) doesn't get a second batch stacked on top before the
  // first finishes. The 24h cadence is preserved at minimum; once the
  // pass is fast enough the trigger can be tightened.
  const RELATIONSHIP_TIER_BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;
  let relationshipTierBackfillInFlight = false;

  // #304: briefing-generator wiring (daily + weekly). Same fire-and-
  // forget + single-flight + revert-on-failure pattern as the
  // relationship-tier backfill above.
  //
  // Cadences are intervals since the last START, not UTC-day buckets:
  // a worker restart resets the interval, which on rapid restart can
  // cause one extra briefing per cadence. Briefings are persisted via
  // `briefingRepository.create` without an ON CONFLICT guard, so the
  // duplicate can land. For v1 this is acceptable (briefings are
  // user-visible read-only artifacts; an extra one is mild noise);
  // a follow-up should add per-UTC-day idempotency to make the job
  // restart-safe.
  //
  // #310: promotion-eligibility-check is now wired. The job no longer
  // depends on an injected SSE emitter — instead it writes pending
  // offers to `promotion_offers`, which the API serves to the
  // dashboard via polling (and may opportunistically SSE-emit for live
  // connections). The worker→API bridge is the durable DB table; no
  // direct IPC needed.
  let lastBriefingDailyAt = 0;
  const BRIEFING_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
  let briefingDailyInFlight = false;

  let lastBriefingWeeklyAt = 0;
  const BRIEFING_WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
  let briefingWeeklyInFlight = false;

  // #310: promotion-eligibility-check on a 24h cadence. Same fire-and-
  // forget + single-flight + revert-on-failure pattern as the briefing
  // generator. The job is idempotent — its writes go through the
  // ON CONFLICT-guarded `promotionOffersRepository.createIfPending`,
  // so even concurrent ticks (worker rapidly restarted) can't produce
  // duplicate pending offers for the same (server, proposed_tier).
  let lastPromotionEligibilityAt = 0;
  const PROMOTION_ELIGIBILITY_INTERVAL_MS = 24 * 60 * 60 * 1000;
  let promotionEligibilityInFlight = false;

  // Poll loop
  while (running) {
    for (const uc of userConnectors) {
      await pollUser(uc);
    }

    pollCount++;

    // Drain in-memory metrics buffer to DB at most once per minute (#183).
    const nowMs = Date.now();
    if (nowMs - lastMetricsRollupAt >= METRICS_ROLLUP_INTERVAL_MS) {
      await runMetricsRollupJob();
      lastMetricsRollupAt = nowMs;
    }

    // Sweep MCP server changelogs weekly (#184 AC#2).
    // Individual server errors are caught inside the job — never propagate here.
    if (nowMs - lastChangelogPollAt >= CHANGELOG_POLL_INTERVAL_MS) {
      await runChangelogPollJob().catch((err) => {
        log.warn('Changelog poll job failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      lastChangelogPollAt = nowMs;
    }

    // Re-extract life domains weekly (#193 Child 1). The job no-ops when no
    // LlmClient is available — extraction is LLM-dependent. Per-user errors
    // are absorbed inside the job.
    if (nowMs - lastDomainExtractionAt >= DOMAIN_EXTRACTION_INTERVAL_MS) {
      await runDomainExtractionJob().catch((err) => {
        log.warn('Domain extraction job failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      lastDomainExtractionAt = nowMs;
    }

    // Push federation deltas to active peers hourly (#194 Child 1).
    if (nowMs - lastFederationSyncAt >= FEDERATION_SYNC_INTERVAL_MS) {
      await runFederationSyncJob().catch((err) => {
        log.warn('Federation sync job failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      lastFederationSyncAt = nowMs;
    }

    // Drain the brain_embedding_jobs queue every 30s (#197). The write path
    // queues jobs when synchronous embedding fails (rate limit, network);
    // this catches them up. SELECT FOR UPDATE SKIP LOCKED makes it safe
    // under multiple worker instances.
    if (nowMs - lastEmbeddingBackfillAt >= EMBEDDING_BACKFILL_INTERVAL_MS) {
      await runEmbeddingBackfillJob().catch((err) => {
        log.warn('Embedding backfill job failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      lastEmbeddingBackfillAt = nowMs;
    }

    // Backfill authoringTier on pre-Layer-1 pages (#251 follow-up).
    // Hourly; converges to no-op once the corpus is fully tagged.
    if (nowMs - lastTierBackfillAt >= TIER_BACKFILL_INTERVAL_MS) {
      await runTierBackfillJob().catch((err) => {
        log.warn('Tier backfill job failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      lastTierBackfillAt = nowMs;
    }

    // #282: kick off a daily relationship-tier backfill batch when one
    // is not already running and 24h has elapsed since the last START
    // (not since the last completion — a batch that took a long time
    // does not delay the next cycle by its own duration). The batch
    // runs with bounded concurrency + per-user timeout via
    // `runRelationshipTierBackfillBatch`; the poll loop does NOT await
    // it, so signal ingestion is never delayed by backfill work.
    //
    // On a scheduler-level failure (the helper itself rejects — distinct
    // from per-user errors, which it catches internally) we revert
    // `lastRelationshipTierBackfillAt` so the next poll cycle re-attempts
    // immediately instead of waiting another 24h. A successful batch
    // (even with per-user failures inside it) keeps the timestamp so
    // the cadence stays at one batch / 24h.
    if (
      !relationshipTierBackfillInFlight &&
      nowMs - lastRelationshipTierBackfillAt >= RELATIONSHIP_TIER_BACKFILL_INTERVAL_MS
    ) {
      relationshipTierBackfillInFlight = true;
      const previousLastAt = lastRelationshipTierBackfillAt;
      lastRelationshipTierBackfillAt = nowMs;
      const userIds = userConnectors.map((uc) => uc.userId);
      void runRelationshipTierBackfillBatch(userIds)
        .then((batchSummary) => {
          log.info('Relationship-tier backfill batch complete', {
            users: userIds.length,
            ...batchSummary,
          });
        })
        .catch((err) => {
          // Scheduler-level failure (per-user errors are caught inside
          // the batch helper). Revert the timestamp so the next cycle
          // retries immediately rather than waiting another 24h.
          log.warn('Relationship-tier backfill batch failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          lastRelationshipTierBackfillAt = previousLastAt;
        })
        .finally(() => {
          relationshipTierBackfillInFlight = false;
        });
    }

    // #304: briefing generation, daily and weekly. Two independent
    // single-flight guards because the cadences are different and a
    // long daily pass shouldn't block the weekly pass (or vice versa).
    // `llmClient` is left undefined — the briefing-prose prompt path
    // requires per-user LLM client setup that lives in the API
    // (events.ts route). The deterministic Markdown template fallback
    // runs without an LLM client and is good enough for v1; the
    // adaptive-prose path can be wired once a worker-side LLM-per-user
    // path lands (separate follow-up).
    if (
      !briefingDailyInFlight &&
      nowMs - lastBriefingDailyAt >= BRIEFING_DAILY_INTERVAL_MS
    ) {
      briefingDailyInFlight = true;
      const previousLastAt = lastBriefingDailyAt;
      lastBriefingDailyAt = nowMs;
      void runBriefingGeneratorJob({ cadence: 'daily' })
        .catch((err) => {
          log.warn('Daily briefing generator failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          lastBriefingDailyAt = previousLastAt;
        })
        .finally(() => {
          briefingDailyInFlight = false;
        });
    }

    if (
      !briefingWeeklyInFlight &&
      nowMs - lastBriefingWeeklyAt >= BRIEFING_WEEKLY_INTERVAL_MS
    ) {
      briefingWeeklyInFlight = true;
      const previousLastAt = lastBriefingWeeklyAt;
      lastBriefingWeeklyAt = nowMs;
      void runBriefingGeneratorJob({ cadence: 'weekly' })
        .catch((err) => {
          log.warn('Weekly briefing generator failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          lastBriefingWeeklyAt = previousLastAt;
        })
        .finally(() => {
          briefingWeeklyInFlight = false;
        });
    }

    // #310: promotion-eligibility check, daily. Idempotent — writes
    // are dedup'd by the partial unique index on (server_id,
    // proposed_tier) WHERE responded_at IS NULL, so a re-run during
    // the same window adds no new rows. Revert-on-failure keeps the
    // cadence tight when a transient DB error stops a tick.
    if (
      !promotionEligibilityInFlight &&
      nowMs - lastPromotionEligibilityAt >= PROMOTION_ELIGIBILITY_INTERVAL_MS
    ) {
      promotionEligibilityInFlight = true;
      const previousLastAt = lastPromotionEligibilityAt;
      lastPromotionEligibilityAt = nowMs;
      void runPromotionEligibilityCheckJob()
        .then((summary) => {
          if (summary.offered > 0 || summary.alreadyPending > 0) {
            log.info('Promotion eligibility tick complete', { ...summary });
          }
        })
        .catch((err) => {
          log.warn('Promotion eligibility check failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          lastPromotionEligibilityAt = previousLastAt;
        })
        .finally(() => {
          promotionEligibilityInFlight = false;
        });
    }

    // Expire stale approval requests every 10 poll cycles
    if (pollCount % 10 === 0) {
      try {
        const expired = await approvalRepository.expirePending();
        if (expired > 0) {
          console.info(`[worker] Expired ${expired} stale approval request(s)`);
        }
      } catch (error) {
        console.error(
          '[worker] Error expiring approvals:',
          error instanceof Error ? error.message : error,
        );
      }
      // Clean up expired escalations — separate try/catch so expiry failures
      // don't block cleanup and vice versa
      for (const uc of userConnectors) {
        try {
          const cleaned = await approvalRepository.deleteStaleEscalations(uc.userId);
          if (cleaned > 0) {
            console.info(`[worker] Cleaned ${cleaned} stale escalation(s) for user ${uc.userId}`);
          }
        } catch (error) {
          console.error(
            `[worker] Error cleaning stale escalations for user ${uc.userId}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }

    // Re-discover users every 10 poll cycles to pick up new connections.
    // When no users are tracked yet, check every cycle so first-time
    // connections are picked up within one poll interval (~10s).
    if (userConnectors.length === 0 || pollCount % 10 === 0) {
      const newUserConnectors = await connectUserConnectors(await discoverUsers());
      const oldUserIds = new Set(userConnectors.map((uc) => uc.userId));
      const newUserIds = new Set(newUserConnectors.map((uc) => uc.userId));
      const usersChanged = oldUserIds.size !== newUserIds.size
        || [...oldUserIds].some((id) => !newUserIds.has(id));
      if (usersChanged) {
        log.info(`User set changed: ${[...oldUserIds].join(',')} → ${[...newUserIds].join(',')}`);
        // Disconnect old connectors
        for (const uc of userConnectors) {
          for (const connector of uc.connectors) {
            await connector.disconnect();
          }
        }
        userConnectors = newUserConnectors;

        // Prune circuit breakers and signal dedupe maps for users no longer tracked
        for (const userId of userCircuitBreakers.keys()) {
          if (!newUserIds.has(userId)) {
            userCircuitBreakers.delete(userId);
          }
        }
        signalDeduper.pruneUsers(newUserIds);
      }
    }

    await refreshIronClawToolsIfDue();

    await new Promise((resolve) => setTimeout(resolve, config.workerPollIntervalMs));
  }

  // Graceful shutdown
  log.info('Shutting down...');
  for (const uc of userConnectors) {
    for (const connector of uc.connectors) {
      await connector.disconnect();
      log.info(`Disconnected: ${connector.name} for user ${uc.userId}`);
    }
  }
  log.info('Worker stopped.');
}

// Graceful shutdown handlers
process.on('SIGINT', () => {
  log.info('Received SIGINT, shutting down gracefully...');
  running = false;
});

process.on('SIGTERM', () => {
  log.info('Received SIGTERM, shutting down gracefully...');
  running = false;
});

// Start the worker
void main().catch((error) => {
  log.error('Fatal error', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
