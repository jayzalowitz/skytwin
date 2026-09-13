import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool } from '../connection.js';
import { aiProviderRepository } from '../repositories/ai-provider-repository.js';
import { reasoningModeRepository } from '../repositories/reasoning-mode-repository.js';

const E2E = process.env['E2E'] === 'true';

let pool: Pool;
const userIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = randomUUID();
  userIds.push(userId);
  await pool.query(
    `INSERT INTO users (id, email, name, trust_tier, autonomy_settings)
     VALUES ($1, $2, 'Provider boundary test', 'observer', '{}')`,
    [userId, `${userId}@example.test`],
  );
  return userId;
}

describe.skipIf(!E2E)('AI provider reasoning mutations on CockroachDB', () => {
  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) throw new Error('DATABASE_URL must be set for E2E tests');
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  });

  afterEach(async () => {
    for (const userId of userIds.splice(0)) {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  afterAll(async () => {
    await closePool();
    await pool.end();
  });

  it('persists a provider snapshot and rolls back a mode write when credential authority changes', async () => {
    const userId = await createUser();
    await aiProviderRepository.replaceAllWithReasoningMode(
      userId,
      'bring_your_own_provider',
      [
        {
          provider: 'openai',
          apiKey: 'stored-secret',
          model: 'gpt',
          baseUrl: 'https://gateway.example/v1',
          priority: 0,
        },
      ],
    );
    await aiProviderRepository.replaceAllWithReasoningMode(
      userId,
      'bring_your_own_provider',
      [
        {
          provider: 'openai',
          model: 'gpt',
          baseUrl: 'https://gateway.example/v2',
          priority: 0,
        },
      ],
    );

    await expect(
      aiProviderRepository.replaceAllWithReasoningMode(userId, 'on_device', [
        {
          provider: 'openai',
          model: 'gpt',
          baseUrl: 'https://other.example/v1',
          priority: 0,
        },
      ]),
    ).rejects.toMatchObject({ code: 'provider_credential_endpoint_changed' });

    const state = await pool.query<{
      mode: string;
      api_key: string;
      base_url: string;
    }>(
      `SELECT mode, api_key, base_url
         FROM reasoning_mode_settings
         JOIN ai_provider_settings USING (user_id)
        WHERE user_id = $1`,
      [userId],
    );
    expect(state.rows).toEqual([
      {
        mode: 'bring_your_own_provider',
        api_key: 'stored-secret',
        base_url: 'https://gateway.example/v2',
      },
    ]);
  });

  it('leaves the stored mode unchanged when the live provider snapshot is incompatible', async () => {
    const userId = await createUser();
    await aiProviderRepository.replaceAllWithReasoningMode(
      userId,
      'bring_your_own_provider',
      [{ provider: 'openai', apiKey: 'secret', model: 'gpt', priority: 0 }],
    );

    await expect(
      reasoningModeRepository.setForUserIfCompatible(userId, 'on_device'),
    ).resolves.toBeNull();
    const stored = await pool.query<{ mode: string }>(
      'SELECT mode FROM reasoning_mode_settings WHERE user_id = $1',
      [userId],
    );
    expect(stored.rows).toEqual([{ mode: 'bring_your_own_provider' }]);
  });
});
