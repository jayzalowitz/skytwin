import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { lifebookRepository } = await import('../repositories/lifebook-repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('lifebookRepository.upsert — #321 override-respecting SET', () => {
  it('SQL includes the CASE that respects metadata.importanceOverride freshness', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'lb-1', importance: 'core', metadata: {} }],
      rowCount: 1,
    });

    await lifebookRepository.upsert({
      userId: 'u-1',
      domainName: 'Health',
      importance: 'emerging',
      sampleSignals: [],
      suggestedCapabilities: [],
      wingId: null,
    });

    const [sql, params] = mockQuery.mock.calls[0]!;
    // The CASE expression is the load-bearing line — when an override
    // exists AND (decayDays = 0 OR setAt is within the decay window),
    // the override value wins over EXCLUDED.importance.
    expect(sql).toContain('importance = CASE');
    expect(sql).toContain("lifebooks.metadata ? 'importanceOverride'");
    expect(sql).toContain("'decayDays')::int = 0");
    expect(sql).toContain("'setAt')::timestamptz");
    expect(sql).toContain("ELSE EXCLUDED.importance");
    expect(params).toEqual(['u-1', 'Health', 'emerging', '[]', '[]', null]);
  });

  it('always updates non-importance fields (signals, capabilities, wing, last_seen_at)', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'lb-2' }],
      rowCount: 1,
    });
    await lifebookRepository.upsert({
      userId: 'u-1',
      domainName: 'Health',
      importance: 'core',
      sampleSignals: ['s1'],
      suggestedCapabilities: ['c1'],
      wingId: 'wing-9',
    });
    const [sql] = mockQuery.mock.calls[0]!;
    // These columns are NOT gated by the override — they always update.
    expect(sql).toContain('sample_signals = EXCLUDED.sample_signals');
    expect(sql).toContain('suggested_capabilities = EXCLUDED.suggested_capabilities');
    expect(sql).toContain('last_seen_at = EXCLUDED.last_seen_at');
    // Override gating applies only to `importance`.
    expect(sql).not.toContain('sample_signals = CASE');
    expect(sql).not.toContain('suggested_capabilities = CASE');
  });
});

describe('lifebookRepository.setImportanceOverride — #321', () => {
  it('writes the override JSON + sets importance column immediately', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'lb-1', importance: 'core', metadata: { importanceOverride: {} } }],
      rowCount: 1,
    });
    const result = await lifebookRepository.setImportanceOverride('u-1', 'Health', 'core', 90);
    expect(result).toBeTruthy();
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('UPDATE lifebooks');
    expect(sql).toContain('SET importance = $3');
    expect(sql).toContain("jsonb_set(metadata, '{importanceOverride}', $4::jsonb, true)");
    expect(params[0]).toBe('u-1');
    expect(params[1]).toBe('Health');
    expect(params[2]).toBe('core');
    const override = JSON.parse(params[3] as string);
    expect(override.value).toBe('core');
    expect(override.decayDays).toBe(90);
    expect(typeof override.setAt).toBe('string');
    expect(() => new Date(override.setAt as string).toISOString()).not.toThrow();
  });

  it('defaults decayDays to 90 when not provided', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'lb-1' }], rowCount: 1 });
    await lifebookRepository.setImportanceOverride('u-1', 'Health', 'secondary');
    const [, params] = mockQuery.mock.calls[0]!;
    const override = JSON.parse(params[3] as string);
    expect(override.decayDays).toBe(90);
  });

  it('preserves decayDays = 0 as the "never auto-decay" sentinel', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'lb-1' }], rowCount: 1 });
    await lifebookRepository.setImportanceOverride('u-1', 'Health', 'emerging', 0);
    const [, params] = mockQuery.mock.calls[0]!;
    const override = JSON.parse(params[3] as string);
    expect(override.decayDays).toBe(0);
  });

  it('returns null when no matching row exists (caller can 404)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await lifebookRepository.setImportanceOverride('u-1', 'NoSuchDomain', 'core');
    expect(result).toBeNull();
  });
});

describe('lifebookRepository.clearImportanceOverride — #321', () => {
  it('strips the importanceOverride key from metadata via JSONB minus operator', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'lb-1', metadata: {} }],
      rowCount: 1,
    });
    const result = await lifebookRepository.clearImportanceOverride('u-1', 'Health');
    expect(result).toBeTruthy();
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("SET metadata = metadata - 'importanceOverride'");
    expect(params).toEqual(['u-1', 'Health']);
  });

  it('returns null when no matching row exists', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await lifebookRepository.clearImportanceOverride('u-1', 'NoSuchDomain');
    expect(result).toBeNull();
  });

  it('is idempotent — calling on a row without an override is a no-op rather than an error', async () => {
    // The metadata - 'key' operator returns the JSON unchanged when the
    // key isn't present, so the UPDATE succeeds and returns the row.
    mockQuery.mockResolvedValue({
      rows: [{ id: 'lb-1', metadata: {} }],
      rowCount: 1,
    });
    await expect(
      lifebookRepository.clearImportanceOverride('u-1', 'Health'),
    ).resolves.not.toBeNull();
  });
});
