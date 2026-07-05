import express, { type Application } from 'express';
import { loadConfig, validate } from '@skytwin/config';
import { createLogger } from '@skytwin/core';
import { assertSessionSecret } from './startup-assertions.js';

const log = createLogger('api');
import { createEventsRouter } from './routes/events.js';
import { createTwinRouter } from './routes/twin.js';
import { createDecisionsRouter } from './routes/decisions.js';
import { createApprovalsRouter } from './routes/approvals.js';
import { createFeedbackRouter } from './routes/feedback.js';
import { createOAuthRouter } from './routes/oauth.js';
import { createEvalsRouter } from './routes/evals.js';
import { createUsersRouter } from './routes/users.js';
import { createProposalsRouter } from './routes/proposals.js';
import { createAskRouter } from './routes/ask.js';
import { createBriefingsRouter } from './routes/briefings.js';
import { createLifebooksRouter } from './routes/lifebooks.js';
import { createSkillGapsRouter } from './routes/skill-gaps.js';
import { createSettingsRouter } from './routes/settings.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createAuditRouter } from './routes/audit.js';
import { sessionAuth } from './middleware/session-auth.js';
import { requireOwnership } from './middleware/require-ownership.js';
import { requestContext } from './middleware/request-context.js';
import { createPoliciesRouter } from './routes/policies.js';
import { createActivityRouter } from './routes/activity.js';
import { createMempalaceRouter } from './routes/mempalace.js';
import { createMemoryConfigRouter } from './routes/memory-config.js';
import { createAssistantRouter } from './routes/assistant.js';
import { createSearchRouter } from './routes/search.js';
import { createCredentialsRouter } from './routes/credentials.js';
import { createRoutinesRouter } from './routes/routines.js';
import { createDemoRouter } from './routes/demo.js';
import { createSystemRouter } from './routes/system.js';
import { createCapabilitiesRouter } from './routes/capabilities.js';
import { createRiskProfileRouter } from './routes/risk-profile.js';
import { createAboutMeRouter } from './routes/about-me.js';
import { createTwinBriefingsRouter } from './routes/twin-briefings.js';
import { createOnboardingRouter } from './routes/onboarding.js';
import { createExternalAgentsRouter } from './routes/external-agents.js';
import { createCredentialVaultRouter } from './routes/credential-vault.js';
import { createDxtRouter } from './routes/dxt.js';
import { createFederationRouter } from './routes/federation.js';
import { createVoiceRouter } from './routes/voice.js';
import { createCrisisModesRouter } from './routes/crisis-modes.js';
import { createConnectorsRouter } from './routes/connectors.js';
import { createAdminDlqRouter } from './routes/admin-dlq.js';
import { createEmbeddedLlmRouter } from './routes/embedded-llm.js';
import {
  createPromotionOffersRouter,
  startPromotionOffersSweeper,
  stopPromotionOffersSweeper,
} from './routes/promotion-offers.js';
import { recoverOnBoot as recoverEmbeddedLlmDownloads } from './embedded-llm/downloader.js';
import { getExecutionRouter } from './execution-setup.js';
import { startMdnsAdvertisement, stopMdnsAdvertisement } from './mdns.js';
import { closePool, mcpServerMetricsRepository } from '@skytwin/db';
import { MetricsRollupService, sharedMetricsCollector } from '@skytwin/observability';

const config = loadConfig();

// SESSION_SECRET is the HMAC key for bearer-token hashing AND for OAuth
// state signatures (see apps/api/src/routes/oauth.ts). Both fall back to
// the literal `'skytwin-dev-secret'` if unset, which is fine in dev but
// a security hole anywhere else — the default is in the open-source code.
// See startup-assertions.ts for the policy and unit tests.
{
  const result = assertSessionSecret({
    nodeEnv: config.nodeEnv,
    sessionSecret: process.env['SESSION_SECRET'],
  });
  if (!result.ok && result.fatal) {
    log.error(`Fatal: ${result.message}`);
    process.exit(1);
  }
}

