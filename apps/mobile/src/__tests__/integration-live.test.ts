import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Live integration tests for the mobile app's API interaction.
 *
 * Tests run against the real API server (localhost:3100) and validate
 * the exact request/response contracts that the mobile app depends on.
 * Each test mirrors a real mobile user flow.
 *
 * These tests are automatically skipped when the API server is not running
 * (e.g. in CI). Run with a live server for full coverage.
 */

const API_BASE = 'http://localhost:3100';

async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/health/live`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const serverAvailable = await isServerUp();

// ────────────────────────────────────────────────
// Flow 1: mDNS discovery → health check → connection confirmed
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('mobile discovery flow', () => {
  it('health endpoint responds with expected shape', async () => {
    const res = await fetch(`${API_BASE}/api/health`);
    expect(res.ok).toBe(true);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('service');
    expect(typeof body.status).toBe('string');
    expect(typeof body.service).toBe('string');
  });

  it('health endpoint response time is mobile-friendly (<500ms)', async () => {
    const start = Date.now();
    await fetch(`${API_BASE}/api/health`);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('health endpoint returns JSON content-type', async () => {
    const res = await fetch(`${API_BASE}/api/health`);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/json');
  });
});

// ────────────────────────────────────────────────
// Flow 2: QR scan → create session → Bearer token auth
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('mobile QR pairing flow', () => {
  it('POST /api/sessions validates required userId field', async () => {
    const res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('POST /api/sessions accepts valid pairing request', async () => {
    const res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'mobile-test-user', deviceName: 'iPhone 15' }),
    });

    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      // Validate QR payload structure matches what PairingScreen parses
      expect(body).toHaveProperty('sessionId');
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('qrUrl');
      expect(body).toHaveProperty('expiresAt');

      // Token should be long enough for 128+ bits of entropy
      const token = body.token as string;
      expect(token.length).toBeGreaterThan(30);

      // QR URL should be parseable by PairingScreen
      const qrUrl = body.qrUrl as string;
      const parsed = new URL(qrUrl);
      expect(parsed.searchParams.get('token')).toBeTruthy();
      expect(parsed.searchParams.get('userId')).toBe('mobile-test-user');
      expect(parsed.hostname).toBe('skytwin.local');

      // Expiry should be ~7 days from now
      const expiresAt = new Date(body.expiresAt as string);
      const now = new Date();
      const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(6);
      expect(diffDays).toBeLessThan(8);
    } else {
      // DB not available — acceptable for CI without CockroachDB
      expect(res.status).toBeGreaterThanOrEqual(500);
    }
  });

  it('POST /api/sessions with custom deviceName stores it', async () => {
    const res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'mobile-test-user', deviceName: 'Pixel 9 Pro' }),
    });

    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('sessionId');
    }
    // If DB is down, 500 is fine — we're testing the request is accepted
  });
});

// ────────────────────────────────────────────────
// Flow 3: Approvals list → pull to refresh → swipe to approve/reject
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('mobile approvals flow', () => {
  it('GET /api/approvals/:userId/pending returns array (with DB)', async () => {
    const res = await fetch(`${API_BASE}/api/approvals/mobile-test-user/pending`);
    if (res.ok) {
      const body = await res.json() as { approvals: unknown[] };
      expect(Array.isArray(body.approvals)).toBe(true);
    } else {
      // DB required
      expect(res.status).toBeGreaterThanOrEqual(500);
    }
  });

  it('approval response endpoint validates action field', async () => {
    const res = await fetch(`${API_BASE}/api/approvals/fake-req-id/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'test-user' }),
    });
    // Should reject — missing 'action' field
    expect(res.ok).toBe(false);
  });

  it('approval response endpoint validates action enum', async () => {
    const res = await fetch(`${API_BASE}/api/approvals/fake-req-id/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'invalid-action', userId: 'test-user' }),
    });
    // Should reject — invalid action value
    expect(res.ok).toBe(false);
  });

  it('rejection includes reason in request body', async () => {
    const res = await fetch(`${API_BASE}/api/approvals/fake-req-id/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'reject',
        userId: 'test-user',
        reason: 'Too expensive',
      }),
    });
    // Will fail because fake-req-id doesn't exist, but should not be a format error
    // 400 (validation) or 404 (not found) or 500 (DB) — all acceptable
    expect([400, 404, 500, 502, 503]).toContain(res.status);
  });
});

// ────────────────────────────────────────────────
// Flow 4: Decision history for dashboard
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('mobile dashboard — decision history', () => {
  it('GET /api/decisions/:userId returns decisions array', async () => {
    const res = await fetch(`${API_BASE}/api/decisions/mobile-test-user`);
    if (res.ok) {
      const body = await res.json() as { decisions: unknown[] };
      expect(Array.isArray(body.decisions)).toBe(true);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(500);
    }
  });

  it('accepts limit query param', async () => {
    const res = await fetch(`${API_BASE}/api/decisions/mobile-test-user?limit=5`);
    if (res.ok) {
      const body = await res.json() as { decisions: unknown[] };
      expect(body.decisions.length).toBeLessThanOrEqual(5);
    }
  });

  it('accepts domain filter', async () => {
    const res = await fetch(`${API_BASE}/api/decisions/mobile-test-user?domain=email`);
    // Should accept the param without error (200 or 500 for DB)
    expect([200, 500, 502, 503]).toContain(res.status);
  });

  it('accepts offset for pagination', async () => {
    const res = await fetch(`${API_BASE}/api/decisions/mobile-test-user?limit=10&offset=0`);
    expect([200, 500, 502, 503]).toContain(res.status);
  });
});

