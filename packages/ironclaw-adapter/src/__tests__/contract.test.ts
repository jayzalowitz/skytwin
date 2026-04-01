import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type { CandidateAction } from '@skytwin/shared-types';
import { RealIronClawAdapter } from '../real-adapter.js';
import { MockIronClawAdapter } from '../mock-adapter.js';
import { MockIronClawServer } from './mock-ironclaw-server.js';

/**
 * Contract tests: verify that MockIronClawAdapter and RealIronClawAdapter
 * produce compatible outputs for the same inputs.
 *
 * Both implement execute(plan) -> ExecutionResult and rollback(planId) -> RollbackResult.
 * The RealIronClawAdapter also has buildPlan(action) -> ExecutionPlan.
 * The MockIronClawAdapter expects plans to be passed directly to execute().
 *
 * These tests verify:
 * 1. buildPlan (real adapter) produces valid ExecutionPlan structure
 * 2. execute returns an ExecutionResult with required fields from both
 * 3. rollback returns a RollbackResult with success/message from both
 * 4. healthCheck works on both
 * 5. HMAC authentication works against the mock server
 */

const WEBHOOK_SECRET = 'test-contract-secret-key';

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action-contract-1',
    decisionId: 'decision-contract-1',
    actionType: 'send_email',
    description: 'Send a test email',
    domain: 'email',
    parameters: { to: 'test@example.com', subject: 'Contract Test' },
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Contract test action',
    ...overrides,
  };
}

