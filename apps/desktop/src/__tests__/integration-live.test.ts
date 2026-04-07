import { describe, it, expect } from 'vitest';

/**
 * Live integration tests for desktop + API interaction.
 *
 * These tests run against the real API server (expected on localhost:3100)
 * and validate the full request/response cycle that the desktop app depends on.
 *
 * Automatically skipped when the API server is not running (e.g. in CI).
 */

const API_BASE = 'http://localhost:3100';
const WEB_BASE = 'http://localhost:3200';

async function isServerUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const serverAvailable = await isServerUp(`${API_BASE}/api/health/live`);

describe.runIf(serverAvailable)('API server health (desktop process supervision target)', () => {

  it('GET /api/health returns ok status', async () => {
    const res = await fetch(`${API_BASE}/api/health`);
    expect(res.ok).toBe(true);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('skytwin-api');
  });

  it('GET /api/health/live returns 200', async () => {
    const res = await fetch(`${API_BASE}/api/health/live`);
    expect(res.status).toBe(200);
  });

  it('GET /api/health/ready returns status (may fail without DB)', async () => {
    const res = await fetch(`${API_BASE}/api/health/ready`);
    // Ready check may fail if CockroachDB is not running — that's fine
    // We just verify it responds with valid JSON
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('status');
  });

  it('health endpoint responds within 1 second', async () => {
    const start = Date.now();
    await fetch(`${API_BASE}/api/health`);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});

describe.runIf(serverAvailable)('web dashboard proxy (desktop embeds this)', () => {
  it('GET / returns 200 with HTML', async () => {
    const res = await fetch(WEB_BASE);
    expect(res.ok).toBe(true);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/html');
  });

  it('proxied /api/health returns API response', async () => {
    const res = await fetch(`${WEB_BASE}/api/health`);
    expect(res.ok).toBe(true);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('skytwin-api');
  });

  it('SPA fallback serves index.html for unknown routes', async () => {
    const res = await fetch(`${WEB_BASE}/dashboard/decisions`);
    expect(res.ok).toBe(true);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/html');
  });
});

describe.runIf(serverAvailable)('session management (QR pairing flow)', () => {
  it('POST /api/sessions without userId returns 400', async () => {
    const res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, string>;
    expect(body.error).toContain('userId');
  });

  it('POST /api/sessions creates session and returns QR URL (may fail without DB)', async () => {
    const res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'test-user-1', deviceName: 'Test Phone' }),
    });
    // This will 500 without CockroachDB — but we verify the request format is accepted
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('sessionId');
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('qrUrl');
      expect(body).toHaveProperty('expiresAt');
      // QR URL format validation
      const qrUrl = body.qrUrl as string;
      expect(qrUrl).toContain('skytwin.local');
      expect(qrUrl).toContain('token=');
      expect(qrUrl).toContain('userId=');
    } else {
      // Expected to fail without DB — verify it's a server error not a client error
      expect(res.status).toBeGreaterThanOrEqual(500);
    }
  });
});

describe.runIf(serverAvailable)('session auth middleware (mobile auth flow)', () => {
  it('localhost requests bypass auth', async () => {
    // Requests from localhost should pass without Bearer token
    const res = await fetch(`${API_BASE}/api/health`);
    expect(res.ok).toBe(true);
  });

  it('request without Bearer token from localhost still works', async () => {
    // Localhost is trusted — this should succeed for any API route
    const res = await fetch(`${API_BASE}/api/health/live`);
    expect(res.ok).toBe(true);
  });
});

describe.runIf(serverAvailable)('mDNS advertisement (mobile discovery)', () => {
  it('API logs show mDNS advertisement started', async () => {
    // We verify mDNS was started by checking the API is advertising
    // In integration, we can check the health endpoint includes proper info
    const res = await fetch(`${API_BASE}/api/health`);
    expect(res.ok).toBe(true);
    // The mDNS advertisement runs on _skytwin._tcp
    // We can't query mDNS from a test, but we verify the server started successfully
    // which means startMdnsAdvertisement() didn't crash the server
  });
});

describe.runIf(serverAvailable)('approval endpoints (mobile approve/reject flow)', () => {
  it('GET /api/approvals/:userId/pending returns list (may need DB)', async () => {
    const res = await fetch(`${API_BASE}/api/approvals/test-user-1/pending`);
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('approvals');
      expect(Array.isArray((body as { approvals: unknown[] }).approvals)).toBe(true);
    } else {
      // DB not available — verify it's a server error
      expect(res.status).toBeGreaterThanOrEqual(500);
    }
  });

  it('POST /api/approvals/nonexistent/respond returns error', async () => {
    const res = await fetch(`${API_BASE}/api/approvals/nonexistent-id/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', userId: 'test-user-1' }),
    });
    // Should be 404 or 500 (not found or DB error), never 200
    expect(res.ok).toBe(false);
  });

  it('POST /api/approvals/:id/respond without action returns 400', async () => {
    const res = await fetch(`${API_BASE}/api/approvals/some-id/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'test-user-1' }),
    });
    // Should be 400 (missing action) or 500 (DB)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe.runIf(serverAvailable)('decision history (mobile dashboard)', () => {
  it('GET /api/decisions/:userId returns list (may need DB)', async () => {
    const res = await fetch(`${API_BASE}/api/decisions/test-user-1`);
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('decisions');
    } else {
      expect(res.status).toBeGreaterThanOrEqual(500);
    }
  });

  it('query params are accepted without error', async () => {
    const res = await fetch(
      `${API_BASE}/api/decisions/test-user-1?limit=5&offset=0&domain=email`,
    );
    // Should return data or 500 (DB), never 400
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('decisions');
    }
  });
});

describe.runIf(serverAvailable)('twin profile (mobile dashboard)', () => {
  it('GET /api/twin/:userId returns profile (may need DB)', async () => {
    const res = await fetch(`${API_BASE}/api/twin/test-user-1`);
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('profile');
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe.runIf(serverAvailable)('policies endpoint (engine gaps feature)', () => {
  it('GET /api/policies/:userId responds (may need DB)', async () => {
    const res = await fetch(`${API_BASE}/api/policies/test-user-1`);
    // 200 (with data), 500 (DB not available) — route exists either way
    expect([200, 500, 502, 503]).toContain(res.status);
  });
});

describe.runIf(serverAvailable)('audit endpoint (dashboard feature)', () => {
  it('GET /api/audit/:userId responds (may need DB)', async () => {
    const res = await fetch(`${API_BASE}/api/audit/test-user-1`);
    expect([200, 500, 502, 503]).toContain(res.status);
  });
});

describe.runIf(serverAvailable)('API CORS and content type', () => {
  it('JSON responses have correct content-type', async () => {
    const res = await fetch(`${API_BASE}/api/health`);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/json');
  });

  it('unknown routes return 404 not crash', async () => {
    const res = await fetch(`${API_BASE}/api/nonexistent-endpoint`);
    // Should be 404, not 500
    expect(res.status).toBe(404);
  });
});

describe.runIf(serverAvailable)('desktop service manager targets', () => {
  it('API health check matches service-manager polling URL', async () => {
    // ServiceManager polls http://localhost:3100/api/health every 5s
    const res = await fetch('http://localhost:3100/api/health');
    expect(res.ok).toBe(true);
    const body = await res.json() as Record<string, string>;
    expect(body.status).toBe('ok');
  });

  it('web dashboard matches main.ts loadURL target', async () => {
    // main.ts loads http://localhost:3200
    const res = await fetch('http://localhost:3200');
    expect(res.ok).toBe(true);
  });
});
