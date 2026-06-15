import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptColumn } from '../lib/vault-helper.js';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const {
  TwinRepositoryAdapter,
  setPreferenceVaultKeyProvider,
  VaultLockedError,
} = await import('../adapters/twin-repository-adapter.js');

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const KEY = randomBytes(32);

function keyProvider(map: Record<string, Buffer>) {
  return { get: (u: string) => map[u] ?? null };
}

function plaintextRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pref-1',
    user_id: USER_ID,
    domain: 'email',
    key: 'tone',
    value: { tone: 'concise' },
    confidence: 'high',
    source: 'inferred',
    evidence: ['e1', 'e2'],
    version: 1,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-02'),
    value_encrypted: null,
    evidence_encrypted: null,
    ...over,
  };
}

describe('preferences at-rest encryption (#374)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    setPreferenceVaultKeyProvider(null); // default: feature off
  });

  // -- WRITE PATH ----------------------------------------------------------

  it('encrypts value + evidence on write and NULLs the plaintext columns', async () => {
    setPreferenceVaultKeyProvider(keyProvider({ [USER_ID]: KEY }));
    // 1st query: existing lookup → none. 2nd: INSERT returning the encrypted row.
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockImplementationOnce((_sql: string, params: unknown[]) => {
        // params: [userId, domain, key, value_encrypted, evidence_encrypted, confidence, source]
        const valueEncrypted = params[3] as Buffer;
        const evidenceEncrypted = params[4] as Buffer;
        return Promise.resolve({
          rows: [
            plaintextRow({
              value: null,
              evidence: null,
              value_encrypted: valueEncrypted,
              evidence_encrypted: evidenceEncrypted,
            }),
          ],
        });
      });

    const adapter = new TwinRepositoryAdapter();
    const result = await adapter.upsertPreference(USER_ID, {
      id: 'pref-1',
      domain: 'email',
      key: 'tone',
      value: { tone: 'concise', max: 120 },
      confidence: 'high',
      source: 'inferred',
      evidenceIds: ['e1', 'e2'],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    // The INSERT SQL must write ciphertext columns and NULL the plaintext ones.
    const insertCall = mockQuery.mock.calls[1]!;
    const insertSql = insertCall[0] as string;
    expect(insertSql).toMatch(/value_encrypted/);
    expect(insertSql).toMatch(/evidence_encrypted/);
    expect(insertSql).toMatch(/VALUES \(\$1, \$2, \$3, NULL, NULL/);

    const insertParams = insertCall[1] as unknown[];
    const valueCipher = insertParams[3] as Buffer;
    // Ciphertext must be a Buffer that is NOT readable as the plaintext.
    expect(Buffer.isBuffer(valueCipher)).toBe(true);
    expect(valueCipher.toString('utf8')).not.toContain('concise');
    // And it decrypts back to the original JSON with the right key.
    const round = decryptColumn(valueCipher, KEY);
    expect(round.success).toBe(true);
    if (round.success) {
      expect(JSON.parse(round.value)).toEqual({ tone: 'concise', max: 120 });
    }

    // Returned domain object exposes the decrypted value (not ciphertext).
    expect(result.value).toEqual({ tone: 'concise', max: 120 });
    expect(result.evidenceIds).toEqual(['e1', 'e2']);
  });

  it('writes plaintext (and clears any stale ciphertext) when the vault feature is off', async () => {
    // provider stays null
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [plaintextRow()] });

    const adapter = new TwinRepositoryAdapter();
    await adapter.upsertPreference(USER_ID, {
      id: 'pref-1',
      domain: 'email',
      key: 'tone',
      value: { tone: 'concise' },
      confidence: 'high',
      source: 'inferred',
      evidenceIds: ['e1', 'e2'],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const insertSql = mockQuery.mock.calls[1]![0] as string;
    expect(insertSql).not.toMatch(/value_encrypted = /);
    expect(insertSql).toMatch(/INSERT INTO preferences \(user_id, domain, key, value,/);
    const params = mockQuery.mock.calls[1]![1] as unknown[];
    expect(params[3]).toBe(JSON.stringify({ tone: 'concise' })); // plaintext JSON
  });

  // -- READ PATH -----------------------------------------------------------

  it('decrypts an encrypted row on read', async () => {
    setPreferenceVaultKeyProvider(keyProvider({ [USER_ID]: KEY }));
    // Build an encrypted row using the helper.
    const { encryptColumn } = await import('../lib/vault-helper.js');
    const valueCipher = encryptColumn(JSON.stringify({ tone: 'warm' }), KEY);
    const evidenceCipher = encryptColumn(JSON.stringify(['x']), KEY);
    mockQuery.mockResolvedValueOnce({
      rows: [
        plaintextRow({
          value: null,
          evidence: null,
          value_encrypted: valueCipher,
          evidence_encrypted: evidenceCipher,
        }),
      ],
    });

    const adapter = new TwinRepositoryAdapter();
    const prefs = await adapter.getPreferences(USER_ID);
    expect(prefs).toHaveLength(1);
    expect(prefs[0]!.value).toEqual({ tone: 'warm' });
    expect(prefs[0]!.evidenceIds).toEqual(['x']);
  });

  it('falls back to the plaintext column during the lazy-migration window', async () => {
    setPreferenceVaultKeyProvider(keyProvider({ [USER_ID]: KEY }));
    mockQuery.mockResolvedValueOnce({ rows: [plaintextRow()] }); // plaintext, no ciphertext

    const adapter = new TwinRepositoryAdapter();
    const prefs = await adapter.getPreferences(USER_ID);
    expect(prefs[0]!.value).toEqual({ tone: 'concise' });
    expect(prefs[0]!.evidenceIds).toEqual(['e1', 'e2']);
  });

  it('reads plaintext rows fine when the vault feature is off', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [plaintextRow()] });
    const adapter = new TwinRepositoryAdapter();
    const prefs = await adapter.getPreferences(USER_ID);
    expect(prefs[0]!.value).toEqual({ tone: 'concise' });
  });

  // -- VAULT-LOCKED PATH ---------------------------------------------------

  it('throws VaultLockedError on read when the vault is wired but locked', async () => {
    setPreferenceVaultKeyProvider(keyProvider({})); // wired, but no key for user
    const adapter = new TwinRepositoryAdapter();
    await expect(adapter.getPreferences(USER_ID)).rejects.toBeInstanceOf(VaultLockedError);
    // Locked reads must short-circuit BEFORE querying ciphertext out of the DB.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('throws VaultLockedError on write when the vault is wired but locked', async () => {
    setPreferenceVaultKeyProvider(keyProvider({}));
    const adapter = new TwinRepositoryAdapter();
    await expect(
      adapter.upsertPreference(USER_ID, {
        id: 'pref-1',
        domain: 'email',
        key: 'tone',
        value: { tone: 'concise' },
        confidence: 'high',
        source: 'inferred',
        evidenceIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never),
    ).rejects.toBeInstanceOf(VaultLockedError);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
