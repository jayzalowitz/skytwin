import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockCreateWing = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

vi.mock('../repositories/mempalace-repository.js', () => ({
  mempalaceRepository: {
    createWing: (...args: unknown[]) => mockCreateWing(...args),
  },
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
  it('writes the override JSON via DB-side now() + sets importance column immediately', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'lb-1', importance: 'core', metadata: { importanceOverride: {} } }],
      rowCount: 1,
    });
    const result = await lifebookRepository.setImportanceOverride('u-1', 'Health', 'core', 90);
    expect(result).toBeTruthy();
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('UPDATE lifebooks');
    expect(sql).toContain('SET importance = $3');
    // SET uses jsonb_build_object so the timestamp comes from DB now()
    // (not the app server) — same clock as the upsert freshness CASE.
    // Copilot caught the clock-skew issue when setAt was generated
    // via new Date().toISOString() on the API node.
    expect(sql).toContain('jsonb_build_object');
    expect(sql).toContain("'value', $3::string");
    expect(sql).toContain("'setAt', now()::string");
    expect(sql).toContain("'decayDays', $4::int");
    // Params: userId, domain, value, decayDays — NO JSON-stringified
    // setAt (the SQL produces it).
    expect(params).toEqual(['u-1', 'Health', 'core', 90]);
  });

  it('defaults decayDays to 90 when not provided', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'lb-1' }], rowCount: 1 });
    await lifebookRepository.setImportanceOverride('u-1', 'Health', 'secondary');
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params[3]).toBe(90);
  });

  it('preserves decayDays = 0 as the "never auto-decay" sentinel', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'lb-1' }], rowCount: 1 });
    await lifebookRepository.setImportanceOverride('u-1', 'Health', 'emerging', 0);
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params[3]).toBe(0);
  });

  it('returns null when no matching row exists (caller can 404)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await lifebookRepository.setImportanceOverride('u-1', 'NoSuchDomain', 'core');
    expect(result).toBeNull();
  });
});

describe('lifebookRepository.editSampleSignal — #319 inline fact-edit', () => {
  it('updates the targeted array element via jsonb_set with an index-bounds guard', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'lb-1', sample_signals: ['fixed', 'b'] }],
      rowCount: 1,
    });
    const result = await lifebookRepository.editSampleSignal('u-1', 'Health', 0, 'fixed');
    expect(result).toBeTruthy();
    const [sql, params] = mockQuery.mock.calls[0]!;
    // jsonb_set targets ARRAY[index] and replaces it with the corrected
    // text. The WHERE clause bounds-checks the index IN SQL so a stale
    // out-of-range index updates nothing (race-safe vs the extractor).
    expect(sql).toContain('UPDATE lifebooks');
    expect(sql).toContain('jsonb_set');
    expect(sql).toContain('ARRAY[$3::int::string]');
    expect(sql).toContain('to_jsonb($4::string)');
    expect(sql).toContain('$3::int >= 0');
    expect(sql).toContain('$3::int < jsonb_array_length(sample_signals)');
    expect(params).toEqual(['u-1', 'Health', 0, 'fixed']);
  });

  it('returns null when no row matches — covers both missing lifebook AND out-of-range index', async () => {
    // The SQL bounds-check means an out-of-range index produces zero
    // updated rows, indistinguishable here from a missing lifebook; the
    // route layer disambiguates via a prior findByDomain.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await lifebookRepository.editSampleSignal('u-1', 'Health', 99, 'x');
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

describe('lifebookRepository.addManual — #193 AC#8 (manual create)', () => {
  it('creates the wing immediately and inserts a manuallyAdded lifebook (created: true)', async () => {
    mockCreateWing.mockResolvedValue({ id: 'wing-new', name: 'Volunteering' });
    // First query is the existence pre-check → no rows → created.
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'lb-new',
            user_id: 'u-1',
            domain_name: 'Volunteering',
            importance: 'emerging',
            wing_id: 'wing-new',
            hidden_at: null,
            metadata: { manuallyAdded: true },
          },
        ],
        rowCount: 1,
      });

    const result = await lifebookRepository.addManual({
      userId: 'u-1',
      domainName: 'Volunteering',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.created).toBe(true);
    expect(result.lifebook.wing_id).toBe('wing-new');

    // Wing is created with the domain name + domains array.
    expect(mockCreateWing).toHaveBeenCalledWith({
      userId: 'u-1',
      name: 'Volunteering',
      description: 'Memories related to Volunteering',
      domains: ['Volunteering'],
    });

    // INSERT carries the manuallyAdded stamp + defaults importance to emerging.
    const insertCall = mockQuery.mock.calls[1]!;
    const [sql, params] = insertCall;
    expect(sql).toContain('INSERT INTO lifebooks');
    expect(sql).toContain('"manuallyAdded": true');
    expect(params).toEqual(['u-1', 'Volunteering', 'emerging', 'wing-new']);
  });

  it('re-surfaces an existing (hidden) domain instead of erroring — clears hidden_at, created: false', async () => {
    mockCreateWing.mockResolvedValue({ id: 'wing-existing', name: 'Kayaking' });
    // Pre-check finds an existing row → created: false.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'lb-existing' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'lb-existing', importance: 'core', hidden_at: null, metadata: { manuallyAdded: true } }],
        rowCount: 1,
      });

    const result = await lifebookRepository.addManual({
      userId: 'u-1',
      domainName: 'Kayaking',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.created).toBe(false);

    // The ON CONFLICT branch clears hidden_at (the one allowed unhide path)
    // and OR-merges the manuallyAdded flag without demoting importance.
    const [sql] = mockQuery.mock.calls[1]!;
    expect(sql).toContain('ON CONFLICT (user_id, domain_name) DO UPDATE SET');
    expect(sql).toContain('hidden_at = NULL');
    expect(sql).toContain(`metadata = lifebooks.metadata || '{"manuallyAdded": true}'::jsonb`);
    // importance is NOT in the UPDATE SET — re-add must not demote.
    expect(sql).not.toMatch(/DO UPDATE SET[\s\S]*importance =/);
  });

  it('honors a caller-supplied importance on create', async () => {
    mockCreateWing.mockResolvedValue({ id: 'wing-x', name: 'Caregiving' });
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'lb-x', importance: 'core' }], rowCount: 1 });

    await lifebookRepository.addManual({
      userId: 'u-1',
      domainName: 'Caregiving',
      importance: 'core',
    });

    const [, params] = mockQuery.mock.calls[1]!;
    expect(params[2]).toBe('core');
  });

  it('trims the domain name before creating the wing + row', async () => {
    mockCreateWing.mockResolvedValue({ id: 'wing-t', name: 'Travel' });
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'lb-t' }], rowCount: 1 });

    await lifebookRepository.addManual({ userId: 'u-1', domainName: '  Travel  ' });

    expect(mockCreateWing).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Travel', domains: ['Travel'] }),
    );
    const [, params] = mockQuery.mock.calls[1]!;
    expect(params[1]).toBe('Travel');
  });

  it('returns invalid_domain_name and never touches the DB for an empty/whitespace name', async () => {
    const result = await lifebookRepository.addManual({ userId: 'u-1', domainName: '   ' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBe('invalid_domain_name');
    // No wing, no query — fail before any side effect.
    expect(mockCreateWing).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
