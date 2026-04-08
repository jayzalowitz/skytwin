import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env['WEB_PORT'] ?? '3200', 10);
const API_BASE = process.env['API_BASE_URL'] ?? 'http://localhost:3100';

const app = express();
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// API proxy to avoid CORS issues — forwards /api/* to the API server
app.all('/api/*', async (req, res) => {
  try {
    const targetUrl = `${API_BASE}${req.originalUrl}`;
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers['authorization'] ? { Authorization: req.headers['authorization'] as string } : {}),
      },
      body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });

    const data = await response.text();
    res.status(response.status).type('application/json').send(data);
  } catch (error) {
    res.status(502).json({ error: 'API proxy error', details: String(error) });
  }
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.info(`[web] SkyTwin Dashboard at http://localhost:${PORT}`);
  console.info(`[web] API proxy → ${API_BASE}`);
});
