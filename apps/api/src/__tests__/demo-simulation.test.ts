import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import express from 'express';
import type { Express } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SampleSimulationStateResponse } from '@skytwin/shared-types';
import {
  _resetDemoSessionLifecycleForTests,
  DEMO_USER_ID,
  inspectDemoSession,
  inspectDemoSessionForDiscard,
  issueDemoSession,
  revokeDemoSession,
} from '../auth/demo-session.js';
import type { DemoFixtureIncarnation } from '../auth/demo-session.js';
import { createDemoSimulationRouter } from '../routes/demo-simulation.js';
import { SampleSimulationService } from '../services/sample-simulation.js';

const TEST_FIXTURE = {
  userId: DEMO_USER_ID,
  revision: 'demo-fixture-test-v1',
} as const;

function buildApp(
  service = new SampleSimulationService(),
  isSampleAvailable: (
    expected: DemoFixtureIncarnation,
  ) => Promise<boolean> = async () => true,
): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/demo/simulation', createDemoSimulationRouter(service, isSampleAvailable));
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: error.message });
    },
  );
  return app;
}

async function request(
  app: Express,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; cacheControl: string | null }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine test server port.'));
        return;
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const encodedBody = body === undefined ? '' : JSON.stringify(body);
      if (encodedBody)
        headers['Content-Length'] = String(Buffer.byteLength(encodedBody));
      const clientRequest = httpRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path,
          method,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const parsed = raw ? JSON.parse(raw) : null;
            server.close();
            resolve({
              status: response.statusCode ?? 0,
              body: parsed,
              cacheControl:
                typeof response.headers['cache-control'] === 'string'
                  ? response.headers['cache-control']
                  : null,
            });
          });
        },
      );
      clientRequest.on('error', (error) => {
        server.close();
        reject(error);
      });
      if (encodedBody) clientRequest.write(encodedBody);
      clientRequest.end();
    });
  });
}

function asState(body: unknown): SampleSimulationStateResponse {
  return body as SampleSimulationStateResponse;
}

