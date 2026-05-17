import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvalResult } from '@skytwin/decision-engine';

const mockClient = { query: vi.fn() };
const mockWithTransaction = vi.fn(async (fn: (c: typeof mockClient) => unknown) =>
  fn(mockClient),
);
const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (fn: (c: typeof mockClient) => unknown) => mockWithTransaction(fn),
}));

const { draftEmailEvalRunsRepository } = await import(
  '../repositories/draft-email-eval-runs-repository.js'
);

function makeResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    corpusSize: 50,
    voicePassRate: 0.9,
    topicalPassRate: 0.85,
    lengthPassRate: 0.95,
    overallPassRate: 0.82,
    passed: true,
    thresholds: {
      voiceJaccardMin: 0.25,
      topicalJaccardMin: 0.3,
      lengthSigmaMax: 2,
      overallPassRateMin: 0.8,
    },
    notes: 'ok',
    pairs: [],
    ...overrides,
  };
}

describe('draftEmailEvalRunsRepository.recordRun (#301)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.query.mockReset();
  });

  it('inserts the run inside a transaction and stamps drafts_eval_passed_at when result.passed=true', async () => {
    mockClient.query
      .mockResolvedValueOnce({
        rows: [{ id: 'r-1', user_id: 'u-1', passed: true }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const row = await draftEmailEvalRunsRepository.recordRun({
      userId: 'u-1',
      result: makeResult({ passed: true }),
    });
    expect(row.id).toBe('r-1');
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenCalledTimes(2);

    const [insertSql] = mockClient.query.mock.calls[0]!;
    expect(insertSql).toContain('INSERT INTO draft_email_eval_runs');
    expect(insertSql).toContain('RETURNING *');

    const [updateSql, updateParams] = mockClient.query.mock.calls[1]!;
    expect(updateSql).toContain('UPDATE twin_profiles');
    expect(updateSql).toContain('SET drafts_eval_passed_at = now()');
    expect(updateParams).toEqual(['u-1']);
  });

  it('skips the twin_profiles update when result.passed=false', async () => {
    // Only the INSERT runs — no UPDATE. The pass timestamp stays
    // null (or at its prior value if a previous run passed).
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 'r-1', user_id: 'u-1', passed: false }],
      rowCount: 1,
    });
    await draftEmailEvalRunsRepository.recordRun({
      userId: 'u-1',
      result: makeResult({ passed: false }),
    });
    expect(mockClient.query).toHaveBeenCalledTimes(1);
    const [sql] = mockClient.query.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO draft_email_eval_runs');
  });

  it('serializes thresholds as JSONB string', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ id: 'r-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await draftEmailEvalRunsRepository.recordRun({
      userId: 'u-1',
      result: makeResult({ passed: true }),
    });
    const [, params] = mockClient.query.mock.calls[0]!;
    // Position 6 (0-indexed) is the thresholds slot per the SQL.
    expect(typeof params[6]).toBe('string');
    expect(JSON.parse(params[6])).toMatchObject({ voiceJaccardMin: 0.25 });
  });
});

describe('draftEmailEvalRunsRepository.getLatestForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the most-recent run for the user, newest first', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'r-latest', passed: true }],
      rowCount: 1,
    });
    const row = await draftEmailEvalRunsRepository.getLatestForUser('u-1');
    expect(row?.id).toBe('r-latest');
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('ORDER BY ran_at DESC');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual(['u-1']);
  });

  it('returns null when no runs exist', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await draftEmailEvalRunsRepository.getLatestForUser('u-1')).toBeNull();
  });
});

describe('draftEmailEvalRunsRepository.listForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns up to `limit` rows for the user, newest first', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'r-3' }, { id: 'r-2' }, { id: 'r-1' }],
      rowCount: 3,
    });
    const rows = await draftEmailEvalRunsRepository.listForUser('u-1', 3);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.id).toBe('r-3');
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params).toEqual(['u-1', 3]);
  });

  it('defaults to limit=20 when none supplied', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await draftEmailEvalRunsRepository.listForUser('u-1');
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params).toEqual(['u-1', 20]);
  });
});
