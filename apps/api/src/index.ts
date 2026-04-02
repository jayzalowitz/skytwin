import express, { type Application } from 'express';
import { loadConfig, validate } from '@skytwin/config';
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
import { getExecutionRouter } from './execution-setup.js';

const config = loadConfig();

// Validate config on startup (warn but don't crash in development)
const configErrors = validate(config);
if (configErrors.length > 0) {
  const messages = configErrors.map((e) => `  - ${e.field}: ${e.message}`).join('\n');
  if (config.nodeEnv === 'production') {
    console.error(`[api] Fatal: invalid configuration:\n${messages}`);
    process.exit(1);
  } else {
    console.warn(`[api] Configuration warnings (non-fatal in development):\n${messages}`);
  }
}

// Initialize the execution router early to log adapter registration
getExecutionRouter();

const app: Application = express();

// Middleware
app.use(express.json());

// Routes
app.use('/api/events', createEventsRouter());
app.use('/api/twin', createTwinRouter());
app.use('/api/decisions', createDecisionsRouter());
app.use('/api/approvals', createApprovalsRouter());
app.use('/api/feedback', createFeedbackRouter());
app.use('/api/oauth', createOAuthRouter());
app.use('/api/evals', createEvalsRouter());
app.use('/api/users', createUsersRouter());
app.use('/api/proposals', createProposalsRouter());
app.use('/api/v1/twin', createAskRouter());
app.use('/api/v1/briefings', createBriefingsRouter());
app.use('/api/v1/skill-gaps', createSkillGapsRouter());
app.use('/api/settings', createSettingsRouter());

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'skytwin-api',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    adapters: {
      note: 'Execution router initialized with trust-ranked adapters',
    },
  });
});

// Error handling middleware
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[api] Unhandled error:', err.message, err.stack);
    res.status(500).json({
      error: 'Internal server error',
      message: config.nodeEnv === 'development' ? err.message : undefined,
    });
  },
);

// Start server
const port = config.apiPort;
app.listen(port, () => {
  console.info(`[api] SkyTwin API server listening on port ${port}`);
  console.info(`[api] Environment: ${config.nodeEnv}`);
  console.info(`[api] Health check: http://localhost:${port}/api/health`);
});

export default app;
