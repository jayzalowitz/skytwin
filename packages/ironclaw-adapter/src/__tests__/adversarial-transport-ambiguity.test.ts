import { afterEach, expect, it, vi } from 'vitest';
import { ConfidenceLevel, resolveActionProvenance } from '@skytwin/shared-types';
import type { CandidateAction } from '@skytwin/shared-types';
import { RealIronClawAdapter } from '../real-adapter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function action(): CandidateAction {
  return {
    id: 'act-1',
    decisionId: 'decision-1',
    actionType: 'send_email',
    description: 'Send an email from an untrusted inbound trigger',
    domain: 'email',
    parameters: { userId: 'user-1' },
    estimatedCostCents: 0,
    reversible: false,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Adversarial source-checkout regression',
    provenance: resolveActionProvenance('gmail', 'inbox_automated'),
  };
}

it('adv-v1-ironclaw-transport-ambiguous never retries an uncertain send', async () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  vi.stubGlobal('fetch', fetchMock);
  const adapter = new RealIronClawAdapter({
    apiUrl: 'http://localhost:4000',
    webhookSecret: 'test-secret-key',
    ownerId: 'test-owner',
    maxRetries: 0,
  });
  const candidate = action();
  expect(candidate).toMatchObject({
    actionType: 'send_email',
    reversible: false,
    provenance: 'untrusted_external',
  });
  const plan = await adapter.buildPlan(candidate);

  await expect(adapter.execute(plan)).rejects.toThrow('ECONNREFUSED');

  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(adapter.getStatus(plan.id)).resolves.toBe('running');
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  const body = JSON.parse(String(init.body)) as {
    metadata: { action: { type: string; reversible: boolean } };
  };
  expect(body.metadata.action).toMatchObject({ type: 'send_email', reversible: false });
});
