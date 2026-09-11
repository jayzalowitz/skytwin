import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockPolicyRepository = {
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  hardDeletePolicy: vi.fn(),
};

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../repositories/policy-repository.js', () => ({
  policyRepository: mockPolicyRepository,
}));

const { policyRepositoryAdapter } = await import('../adapters/policy-repository-adapter.js');

function fakePolicyRow(overrides: Partial<{
  id: string;
  user_id: string;
  name: string;
  domain: string;
  rules: unknown[];
  priority: number;
  is_active: boolean;
  created_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'policy-1',
    user_id: overrides.user_id ?? 'user-1',
    name: overrides.name ?? 'Spend limit',
    domain: overrides.domain ?? 'shopping',
    rules: overrides.rules ?? [],
    priority: overrides.priority ?? 10,
    is_active: overrides.is_active ?? true,
    created_at: overrides.created_at ?? new Date('2026-06-01'),
  };
}

describe('policyRepositoryAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes direct getAllPolicies priority values from Cockroach INT8 strings', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...fakePolicyRow(), priority: '10' as unknown as number }],
      rowCount: 1,
    });

    const policies = await policyRepositoryAdapter.getAllPolicies('user-1');

    expect(policies[0]?.priority).toBe(10);
    expect(typeof policies[0]?.priority).toBe('number');
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM action_policies WHERE user_id = $1 ORDER BY priority DESC',
      ['user-1'],
    );
  });

  it('normalizes direct getEnabledPolicies priority values from Cockroach INT8 strings', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...fakePolicyRow(), priority: '20' as unknown as number }],
      rowCount: 1,
    });

    const policies = await policyRepositoryAdapter.getEnabledPolicies('user-2');

    expect(policies[0]?.priority).toBe(20);
    expect(typeof policies[0]?.priority).toBe('number');
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM action_policies WHERE user_id = $1 AND is_active = true ORDER BY priority DESC',
      ['user-2'],
    );
  });

  it('normalizes direct getPoliciesByDomain priority values from Cockroach INT8 strings', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...fakePolicyRow({ domain: 'email' }), priority: '30' as unknown as number }],
      rowCount: 1,
    });

    const policies = await policyRepositoryAdapter.getPoliciesByDomain('email', 'user-3');

    expect(policies[0]?.priority).toBe(30);
    expect(typeof policies[0]?.priority).toBe('number');
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM action_policies WHERE domain = $1 AND user_id = $2 AND is_active = true ORDER BY priority DESC',
      ['email', 'user-3'],
    );
  });

  it('normalizes repository-backed getPolicy priority values defensively', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...fakePolicyRow(), priority: '40' as unknown as number }],
      rowCount: 1,
    });

    const policy = await policyRepositoryAdapter.getPolicy('policy-1', 'user-4');

    expect(policy?.priority).toBe(40);
    expect(typeof policy?.priority).toBe('number');
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM action_policies WHERE id = $1 AND user_id = $2',
      ['policy-1', 'user-4'],
    );
  });

  it('returns no policy when the owner-scoped lookup finds no row', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(policyRepositoryAdapter.getPolicy('policy-1', 'other-user')).resolves.toBeNull();
  });
});
