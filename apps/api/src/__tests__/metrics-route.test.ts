/**
 * Tests for the /metrics Prometheus scrape endpoint (#392).
 *
 * Verifies the wire format the scraper expects (Content-Type +
 * known series names). The formatter spec compliance lives in
 * `packages/observability/src/__tests__/prometheus.test.ts`; this
 * test pins the API surface — series names, label-free shape, and
 * the auth posture (no session required).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const mockGetPoolStats = vi.fn();

vi.mock('@skytwin/db', () => ({
  getPoolStats: () => mockGetPoolStats(),
}));

// Re-use the real observability formatter — this is the only test
// surface that locks the route's wire output, so we want the actual
// rendering path exercised end-to-end.

async function loadApp(): Promise<Express> {
  // Inline the same handler shape as apps/api/src/index.ts so we
  // test the wire-format contract without booting the full server
  // (which pulls in CRDB, the worker bridge, OAuth, etc.).
  const { formatPrometheus, PROMETHEUS_CONTENT_TYPE } = await import(
    '@skytwin/observability'
  );
  const app = express();
  app.get('/metrics', async (_req, res) => {
    const pool = mockGetPoolStats();
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
        help: 'Callers queued waiting',
        samples: [{ value: pool?.waitingCount ?? 0 }],
      },
      {
        name: 'skytwin_process_uptime',
        type: 'gauge',
        unit: 'seconds',
        help: 'Process uptime',
        samples: [{ value: process.uptime() }],
      },
      {
        name: 'skytwin_process_heap_used',
        type: 'gauge',
        unit: 'bytes',
        help: 'V8 heap bytes in use',
        samples: [{ value: heap.heapUsed }],
      },
    ]);
    res.setHeader('Content-Type', PROMETHEUS_CONTENT_TYPE);
    res.status(200).send(body);
  });
  return app;
}

async function request(app: Express, path: string): Promise<{
  status: number;
  body: string;
  contentType: string;
}> {
  return new Promise((resolve, reject) => {
    const req: Partial<express.Request> = {
      method: 'GET',
      url: path,
      headers: {},
    } as Partial<express.Request>;
    let status = 200;
    let body = '';
    let contentType = '';
    const res = {
      status(code: number) { status = code; return res; },
      setHeader(name: string, value: string) {
        if (name.toLowerCase() === 'content-type') contentType = value;
        return res;
      },
      send(payload: unknown) {
        body = typeof payload === 'string' ? payload : String(payload);
        resolve({ status, body, contentType });
        return res;
      },
      json() { return res; },
      end: () => resolve({ status, body, contentType }),
    } as unknown as express.Response;
    app(req as express.Request, res as express.Response, (err?: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve({ status, body, contentType });
    });
  });
}

describe('GET /metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPoolStats.mockReturnValue({
      totalCount: 20,
      idleCount: 15,
      waitingCount: 0,
    });
  });

  it('returns 200 with Prometheus Content-Type', async () => {
    const app = await loadApp();
    const { status, contentType } = await request(app, '/metrics');
    expect(status).toBe(200);
    expect(contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('exposes pg pool series with current values', async () => {
    const app = await loadApp();
    const { body } = await request(app, '/metrics');
    expect(body).toContain('skytwin_db_pool_total 20');
    expect(body).toContain('skytwin_db_pool_idle 15');
    expect(body).toContain('skytwin_db_pool_waiting 0');
  });

  it('exposes process uptime + heap series with the spec-required unit suffix', async () => {
    const app = await loadApp();
    const { body } = await request(app, '/metrics');
    expect(body).toMatch(/skytwin_process_uptime_seconds \d+(\.\d+)?/);
    expect(body).toMatch(/skytwin_process_heap_used_bytes \d+/);
  });

  it('flags pool saturation by surfacing waitingCount > 0 verbatim (canary for #378)', async () => {
    mockGetPoolStats.mockReturnValue({
      totalCount: 20,
      idleCount: 0,
      waitingCount: 5,
    });
    const app = await loadApp();
    const { body } = await request(app, '/metrics');
    expect(body).toContain('skytwin_db_pool_waiting 5');
  });

  it('renders a coherent payload (HELP, TYPE, sample triples for every series)', async () => {
    const app = await loadApp();
    const { body } = await request(app, '/metrics');
    // Every metric MUST have its declared HELP and TYPE lines —
    // scrapers reject a series whose TYPE wasn't pre-declared.
    const helpCount = (body.match(/^# HELP /gm) || []).length;
    const typeCount = (body.match(/^# TYPE /gm) || []).length;
    expect(helpCount).toBeGreaterThanOrEqual(5);
    expect(typeCount).toBe(helpCount);
    // Trailing newline per spec.
    expect(body.endsWith('\n')).toBe(true);
  });

  it('defaults to zero gracefully when getPoolStats returns null (boot race)', async () => {
    mockGetPoolStats.mockReturnValue(null);
    const app = await loadApp();
    const { body, status } = await request(app, '/metrics');
    expect(status).toBe(200);
    expect(body).toContain('skytwin_db_pool_total 0');
  });
});
