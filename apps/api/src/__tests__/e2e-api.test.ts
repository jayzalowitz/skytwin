/**
 * E2E API integration tests.
 *
 * These tests run against a live API server backed by a real CockroachDB
 * instance. They are gated behind E2E=true so the normal `pnpm test` suite
 * is unaffected.
 *
 * The test expects:
 *   - E2E=true
 *   - E2E_API_PORT set (defaults to 3199)
 *   - API server already running on that port
 *   - API pointed at the test database
 *
 * Run via:  ./bin/skytwin-e2e-test --api-only
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const E2E = process.env['E2E'] === 'true';
const API_PORT = process.env['E2E_API_PORT'] ?? '3199';
const BASE = `http://localhost:${API_PORT}`;

// Track resources for cleanup
const createdUserIds: string[] = [];
const createdPolicyIds: Array<{ userId: string; policyId: string }> = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers as Record<string, string> },
    ...options,
  });
}

async function apiJson<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await api(path, options);
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

/**
 * Create a test user via the API and track for cleanup.
 */
async function createUser(email: string, name: string) {
  const { status, body } = await apiJson<{
    user: { id: string; email: string; name: string; trust_tier: string };
    created: boolean;
  }>('/api/users', {
    method: 'POST',
    body: JSON.stringify({ email, name }),
  });

  if (status === 201 || status === 200) {
    createdUserIds.push(body.user.id);
  }
  return { status, body };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!E2E)('E2E: API integration', () => {
  beforeAll(async () => {
    // Verify API is reachable
    try {
      const res = await fetch(`${BASE}/api/health/live`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
    } catch (error) {
      throw new Error(
        `API server is not reachable at ${BASE}. ` +
        `Start it with ./bin/skytwin-e2e-test or manually. Error: ${error}`,
      );
    }
  });

  afterAll(async () => {
    // Clean up policies first (soft-delete via API)
    for (const { userId, policyId } of createdPolicyIds) {
      try {
        await api(`/api/policies/${userId}/${policyId}`, { method: 'DELETE' });
      } catch {
        // Best-effort
      }
    }

    // We cannot easily delete users via the API (no DELETE endpoint exposed),
    // but the bash script drops the entire test database anyway.
  });

  // =========================================================================
  // a. Health endpoints
  // =========================================================================

  describe('Health endpoints', () => {
    it('GET /api/health/live returns ok', async () => {
      const { status, body } = await apiJson<{ status: string; service: string }>(
        '/api/health/live',
      );
      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.service).toBe('skytwin-api');
    });

    it('GET /api/health/ready returns ok with database check', async () => {
      const { status, body } = await apiJson<{
        status: string;
        checks: { database: string };
        dbLatencyMs: number;
      }>('/api/health/ready');

      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.checks.database).toBe('ok');
      expect(body.dbLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('GET /api/health returns legacy format', async () => {
      const { status, body } = await apiJson<{
        status: string;
        service: string;
        timestamp: string;
        uptime: number;
      }>('/api/health');

      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
      expect(body.uptime).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // b. User onboarding
  // =========================================================================

  describe('User onboarding', () => {
    it('POST /api/users creates a new user', async () => {
      const email = `e2e-api-${Date.now()}@test.local`;
      const { status, body } = await createUser(email, 'API Test User');

      expect(status).toBe(201);
      expect(body.created).toBe(true);
      expect(body.user.email).toBe(email);
      expect(body.user.name).toBe('API Test User');
      // New users get 'suggest' tier (not 'observer' -- the API route enforces this)
      expect(body.user.trust_tier).toBe('suggest');
    });

    it('POST /api/users with same email returns existing user', async () => {
      const email = `e2e-api-idempotent-${Date.now()}@test.local`;

      const first = await createUser(email, 'First');
      expect(first.status).toBe(201);

      const second = await createUser(email, 'Second');
      expect(second.status).toBe(200);
      expect(second.body.created).toBe(false);
      expect(second.body.user.id).toBe(first.body.user.id);
    });

    it('POST /api/users without email returns 400', async () => {
      const { status, body } = await apiJson<{ error: string }>(
        '/api/users',
        {
          method: 'POST',
          body: JSON.stringify({ name: 'No Email' }),
        },
      );
      expect(status).toBe(400);
      expect(body.error).toContain('Email');
    });

    it('GET /api/users/:userId returns user by ID', async () => {
      const email = `e2e-api-get-${Date.now()}@test.local`;
      const { body: createBody } = await createUser(email, 'Get Test');

      const { status, body } = await apiJson<{ user: { id: string; email: string } }>(
        `/api/users/${createBody.user.id}`,
      );
      expect(status).toBe(200);
      expect(body.user.email).toBe(email);
    });

    it('GET /api/users/:email returns user by email', async () => {
      const email = `e2e-api-byemail-${Date.now()}@test.local`;
      await createUser(email, 'Email Lookup');

      const { status, body } = await apiJson<{ user: { email: string } }>(
        `/api/users/${encodeURIComponent(email)}`,
      );
      expect(status).toBe(200);
      expect(body.user.email).toBe(email);
    });

    it('GET /api/users/:unknown returns 404', async () => {
      const { status } = await apiJson('/api/users/00000000-0000-0000-0000-000000000000');
      expect(status).toBe(404);
    });
  });

  // =========================================================================
  // c. SSE endpoint
  // =========================================================================

  describe('SSE endpoint', () => {
    it('GET /api/events/stream/:userId connects and receives initial event', async () => {
      const email = `e2e-sse-${Date.now()}@test.local`;
      const { body: createBody } = await createUser(email, 'SSE User');
      const userId = createBody.user.id;

      // Use AbortController to close the SSE connection after we read enough
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const res = await fetch(`${BASE}/api/events/stream/${userId}`, {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' },
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');

        // Read the first chunk (should contain the 'connected' event)
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let accumulated = '';
        let foundConnected = false;

        // Read up to 3 chunks or until we find the connected event
        for (let i = 0; i < 3; i++) {
          const { value, done } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });

          if (accumulated.includes('event: connected')) {
            foundConnected = true;
            break;
          }
        }

        reader.cancel();
        expect(foundConnected).toBe(true);
        expect(accumulated).toContain(`"userId":"${userId}"`);
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    });
  });

  // =========================================================================
  // d. Approval lifecycle
  // =========================================================================

  describe('Approval lifecycle', () => {
    it('full cycle: ingest event -> creates approval -> respond -> verify', async () => {
      const email = `e2e-approval-${Date.now()}@test.local`;
      const { body: createBody } = await createUser(email, 'Approval Lifecycle');
      const userId = createBody.user.id;

      // Set trust tier to observer so the system will escalate for approval
      await api(`/api/users/${userId}/trust-tier`, {
        method: 'PUT',
        body: JSON.stringify({ trustTier: 'observer' }),
      });

      // Ingest an event
      const { status: ingestStatus, body: ingestBody } = await apiJson<{
        decision: { id: string; domain: string };
        outcome: { requiresApproval: boolean; autoExecute: boolean };
        approval: { id: string; status: string } | null;
      }>('/api/events/ingest', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          type: 'email_received',
          source: 'gmail',
          data: {
            from: 'client@example.com',
            subject: 'Urgent: Contract renewal',
            body: 'Please review the attached contract.',
          },
        }),
      });

      expect(ingestStatus).toBe(200);
      expect(ingestBody.decision.id).toBeDefined();

      // Check pending approvals for the user
      const { status: pendingStatus, body: pendingBody } = await apiJson<{
        approvals: Array<{
          id: string;
          decisionId: string;
          status: string;
        }>;
      }>(`/api/approvals/${userId}/pending`);

      expect(pendingStatus).toBe(200);
      // There should be at least the approval from our ingest (if system created one)
      // or the pending list might be empty if the event was auto-executed.
      // We handle both cases for robustness.

      if (ingestBody.approval) {
        // System escalated -- verify the approval shows up in pending
        const found = pendingBody.approvals.find(
          (a) => a.id === ingestBody.approval!.id,
        );
        expect(found).toBeDefined();
        expect(found!.status).toBe('pending');

        // Respond to the approval
        const { status: respondStatus, body: respondBody } = await apiJson<{
          requestId: string;
          action: string;
          approval: { status: string };
        }>(`/api/approvals/${ingestBody.approval.id}/respond`, {
          method: 'POST',
          body: JSON.stringify({
            action: 'approve',
            userId,
            reason: 'Looks good, proceed',
          }),
        });

        expect(respondStatus).toBe(200);
        expect(respondBody.action).toBe('approve');
        expect(respondBody.approval.status).toBe('approved');

        // Double-respond should return 409
        const { status: doubleStatus } = await apiJson(
          `/api/approvals/${ingestBody.approval.id}/respond`,
          {
            method: 'POST',
            body: JSON.stringify({
              action: 'reject',
              userId,
              reason: 'Changed my mind',
            }),
          },
        );
        expect(doubleStatus).toBe(409);

        // Verify it appears in history
        const { body: historyBody } = await apiJson<{
          approvals: Array<{ id: string; status: string }>;
        }>(`/api/approvals/${userId}/history`);

        const inHistory = historyBody.approvals.find(
          (a) => a.id === ingestBody.approval!.id,
        );
        expect(inHistory).toBeDefined();
        expect(inHistory!.status).toBe('approved');
      } else {
        // System auto-executed (high trust / low risk)
        expect(ingestBody.outcome.autoExecute).toBe(true);
      }
    });

    it('respond to non-existent approval returns 404', async () => {
      const email = `e2e-approval-404-${Date.now()}@test.local`;
      const { body: createBody } = await createUser(email, 'Approval 404');

      const { status } = await apiJson(
        '/api/approvals/00000000-0000-0000-0000-000000000000/respond',
        {
          method: 'POST',
          body: JSON.stringify({
            action: 'approve',
            userId: createBody.user.id,
          }),
        },
      );
      expect(status).toBe(404);
    });

    it('respond without required fields returns 400', async () => {
      const { status } = await apiJson(
        '/api/approvals/some-id/respond',
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
      expect(status).toBe(400);
    });
  });

  // =========================================================================
  // e. Policy CRUD
  // =========================================================================

  describe('Policy CRUD', () => {
    let policyUserId: string;
    let policyId: string;

    beforeAll(async () => {
      const email = `e2e-policy-${Date.now()}@test.local`;
      const { body } = await createUser(email, 'Policy User');
      policyUserId = body.user.id;
    });

    it('POST /api/policies/:userId creates a policy', async () => {
      const { status, body } = await apiJson<{
        id: string;
        name: string;
        domain: string;
        rules: unknown[];
        priority: number;
        isActive: boolean;
      }>(`/api/policies/${policyUserId}`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'No auto-purchases over $50',
          domain: 'shopping',
          rules: [
            { type: 'spend_limit', maxCents: 5000 },
            { type: 'require_approval', condition: 'always' },
          ],
          priority: 10,
        }),
      });

      expect(status).toBe(201);
      expect(body.name).toBe('No auto-purchases over $50');
      expect(body.domain).toBe('shopping');
      expect(body.priority).toBe(10);
      expect(body.isActive).toBe(true);
      expect(body.rules).toHaveLength(2);

      policyId = body.id;
      createdPolicyIds.push({ userId: policyUserId, policyId });
    });

    it('GET /api/policies/:userId lists policies', async () => {
      const { status, body } = await apiJson<{
        policies: Array<{ id: string; name: string; domain: string }>;
      }>(`/api/policies/${policyUserId}`);

      expect(status).toBe(200);
      expect(body.policies.length).toBeGreaterThanOrEqual(1);

      const found = body.policies.find((p) => p.id === policyId);
      expect(found).toBeDefined();
      expect(found!.name).toBe('No auto-purchases over $50');
    });

    it('GET /api/policies/:userId?domain=shopping filters by domain', async () => {
      // Create another policy in a different domain
      const { body: emailPolicy } = await apiJson<{ id: string }>(
        `/api/policies/${policyUserId}`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: 'Auto-reply to newsletters',
            domain: 'email',
            rules: [{ type: 'auto_reply', template: 'unsubscribe' }],
          }),
        },
      );
      createdPolicyIds.push({ userId: policyUserId, policyId: emailPolicy.id });

      const { body: shoppingPolicies } = await apiJson<{
        policies: Array<{ id: string; domain: string }>;
      }>(`/api/policies/${policyUserId}?domain=shopping`);

      expect(shoppingPolicies.policies.every((p) => p.domain === 'shopping')).toBe(true);
    });

    it('PUT /api/policies/:userId/:policyId updates a policy', async () => {
      const { status, body } = await apiJson<{
        id: string;
        name: string;
        priority: number;
      }>(`/api/policies/${policyUserId}/${policyId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: 'No auto-purchases over $100',
          priority: 20,
        }),
      });

      expect(status).toBe(200);
      expect(body.name).toBe('No auto-purchases over $100');
      expect(body.priority).toBe(20);
    });

    it('DELETE /api/policies/:userId/:policyId soft-deletes a policy', async () => {
      // Create a policy we can delete
      const { body: toDelete } = await apiJson<{ id: string }>(
        `/api/policies/${policyUserId}`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: 'Temporary policy',
            domain: 'travel',
            rules: [],
          }),
        },
      );

      const deleteRes = await api(
        `/api/policies/${policyUserId}/${toDelete.id}`,
        { method: 'DELETE' },
      );
      expect(deleteRes.status).toBe(204);

      // Verify it no longer appears in active list
      const { body: afterDelete } = await apiJson<{
        policies: Array<{ id: string }>;
      }>(`/api/policies/${policyUserId}?domain=travel`);

      const found = afterDelete.policies.find((p) => p.id === toDelete.id);
      expect(found).toBeUndefined();
    });

    it('POST /api/policies/:userId without name returns 400', async () => {
      const { status, body } = await apiJson<{ error: string }>(
        `/api/policies/${policyUserId}`,
        {
          method: 'POST',
          body: JSON.stringify({ domain: 'email' }),
        },
      );
      expect(status).toBe(400);
      expect(body.error).toContain('name');
    });

    it('POST /api/policies/:userId without domain returns 400', async () => {
      const { status, body } = await apiJson<{ error: string }>(
        `/api/policies/${policyUserId}`,
        {
          method: 'POST',
          body: JSON.stringify({ name: 'Missing domain' }),
        },
      );
      expect(status).toBe(400);
      expect(body.error).toContain('domain');
    });

    it('PUT /api/policies/:userId/:nonexistent returns 404', async () => {
      const { status } = await apiJson(
        `/api/policies/${policyUserId}/00000000-0000-0000-0000-000000000000`,
        {
          method: 'PUT',
          body: JSON.stringify({ name: 'Ghost' }),
        },
      );
      expect(status).toBe(404);
    });
  });

  // =========================================================================
  // f. Policy safety kernel — Safety Invariant #1 end-to-end
  //
  // Issue #80 follow-ups: prove that no auto-execution path bypasses the
  // policy check, and that the approval gate actually blocks execution
  // until the user approves.
  // =========================================================================

  describe('Policy safety kernel', () => {
    it('blocks execution when a deny policy matches every candidate', async () => {
      const email = `e2e-policy-block-${Date.now()}@test.local`;
      const { body: createBody } = await createUser(email, 'Policy Block User');
      const userId = createBody.user.id;

      // Promote to high autonomy so trust tier alone wouldn't gate execution.
      // The deny policy is the only thing that should block.
      await api(`/api/users/${userId}/trust-tier`, {
        method: 'PUT',
        body: JSON.stringify({ trustTier: 'high_autonomy' }),
      });

      // Create a deny-everything policy on the calendar domain. The evaluator
      // resolves field 'domain' from CandidateAction, so this matches every
      // calendar candidate the engine generates.
      const { status: policyStatus, body: policyBody } = await apiJson<{ id: string }>(
        `/api/policies/${userId}`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: 'Block all calendar actions (e2e)',
            domain: 'calendar',
            rules: [
              {
                effect: 'deny',
                condition: { field: 'domain', operator: 'eq', value: 'calendar' },
              },
            ],
            priority: 1000,
          }),
        },
      );
      expect(policyStatus).toBe(201);
      createdPolicyIds.push({ userId, policyId: policyBody.id });

      // Ingest a calendar event. The engine should generate calendar
      // candidates, all of which are blocked by the deny policy.
      const { status: ingestStatus, body: ingestBody } = await apiJson<{
        decision: { id: string };
        outcome: {
          selectedAction: { actionType: string; description: string } | null;
          autoExecute: boolean;
          requiresApproval: boolean;
        };
        execution: unknown | null;
        approval: unknown | null;
      }>('/api/events/ingest', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          type: 'calendar_event',
          source: 'google_calendar',
          data: { title: 'Weekly standup', time: '09:00' },
        }),
      });

      expect(ingestStatus).toBe(200);
      // Safety Invariant #1: when policy denies every candidate, no action is
      // selected and no execution path runs.
      expect(ingestBody.outcome.selectedAction).toBeNull();
      expect(ingestBody.outcome.autoExecute).toBe(false);
      expect(ingestBody.execution).toBeNull();
      expect(ingestBody.approval).toBeNull();
    });

    it('approval gate blocks execution until the user approves', async () => {
      const email = `e2e-approval-gate-${Date.now()}@test.local`;
      const { body: createBody } = await createUser(email, 'Approval Gate User');
      const userId = createBody.user.id;

      // Observer trust tier forces every action to escalate for approval.
      await api(`/api/users/${userId}/trust-tier`, {
        method: 'PUT',
        body: JSON.stringify({ trustTier: 'observer' }),
      });

      // Ingest an event. Should produce an approval, NOT an execution.
      const { status: ingestStatus, body: ingestBody } = await apiJson<{
        decision: { id: string };
        outcome: { autoExecute: boolean; requiresApproval: boolean };
        execution: unknown | null;
        approval: { id: string; status: string } | null;
      }>('/api/events/ingest', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          type: 'email_received',
          source: 'gmail',
          data: {
            from: 'client@example.com',
            subject: 'Quick question about the contract',
            body: 'Could you take a look when you get a chance?',
          },
        }),
      });

      expect(ingestStatus).toBe(200);
      expect(ingestBody.execution).toBeNull();

      // If the engine produced an approval, exercise the gate. If it didn't
      // (e.g. the engine couldn't generate a candidate at all), the test still
      // proves "no execution before approval" — that's the invariant.
      if (ingestBody.approval) {
        expect(ingestBody.outcome.requiresApproval).toBe(true);
        expect(ingestBody.outcome.autoExecute).toBe(false);
        expect(ingestBody.approval.status).toBe('pending');

        // Capture decisions count BEFORE approval.
        const { body: beforeDecisions } = await apiJson<{ total: number }>(
          `/api/decisions/${userId}`,
        );
        const beforeTotal = beforeDecisions.total;

        // Approve the action.
        const { status: respondStatus } = await apiJson<{ approval: { status: string } }>(
          `/api/approvals/${ingestBody.approval.id}/respond`,
          {
            method: 'POST',
            body: JSON.stringify({ action: 'approve', userId, reason: 'Looks good.' }),
          },
        );
        expect(respondStatus).toBe(200);

        // Decision count should not regress and should be at least the same
        // (approval flow may or may not synchronously create another row).
        const { body: afterDecisions } = await apiJson<{ total: number }>(
          `/api/decisions/${userId}`,
        );
        expect(afterDecisions.total).toBeGreaterThanOrEqual(beforeTotal);
      } else {
        // Engine couldn't escalate — at minimum verify autoExecute stayed off
        // (observer trust tier should never auto-execute).
        expect(ingestBody.outcome.autoExecute).toBe(false);
      }
    });
  });

  // =========================================================================
  // Bonus: decisions listing
  // =========================================================================

  describe('Decisions listing', () => {
    it('GET /api/decisions/:userId returns decisions for a user', async () => {
      const email = `e2e-decisions-${Date.now()}@test.local`;
      const { body: createBody } = await createUser(email, 'Decisions User');
      const userId = createBody.user.id;

      // Ingest an event so there is at least one decision
      await api('/api/events/ingest', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          type: 'calendar_event',
          source: 'google_calendar',
          data: { title: 'Team standup', time: '09:00' },
        }),
      });

      const { status, body } = await apiJson<{
        decisions: Array<{ id: string; domain: string }>;
        total: number;
      }>(`/api/decisions/${userId}`);

      expect(status).toBe(200);
      expect(body.decisions.length).toBeGreaterThanOrEqual(1);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });
  });
});
