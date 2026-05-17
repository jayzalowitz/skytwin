import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { explanationRepository } = await import(
  '../repositories/explanation-repository.js'
);

describe('explanationRepository.create — capabilityProvenanceNodeId (#305)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the column when capabilityProvenanceNodeId is provided', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'e-1', capability_provenance_node_id: 'cpn-1' }],
      rowCount: 1,
    });
    await explanationRepository.create({
      decisionId: '11111111-1111-1111-1111-111111111111',
      whatHappened: 'did the thing',
      confidenceReasoning: 'because',
      actionRationale: 'because',
      correctionGuidance: 'try this',
      capabilityProvenanceNodeId: 'cpn-1',
    });
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('capability_provenance_node_id');
    // 9 params now (was 8 pre-#305).
    expect(params).toHaveLength(9);
    // Last param is the new column value.
    expect(params[8]).toBe('cpn-1');
  });

  it('writes NULL for the column when capabilityProvenanceNodeId is omitted (engine-originated action)', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'e-1', capability_provenance_node_id: null }],
      rowCount: 1,
    });
    await explanationRepository.create({
      decisionId: '22222222-2222-2222-2222-222222222222',
      whatHappened: 'did another thing',
      confidenceReasoning: 'because',
      actionRationale: 'because',
      correctionGuidance: 'try this',
      // capabilityProvenanceNodeId omitted
    });
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params[8]).toBeNull();
  });

  it('writes NULL when capabilityProvenanceNodeId is explicitly null', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'e-1', capability_provenance_node_id: null }],
      rowCount: 1,
    });
    await explanationRepository.create({
      decisionId: '33333333-3333-3333-3333-333333333333',
      whatHappened: 'thing',
      confidenceReasoning: 'b',
      actionRationale: 'b',
      correctionGuidance: 'b',
      capabilityProvenanceNodeId: null,
    });
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params[8]).toBeNull();
  });
});
