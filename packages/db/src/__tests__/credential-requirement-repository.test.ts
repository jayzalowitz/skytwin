import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { credentialRequirementRepository } = await import(
  '../repositories/credential-requirement-repository.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRow(
  overrides: Partial<{
    id: string;
    adapter: string;
    integration: string;
    integration_label: string;
    description: string | null;
    field_key: string;
    field_label: string;
    field_placeholder: string | null;
    is_secret: boolean;
    is_optional: boolean;
    skills: string[];
    created_at: Date;
  }> = {},
) {
  return {
    id: overrides.id ?? 'req-001',
    adapter: overrides.adapter ?? 'openclaw',
    integration: overrides.integration ?? 'twitter',
    integration_label: overrides.integration_label ?? 'Twitter / X',
    description: overrides.description ?? 'Post tweets on your behalf',
    field_key: overrides.field_key ?? 'api_key',
    field_label: overrides.field_label ?? 'API Key',
    field_placeholder: overrides.field_placeholder ?? 'Enter your Twitter API key',
    is_secret: overrides.is_secret ?? true,
    is_optional: overrides.is_optional ?? false,
    skills: overrides.skills ?? ['tweet', 'dm'],
    created_at: overrides.created_at ?? new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('credentialRequirementRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // register
  // -----------------------------------------------------------------------

  describe('register', () => {
    it('inserts a new requirement with all 10 parameters', async () => {
      const row = fakeRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await credentialRequirementRepository.register({
        adapter: 'openclaw',
        integration: 'twitter',
        integrationLabel: 'Twitter / X',
        description: 'Post tweets on your behalf',
        fieldKey: 'api_key',
        fieldLabel: 'API Key',
        fieldPlaceholder: 'Enter your Twitter API key',
        isSecret: true,
        isOptional: false,
        skills: ['tweet', 'dm'],
      });

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO credential_requirements');
      expect(sql).toContain(
        '(adapter, integration, integration_label, description, field_key, field_label, field_placeholder, is_secret, is_optional, skills)',
      );
      expect(sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)');
      expect(sql).toContain('ON CONFLICT (adapter, integration, field_key) DO UPDATE SET');
      expect(sql).toContain('integration_label = EXCLUDED.integration_label');
      expect(sql).toContain(
        'description = COALESCE(EXCLUDED.description, credential_requirements.description)',
      );
      expect(sql).toContain('field_label = EXCLUDED.field_label');
      expect(sql).toContain(
        'field_placeholder = COALESCE(EXCLUDED.field_placeholder, credential_requirements.field_placeholder)',
      );
      expect(sql).toContain('is_secret = EXCLUDED.is_secret');
      expect(sql).toContain('is_optional = EXCLUDED.is_optional');
      expect(sql).toContain('skills = EXCLUDED.skills');
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual([
        'openclaw',
        'twitter',
        'Twitter / X',
        'Post tweets on your behalf',
        'api_key',
        'API Key',
        'Enter your Twitter API key',
        true,
        false,
        ['tweet', 'dm'],
      ]);
    });

    it('defaults optional fields to null/false when not provided', async () => {
      const row = fakeRow({
        description: null,
        field_placeholder: null,
        is_secret: false,
        is_optional: false,
      });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await credentialRequirementRepository.register({
        adapter: 'openclaw',
        integration: 'twitter',
        integrationLabel: 'Twitter / X',
        fieldKey: 'api_key',
        fieldLabel: 'API Key',
        skills: ['tweet'],
      });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params).toEqual([
        'openclaw',
        'twitter',
        'Twitter / X',
        null,          // description defaults to null
        'api_key',
        'API Key',
        null,          // fieldPlaceholder defaults to null
        false,         // isSecret defaults to false
        false,         // isOptional defaults to false
        ['tweet'],
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // getByAdapter
  // -----------------------------------------------------------------------

  describe('getByAdapter', () => {
    it('returns requirements filtered by adapter', async () => {
      const rows = [
        fakeRow({ field_key: 'api_key' }),
        fakeRow({ field_key: 'api_secret' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await credentialRequirementRepository.getByAdapter('openclaw');

      expect(result).toEqual(rows);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM credential_requirements WHERE adapter = $1 ORDER BY integration, field_key',
        ['openclaw'],
      );
    });

    it('returns empty array when adapter has no requirements', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await credentialRequirementRepository.getByAdapter('unknown');

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getByIntegration
  // -----------------------------------------------------------------------

  describe('getByIntegration', () => {
    it('returns requirements filtered by integration', async () => {
      const rows = [
        fakeRow({ adapter: 'openclaw', field_key: 'api_key' }),
        fakeRow({ adapter: 'ironclaw', field_key: 'api_key' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await credentialRequirementRepository.getByIntegration('twitter');

      expect(result).toEqual(rows);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM credential_requirements WHERE integration = $1 ORDER BY adapter, field_key',
        ['twitter'],
      );
    });

    it('returns empty array when integration has no requirements', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await credentialRequirementRepository.getByIntegration('unknown');

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getAll
  // -----------------------------------------------------------------------

  describe('getAll', () => {
    it('returns all requirements ordered by adapter, integration, field_key', async () => {
      const rows = [
        fakeRow({ adapter: 'ironclaw', integration: 'github', field_key: 'token' }),
        fakeRow({ adapter: 'openclaw', integration: 'twitter', field_key: 'api_key' }),
        fakeRow({ adapter: 'openclaw', integration: 'twitter', field_key: 'api_secret' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 3 });

      const result = await credentialRequirementRepository.getAll();

      expect(result).toEqual(rows);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM credential_requirements ORDER BY adapter, integration, field_key',
      );
    });

    it('returns empty array when no requirements exist', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await credentialRequirementRepository.getAll();

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getBySkill
  // -----------------------------------------------------------------------

  describe('getBySkill', () => {
    it('uses ANY() operator to find requirements matching a skill', async () => {
      const rows = [
        fakeRow({ skills: ['tweet', 'dm'] }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 1 });

      const result = await credentialRequirementRepository.getBySkill('tweet');

      expect(result).toEqual(rows);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM credential_requirements WHERE $1 = ANY(skills) ORDER BY adapter, integration',
        ['tweet'],
      );
    });

    it('returns empty array when no requirements match the skill', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await credentialRequirementRepository.getBySkill('nonexistent');

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getAllGrouped
  // -----------------------------------------------------------------------

  describe('getAllGrouped', () => {
    it('groups requirements by adapter:integration key', async () => {
      const twitterKey = fakeRow({
        adapter: 'openclaw',
        integration: 'twitter',
        integration_label: 'Twitter / X',
        description: 'Post tweets',
        field_key: 'api_key',
        field_label: 'API Key',
      });
      const twitterSecret = fakeRow({
        adapter: 'openclaw',
        integration: 'twitter',
        integration_label: 'Twitter / X',
        description: 'Post tweets',
        field_key: 'api_secret',
        field_label: 'API Secret',
      });
      const githubToken = fakeRow({
        adapter: 'ironclaw',
        integration: 'github',
        integration_label: 'GitHub',
        description: 'Manage repos',
        field_key: 'token',
        field_label: 'Personal Access Token',
      });

      mockQuery.mockResolvedValue({
        rows: [githubToken, twitterKey, twitterSecret],
        rowCount: 3,
      });

      const result = await credentialRequirementRepository.getAllGrouped();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);

      const twitterGroup = result.get('openclaw:twitter');
      expect(twitterGroup).toBeDefined();
      expect(twitterGroup!.label).toBe('Twitter / X');
      expect(twitterGroup!.description).toBe('Post tweets');
      expect(twitterGroup!.adapter).toBe('openclaw');
      expect(twitterGroup!.fields).toHaveLength(2);
      expect(twitterGroup!.fields[0]).toEqual(twitterKey);
      expect(twitterGroup!.fields[1]).toEqual(twitterSecret);

      const githubGroup = result.get('ironclaw:github');
      expect(githubGroup).toBeDefined();
      expect(githubGroup!.label).toBe('GitHub');
      expect(githubGroup!.description).toBe('Manage repos');
      expect(githubGroup!.adapter).toBe('ironclaw');
      expect(githubGroup!.fields).toHaveLength(1);
      expect(githubGroup!.fields[0]).toEqual(githubToken);
    });

    it('returns empty map when no requirements exist', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await credentialRequirementRepository.getAllGrouped();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // delete
  // -----------------------------------------------------------------------

  describe('delete', () => {
    it('returns true when a requirement was deleted', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const result = await credentialRequirementRepository.delete(
        'openclaw',
        'twitter',
        'api_key',
      );

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM credential_requirements WHERE adapter = $1 AND integration = $2 AND field_key = $3',
        ['openclaw', 'twitter', 'api_key'],
      );
    });

    it('returns false when no requirement was found to delete', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await credentialRequirementRepository.delete(
        'openclaw',
        'twitter',
        'missing',
      );

      expect(result).toBe(false);
    });

    it('handles null rowCount gracefully', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: null });

      const result = await credentialRequirementRepository.delete(
        'openclaw',
        'twitter',
        'api_key',
      );

      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // deleteIntegration
  // -----------------------------------------------------------------------

  describe('deleteIntegration', () => {
    it('removes all requirements for an integration and returns count', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 3 });

      const result = await credentialRequirementRepository.deleteIntegration(
        'openclaw',
        'twitter',
      );

      expect(result).toBe(3);
      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM credential_requirements WHERE adapter = $1 AND integration = $2',
        ['openclaw', 'twitter'],
      );
    });

    it('returns 0 when no requirements existed for the integration', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await credentialRequirementRepository.deleteIntegration(
        'openclaw',
        'unknown',
      );

      expect(result).toBe(0);
    });

    it('handles null rowCount gracefully', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: null });

      const result = await credentialRequirementRepository.deleteIntegration(
        'openclaw',
        'twitter',
      );

      expect(result).toBe(0);
    });
  });
});
