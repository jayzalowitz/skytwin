import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { serviceCredentialRepository } = await import(
  '../repositories/service-credential-repository.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRow(
  overrides: Partial<{
    id: string;
    service: string;
    credential_key: string;
    credential_value: string;
    label: string | null;
    created_at: Date;
    updated_at: Date;
  }> = {},
) {
  return {
    id: overrides.id ?? 'cred-001',
    service: overrides.service ?? 'openai',
    credential_key: overrides.credential_key ?? 'api_key',
    credential_value: overrides.credential_value ?? 'sk-test-123',
    label: overrides.label ?? 'OpenAI API Key',
    created_at: overrides.created_at ?? new Date('2026-01-01'),
    updated_at: overrides.updated_at ?? new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serviceCredentialRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // getByService
  // -----------------------------------------------------------------------

  describe('getByService', () => {
    it('returns rows for a given service', async () => {
      const rows = [
        fakeRow({ credential_key: 'api_key' }),
        fakeRow({ credential_key: 'org_id' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await serviceCredentialRepository.getByService('openai');

      expect(result).toEqual(rows);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM service_credentials WHERE service = $1 ORDER BY credential_key',
        ['openai'],
      );
    });

    it('returns empty array when no credentials exist for service', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await serviceCredentialRepository.getByService('unknown');

      expect(result).toEqual([]);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM service_credentials WHERE service = $1 ORDER BY credential_key',
        ['unknown'],
      );
    });
  });

  // -----------------------------------------------------------------------
  // get
  // -----------------------------------------------------------------------

  describe('get', () => {
    it('returns credential when row exists', async () => {
      const row = fakeRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await serviceCredentialRepository.get('openai', 'api_key');

      expect(result).toEqual(row);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM service_credentials WHERE service = $1 AND credential_key = $2',
        ['openai', 'api_key'],
      );
    });

    it('returns null when no row exists', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await serviceCredentialRepository.get('openai', 'missing');

      expect(result).toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM service_credentials WHERE service = $1 AND credential_key = $2',
        ['openai', 'missing'],
      );
    });
  });

  // -----------------------------------------------------------------------
  // upsert
  // -----------------------------------------------------------------------

  describe('upsert', () => {
    it('inserts a new credential and returns the row', async () => {
      const row = fakeRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await serviceCredentialRepository.upsert({
        service: 'openai',
        credentialKey: 'api_key',
        credentialValue: 'sk-test-123',
        label: 'OpenAI API Key',
      });

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO service_credentials');
      expect(sql).toContain('ON CONFLICT (service, credential_key) DO UPDATE SET');
      expect(sql).toContain('credential_value = EXCLUDED.credential_value');
      expect(sql).toContain('label = COALESCE(EXCLUDED.label, service_credentials.label)');
      expect(sql).toContain('updated_at = now()');
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual(['openai', 'api_key', 'sk-test-123', 'OpenAI API Key']);
    });

    it('defaults label to null when not provided', async () => {
      const row = fakeRow({ label: null });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await serviceCredentialRepository.upsert({
        service: 'slack',
        credentialKey: 'token',
        credentialValue: 'xoxb-test',
      });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params).toEqual(['slack', 'token', 'xoxb-test', null]);
    });
  });

  // -----------------------------------------------------------------------
  // delete
  // -----------------------------------------------------------------------

  describe('delete', () => {
    it('returns true when a row was deleted', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const result = await serviceCredentialRepository.delete('openai', 'api_key');

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM service_credentials WHERE service = $1 AND credential_key = $2',
        ['openai', 'api_key'],
      );
    });

    it('returns false when no row was found to delete', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await serviceCredentialRepository.delete('openai', 'missing');

      expect(result).toBe(false);
    });

    it('handles null rowCount gracefully', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: null });

      const result = await serviceCredentialRepository.delete('openai', 'api_key');

      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // listServices
  // -----------------------------------------------------------------------

  describe('listServices', () => {
    it('returns distinct service names', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ service: 'gmail' }, { service: 'openai' }, { service: 'slack' }],
        rowCount: 3,
      });

      const result = await serviceCredentialRepository.listServices();

      expect(result).toEqual(['gmail', 'openai', 'slack']);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT DISTINCT service FROM service_credentials ORDER BY service',
      );
    });

    it('returns empty array when no services exist', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await serviceCredentialRepository.listServices();

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getAll
  // -----------------------------------------------------------------------

  describe('getAll', () => {
    it('returns all credential rows ordered by service and key', async () => {
      const rows = [
        fakeRow({ service: 'gmail', credential_key: 'client_id' }),
        fakeRow({ service: 'gmail', credential_key: 'client_secret' }),
        fakeRow({ service: 'openai', credential_key: 'api_key' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 3 });

      const result = await serviceCredentialRepository.getAll();

      expect(result).toEqual(rows);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM service_credentials ORDER BY service, credential_key',
      );
    });

    it('returns empty array when no credentials exist', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await serviceCredentialRepository.getAll();

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getAsMap
  // -----------------------------------------------------------------------

  describe('getAsMap', () => {
    it('builds a key-value map from credential rows', async () => {
      const rows = [
        fakeRow({ credential_key: 'api_key', credential_value: 'sk-abc' }),
        fakeRow({ credential_key: 'org_id', credential_value: 'org-123' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await serviceCredentialRepository.getAsMap('openai');

      expect(result).toEqual({
        api_key: 'sk-abc',
        org_id: 'org-123',
      });
      // getAsMap delegates to getByService
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM service_credentials WHERE service = $1 ORDER BY credential_key',
        ['openai'],
      );
    });

    it('returns empty object when service has no credentials', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await serviceCredentialRepository.getAsMap('unknown');

      expect(result).toEqual({});
    });
  });
});
