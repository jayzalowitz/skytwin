import express, { type Application } from 'express';
import { loadConfig } from '@skytwin/config';
import { createEventsRouter } from './routes/events.js';
import { createTwinRouter } from './routes/twin.js';
import { createDecisionsRouter } from './routes/decisions.js';
import { createApprovalsRouter } from './routes/approvals.js';
import { createFeedbackRouter } from './routes/feedback.js';

const config = loadConfig();
const app: Application = express();

// Middleware
app.use(express.json());

// Routes
app.use('/api/events', createEventsRouter());
app.use('/api/twin', createTwinRouter());
app.use('/api/decisions', createDecisionsRouter());
app.use('/api/approvals', createApprovalsRouter());
app.use('/api/feedback', createFeedbackRouter());

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'skytwin-api',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
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
