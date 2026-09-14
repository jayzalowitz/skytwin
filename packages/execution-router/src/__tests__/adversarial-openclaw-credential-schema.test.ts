import { afterEach, expect, it, vi } from 'vitest';
import { ConfidenceLevel, resolveActionProvenance } from '@skytwin/shared-types';
import type { CandidateAction } from '@skytwin/shared-types';
import { OpenClawAdapter } from '../openclaw-adapter.js';

const mappedScenario = {
  runtimeEntryPath: 'execution_router.openclaw_response',
  adapter: 'openclaw',
  criticalShape: 'credential',
  action: { actionType: 'revoke_token', reversible: false, parameters: { userId: 'user-1' } },
  origin: { kind: 'mcp', source: 'mcp_tool' },
  provenance: 'untrusted_external',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

function action(): CandidateAction {
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    ...mappedScenario.action,
    description: 'Revoke a credential from an MCP-origin request',
    domain: 'credentials',
    estimatedCostCents: 0,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Adversarial source-checkout regression',
    provenance: resolveActionProvenance(mappedScenario.origin.source),
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
  // Execution ownership is router-authored in production. Bind the same
  // trusted context here so this regression reaches credential metadata
  // validation instead of failing earlier at the owner boundary.
  plan.executionOwnerId = 'user-1';
  expect({
    runtimeEntryPath: mappedScenario.runtimeEntryPath,
    adapter: mappedScenario.adapter,
    criticalShape: mappedScenario.criticalShape,
    action: {
      actionType: plan.action.actionType,
      reversible: plan.action.reversible,
      parameters: plan.action.parameters,
    },
    origin: mappedScenario.origin,
    provenance: plan.action.provenance,
  }).toEqual(mappedScenario);

  const error = await adapter.execute(plan).catch((caught) => caught);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('outcome is ambiguous');
  expect(String(error)).not.toContain('SECRET_MARKER');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onCredentialNeeded).not.toHaveBeenCalled();
  await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
});
