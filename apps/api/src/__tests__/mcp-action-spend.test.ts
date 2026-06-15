import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CandidateAction } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

const mockGetById = vi.fn();
const mockCreate = vi.fn();

vi.mock('@skytwin/db', () => ({
  mcpServerRepository: {
    getById: (...args: unknown[]) => mockGetById(...args),
  },
  spendRepository: {
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

const { recordMcpActionSpend } = await import('../mcp-action-spend.js');

function makeAction(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    actionType: 'send_message',
    description: 'Post a message via the Slack MCP server',
    domain: 'communication',
    parameters: {},
    estimatedCostCents: 50,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'test',
    ...overrides,
  };
}

describe('recordMcpActionSpend (#323 AC#3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ id: 'spend-1' });
  });

  it('records spend tagged with the resolved registry_id when the action targets a known MCP server', async () => {
    mockGetById.mockResolvedValue({ id: 'srv-uuid-1', registry_id: 'slack-mcp' });

    await recordMcpActionSpend({
      userId: 'user-1',
      decisionId: 'decision-1',
      action: makeAction({ parameters: { mcpServerId: 'srv-uuid-1' } }),
    });

    expect(mockGetById).toHaveBeenCalledWith('srv-uuid-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      userId: 'user-1',
      actionId: 'action-1',
      decisionId: 'decision-1',
      estimatedCostCents: 50,
      registryId: 'slack-mcp',
    });
  });

  it('records spend with registryId undefined (→ NULL, user-global only) when the action has no MCP server source', async () => {
    await recordMcpActionSpend({
      userId: 'user-1',
      decisionId: 'decision-1',
      action: makeAction({ parameters: {} }),
    });

    // Never tries to resolve a server when there's no mcpServerId.
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0]![0];
    expect(call.registryId).toBeUndefined();
    expect(call.estimatedCostCents).toBe(50);
  });

  it('records with registryId undefined when the resolved server row has no registry_id', async () => {
    // Locally-defined MCP server with no registry entry — its spend
    // rolls into the user-global total only, never a per-app total.
    mockGetById.mockResolvedValue({ id: 'srv-local', registry_id: null });

    await recordMcpActionSpend({
      userId: 'user-1',
      decisionId: 'decision-1',
      action: makeAction({ parameters: { mcpServerId: 'srv-local' } }),
    });

    expect(mockGetById).toHaveBeenCalledWith('srv-local');
    expect(mockCreate.mock.calls[0]![0].registryId).toBeUndefined();
  });

  it('records with registryId undefined when the server row is gone', async () => {
    mockGetById.mockResolvedValue(null);

    await recordMcpActionSpend({
      userId: 'user-1',
      decisionId: 'decision-1',
      action: makeAction({ parameters: { mcpServerId: 'srv-missing' } }),
    });

    expect(mockCreate.mock.calls[0]![0].registryId).toBeUndefined();
  });

  it('skips zero-cost actions — no ledger noise, no server lookup', async () => {
    await recordMcpActionSpend({
      userId: 'user-1',
      decisionId: 'decision-1',
      action: makeAction({ estimatedCostCents: 0, parameters: { mcpServerId: 'srv-uuid-1' } }),
    });

    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips negative / non-finite cost actions (defensive)', async () => {
    await recordMcpActionSpend({
      userId: 'user-1',
      decisionId: 'decision-1',
      action: makeAction({ estimatedCostCents: -10 }),
    });
    await recordMcpActionSpend({
      userId: 'user-1',
      decisionId: 'decision-1',
      action: makeAction({ estimatedCostCents: Number.NaN }),
    });

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('ignores a non-string mcpServerId parameter and records as user-global', async () => {
    await recordMcpActionSpend({
      userId: 'user-1',
      decisionId: 'decision-1',
      // A malformed parameter (e.g. number) must not be passed to getById.
      action: makeAction({ parameters: { mcpServerId: 12345 } }),
    });

    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockCreate.mock.calls[0]![0].registryId).toBeUndefined();
  });

  it('swallows repository errors — the already-executed action must not surface a ledger failure', async () => {
    mockGetById.mockResolvedValue({ id: 'srv-uuid-1', registry_id: 'slack-mcp' });
    mockCreate.mockRejectedValue(new Error('db down'));

    // Must resolve, not reject.
    await expect(
      recordMcpActionSpend({
        userId: 'user-1',
        decisionId: 'decision-1',
        action: makeAction({ parameters: { mcpServerId: 'srv-uuid-1' } }),
      }),
    ).resolves.toBeUndefined();
  });
});