// Validate config on startup
const configErrors = validate(config);
if (configErrors.length > 0) {
  const criticalFields = new Set(['databaseUrl', 'apiPort', 'nodeEnv']);
  const criticalErrors = configErrors.filter((e) => criticalFields.has(e.field));
  const warningErrors = configErrors.filter((e) => !criticalFields.has(e.field));
  const messages = configErrors.map((e) => `  - ${e.field}: ${e.message}`).join('\n');

  if (criticalErrors.length > 0) {
    log.error(`Fatal: invalid configuration:\n${messages}`);
    process.exit(1);
  } else if (config.nodeEnv === 'production') {
    log.error(`Fatal: invalid configuration:\n${messages}`);
    process.exit(1);
  } else if (warningErrors.length > 0) {
    log.warn(`Configuration warnings (non-fatal in development):\n${messages}`);
  }
}

// Initialize the execution router early to log adapter registration
getExecutionRouter().catch((err) =>
  log.error('Failed to initialize execution router', {
    error: err instanceof Error ? err.message : String(err),
  }),
);

// Boot-time recovery for orphaned model downloads (#187 AC#2). Any row
// stuck in 'downloading' from a prior process flips to 'paused' so the
// user can resume manually. Best-effort — never blocks startup.
recoverEmbeddedLlmDownloads().catch((err) =>
  log.warn('Failed to recover orphaned model downloads', {
    error: err instanceof Error ? err.message : String(err),
  }),
);

const app: Application = express();

// Trust-proxy hop count — controls whether Express trusts upstream
// `X-Forwarded-For` headers and how many hops back to walk before
// settling on `req.ip`. This is GLOBAL — every IP-keyed check in the
// API depends on it: session-auth localhost detection, OAuth new-user
// per-IP rate limit, /api/v1/demo/preview per-IP bucket.
//
// Setting this too high is a security hole: a client-controlled
// `X-Forwarded-For` becomes `req.ip`, and any IP-keyed limit collapses
// or can be bypassed with header rotation. Setting it too low (e.g.
// keeping the default 0 behind nginx) flattens every caller's IP to
// the proxy's, and per-IP limits become a single shared bucket.
//
// Pick the EXACT hop count between this Node process and the actual
// client. When in doubt, prefer fewer hops:
//
//   0  — direct: nothing in front of Node, or you don't trust any
//        upstream `X-Forwarded-For`. Default.
//   1  — single reverse proxy on the same host (nginx, Caddy, Fly,
//        Render, Heroku app router, AWS ELB target).
//   2  — CDN in front of a reverse proxy (Cloudflare → nginx → Node;
//        most "Fly behind Cloudflare" setups).
//   3+ — multi-hop edge (rare; e.g. Cloudflare → AWS WAF → ALB → Node).
//
// Verification after deploying: `curl -H 'X-Forwarded-For: 1.2.3.4'
// https://your-api/api/health/live` then check the API log for the
// resolved `req.ip` — it should NOT be `1.2.3.4` unless `1.2.3.4` is
// actually a trusted upstream. If it is, the setting is too permissive.
//
// See README.md "Deployment" → "Reverse proxies and TRUST_PROXY_HOPS"
// for a longer treatment.
//
// Validates the env value strictly. parseInt('abc') is NaN; parseInt('1abc')
// silently returns 1 (the "consumed prefix" — would be the worst kind of
// failure here, a typo quietly becoming a 1-hop trust setting). We require
// the entire value to be a non-negative integer and warn + fall back to 0
// on anything else, so a typo can't quietly become a security hole.
const trustProxyHops = (() => {
  const raw = process.env['TRUST_PROXY_HOPS'];
  if (raw == null || raw === '') return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    // eslint-disable-next-line no-console
    console.warn(`[api] TRUST_PROXY_HOPS=${raw} is invalid (must be a non-negative integer); falling back to 0 (no proxy trust). All per-IP rate limits will key on the upstream socket IP.`);
    return 0;
  }
  const parsed = parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    // eslint-disable-next-line no-console
    console.warn(`[api] TRUST_PROXY_HOPS=${raw} is not finite; falling back to 0 (no proxy trust).`);
    return 0;
  }
  return parsed;
})();
if (trustProxyHops > 0) {
  app.set('trust proxy', trustProxyHops);
}

