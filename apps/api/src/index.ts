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
import { createSkillGapsRouter } from './routes/skill-gaps.js';
import { createSettingsRouter } from './routes/settings.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createAuditRouter } from './routes/audit.js';
import { sessionAuth } from './middleware/session-auth.js';
import { requireOwnership } from './middleware/require-ownership.js';
import { createPoliciesRouter } from './routes/policies.js';
import { createMempalaceRouter } from './routes/mempalace.js';
import { createCredentialsRouter } from './routes/credentials.js';
import { createRoutinesRouter } from './routes/routines.js';
import { getExecutionRouter } from './execution-setup.js';
import { startMdnsAdvertisement, stopMdnsAdvertisement } from './mdns.js';
import { closePool } from '@skytwin/db';

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

const app: Application = express();

// Middleware
app.use(express.json());

// Health checks (before auth — must be reachable without a session)

// Liveness: process is alive and can handle HTTP requests
app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok', service: 'skytwin-api' });
});

// Readiness: process is ready to serve traffic (dependencies available)
app.get('/api/health/ready', async (_req, res) => {
  const { healthCheck } = await import('@skytwin/db');
  const dbHealth = await healthCheck();

  const checks: Record<string, string> = {
    database: dbHealth.healthy ? 'ok' : 'unavailable',
  };
  const allOk = Object.values(checks).every((v) => v === 'ok');

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    service: 'skytwin-api',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
    dbLatencyMs: dbHealth.latencyMs,
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

// Routes
// Protected routes
app.use('/api/events', sessionAuth, requireOwnership, createEventsRouter());
app.use('/api/twin', sessionAuth, requireOwnership, createTwinRouter());
app.use('/api/decisions', sessionAuth, requireOwnership, createDecisionsRouter());
app.use('/api/approvals', sessionAuth, requireOwnership, createApprovalsRouter());
app.use('/api/feedback', sessionAuth, requireOwnership, createFeedbackRouter());
app.use('/api/oauth', createOAuthRouter()); // manages its own public callback
app.use('/api/evals', sessionAuth, requireOwnership, createEvalsRouter());
app.use('/api/users', createUsersRouter());
app.use('/api/proposals', sessionAuth, requireOwnership, createProposalsRouter());
app.use('/api/v1/twin', sessionAuth, requireOwnership, createAskRouter());
app.use('/api/v1/briefings', sessionAuth, requireOwnership, createBriefingsRouter());
app.use('/api/v1/skill-gaps', sessionAuth, requireOwnership, createSkillGapsRouter());
app.use('/api/settings', sessionAuth, requireOwnership, createSettingsRouter());
app.use('/api/sessions', createSessionsRouter()); // POST pairing is public; others are protected in-router
app.use('/api/audit', sessionAuth, requireOwnership, createAuditRouter());
app.use('/api/policies', sessionAuth, requireOwnership, createPoliciesRouter());
app.use('/api/mempalace', sessionAuth, requireOwnership, createMempalaceRouter());
app.use('/api/credentials', sessionAuth, requireOwnership, createCredentialsRouter());
app.use('/api/routines', sessionAuth, requireOwnership, createRoutinesRouter());

// Error handling middleware
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    log.error('Unhandled error', { message: err.message, stack: err.stack });
    res.status(500).json({
      error: 'Internal server error',
      message: config.nodeEnv === 'development' ? err.message : undefined,
    });
  },
);

// Start server
const port = config.apiPort;
const server = app.listen(port, () => {
  log.info(`SkyTwin API server listening on port ${port}`);
  log.info(`Environment: ${config.nodeEnv}`);
  log.info(`Health check: http://localhost:${port}/api/health`);
  if (config.nodeEnv !== 'production') {
    startMdnsAdvertisement(port);
  }
});

// Graceful shutdown
let shuttingDown = false;
function handleShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down gracefully...`);
  stopMdnsAdvertisement();
  // Force exit after 25s if connections don't drain (e.g. SSE keep-alive).
  // Set below K8s default terminationGracePeriodSeconds (30s) so we clean up
  // before the orchestrator sends SIGKILL.
  const forceTimer = setTimeout(() => {
    log.warn('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 25_000);
  forceTimer.unref();
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
