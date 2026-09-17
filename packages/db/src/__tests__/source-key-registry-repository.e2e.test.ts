import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool } from '../connection.js';
import {
  SourceKeyRegistryConflictError,
  sourceKeyRegistryRepository,
} from '../repositories/source-key-registry-repository.js';
import { sessionRepository } from '../repositories/session-repository.js';

const E2E = process.env['E2E'] === 'true';
const users = [
  '64700000-0000-4000-8000-000000000001',
  '64700000-0000-4000-8000-000000000002',
];
const initial = (userId: string) => ({
  user_id: userId,
  key_version: 1,
  wrapper_version: 1,
  algorithm: 'aes-256-gcm' as const,
  kdf_record: { algorithm: 'scrypt', N: 32768 },
  recovery_wrapper: { magic: 'skytwin-user-key', ciphertext: 'fixture' },
});

let pool: Pool;

describe.skipIf(!E2E)('E2E: source-key registry authority', () => {
  beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) throw new Error('DATABASE_URL must be set for E2E tests');
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    for (const [index, userId] of users.entries()) {
      await pool.query(
        `INSERT INTO users (id, email, name, trust_tier, autonomy_settings)
         VALUES ($1, $2, 'Source key E2E', 'observer', '{}')
         ON CONFLICT (id) DO NOTHING`,
        [userId, `source-key-647-${index}@example.test`],
      );
    }
  });

  afterEach(async () => {
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1::UUID[])', [users]);
    await pool.query('DELETE FROM user_source_key_registry WHERE user_id = ANY($1::UUID[])', [users]);
    await pool.query('DELETE FROM source_key_deletion_intents WHERE user_id = ANY($1::UUID[])', [users]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1::UUID[])', [users]);
    await closePool();
    await pool.end();
  });

  it('normalizes Cockroach INT values and admits one concurrent initializer', async () => {
    const attempts = await Promise.all([
      sourceKeyRegistryRepository.createInitial(initial(users[0]!)),
      sourceKeyRegistryRepository.createInitial(initial(users[0]!)),
    ]);
    expect(attempts.sort()).toEqual([false, true]);

    const raw = await pool.query<{ key_version: unknown; wrapper_version: unknown }>(
      'SELECT key_version, wrapper_version FROM user_source_key_registry WHERE user_id = $1',
      [users[0]],
    );
    expect(typeof raw.rows[0]!.key_version).toBe('string');
    const current = await sourceKeyRegistryRepository.getCurrent(users[0]!);
    expect(current).toMatchObject({ key_version: 1, wrapper_version: 1, user_id: users[0] });
  });

  it('fails closed on multiple active wrappers and preserves owner isolation', async () => {
    await sourceKeyRegistryRepository.createInitial(initial(users[0]!));
    await sourceKeyRegistryRepository.createInitial(initial(users[1]!));
    await pool.query(
      `INSERT INTO user_source_key_registry
        (user_id, key_version, wrapper_version, algorithm, kdf_record, recovery_wrapper)
       VALUES ($1, 2, 1, 'aes-256-gcm', '{}', '{}')`,
      [users[0]],
    );
    await expect(sourceKeyRegistryRepository.getCurrent(users[0]!))
      .rejects.toBeInstanceOf(SourceKeyRegistryConflictError);
    expect(await sourceKeyRegistryRepository.getCurrent(users[1]!))
      .toMatchObject({ user_id: users[1], key_version: 1 });
  });

  it('conditionally deletes only the exact initial wrapper', async () => {
    const record = initial(users[0]!);
    await sourceKeyRegistryRepository.createInitial(record);
    expect(await sourceKeyRegistryRepository.deleteInitialIfMatch({
      ...record,
      recovery_wrapper: { ...record.recovery_wrapper, ciphertext: 'different' },
    })).toBe(false);
    expect(await sourceKeyRegistryRepository.getCurrent(users[0]!)).not.toBeNull();
    expect(await sourceKeyRegistryRepository.deleteInitialIfMatch(record)).toBe(true);
    expect(await sourceKeyRegistryRepository.getCurrent(users[0]!)).toBeNull();
  });

  it('returns one canonical refreshed expiry to concurrent authentication calls', async () => {
    const tokenHash = 'a'.repeat(64);
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + INTERVAL '10 minutes')`,
      [users[0], tokenHash],
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, () => sessionRepository.authenticateAndMaintain(tokenHash)),
    );
    expect(results.every((result) => result.status === 'active')).toBe(true);
    const expiries = results.map((result) =>
      result.status === 'active' ? new Date(result.session.expires_at).getTime() : null,
    );
    expect(new Set(expiries).size).toBe(1);
    expect(expiries[0]).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1_000);
  });
});