// Middleware
//
// Voice routes carry audio payloads — the single-shot /transcribe sends
// up to 25MB of base64, and the chunked /upload/chunk path (#386) sends
// ~256KB base64 per request. Both exceed Express' default 100KB JSON
// limit, so a voice-scoped parser with a higher ceiling runs BEFORE the
// global parser; once it parses a /api/voice body, the global one sees
// req._body and skips it. Non-voice routes keep the tight 100KB default.
app.use('/api/voice', express.json({ limit: '30mb' }));
app.use(express.json());

// Health checks (before auth — must be reachable without a session)

// Liveness: process is alive and can handle HTTP requests.
// Echoes `clientIp` so the README's `TRUST_PROXY_HOPS` verification
// curl can confirm req.ip resolution without scraping logs.
app.get('/api/health/live', (req, res) => {
  res.json({ status: 'ok', service: 'skytwin-api', clientIp: req.ip });
});

// Readiness: process is ready to serve traffic (dependencies available)
app.get('/api/health/ready', async (_req, res) => {
  const { healthCheck, getPoolStats } = await import('@skytwin/db');
  const dbHealth = await healthCheck();
  const poolStats = getPoolStats();

  // Pool saturation is the canary signal for "the pool is exhausted —
  // every subsequent acquire is queued, every queued caller is hung."
  // Reporting it via /ready lets an operator (or a future canary) see
  // 18/20 connections saturated before queue depth becomes a customer
  // call. waitingCount > 0 means at least one caller is queued. (#378)
  const poolSaturated = (poolStats?.waitingCount ?? 0) > 0;

  const checks: Record<string, string> = {
    database: dbHealth.healthy ? 'ok' : 'unavailable',
    pool: poolSaturated ? 'saturated' : 'ok',
  };
  const allOk = Object.values(checks).every((v) => v === 'ok');

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    service: 'skytwin-api',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
    dbLatencyMs: dbHealth.latencyMs,
    pool: poolStats ?? { totalCount: 0, idleCount: 0, waitingCount: 0 },
  });
});

