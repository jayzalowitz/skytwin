import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockPolicyRepository = {
  findById: vi.fn(),
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

    const policies = await policyRepositoryAdapter.getAllPolicies();

    expect(policies[0]?.priority).toBe(10);
    expect(typeof policies[0]?.priority).toBe('number');
  });

  it('normalizes direct getEnabledPolicies priority values from Cockroach INT8 strings', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...fakePolicyRow(), priority: '20' as unknown as number }],
      rowCount: 1,
    });

    const policies = await policyRepositoryAdapter.getEnabledPolicies();

    expect(policies[0]?.priority).toBe(20);
    expect(typeof policies[0]?.priority).toBe('number');
  });

  it('normalizes direct getPoliciesByDomain priority values from Cockroach INT8 strings', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...fakePolicyRow({ domain: 'email' }), priority: '30' as unknown as number }],
      rowCount: 1,
    });

    const policies = await policyRepositoryAdapter.getPoliciesByDomain('email');

    expect(policies[0]?.priority).toBe(30);
    expect(typeof policies[0]?.priority).toBe('number');
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM action_policies WHERE domain = $1 AND is_active = true ORDER BY priority DESC',
      ['email'],
    );
  });

  it('normalizes repository-backed getPolicy priority values defensively', async () => {
    mockPolicyRepository.findById.mockResolvedValue({
      ...fakePolicyRow(),
      priority: '40' as unknown as number,
    });

    const policy = await policyRepositoryAdapter.getPolicy('policy-1');

    expect(policy?.priority).toBe(40);
    expect(typeof policy?.priority).toBe('number');
  });
});
