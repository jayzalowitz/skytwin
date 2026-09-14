import { afterEach, expect, it, vi } from 'vitest';
import { ConfidenceLevel, resolveActionProvenance } from '@skytwin/shared-types';
import type { CandidateAction } from '@skytwin/shared-types';
import { OpenClawAdapter } from '../openclaw-adapter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function action(): CandidateAction {
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    actionType: 'revoke_token',
    description: 'Revoke a credential from an MCP-origin request',
    domain: 'credentials',
    parameters: { userId: 'user-1' },
    estimatedCostCents: 0,
    reversible: false,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Adversarial source-checkout regression',
    provenance: resolveActionProvenance('mcp_tool'),
  };
}

it('adv-v1-openclaw-credential-schema rejects malicious metadata', async () => {
  const onCredentialNeeded = vi.fn();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    credential_required: { integration: '../SECRET_MARKER', label: 'Credential' },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  const adapter = new OpenClawAdapter({
    apiUrl: 'http://localhost:9000',
    onCredentialNeeded,
  });
  const plan = await adapter.buildPlan(action());
  expect(plan.action).toMatchObject({
    actionType: 'revoke_token',
    reversible: false,
    provenance: 'untrusted_external',
  });

  const error = await adapter.execute(plan).catch((caught) => caught);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('openclaw_response_invalid');
  expect(String(error)).not.toContain('SECRET_MARKER');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onCredentialNeeded).not.toHaveBeenCalled();
});
