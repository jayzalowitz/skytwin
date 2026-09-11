import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfidenceLevel } from '@skytwin/shared-types';
import type { CandidateAction, ExecutionPlan } from '@skytwin/shared-types';
import { OpenClawAdapter } from '../openclaw-adapter.js';
import type { OpenClawCredentialRequirement } from '../openclaw-adapter.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn> & ((...args: any[]) => any);

// ── Test helpers ─────────────────────────────────────────────────────

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    actionType: 'social_media_post',
    description: 'Post a tweet about the launch',
    domain: 'social',
    parameters: { content: 'Hello world', platform: 'twitter', userId: 'user-1' },
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'User requested a social media post',
    ...overrides,
  };
}

async function buildPlanFromAdapter(
  adapter: OpenClawAdapter,
  actionOverrides: Partial<CandidateAction> = {},
): Promise<ExecutionPlan> {
  const action = makeAction(actionOverrides);
  return adapter.buildPlan(action);
}

/** Create a Response-like object for fetch mock */
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('OpenClawAdapter credential_required handling', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it('does not expose a peer response body on HTTP failure', async () => {
    const adapter = new OpenClawAdapter({ apiUrl: 'http://localhost:9000' });
    fetchMock.mockResolvedValueOnce(new Response('SECRET_MARKER provider echo', { status: 503 }));

    const result = await adapter.execute(await buildPlanFromAdapter(adapter));

    expect(result.status).toBe('failed');
    expect(result.error).toBe('openclaw_http_503');
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
  });

  it('returns a bounded known failure for an explicit failed 2xx response', async () => {
    const adapter = new OpenClawAdapter({ apiUrl: 'http://localhost:9000' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'failed', error: 'SECRET_MARKER' }));

    const result = await adapter.execute(await buildPlanFromAdapter(adapter));

    expect(result).toMatchObject({ status: 'failed', error: 'openclaw_execution_failed' });
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
  });

  describe('credential_required in response triggers callback', () => {
    it('calls onCredentialNeeded with the correct shape and returns a failed result', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            integration: 'twitter',
            label: 'Twitter / X',
            description: 'Post tweets',
            fields: [{ key: 'api_key', label: 'API Key', secret: true }],
            skills: ['social_media_post'],
          },
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);
      const result = await adapter.execute(plan);

      // Verify callback was called exactly once
      expect(onCredentialNeeded).toHaveBeenCalledTimes(1);

      // Verify the callback received the correct shape
      const requirement = onCredentialNeeded.mock
        .calls[0]![0] as OpenClawCredentialRequirement;
      expect(requirement.integration).toBe('twitter');
      expect(requirement.userId).toBe('user-1');
      expect(requirement.integrationLabel).toBe('Twitter / X');
      expect(requirement.description).toBe('Post tweets');
      expect(requirement.fields).toHaveLength(1);
      expect(requirement.fields[0]).toEqual({
        key: 'api_key',
        label: 'API Key',
        secret: true,
      });
      expect(requirement.skills).toEqual(['social_media_post']);

      // Verify the returned ExecutionResult
      expect(result.status).toBe('failed');
      expect(result.error).toBe('openclaw_credentials_required');
      expect(result.output).toBeDefined();
      expect(result.output!['credential_required']).toBe(true);
      expect(result.output!['integration']).toBe('social_media_post');
      expect(result.output!['adapter_used']).toBe('openclaw');
    });

    it('includes all credential fields in the callback', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            integration: 'slack',
            label: 'Slack',
            description: 'Send messages to Slack channels',
            fields: [
              { key: 'bot_token', label: 'Bot Token', secret: true },
              {
                key: 'channel_id',
                label: 'Default Channel',
                placeholder: '#general',
                secret: false,
                optional: true,
              },
            ],
            skills: ['send_message', 'post_update'],
          },
        }),
      );

      const plan = await buildPlanFromAdapter(adapter, {
        actionType: 'send_email',
      });
      await adapter.execute(plan);

      const requirement = onCredentialNeeded.mock
        .calls[0]![0] as OpenClawCredentialRequirement;
      expect(requirement.fields).toHaveLength(2);
      expect(requirement.fields[1]).toEqual({
        key: 'channel_id',
        label: 'Default Channel',
        placeholder: '#general',
        secret: false,
        optional: true,
      });
      expect(requirement.skills).toEqual(['send_message', 'post_update']);
    });
  });

  describe('untrusted credential schema', () => {
    it.each([
      { integration: 'github', label: 'GitHub', extra: 'SECRET_MARKER' },
      { integration: '../SECRET_MARKER', label: 'GitHub' },
      { integration: 'github', label: 'Bad\u0000SECRET_MARKER' },
      { integration: 'github', label: 'GitHub', fields: [{ key: 'token', label: 'Token', secret: true, extra: 'SECRET_MARKER' }] },
      { integration: 'github', label: 'GitHub', fields: Array.from({ length: 21 }, (_, index) => ({ key: `key_${index}`, label: 'Key', secret: true })) },
      { integration: 'github', label: 'GitHub', fields: [{ key: 'token', label: 'One', secret: true }, { key: 'token', label: 'Two', secret: true }] },
      { integration: 'github', label: 'GitHub', skills: ['../../SECRET_MARKER'] },
      { integration: 'github', label: 'GitHub', skills: ['create_issue', 'create_issue'] },
    ])('rejects malformed or oversized credential metadata without invoking a sink', async (credentialRequired) => {
      const onCredentialNeeded = vi.fn() as MockFn;
      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });
      fetchMock.mockResolvedValueOnce(jsonResponse({ credential_required: credentialRequired }));

      const error = await adapter.execute(await buildPlanFromAdapter(adapter)).catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('openclaw_response_invalid');
      expect(String(error)).not.toContain('SECRET_MARKER');
      expect(onCredentialNeeded).not.toHaveBeenCalled();
    });

    it('rejects credential notifications when the prepared action has no safe tenant id', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;
      const adapter = new OpenClawAdapter({ apiUrl: 'http://localhost:9000', onCredentialNeeded });
      fetchMock.mockResolvedValueOnce(jsonResponse({ credential_required: {} }));
      const plan = await buildPlanFromAdapter(adapter, { parameters: { content: 'hello' } });

      await expect(adapter.execute(plan)).rejects.toThrow('openclaw_response_invalid');
      expect(onCredentialNeeded).not.toHaveBeenCalled();
    });
  });

  describe('callback error is swallowed', () => {
    it('returns a failed result even when onCredentialNeeded throws synchronously', async () => {
      const onCredentialNeeded = vi.fn().mockImplementation(() => {
        throw new Error('DB connection failed');
      }) as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            integration: 'twitter',
            label: 'Twitter / X',
            fields: [{ key: 'api_key', label: 'API Key', secret: true }],
            skills: ['social_media_post'],
          },
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);

      // Should NOT throw, even though the callback threw
      const result = await adapter.execute(plan);

      expect(onCredentialNeeded).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('failed');
      expect(result.output!['credential_required']).toBe(true);
    });

    it('returns a failed result even when onCredentialNeeded rejects', async () => {
      const onCredentialNeeded = vi
        .fn()
        .mockRejectedValue(new Error('Async failure')) as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            integration: 'github',
            label: 'GitHub',
            fields: [{ key: 'token', label: 'Personal Access Token', secret: true }],
            skills: ['create_issue'],
          },
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);

      // Should NOT throw, even though the callback rejected
      const result = await adapter.execute(plan);

      expect(onCredentialNeeded).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('failed');
      expect(result.output!['credential_required']).toBe(true);
      expect(result.output!['integration']).toBe('social_media_post');
    });
  });

  describe('no callback provided', () => {
    it('fails closed when credential_required is present but no callback', async () => {
      // Create adapter WITHOUT onCredentialNeeded
      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            integration: 'twitter',
            label: 'Twitter / X',
            description: 'Post tweets',
            fields: [{ key: 'api_key', label: 'API Key', secret: true }],
            skills: ['social_media_post'],
          },
          // Response also includes other fields that would appear in a normal response
          message: 'ok',
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);
      const result = await adapter.execute(plan);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('openclaw_credentials_required');
      expect(result.output).toBeDefined();
      expect(result.output!['adapter_used']).toBe('openclaw');
      expect(result.output!['credential_required']).toBe(true);
    });

    it('fails closed when adapter is created with explicit undefined callback', async () => {
      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded: undefined,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            integration: 'twitter',
            label: 'Twitter',
            fields: [],
            skills: [],
          },
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);
      const result = await adapter.execute(plan);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('openclaw_credentials_required');
    });
  });

  describe('normal response without credential_required', () => {
    it('returns completed and does NOT call onCredentialNeeded', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          message: 'Tweet posted successfully',
          tweetId: 'tweet_abc123',
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);
      const result = await adapter.execute(plan);

      // Callback should NOT have been called
      expect(onCredentialNeeded).not.toHaveBeenCalled();

      // Result should be completed
      expect(result.status).toBe('completed');
      expect(result.output).toBeDefined();
      expect(result.output!['adapter_used']).toBe('openclaw');
      expect(result.output!['stepsCompleted']).toBe(1);
      expect(result.output!['tweetId']).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('Tweet posted successfully');
    });

    it.each([
      [{ status: 'completed', success: false, error: 'SECRET_MARKER' }],
      [{ status: 'running', output: 'SECRET_MARKER' }],
      [{ message: 'SECRET_MARKER' }],
    ])('rejects contradictory or nonconforming 2xx bodies without exposing them', async (body) => {
      const adapter = new OpenClawAdapter({ apiUrl: 'http://localhost:9000' });
      fetchMock.mockResolvedValueOnce(jsonResponse(body));

      const error = await adapter.execute(await buildPlanFromAdapter(adapter)).catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('openclaw_response_invalid');
      expect(String(error)).not.toContain('SECRET_MARKER');
    });

    it('does not trigger on null credential_required', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          credential_required: null,
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);
      const result = await adapter.execute(plan);

      expect(onCredentialNeeded).not.toHaveBeenCalled();
      expect(result.status).toBe('completed');
    });

    it('does not trigger on empty string credential_required', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          credential_required: '',
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);
      const result = await adapter.execute(plan);

      expect(onCredentialNeeded).not.toHaveBeenCalled();
      expect(result.status).toBe('completed');
    });

    it('does not trigger on false credential_required', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          credential_required: false,
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);
      const result = await adapter.execute(plan);

      expect(onCredentialNeeded).not.toHaveBeenCalled();
      expect(result.status).toBe('completed');
    });
  });

  describe('partial credential_required fields', () => {
    it('falls back integration to actionType when missing', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            // no integration field
            label: 'Unknown Service',
            fields: [{ key: 'token', label: 'Token', secret: true }],
          },
        }),
      );

      const plan = await buildPlanFromAdapter(adapter, {
        actionType: 'social_media_post',
      });
      const result = await adapter.execute(plan);

      expect(onCredentialNeeded).toHaveBeenCalledTimes(1);
      const requirement = onCredentialNeeded.mock
        .calls[0]![0] as OpenClawCredentialRequirement;

      // integration falls back to actionType
      expect(requirement.integration).toBe('social_media_post');
      expect(requirement.integrationLabel).toBe('Unknown Service');

      expect(result.status).toBe('failed');
    });

    it('falls back label to actionType when missing', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            integration: 'some_service',
            // no label field
            fields: [{ key: 'key', label: 'API Key', secret: true }],
          },
        }),
      );

      const plan = await buildPlanFromAdapter(adapter, {
        actionType: 'web_search',
      });
      const result = await adapter.execute(plan);

      expect(onCredentialNeeded).toHaveBeenCalledTimes(1);
      const requirement = onCredentialNeeded.mock
        .calls[0]![0] as OpenClawCredentialRequirement;

      // integrationLabel falls back to actionType
      expect(requirement.integrationLabel).toBe('web_search');
      expect(requirement.integration).toBe('some_service');

      // error message also falls back
      expect(result.error).toBe('openclaw_credentials_required');
      expect(result.status).toBe('failed');
    });

    it('defaults description to undefined when missing', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            integration: 'twitter',
            label: 'Twitter',
            // no description field
            fields: [{ key: 'api_key', label: 'API Key', secret: true }],
            skills: ['social_media_post'],
          },
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);
      await adapter.execute(plan);

      const requirement = onCredentialNeeded.mock
        .calls[0]![0] as OpenClawCredentialRequirement;
      expect(requirement.description).toBeUndefined();
    });

    it('defaults skills to [actionType] when missing', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            integration: 'twitter',
            label: 'Twitter / X',
            description: 'Post tweets',
            fields: [{ key: 'api_key', label: 'API Key', secret: true }],
            // no skills field
          },
        }),
      );

      const plan = await buildPlanFromAdapter(adapter, {
        actionType: 'social_media_post',
      });
      await adapter.execute(plan);

      const requirement = onCredentialNeeded.mock
        .calls[0]![0] as OpenClawCredentialRequirement;
      // skills falls back to [actionType]
      expect(requirement.skills).toEqual(['social_media_post']);
    });

    it('defaults fields to empty array when missing', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {
            integration: 'twitter',
            label: 'Twitter / X',
            // no fields
          },
        }),
      );

      const plan = await buildPlanFromAdapter(adapter);
      await adapter.execute(plan);

      const requirement = onCredentialNeeded.mock
        .calls[0]![0] as OpenClawCredentialRequirement;
      expect(requirement.fields).toEqual([]);
    });

    it('handles completely minimal credential_required object', async () => {
      const onCredentialNeeded = vi.fn() as MockFn;

      const adapter = new OpenClawAdapter({
        apiUrl: 'http://localhost:9000',
        onCredentialNeeded,
      });

      // Minimal: just an empty object (truthy) as credential_required
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          credential_required: {},
        }),
      );

      const plan = await buildPlanFromAdapter(adapter, {
        actionType: 'data_analysis',
      });
      const result = await adapter.execute(plan);

      expect(onCredentialNeeded).toHaveBeenCalledTimes(1);
      const requirement = onCredentialNeeded.mock
        .calls[0]![0] as OpenClawCredentialRequirement;

      // All fields should fall back to defaults
      expect(requirement.integration).toBe('data_analysis');
      expect(requirement.integrationLabel).toBe('data_analysis');
      expect(requirement.description).toBeUndefined();
      expect(requirement.fields).toEqual([]);
      expect(requirement.skills).toEqual(['data_analysis']);

      expect(result.status).toBe('failed');
      expect(result.output!['credential_required']).toBe(true);
    });
  });
});
