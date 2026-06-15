import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env['WEB_PORT'] ?? '3200', 10);
const API_BASE = process.env['API_BASE_URL'] ?? 'http://localhost:3100';

const app = express();
app.use(express.json());

const PUBLIC_DIR = path.join(__dirname, '../public');

// PWA (#403): the service worker must be served with no-cache so a new
// deploy's sw.js is picked up on the next visit (browsers byte-compare it),
// and with `Service-Worker-Allowed: /` so a worker fetched from /sw.js can
// claim the whole-origin scope the SPA needs. Registered BEFORE the static
// middleware so these headers always win.
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});

// Serve static files. `.webmanifest` isn't in Express's default MIME table,
// so register it explicitly; otherwise the manifest is served as
// application/octet-stream and some browsers refuse to parse it.
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.webmanifest')) {
        res.setHeader('Content-Type', 'application/manifest+json');
      }
    },
  }),
);

// API proxy to avoid CORS issues — forwards /api/* to the API server
app.all('/api/*splat', async (req, res) => {
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
app.get('/*splat', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.info(`[web] SkyTwin Dashboard at http://localhost:${PORT}`);
  console.info(`[web] API proxy → ${API_BASE}`);
});