describe('isolated sample simulation', () => {
  beforeEach(() => {
    _resetDemoSessionLifecycleForTests();
    process.env['SESSION_SECRET'] = 'sample-simulation-test-secret';
  });

  it('requires a valid signed sample session and never caches responses', async () => {
    const app = buildApp();
    const missing = await request(app, 'GET', '/api/v1/demo/simulation');
    expect(missing.status).toBe(401);

    const valid = await request(
      app,
      'GET',
      '/api/v1/demo/simulation',
      issueDemoSession(TEST_FIXTURE).token,
    );
    expect(valid.status).toBe(200);
    expect(valid.cacheControl).toBe('no-store');
  });

  it('revokes simulation access when the sample identity marker is removed', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/demo/simulation',
      createDemoSimulationRouter(
        new SampleSimulationService(),
        async () => false,
      ),
    );
    const denied = await request(
      app,
      'GET',
      '/api/v1/demo/simulation',
      issueDemoSession(TEST_FIXTURE).token,
    );
    expect(denied.status).toBe(401);
    expect(denied.body).toMatchObject({
      error: expect.stringMatching(/no longer available/i),
    });
  });

  it.each([
    ['the reserved row is deleted and recreated', 'demo-fixture-test-v2'],
    ['the marker is cleared and re-enabled', 'demo-fixture-test-v3'],
  ])('rejects an issued credential before its first simulation request when %s', async (_scenario, revision) => {
    let currentRevision: string = TEST_FIXTURE.revision;
    const observedProofs: DemoFixtureIncarnation[] = [];
    const service = new SampleSimulationService();
    const app = buildApp(service, async (expected) => {
      observedProofs.push(expected);
      return expected.revision === currentRevision;
    });
    const issued = issueDemoSession(TEST_FIXTURE);
    const identity = inspectDemoSessionForDiscard(issued.token)!;
    currentRevision = revision;

    const denied = await request(
      app,
      'GET',
      '/api/v1/demo/simulation',
      issued.token,
    );

    expect(denied.status).toBe(401);
    expect(observedProofs).toEqual([TEST_FIXTURE]);
    expect(inspectDemoSession(issued.token)).toBeNull();
    expect(service.hasSessionForTests(identity.sessionKey)).toBe(false);
  });

  it('discards state when sample authority disappears during response preparation', async () => {
    const service = new SampleSimulationService();
    let checks = 0;
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/demo/simulation',
      createDemoSimulationRouter(service, async () => {
        checks += 1;
        return checks === 1;
      }),
    );
    const issued = issueDemoSession(TEST_FIXTURE);
    const identity = inspectDemoSessionForDiscard(issued.token)!;

    const denied = await request(
      app,
      'GET',
      '/api/v1/demo/simulation',
      issued.token,
    );

    expect(denied.status).toBe(401);
    expect(checks).toBe(2);
    expect(service.hasSessionForTests(identity.sessionKey)).toBe(false);
  });

  it('keeps a failed command retryable when the final fixture check throws', async () => {
    let checks = 0;
    let failFinalCheck = true;
    const service = new SampleSimulationService();
    const app = buildApp(service, async () => {
      checks += 1;
      if (failFinalCheck && checks === 2) throw new Error('transient final fixture check');
      return true;
    });
    const issued = issueDemoSession(TEST_FIXTURE);
    const session = inspectDemoSession(issued.token)!;
    const command = { type: 'approve' as const, proposalId: 'calendar-focus' as const };
    const failed = await request(
      app, 'POST', '/api/v1/demo/simulation/commands', issued.token, command,
    );
    expect(failed.status).toBe(500);
    const unchanged = await service.getState(
      session.sessionKey, session.expiresAtMs, undefined, session.signal,
    );
    expect(unchanged.revision).toBe(0);
    expect(unchanged.proposals.find((item) => item.id === 'calendar-focus')?.status)
      .toBe('pending');

    failFinalCheck = false;
    const retried = await request(
      app, 'POST', '/api/v1/demo/simulation/commands', issued.token, command,
    );
    expect(retried.status).toBe(200);
    expect(asState(retried.body).revision).toBe(1);
  });

  it('keeps prior state when a reset final fixture check throws', async () => {
    let checks = 0;
    let failFinalCheck = true;
    const service = new SampleSimulationService();
    const issued = issueDemoSession(TEST_FIXTURE);
    const session = inspectDemoSession(issued.token)!;
    await service.command(
      session.sessionKey,
      session.expiresAtMs,
      {
        type: 'correct',
        proposalId: 'focus-time-preference',
        correctionId: 'prefer-afternoons',
      },
      undefined,
      session.signal,
    );
    const app = buildApp(service, async () => {
      checks += 1;
      if (failFinalCheck && checks === 2) throw new Error('transient final fixture check');
      return true;
    });
    const failed = await request(
      app, 'POST', '/api/v1/demo/simulation/commands', issued.token, { type: 'reset' },
    );
    expect(failed.status).toBe(500);
    const unchanged = await service.getState(
      session.sessionKey, session.expiresAtMs, undefined, session.signal,
    );
    expect(unchanged.revision).toBe(1);
    expect(unchanged.learning).toEqual([{
      key: 'preferred_focus_window',
      value: 'afternoon',
      source: 'corrected',
    }]);

    failFinalCheck = false;
    const retried = await request(
      app, 'POST', '/api/v1/demo/simulation/commands', issued.token, { type: 'reset' },
    );
    expect(retried.status).toBe(200);
    expect(asState(retried.body)).toMatchObject({ revision: 0, learning: [] });
  });

  it('keeps a discarded credential tombstoned instead of recreating its state', async () => {
    const service = new SampleSimulationService();
    const app = buildApp(service);
    const issued = issueDemoSession(TEST_FIXTURE);
    expect(
      (await request(app, 'GET', '/api/v1/demo/simulation', issued.token))
        .status,
    ).toBe(200);
    expect(
      (await request(app, 'DELETE', '/api/v1/demo/simulation', issued.token))
        .status,
    ).toBe(204);

    const replay = await request(
      app,
      'GET',
      '/api/v1/demo/simulation',
      issued.token,
    );
    expect(replay.status).toBe(401);
    const identity = inspectDemoSessionForDiscard(issued.token)!;
    expect(service.hasSessionForTests(identity.sessionKey)).toBe(false);
  });

  it('does not return state when discard wins the final availability await', async () => {
    let checks = 0;
    let releaseFinalCheck!: () => void;
    const finalCheck = new Promise<void>((resolve) => {
      releaseFinalCheck = resolve;
    });
    const service = new SampleSimulationService();
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/demo/simulation',
      createDemoSimulationRouter(service, async () => {
        checks += 1;
        if (checks === 2) await finalCheck;
        return true;
      }),
    );
    const issued = issueDemoSession(TEST_FIXTURE);
    const pending = request(
      app,
      'GET',
      '/api/v1/demo/simulation',
      issued.token,
    );
    await vi.waitFor(() => expect(checks).toBe(2));
    const discarded = await request(
      app,
      'DELETE',
      '/api/v1/demo/simulation',
      issued.token,
    );
    expect(discarded.status).toBe(204);
    releaseFinalCheck();

    expect((await pending).status).toBe(401);
  });

  it('cancels service work when the exact session authority is revoked', async () => {
    let releasePolicy!: (value: {
      allowed: boolean;
      requiresApproval: boolean;
      reason: string;
    }) => void;
    const policyResult = new Promise<{
      allowed: boolean;
      requiresApproval: boolean;
      reason: string;
    }>((resolve) => {
      releasePolicy = resolve;
    });
    const service = new SampleSimulationService({
      evaluate: vi.fn(() => policyResult),
    });
    const issued = issueDemoSession(TEST_FIXTURE);
    const session = inspectDemoSession(issued.token)!;
    const pending = service.command(
      session.sessionKey,
      session.expiresAtMs,
      { type: 'approve', proposalId: 'calendar-focus' },
      undefined,
      session.signal,
    );
    revokeDemoSession(issued.token);
    releasePolicy({
      allowed: true,
      requiresApproval: true,
      reason: 'Deferred test policy.',
    });

    await expect(pending).rejects.toMatchObject({ statusCode: 401 });
    expect(service.hasSessionForTests(session.sessionKey)).toBe(false);
  });

  it('completes approve, reject, correct, and learn without network access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error(
          'Provider/network access is forbidden in sample simulation.',
        );
      }),
    );
    const service = new SampleSimulationService();
    const app = buildApp(service);
    const token = issueDemoSession(TEST_FIXTURE).token;

    const initial = asState(
      (await request(app, 'GET', '/api/v1/demo/simulation', token)).body,
    );
    expect(initial.mode).toBe('simulation');
    expect(initial.proposals.map((item) => item.actionType)).toEqual([
      'decline_event',
      'archive_email',
      'schedule_focus_block',
      'shell_exec',
    ]);
    expect(
      initial.proposals.filter((item) => item.status === 'pending'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policy: expect.objectContaining({
            allowed: true,
            requiresApproval: true,
          }),
        }),
      ]),
    );
    expect(
      initial.proposals
        .filter((item) => item.status === 'pending')
        .every((item) => item.policy.allowed && item.policy.requiresApproval),
    ).toBe(true);
    expect(
      initial.proposals.find((item) => item.id === 'calendar-focus'),
    ).toMatchObject({
      provenance: 'untrusted_external',
      policy: { confirmationLevel: 'single' },
    });
    expect(initial.nextPrediction).toMatchObject({
      changedByLearning: false,
      proposedAction: expect.stringContaining('9:00'),
    });

    const approved = asState(
      (
        await request(app, 'POST', '/api/v1/demo/simulation/commands', token, {
          type: 'approve',
          proposalId: 'calendar-focus',
        })
      ).body,
    );
    expect(
      approved.proposals.find((item) => item.id === 'calendar-focus'),
    ).toMatchObject({
      status: 'simulated_approved',
      simulationOnly: true,
      externalEffects: false,
    });

    const rejected = asState(
      (
        await request(app, 'POST', '/api/v1/demo/simulation/commands', token, {
          type: 'reject',
          proposalId: 'newsletter-triage',
        })
      ).body,
    );
    expect(
      rejected.proposals.find((item) => item.id === 'newsletter-triage')
        ?.status,
    ).toBe('simulated_rejected');

    const corrected = asState(
      (
        await request(app, 'POST', '/api/v1/demo/simulation/commands', token, {
          type: 'correct',
          proposalId: 'focus-time-preference',
          correctionId: 'prefer-afternoons',
        })
      ).body,
    );
    expect(corrected.learning).toEqual([
      {
        key: 'preferred_focus_window',
        value: 'afternoon',
        source: 'corrected',
      },
    ]);
    expect(corrected.nextPrediction).toMatchObject({
      changedByLearning: true,
      proposedAction: expect.stringContaining('2:00'),
    });
    const correctedFocus = corrected.proposals.find(
      (item) => item.id === 'focus-time-preference',
    );
    expect(correctedFocus?.proposedAction).toContain('9:00');
    expect(correctedFocus?.explanation.preferences).toEqual([]);
    expect(
      corrected.proposals.find((item) => item.id === 'calendar-focus')
        ?.explanation,
    ).toEqual(
      initial.proposals.find((item) => item.id === 'calendar-focus')
        ?.explanation,
    );
    expect(
      corrected.proposals.find((item) => item.id === 'newsletter-triage')
        ?.explanation.preferences,
    ).toEqual([]);
    expect(
      corrected.proposals
        .filter((item) => item.id !== 'focus-time-preference')
        .every((item) => item.explanation.preferences.length === 0),
    ).toBe(true);
    expect(corrected.revision).toBe(3);
  });

  it('fails missing provenance safe and exposes no approval path for containment', async () => {
    const app = buildApp();
    const token = issueDemoSession(TEST_FIXTURE).token;
    const state = asState(
      (await request(app, 'GET', '/api/v1/demo/simulation', token)).body,
    );
    const contained = state.proposals.find(
      (item) => item.id === 'untrusted-document',
    );
    expect(contained).toMatchObject({
      status: 'contained',
      provenance: 'untrusted_external',
      allowedCommands: [],
      externalEffects: false,
      policy: {
        requiresApproval: true,
        confirmationLevel: 'dual',
      },
    });
    expect(contained?.provenanceNote).toMatch(/missing|failed safe/i);
    expect(contained?.resultMessage).toMatch(/no approval path/i);

    const attempted = await request(
      app,
      'POST',
      '/api/v1/demo/simulation/commands',
      token,
      { type: 'approve', proposalId: 'untrusted-document' },
    );
    expect(attempted.status).toBe(400);
  });

  it('rejects unenumerated commands, corrections, fields, and repeated transitions', async () => {
    const app = buildApp();
    const token = issueDemoSession(TEST_FIXTURE).token;
    for (const body of [
      { type: 'execute', proposalId: 'calendar-focus' },
      { type: 'approve', proposalId: 'not-in-catalog' },
      {
        type: 'correct',
        proposalId: 'focus-time-preference',
        correctionId: 'anything',
      },
      {
        type: 'reject',
        proposalId: 'newsletter-triage',
        userId: 'another-user',
      },
    ]) {
      const response = await request(
        app,
        'POST',
        '/api/v1/demo/simulation/commands',
        token,
        body,
      );
      expect(response.status).toBe(400);
    }

    await request(app, 'POST', '/api/v1/demo/simulation/commands', token, {
      type: 'reject',
      proposalId: 'newsletter-triage',
    });
    const repeated = await request(
      app,
      'POST',
      '/api/v1/demo/simulation/commands',
      token,
      { type: 'approve', proposalId: 'newsletter-triage' },
    );
    expect(repeated.status).toBe(409);
  });

  it('serializes simultaneous approvals into one transition', async () => {
    const app = buildApp();
    const token = issueDemoSession(TEST_FIXTURE).token;
    const responses = await Promise.all([
      request(app, 'POST', '/api/v1/demo/simulation/commands', token, {
        type: 'approve',
        proposalId: 'calendar-focus',
      }),
      request(app, 'POST', '/api/v1/demo/simulation/commands', token, {
        type: 'approve',
        proposalId: 'calendar-focus',
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
  });

  it('cannot resurrect a record when reset wins an in-flight policy check', async () => {
    let resolvePolicy!: (value: {
      allowed: boolean;
      requiresApproval: boolean;
      reason: string;
      confirmationLevel: 'single';
    }) => void;
    const policyResult = new Promise<{
      allowed: boolean;
      requiresApproval: boolean;
      reason: string;
      confirmationLevel: 'single';
    }>((resolve) => {
      resolvePolicy = resolve;
    });
    const service = new SampleSimulationService({
      evaluate: vi.fn(() => policyResult),
    });
    const expiresAtMs = Date.now() + 60_000;
    const approval = service.command('reset-race', expiresAtMs, {
      type: 'approve',
      proposalId: 'calendar-focus',
    });
    const reset = service.command('reset-race', expiresAtMs, { type: 'reset' });
    resolvePolicy({
      allowed: true,
      requiresApproval: true,
      reason: 'Deferred test policy requires approval.',
      confirmationLevel: 'single',
    });

    await expect(approval).rejects.toMatchObject({ statusCode: 409 });
    const resetState = await reset;
    expect(resetState.revision).toBe(0);
    expect(
      resetState.proposals.find((item) => item.id === 'calendar-focus')?.status,
    ).toBe('pending');
  });

  it('cannot resurrect a discarded record after an in-flight policy check', async () => {
    let resolvePolicy!: (value: {
      allowed: boolean;
      requiresApproval: boolean;
      reason: string;
    }) => void;
    const policyResult = new Promise<{
      allowed: boolean;
      requiresApproval: boolean;
      reason: string;
    }>((resolve) => {
      resolvePolicy = resolve;
    });
    const service = new SampleSimulationService({
      evaluate: vi.fn(() => policyResult),
    });
    const expiresAtMs = Date.now() + 60_000;
    const approval = service.command('discard-race', expiresAtMs, {
      type: 'approve',
      proposalId: 'calendar-focus',
    });
    service.discard('discard-race');
    resolvePolicy({
      allowed: true,
      requiresApproval: true,
      reason: 'Deferred test policy requires approval.',
    });

    await expect(approval).rejects.toMatchObject({ statusCode: 409 });
    expect(service.hasSessionForTests('discard-race')).toBe(false);
  });

  it('does not return a stale read or reset after discard wins asynchronous presentation', async () => {
    let resolvePolicy!: (value: {
      allowed: boolean;
      requiresApproval: boolean;
      reason: string;
    }) => void;
    const policyResult = new Promise<{
      allowed: boolean;
      requiresApproval: boolean;
      reason: string;
    }>((resolve) => {
      resolvePolicy = resolve;
    });
    const service = new SampleSimulationService({
      evaluate: vi.fn(() => policyResult),
    });
    const expiresAtMs = Date.now() + 60_000;
    const read = service.getState('discarded-read', expiresAtMs);
    const reset = service.command('discarded-reset', expiresAtMs, {
      type: 'reset',
    });
    service.discard('discarded-read');
    service.discard('discarded-reset');
    resolvePolicy({
      allowed: true,
      requiresApproval: true,
      reason: 'Deferred test policy.',
    });

    await expect(read).rejects.toMatchObject({ statusCode: 409 });
    await expect(reset).rejects.toMatchObject({ statusCode: 409 });
    expect(service.hasSessionForTests('discarded-read')).toBe(false);
    expect(service.hasSessionForTests('discarded-reset')).toBe(false);
  });

  it('rejects expiry before creation and after an in-flight policy check', async () => {
    let now = 0;
    let resolvePolicy!: (value: {
      allowed: boolean;
      requiresApproval: boolean;
      reason: string;
    }) => void;
    const policyResult = new Promise<{
      allowed: boolean;
      requiresApproval: boolean;
      reason: string;
    }>((resolve) => {
      resolvePolicy = resolve;
    });
    const service = new SampleSimulationService(
      { evaluate: vi.fn(() => policyResult) },
      1_000,
      () => now,
    );

    await expect(
      service.getState('already-expired', 10, 10),
    ).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(service.hasSessionForTests('already-expired')).toBe(false);

    const command = service.command('expires-in-flight', 10, {
      type: 'approve',
      proposalId: 'calendar-focus',
    });
    now = 10;
    resolvePolicy({
      allowed: true,
      requiresApproval: true,
      reason: 'Deferred policy result.',
    });
    await expect(command).rejects.toMatchObject({ statusCode: 401 });
    expect(service.hasSessionForTests('expires-in-flight')).toBe(false);
  });

  it('rejects expiry during reset and final command rendering without committing', async () => {
    let resetNow = 0;
    const resetService = new SampleSimulationService(
      {
        evaluate: vi.fn(async () => {
          resetNow = 10;
          return {
            allowed: true,
            requiresApproval: true,
            reason: 'Test policy.',
          };
        }),
      },
      1_000,
      () => resetNow,
    );
    await expect(
      resetService.command('reset-expiry', 10, { type: 'reset' }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(resetService.hasSessionForTests('reset-expiry')).toBe(false);

    let commandNow = 0;
    let calls = 0;
    const commandService = new SampleSimulationService(
      {
        evaluate: vi.fn(async () => {
          calls += 1;
          if (calls === 2) commandNow = 10;
          return {
            allowed: true,
            requiresApproval: true,
            reason: 'Test policy.',
          };
        }),
      },
      1_000,
      () => commandNow,
    );
    await expect(
      commandService.command('command-expiry', 10, {
        type: 'approve',
        proposalId: 'calendar-focus',
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(commandService.hasSessionForTests('command-expiry')).toBe(false);
  });

  it('does not commit a command when final presentation fails', async () => {
    let calls = 0;
    const evaluate = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('render failed');
      return { allowed: true, requiresApproval: true, reason: 'Test policy.' };
    });
    const service = new SampleSimulationService({ evaluate });
    const expiresAtMs = Date.now() + 60_000;
    await expect(
      service.command('atomic-render', expiresAtMs, {
        type: 'approve',
        proposalId: 'calendar-focus',
      }),
    ).rejects.toThrow('render failed');
    evaluate.mockResolvedValue({
      allowed: true,
      requiresApproval: true,
      reason: 'Test policy.',
    });
    const state = await service.getState('atomic-render', expiresAtMs);
    expect(
      state.proposals.find((item) => item.id === 'calendar-focus')?.status,
    ).toBe('pending');
  });

  it('refuses hostile capacity churn without evicting active sessions', async () => {
    const service = new SampleSimulationService(undefined, 2);
    const expiresAtMs = Date.now() + 60_000;
    await service.getState('first-active', expiresAtMs);
    await service.getState('second-active', expiresAtMs);

    await expect(
      service.getState('hostile-overflow', expiresAtMs),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(service.hasSessionForTests('first-active')).toBe(true);
    expect(service.hasSessionForTests('second-active')).toBe(true);
    expect(service.hasSessionForTests('hostile-overflow')).toBe(false);
  });

  it('maps state-creation capacity exhaustion to HTTP 429 on GET', async () => {
    const service = new SampleSimulationService(undefined, 1);
    const app = buildApp(service);
    const first = issueDemoSession(TEST_FIXTURE).token;
    const second = issueDemoSession(TEST_FIXTURE).token;
    expect(
      (await request(app, 'GET', '/api/v1/demo/simulation', first)).status,
    ).toBe(200);
    const overflow = await request(
      app,
      'GET',
      '/api/v1/demo/simulation',
      second,
    );
    expect(overflow.status).toBe(429);
    expect(overflow.body).toMatchObject({
      error: expect.stringMatching(/busy/i),
    });
  });

  it('hides and rejects approval when the policy evaluator denies it', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      allowed: false,
      requiresApproval: false,
      reason: 'Denied by injected test policy.',
    });
    const service = new SampleSimulationService({ evaluate });
    const expiresAtMs = Date.now() + 60_000;
    const state = await service.getState('denied-policy-session', expiresAtMs);
    const proposal = state.proposals.find(
      (item) => item.id === 'calendar-focus',
    );
    expect(proposal?.allowedCommands).not.toContain('approve');
    expect(proposal?.allowedCommands).toContain('reject');
    await expect(
      service.command('denied-policy-session', expiresAtMs, {
        type: 'approve',
        proposalId: 'calendar-focus',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('isolates learning by credential and removes it on reset, exit, and expiry cleanup', async () => {
    const service = new SampleSimulationService();
    const app = buildApp(service);
    const first = issueDemoSession(TEST_FIXTURE);
    const second = issueDemoSession(TEST_FIXTURE);
    await request(
      app,
      'POST',
      '/api/v1/demo/simulation/commands',
      first.token,
      {
        type: 'correct',
        proposalId: 'focus-time-preference',
        correctionId: 'prefer-afternoons',
      },
    );
    expect(
      asState(
        (await request(app, 'GET', '/api/v1/demo/simulation', second.token))
          .body,
      ).learning,
    ).toEqual([]);

    const reset = asState(
      (
        await request(
          app,
          'POST',
          '/api/v1/demo/simulation/commands',
          first.token,
          {
            type: 'reset',
          },
        )
      ).body,
    );
    expect(reset.learning).toEqual([]);
    expect(reset.revision).toBe(0);

    const exited = await request(
      app,
      'DELETE',
      '/api/v1/demo/simulation',
      first.token,
    );
    expect(exited.status).toBe(204);

    const expired = issueDemoSession(TEST_FIXTURE, Date.now() - 4 * 60 * 60 * 1000 - 1);
    const expiredIdentity = inspectDemoSessionForDiscard(expired.token)!;
    await service.getState(expiredIdentity.sessionKey, Date.now() + 60_000);
    expect(service.hasSessionForTests(expiredIdentity.sessionKey)).toBe(true);
    const expiredExit = await request(
      app,
      'DELETE',
      '/api/v1/demo/simulation',
      expired.token,
    );
    expect(expiredExit.status).toBe(204);
    expect(service.hasSessionForTests(expiredIdentity.sessionKey)).toBe(false);

    let cleanupNow = 0;
    const cleanupService = new SampleSimulationService(
      undefined,
      1_000,
      () => cleanupNow,
    );
    await cleanupService.getState('expired-key', 10);
    expect(cleanupService.hasSessionForTests('expired-key')).toBe(true);
    cleanupNow = 11;
    await cleanupService.getState('current-key', 20);
    expect(cleanupService.hasSessionForTests('expired-key')).toBe(false);
  });

  it('keeps forbidden infrastructure out of the simulation command import boundary', () => {
    const serviceSource = readFileSync(
      new URL('../services/sample-simulation.ts', import.meta.url),
      'utf8',
    );
    const routeSource = readFileSync(
      new URL('../routes/demo-simulation.ts', import.meta.url),
      'utf8',
    );
    const source = `${serviceSource}\n${routeSource}`;
    for (const forbidden of [
      '@skytwin/db',
      '@skytwin/connectors',
      '@skytwin/credential-vault',
      '@skytwin/llm-client',
      '@skytwin/execution-router',
      '@skytwin/ironclaw-adapter',
      'credentialRepository',
      'sessionRepository',
      'createOAuthRouter',
      'fetch(',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