// Legacy health check (backwards compatible)
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'skytwin-api',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * Prometheus scrape endpoint (#392).
 *
 * Exposes the metrics a self-hosting operator most needs to alert on:
 *   - pg pool stats: total / idle / waiting connections (saturated
 *     pool was the root cause of #378's "API hung forever" bug)
 *   - process uptime + Node.js heap stats (basic process health)
 *
 * Circuit-breaker state per provider, decision rate, signal ingress
 * rate, and worker poll latency are deliberately deferred to a
 * follow-up: those live in the worker process and shared-collector
 * surfaces and require either an IPC bridge or a multi-process
 * scrape strategy (e.g. PushGateway). Shipping pool + process now
 * gives operators something to alert on today.
 *
 * Read-only, unauthenticated by design — Prometheus scrapers don't
 * carry sessions. Self-hosters who want auth can put the API behind
 * a reverse proxy that filters `/metrics` (Caddy, nginx, etc.).
 * The payload contains zero per-user data — purely process-wide
 * aggregates — so there's nothing to leak.
 */
app.get('/metrics', async (_req, res, next) => {
  try {
    const { getPoolStats } = await import('@skytwin/db');
    const { formatPrometheus, PROMETHEUS_CONTENT_TYPE } = await import(
      '@skytwin/observability'
    );
    const pool = getPoolStats();
    const heap = process.memoryUsage();
    const body = formatPrometheus([
      {
        name: 'skytwin_db_pool_total',
        type: 'gauge',
        help: 'Total connections in the pg pool',
        samples: [{ value: pool?.totalCount ?? 0 }],
      },
      {
        name: 'skytwin_db_pool_idle',
        type: 'gauge',
        help: 'Idle connections in the pg pool',
        samples: [{ value: pool?.idleCount ?? 0 }],
      },
      {
        name: 'skytwin_db_pool_waiting',
        type: 'gauge',
        help: 'Callers queued waiting for a pg pool connection (#378 canary signal)',
        samples: [{ value: pool?.waitingCount ?? 0 }],
      },
      {
        name: 'skytwin_process_uptime',
        type: 'gauge',
        unit: 'seconds',
        help: 'Process uptime since boot',
        samples: [{ value: process.uptime() }],
      },
      {
        name: 'skytwin_process_heap_used',
        type: 'gauge',
        unit: 'bytes',
        help: 'V8 heap bytes currently in use',
        samples: [{ value: heap.heapUsed }],
      },
      {
        name: 'skytwin_process_heap_total',
        type: 'gauge',
        unit: 'bytes',
        help: 'V8 heap bytes allocated',
        samples: [{ value: heap.heapTotal }],
      },
      {
        name: 'skytwin_process_rss',
        type: 'gauge',
        unit: 'bytes',
        help: 'Resident set size of the API process',
        samples: [{ value: heap.rss }],
      },
    ]);
    res.setHeader('Content-Type', PROMETHEUS_CONTENT_TYPE);
    res.status(200).send(body);
  } catch (err) {
    next(err);
  }
});

// Routes
// Protected routes
app.use('/api/events', sessionAuth, requireOwnership, requestContext, createEventsRouter());
app.use('/api/twin', sessionAuth, requireOwnership, requestContext, createTwinRouter());
app.use('/api/decisions', sessionAuth, requireOwnership, requestContext, createDecisionsRouter());
app.use('/api/activity', sessionAuth, requireOwnership, requestContext, createActivityRouter());
app.use('/api/approvals', sessionAuth, requireOwnership, requestContext, createApprovalsRouter());
app.use('/api/feedback', sessionAuth, requireOwnership, requestContext, createFeedbackRouter());
app.use('/api/oauth', createOAuthRouter()); // manages its own public callback
app.use('/api/evals', sessionAuth, requireOwnership, requestContext, createEvalsRouter());
app.use('/api/users', createUsersRouter());
app.use('/api/proposals', sessionAuth, requireOwnership, requestContext, createProposalsRouter());
app.use('/api/v1/twin', sessionAuth, requireOwnership, requestContext, createAskRouter());
app.use('/api/v1/briefings', sessionAuth, requireOwnership, requestContext, createBriefingsRouter());
app.use('/api/v1/skill-gaps', sessionAuth, requireOwnership, requestContext, createSkillGapsRouter());
app.use('/api/settings', sessionAuth, requireOwnership, requestContext, createSettingsRouter());
app.use('/api/sessions', createSessionsRouter()); // POST pairing is public; others are protected in-router
app.use('/api/audit', sessionAuth, requireOwnership, requestContext, createAuditRouter());
app.use('/api/policies', sessionAuth, requireOwnership, requestContext, createPoliciesRouter());
app.use('/api/mempalace', sessionAuth, requireOwnership, requestContext, createMempalaceRouter());
app.use('/api/memory-config', sessionAuth, requireOwnership, requestContext, createMemoryConfigRouter());
app.use('/api/assistant', sessionAuth, requireOwnership, requestContext, createAssistantRouter());
app.use('/api/search', sessionAuth, requireOwnership, requestContext, createSearchRouter());
app.use('/api/credentials', sessionAuth, requireOwnership, requestContext, createCredentialsRouter());
app.use('/api/routines', sessionAuth, requireOwnership, requestContext, createRoutinesRouter());
app.use('/api/v1/demo', createDemoRouter()); // public — onboarding tour discovery
app.use('/api/system', createSystemRouter()); // public — hardware detection + local-model pick for onboarding (pre-auth)
app.use('/api/capabilities', sessionAuth, requireOwnership, requestContext, createCapabilitiesRouter());
app.use('/api/risk-profile', sessionAuth, requireOwnership, requestContext, createRiskProfileRouter());
app.use('/api/about-me', sessionAuth, requireOwnership, requestContext, createAboutMeRouter());
app.use('/api/twin-briefings', sessionAuth, requireOwnership, requestContext, createTwinBriefingsRouter());
app.use('/api/onboarding', sessionAuth, requireOwnership, requestContext, createOnboardingRouter());
app.use('/api/external-agents', sessionAuth, requireOwnership, requestContext, createExternalAgentsRouter());
app.use('/api/credential-vault', sessionAuth, requireOwnership, requestContext, createCredentialVaultRouter());
app.use('/api/dxt', sessionAuth, requireOwnership, requestContext, createDxtRouter());
app.use('/api/lifebooks', sessionAuth, requireOwnership, requestContext, createLifebooksRouter());
app.use('/api/federation', sessionAuth, requestContext, createFederationRouter()); // userId-param ownership applied in-router
// /api/voice — `requireOwnership` enforces body/path/query userId matches the
// authenticated session. POST /transcribe + /synthesize take userId in the
// body, so the in-router :userId middleware alone wasn't sufficient — caught
// by Copilot on PR #255.
app.use('/api/voice', sessionAuth, requireOwnership, requestContext, createVoiceRouter());
app.use('/api/crisis-modes', sessionAuth, requestContext, createCrisisModesRouter()); // userId-param ownership in-router
app.use('/api/connectors', sessionAuth, requestContext, createConnectorsRouter()); // #377 — per-user OAuth re-auth surface
app.use('/api/admin', sessionAuth, requestContext, createAdminDlqRouter()); // #407 — worker dead-letter queue (operator-only; rows are process-global)
app.use('/api/embedded-llm', sessionAuth, requestContext, createEmbeddedLlmRouter()); // catalog endpoints; no userId in path
// #310: promotion-offer durable surface. GET takes :userId in the path
// (require-ownership enforces); POST takes offerId in the path with
// userId in the body (cross-checked in-router).
app.use('/api/promotion-offers', sessionAuth, requestContext, createPromotionOffersRouter());

// Error handling middleware
//
// Defense-in-depth for the SQL-leak class of bugs (#367): even with the
// route-layer UUID validator catching malformed `:userId` segments before
// they reach pg, any future code path that lands a bad string in a pg
// query must not leak the driver's "could not parse … as type uuid"
// message — or any other internal — to the client. Full detail goes to
// server-side logs; the response always carries a safe generic message,
// regardless of NODE_ENV (pre-fix, dev mode leaked `err.message`).
app.use(
  (
    err: Error & { code?: unknown },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    log.error('Unhandled error', { message: err.message, stack: err.stack });
    res.status(500).json({
      error: 'internal_error',
      message: 'Something went wrong on our end.',
    });
  },
);

// Start server with a DB probe + 30s hang detector (#378).
//
// Pre-fix, the API bound the port immediately and only discovered an
// unreachable CRDB on the first user request — by then the orchestrator
// was already routing traffic to a dead process. Now we mirror the
// worker's pattern (apps/worker/src/index.ts startup-failure handling):
// arm a 30s setTimeout that exits non-zero with a diagnostic message,
// run a `SELECT 1` round-trip against the pool, and only then bind the
// port. If CRDB is unreachable or the pool is misconfigured, the
// orchestrator sees a non-zero exit instead of a "healthy on /live but
// every real request hangs" zombie. The hang detector also catches
// migration-loop hangs or any unexpected blocking await between here
// and `listen()`.
const port = config.apiPort;
let server: ReturnType<typeof app.listen>;

const STARTUP_HANG_MS = 30_000;
const startupHangTimer = setTimeout(() => {
  log.error(
    `API startup hung past ${STARTUP_HANG_MS}ms. CRDB may be unreachable, the pool may be misconfigured, or a migration may be stuck. Exiting so the orchestrator can restart.`,
  );
  process.exit(1);
}, STARTUP_HANG_MS);
startupHangTimer.unref();

(async () => {
  try {
    const { healthCheck } = await import('@skytwin/db');
    const dbHealth = await healthCheck();
    if (!dbHealth.healthy) {
      log.error(
        `CRDB readiness probe failed at startup (${dbHealth.error ?? 'unknown error'}). Refusing to bind the port — the orchestrator will see a non-zero exit instead of routing traffic to a dead process.`,
      );
      clearTimeout(startupHangTimer);
      process.exit(1);
    }
    log.info(`CRDB readiness probe ok (${dbHealth.latencyMs}ms). Binding port…`);
  } catch (err) {
    log.error(
      `CRDB readiness probe threw at startup: ${err instanceof Error ? err.message : String(err)}. Refusing to bind the port.`,
    );
    clearTimeout(startupHangTimer);
    process.exit(1);
  }

  server = app.listen(port, () => {
    clearTimeout(startupHangTimer);
    log.info(`SkyTwin API server listening on port ${port}`);
    log.info(`Environment: ${config.nodeEnv}`);
    log.info(`Health check: http://localhost:${port}/api/health`);
    if (config.nodeEnv !== 'production') {
      startMdnsAdvertisement(port);
    }
    // #310: kick off the promotion-offers SSE sweeper. Watches
    // `promotion_offers` for newly-inserted rows and emits
    // `capability:promotion-offered` to live dashboard connections.
    // Polling is the source of truth; this is a UX optimization for
    // already-connected tabs. The sweeper's interval is unref'd so
    // the process can exit cleanly.
    startPromotionOffersSweeper();
  });
})();

// In-process metrics rollup (gated by METRICS_ROLLUP_ENABLED).
//
// The MCP host's onToolCall hook records into sharedMetricsCollector in the
// API process — but the singleton is per-process, so the worker's existing
// rollup job drains its own (empty) buffer. Without this interval the
// API-recorded tool-call metrics never reach the DB. The repository's
// writeBucket upserts on (server_id, bucket_started_at, bucket_duration),
// so a separate API-side rollup safely accumulates with the worker's
// rollup of any worker-initiated tool calls.
let metricsRollupTimer: NodeJS.Timeout | null = null;
const METRICS_ROLLUP_INTERVAL_MS = 60_000;
if (process.env['METRICS_ROLLUP_ENABLED'] !== 'false') {
  const rollupSvc = new MetricsRollupService(sharedMetricsCollector, mcpServerMetricsRepository);
  metricsRollupTimer = setInterval(() => {
    rollupSvc.rollup().catch((err: unknown) => {
      log.warn('In-process metrics rollup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, METRICS_ROLLUP_INTERVAL_MS);
  // unref so the timer doesn't keep the event loop alive during graceful shutdown.
  metricsRollupTimer.unref();
  log.info(`Metrics rollup enabled (interval=${METRICS_ROLLUP_INTERVAL_MS}ms)`);
}

// Graceful shutdown
let shuttingDown = false;
function handleShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down gracefully...`);
  stopMdnsAdvertisement();
  stopPromotionOffersSweeper();
  if (metricsRollupTimer) clearInterval(metricsRollupTimer);
  // Force exit after 25s if connections don't drain (e.g. SSE keep-alive).
  // Set below K8s default terminationGracePeriodSeconds (30s) so we clean up
  // before the orchestrator sends SIGKILL.
  const forceTimer = setTimeout(() => {
    log.warn('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 25_000);
  forceTimer.unref();
  // SIGTERM/SIGINT can arrive before the async startup() completes, in
  // which case `server` is undefined and there's no HTTP listener to
  // close. Close the pool directly and exit.
  if (!server) {
    log.info('Shutdown signal received before HTTP server bound — closing pool and exiting');
    closePool()
      .catch((err) => log.warn('Error closing database pool', {
        error: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => process.exit(0));
    return;
  }
  server.close(async () => {
    log.info('HTTP server closed');
    try {
      await closePool();
      log.info('Database pool closed');
    } catch (err) {
      log.warn('Error closing database pool', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

export default app;
