import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { briefingRepository } = await import('../repositories/briefing-repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('briefingRepository.getLatestPerLifebook — #320', () => {
  it('uses DISTINCT ON (domain_name) + ORDER BY domain_name, generated_at DESC', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await briefingRepository.getLatestPerLifebook('u-1');
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('DISTINCT ON (domain_name)');
    expect(sql).toContain('domain_name IS NOT NULL');
    expect(sql).toContain('ORDER BY domain_name, generated_at DESC');
    expect(sql).not.toContain('cadence');
    expect(params).toEqual(['u-1']);
  });

  it('adds the cadence filter when provided', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await briefingRepository.getLatestPerLifebook('u-1', 'weekly');
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('cadence = $2');
    expect(params).toEqual(['u-1', 'weekly']);
  });

  it('returns the rows the query produces (one per domain)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'b-1', user_id: 'u-1', domain_name: 'Health', cadence: 'daily', prose_markdown: 'A' },
        { id: 'b-2', user_id: 'u-1', domain_name: 'Work', cadence: 'daily', prose_markdown: 'B' },
      ],
      rowCount: 2,
    });
    const result = await briefingRepository.getLatestPerLifebook('u-1');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.domain_name)).toEqual(['Health', 'Work']);
  });

  it('returns an empty array when no per-Lifebook briefings exist', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await briefingRepository.getLatestPerLifebook('u-new');
    expect(result).toEqual([]);
  });

  it('NEVER returns rows with domain_name IS NULL (global briefings stay separate)', async () => {
    // The SQL has WHERE domain_name IS NOT NULL — pin it so a future
    // refactor can't accidentally fold global briefings in as sections,
    // which would duplicate them with the parent `briefing` field on
    // the same /latest response.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await briefingRepository.getLatestPerLifebook('u-1');
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toMatch(/domain_name\s+IS\s+NOT\s+NULL/);
  });
});