describe('IronClaw Adapter Contract Tests', () => {
  let mockServer: MockIronClawServer;
  let realAdapter: RealIronClawAdapter;
  let mockAdapter: MockIronClawAdapter;

  beforeAll(async () => {
    mockServer = new MockIronClawServer({ webhookSecret: WEBHOOK_SECRET });
    await mockServer.start();

    realAdapter = new RealIronClawAdapter({
      apiUrl: mockServer.url,
      webhookSecret: WEBHOOK_SECRET,
      ownerId: 'contract-test-owner',
      channelId: 'contract-test',
      timeoutMs: 5000,
      maxRetries: 0,
    });

    mockAdapter = new MockIronClawAdapter({
      simulateDelays: false,
      failureProbability: 0,
    });
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.reset();
    mockAdapter.reset();
  });

  describe('buildPlan contract (real adapter)', () => {
    it('produces a valid ExecutionPlan structure', async () => {
      const action = makeAction();
      const plan = await realAdapter.buildPlan(action);

      expect(plan.id).toBeDefined();
      expect(typeof plan.id).toBe('string');
      expect(plan.decisionId).toBe(action.decisionId);
      expect(plan.action).toBe(action);
      expect(Array.isArray(plan.steps)).toBe(true);
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(Array.isArray(plan.rollbackSteps)).toBe(true);
      expect(plan.createdAt).toBeInstanceOf(Date);
    });

    it('reversible action produces rollback steps', async () => {
      const action = makeAction({ reversible: true });
      const plan = await realAdapter.buildPlan(action);

      expect(plan.rollbackSteps.length).toBeGreaterThan(0);
      expect(plan.rollbackSteps[0]!.type).toContain('rollback');
    });

    it('irreversible action produces no rollback steps', async () => {
      const action = makeAction({ reversible: false });
      const plan = await realAdapter.buildPlan(action);

      expect(plan.rollbackSteps).toHaveLength(0);
    });

    it('step parameters include action metadata', async () => {
      const action = makeAction();
      const plan = await realAdapter.buildPlan(action);

      const step = plan.steps[0]!;
      expect(step.type).toBe(action.actionType);
      expect(step.description).toBe(action.description);
      expect(step.parameters['actionType']).toBe('send_email');
      expect(step.parameters['domain']).toBe('email');
    });
  });

  describe('execute contract', () => {
    it('both adapters return ExecutionResult with required fields', async () => {
      const action = makeAction();
      const plan = await realAdapter.buildPlan(action);

      const realResult = await realAdapter.execute(plan);
      const mockResult = await mockAdapter.execute(plan);

      for (const result of [realResult, mockResult]) {
        expect(result.planId).toBeDefined();
        expect(typeof result.planId).toBe('string');
        expect(['completed', 'failed', 'pending', 'running']).toContain(result.status);
        expect(result.startedAt).toBeInstanceOf(Date);
      }
    });

    it('successful execution returns completed status from both', async () => {
      const action = makeAction();
      const plan = await realAdapter.buildPlan(action);

      const realResult = await realAdapter.execute(plan);
      const mockResult = await mockAdapter.execute(plan);

      expect(realResult.status).toBe('completed');
      expect(mockResult.status).toBe('completed');
      expect(realResult.completedAt).toBeInstanceOf(Date);
      expect(mockResult.completedAt).toBeInstanceOf(Date);
    });

    it('successful execution produces output object', async () => {
      const action = makeAction();
      const plan = await realAdapter.buildPlan(action);

      const realResult = await realAdapter.execute(plan);
      const mockResult = await mockAdapter.execute(plan);

      expect(realResult.output).toBeDefined();
      expect(typeof realResult.output).toBe('object');
      expect(mockResult.output).toBeDefined();
      expect(typeof mockResult.output).toBe('object');
    });

    it('failed execution returns error field from real adapter', async () => {
      mockServer.setNextResponse({
        content: 'Action failed: permission denied',
        thread_id: 'thread_fail',
        attachments: [],
        metadata: {
          status: 'failed',
          error: 'Permission denied',
        },
      });

      const action = makeAction();
      const plan = await realAdapter.buildPlan(action);
      const result = await realAdapter.execute(plan);

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });

  describe('rollback contract', () => {
    it('both adapters return RollbackResult with required fields', async () => {
      const action = makeAction({ reversible: true });
      const plan = await realAdapter.buildPlan(action);

      // Execute via both, then rollback
      await realAdapter.execute(plan);
      const realRollback = await realAdapter.rollback(plan.id);

      await mockAdapter.execute(plan);
      const mockRollback = await mockAdapter.rollback(plan.id);

      for (const result of [realRollback, mockRollback]) {
        expect(typeof result.success).toBe('boolean');
        expect(typeof result.message).toBe('string');
        expect(result.message.length).toBeGreaterThan(0);
      }
    });

    it('rollback of unexecuted plan fails from mock adapter', async () => {
      const result = await mockAdapter.rollback('nonexistent-plan');
      expect(result.success).toBe(false);
      expect(result.message).toContain('No execution');
    });
  });

  describe('healthCheck contract', () => {
    it('real adapter returns { healthy, latencyMs } from mock server', async () => {
      const result = await realAdapter.healthCheck();

      expect(typeof result.healthy).toBe('boolean');
      expect(typeof result.latencyMs).toBe('number');
      expect(result.healthy).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('real adapter reports unhealthy when server is down', async () => {
      mockServer.setHealthy(false);
      const result = await realAdapter.healthCheck();
      expect(result.healthy).toBe(false);
    });
  });

  describe('HMAC authentication', () => {
    it('mock server receives messages with valid HMAC signatures', async () => {
      const action = makeAction();
      const plan = await realAdapter.buildPlan(action);
      await realAdapter.execute(plan);

      expect(mockServer.receivedMessages.length).toBe(1);
      const msg = mockServer.receivedMessages[0]!;
      expect(msg.owner_id).toBe('contract-test-owner');
      expect(msg.channel).toBe('contract-test');
      expect(msg.metadata['skytwin']).toBe(true);
      expect(msg.metadata['message_type']).toBe('execute');
    });

    it('execution message carries structured action metadata', async () => {
      const action = makeAction({ actionType: 'archive_email', domain: 'email' });
      const plan = await realAdapter.buildPlan(action);
      await realAdapter.execute(plan);

      const msg = mockServer.receivedMessages[0]!;
      const actionMeta = msg.metadata['action'] as Record<string, unknown>;
      expect(actionMeta['type']).toBe('archive_email');
      expect(actionMeta['domain']).toBe('email');
      expect(actionMeta['reversible']).toBe(true);
    });

    it('rollback message carries plan_id and rollback message_type', async () => {
      const action = makeAction();
      const plan = await realAdapter.buildPlan(action);
      await realAdapter.execute(plan);
      await realAdapter.rollback(plan.id);

      expect(mockServer.receivedMessages.length).toBe(2);
      const rollbackMsg = mockServer.receivedMessages[1]!;
      expect(rollbackMsg.metadata['message_type']).toBe('rollback');
      expect(rollbackMsg.metadata['plan_id']).toBe(plan.id);
    });
  });
});
