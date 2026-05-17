import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { promotionOffersRepository } = await import(
  '../repositories/promotion-offers-repository.js'
);

describe('promotionOffersRepository.createIfPending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a row and returns it on success', async () => {
    const row = { id: 'o-1', user_id: 'u-1' };
    mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });
    const result = await promotionOffersRepository.createIfPending({
      userId: 'u-1',
      serverId: 's-1',
      currentTier: 'observer',
      proposedTier: 'suggest',
      reason: 'Met threshold',
      decisionsObservedCount: 20,
      approvedCount: 18,
    });
    expect(result).toEqual(row);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO promotion_offers');
    expect(sql).toContain('ON CONFLICT ON CONSTRAINT promotion_offers_pending_uniq DO NOTHING');
    expect(sql).toContain('RETURNING *');
    expect(params).toEqual(['u-1', 's-1', 'observer', 'suggest', 'Met threshold', 20, 18]);
  });

  it('returns null when a pending offer already exists (ON CONFLICT path)', async () => {
    // ON CONFLICT DO NOTHING returns zero rows. Repo must surface this
    // as `null` so callers can distinguish "new offer" from "duplicate".
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await promotionOffersRepository.createIfPending({
      userId: 'u-1',
      serverId: 's-1',
      currentTier: 'observer',
      proposedTier: 'suggest',
      reason: 'duplicate',
      decisionsObservedCount: 20,
      approvedCount: 18,
    });
    expect(result).toBeNull();
  });
});

describe('promotionOffersRepository.listPending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns rows where responded_at IS NULL, newest first', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'o-2' }, { id: 'o-1' }],
      rowCount: 2,
    });
    const rows = await promotionOffersRepository.listPending('u-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe('o-2');
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('responded_at IS NULL');
    expect(sql).toContain('ORDER BY offered_at DESC');
    expect(params).toEqual(['u-1']);
  });

  it('returns empty array when no pending offers', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await promotionOffersRepository.listPending('u-1')).toEqual([]);
  });
});

describe('promotionOffersRepository.listPendingWithServerName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('joins mcp_servers for display_name and surfaces it as server_name', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'o-1', server_name: 'Linear' }],
      rowCount: 1,
    });
    const rows = await promotionOffersRepository.listPendingWithServerName('u-1');
    expect(rows[0]!.server_name).toBe('Linear');
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('LEFT JOIN mcp_servers ms ON ms.id = po.server_id');
    expect(sql).toContain('ms.display_name AS server_name');
  });
});

describe('promotionOffersRepository.findById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the row by id', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'o-1' }], rowCount: 1 });
    expect(await promotionOffersRepository.findById('o-1')).toEqual({ id: 'o-1' });
  });

  it('returns null when the row does not exist', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await promotionOffersRepository.findById('o-missing')).toBeNull();
  });
});

describe('promotionOffersRepository.markResponded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates responded_at + response and returns the row', async () => {
    const row = { id: 'o-1', response: 'accepted' };
    mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });
    const result = await promotionOffersRepository.markResponded('o-1', 'accepted');
    expect(result).toEqual(row);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('UPDATE promotion_offers');
    expect(sql).toContain('SET responded_at = now(), response = $1');
    expect(sql).toContain('WHERE id = $2 AND responded_at IS NULL');
    expect(params).toEqual(['accepted', 'o-1']);
  });

  it('returns null when the offer is already responded (WHERE filter excludes it)', async () => {
    // A duplicate Accept click can't overwrite an earlier response —
    // the WHERE responded_at IS NULL guard means the second UPDATE
    // matches zero rows.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await promotionOffersRepository.markResponded('o-1', 'rejected')).toBeNull();
  });
});

describe('promotionOffersRepository.listOfferedSince', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns offers inserted after the cutoff, with server_name joined', async () => {
    const since = new Date('2026-05-17T00:00:00Z');
    mockQuery.mockResolvedValue({
      rows: [{ id: 'o-1', server_name: 'Notion' }],
      rowCount: 1,
    });
    const rows = await promotionOffersRepository.listOfferedSince(since);
    expect(rows[0]!.server_name).toBe('Notion');
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('po.offered_at > $1');
    expect(sql).toContain('po.responded_at IS NULL');
    expect(sql).toContain('LEFT JOIN mcp_servers');
    expect(params).toEqual([since]);
  });
});
