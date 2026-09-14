import { afterEach, expect, it, vi } from 'vitest';
import { ConfidenceLevel, resolveActionProvenance } from '@skytwin/shared-types';
import type { CandidateAction } from '@skytwin/shared-types';
import { RealIronClawAdapter } from '../real-adapter.js';

const mappedScenario = {
  runtimeEntryPath: 'ironclaw_adapter.execute',
  adapter: 'ironclaw',
  criticalShape: 'send',
  action: { actionType: 'send_email', reversible: false, parameters: { userId: 'user_1' } },
  origin: { kind: 'email', source: 'gmail', authoringTier: 'inbox_automated' },
  provenance: 'untrusted_external',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

function action(): CandidateAction {
  return {
    id: 'act-1',
    decisionId: 'decision-1',
    ...mappedScenario.action,
    description: 'Send an email from an untrusted inbound trigger',
    domain: 'email',
    estimatedCostCents: 0,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Adversarial source-checkout regression',
    provenance: resolveActionProvenance(
      mappedScenario.origin.source,
      mappedScenario.origin.authoringTier,
    ),
  };
}

it('adv-v1-ironclaw-transport-ambiguous never retries an uncertain send', async () => {
  let executePosts = 0;
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { metadata?: { message_type?: string } };
    if (body.metadata?.message_type === 'execute') {
      executePosts += 1;
      if (executePosts === 1) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({
        content: 'A retry would duplicate the send',
        attachments: [],
        metadata: { status: 'completed' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('Status endpoint unavailable');
  });
  vi.stubGlobal('fetch', fetchMock);
  const adapter = new RealIronClawAdapter({
    apiUrl: 'http://localhost:4000',
    webhookSecret: 'test-secret-key',
    ownerId: 'test-owner',
    maxRetries: 2,
  });
  const candidate = action();
  expect({
    runtimeEntryPath: mappedScenario.runtimeEntryPath,
    adapter: mappedScenario.adapter,
    criticalShape: mappedScenario.criticalShape,
    action: {
      actionType: candidate.actionType,
      reversible: candidate.reversible,
      parameters: candidate.parameters,
    },
    origin: mappedScenario.origin,
    provenance: candidate.provenance,
  }).toEqual(mappedScenario);
  const plan = await adapter.buildPlan(candidate);

  await expect(adapter.execute(plan)).rejects.toThrow('ECONNREFUSED');

  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
  expect(executePosts).toBe(1);
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  const body = JSON.parse(String(init.body)) as {
    metadata: { message_type: string; action: { type: string; reversible: boolean } };
  };
  expect(body.metadata.message_type).toBe('execute');
  expect(body.metadata.action).toMatchObject({ type: 'send_email', reversible: false });
});