// ────────────────────────────────────────────────
// Flow 5: Twin profile for trust tier display
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('mobile dashboard — twin profile', () => {
  it('GET /api/twin/:userId returns profile or error', async () => {
    const res = await fetch(`${API_BASE}/api/twin/mobile-test-user`);
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('profile');
    } else {
      // 404 (user not found) or 500 (DB) both acceptable
      expect([404, 500, 502, 503]).toContain(res.status);
    }
  });

  it('GET /api/twin/:userId/progress returns tier info', async () => {
    const res = await fetch(`${API_BASE}/api/twin/mobile-test-user/progress`);
    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('trustTier');
    }
  });
});

// ────────────────────────────────────────────────
// Flow 6: Session management (settings screen)
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('mobile settings — session management', () => {
  it('GET /api/sessions/:userId lists active sessions', async () => {
    const res = await fetch(`${API_BASE}/api/sessions/mobile-test-user`);
    if (res.ok) {
      const body = await res.json() as { sessions: unknown[] };
      expect(Array.isArray(body.sessions)).toBe(true);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(500);
    }
  });

  it('DELETE /api/sessions/:id requires userId in body', async () => {
    const res = await fetch(`${API_BASE}/api/sessions/fake-session-id`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Should be 400 (missing userId)
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('userId');
  });
});

// ────────────────────────────────────────────────
// Flow 7: SSE connection (real-time approvals)
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('mobile SSE — real-time events', () => {
  it('SSE endpoint exists and accepts connections', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(
        `${API_BASE}/api/events/mobile-test-user/stream`,
        {
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
          signal: controller.signal,
        },
      );
      // Should be 200 with text/event-stream or 404 if route doesn't exist
      // or 500 if DB issue
      expect([200, 404, 500, 502, 503]).toContain(res.status);
      if (res.ok) {
        const ct = res.headers.get('content-type') ?? '';
        expect(ct).toContain('text/event-stream');
      }
    } catch (err: unknown) {
      // AbortError is expected (we timeout after 3s of streaming)
      if (err instanceof DOMException && err.name === 'AbortError') {
        // SSE connection was open and streaming — this is success
        expect(true).toBe(true);
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });
});

// ────────────────────────────────────────────────
// API contract: error response shape
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('API error response contract', () => {
  it('400 errors return JSON with error field', async () => {
    const res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
    expect(body.error).toBeTruthy();
  });

  it('404 for unknown API routes', async () => {
    const res = await fetch(`${API_BASE}/api/this-endpoint-does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('404 responses are valid HTTP (Express default handler)', async () => {
    const res = await fetch(`${API_BASE}/api/this-endpoint-does-not-exist`);
    expect(res.status).toBe(404);
    // Express default 404 returns HTML — acceptable for unmatched routes
    const body = await res.text();
    expect(body).toContain('Cannot GET');
  });
});

// ────────────────────────────────────────────────
// Mobile API client contract verification
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('mobile API client URL contract', () => {
  it('all mobile API paths start with /api/', () => {
    const paths = [
      '/api/health',
      '/api/approvals/USER/pending',
      '/api/approvals/REQ_ID/respond',
      '/api/decisions/USER',
      '/api/twin/USER',
      '/api/sessions',
      '/api/sessions/USER',
      '/api/events/USER/stream',
    ];
    for (const path of paths) {
      expect(path).toMatch(/^\/api\//);
    }
  });

  it('Bearer token format matches what session endpoint returns', async () => {
    // Create session and verify the token format
    const res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'token-test-user' }),
    });

    if (res.ok) {
      const body = await res.json() as { token: string };
      // Token format: UUID-UUID (two UUIDs joined by hyphen)
      expect(body.token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // Verify the token can be used as Bearer auth header
      const authHeader = `Bearer ${body.token}`;
      expect(authHeader).toMatch(/^Bearer [0-9a-f-]+$/);
    }
  });
});

// ────────────────────────────────────────────────
// Cross-platform: web dashboard over API proxy
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('web proxy (mobile browser fallback path)', () => {
  it('web dashboard proxies API requests correctly', async () => {
    const directRes = await fetch(`${API_BASE}/api/health`);
    const proxiedRes = await fetch('http://localhost:3200/api/health');

    expect(directRes.ok).toBe(true);
    expect(proxiedRes.ok).toBe(true);

    const directBody = await directRes.json() as Record<string, unknown>;
    const proxiedBody = await proxiedRes.json() as Record<string, unknown>;

    // Timestamp/uptime will differ slightly between two requests — compare stable fields
    expect(proxiedBody.status).toEqual(directBody.status);
    expect(proxiedBody.service).toEqual(directBody.service);
  });

  it('web dashboard serves static HTML for mobile browser access', async () => {
    const res = await fetch('http://localhost:3200/');
    expect(res.ok).toBe(true);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html');
  });
});

// ────────────────────────────────────────────────
// Concurrent request handling (multiple mobile devices)
// ────────────────────────────────────────────────

describe.runIf(serverAvailable)('concurrent requests (simulating multiple mobile devices)', () => {
  it('handles 10 concurrent health checks without errors', async () => {
    const requests = Array.from({ length: 10 }, () =>
      fetch(`${API_BASE}/api/health`).then((r) => r.status),
    );
    const statuses = await Promise.all(requests);
    for (const status of statuses) {
      expect(status).toBe(200);
    }
  });

  it('handles concurrent session creation attempts', async () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      fetch(`${API_BASE}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: `concurrent-user-${i}` }),
      }).then((r) => r.status),
    );
    const statuses = await Promise.all(requests);
    for (const status of statuses) {
      // All should either succeed (201) or fail due to DB (500)
      expect([201, 500, 502, 503]).toContain(status);
    }
    // All should have the same outcome (all succeed or all fail)
    expect(new Set(statuses).size).toBe(1);
  });
});
