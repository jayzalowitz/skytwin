import type { PoolClient } from 'pg';
import { closePool, getPool, withTransaction } from '../connection.js';
import { DEMO_USER_ID, isLocalDbTarget } from './demo-guard.js';
import { DEMO_SIGNALS } from './demo-fixtures/signals.js';

type Db = Pick<PoolClient, 'query'>;

export interface PackagedSampleEnvironment {
  desktopMode: string | undefined;
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  packaged: boolean;
}

export type PackagedSampleGuardResult =
  { ok: true } | { ok: false; reason: string };

export interface PackagedSampleProvisionResult {
  created: boolean;
  userId: string;
}

export interface PackagedSampleIngestResult {
  ingested: number;
  total: number;
}

const PACKAGED_SAMPLE_FIXTURE_VERSION = 1;

function fixtureSignalId(index: number): string {
  return `51a7e000-0001-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

/**
 * This bootstrap is deliberately narrower than the developer demo fixture.
 * It is valid only inside the packaged desktop runtime and only against the
 * bundled loopback database. An operator-supplied hosted DATABASE_URL must
 * never receive synthetic data merely because the desktop app started.
 */
export function assertPackagedSampleSafe(
  env: PackagedSampleEnvironment,
): PackagedSampleGuardResult {
  if (!env.packaged) {
    return {
      ok: false,
      reason: 'sample bootstrap is restricted to packaged desktop builds',
    };
  }
  if (env.desktopMode !== 'true') {
    return { ok: false, reason: 'DESKTOP_MODE=true is required' };
  }
  if ((env.nodeEnv ?? '').toLowerCase() !== 'production') {
    return { ok: false, reason: 'NODE_ENV=production is required' };
  }
  if (!env.databaseUrl || !isLocalDbTarget(env.databaseUrl)) {
    return {
      ok: false,
      reason: 'sample bootstrap requires the bundled loopback database',
    };
  }
  return { ok: true };
}

/**
 * Create the reserved sample identity once. Existing demo rows are left
 * untouched, while a non-demo row occupying the reserved UUID aborts startup
 * provisioning rather than exposing or modifying that account.
 */
export async function provisionPackagedSampleWithClient(
  client: Db,
): Promise<PackagedSampleProvisionResult> {
  const inserted = await client.query(
    `INSERT INTO users (id, email, name, trust_tier, autonomy_settings, is_demo)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      DEMO_USER_ID,
      'sample@local.invalid',
      'Sample User',
      'observer',
      JSON.stringify({ maxAutoSpend: 0 }),
    ],
  );

  if (inserted.rowCount === 0) {
    const existing = await client.query<{ is_demo: boolean }>(
      `SELECT is_demo FROM users WHERE id = $1`,
      [DEMO_USER_ID],
    );
    if (existing.rows[0]?.is_demo !== true) {
      throw new Error(
        'reserved sample identity is occupied by a non-sample account',
      );
    }
  }

  await client.query(
    `INSERT INTO twin_profiles (user_id, version)
     VALUES ($1, 1)
     ON CONFLICT (user_id) DO NOTHING`,
    [DEMO_USER_ID],
  );
  return { created: inserted.rowCount === 1, userId: DEMO_USER_ID };
}

export async function provisionPackagedSample(
  env: PackagedSampleEnvironment,
): Promise<PackagedSampleProvisionResult> {
  const guard = assertPackagedSampleSafe(env);
  if (!guard.ok) throw new Error(guard.reason);

  getPool();
  try {
    return await withTransaction(provisionPackagedSampleWithClient);
  } finally {
    await closePool();
  }
}

/** Feed the sample through the normal ingest boundary using the loopback-only service credential. */
export async function ingestPackagedSampleSignals(options: {
  apiUrl: string;
  serviceToken: string;
  userId?: string;
  fetchImpl?: typeof fetch;
}): Promise<PackagedSampleIngestResult> {
  if (!options.serviceToken)
    throw new Error('loopback service credential is required');
  const fetchImpl = options.fetchImpl ?? fetch;
  const userId = options.userId ?? DEMO_USER_ID;
  if (userId !== DEMO_USER_ID)
    throw new Error('sample ingest is restricted to the reserved identity');

  let ingested = 0;
  for (const [index, signal] of DEMO_SIGNALS.entries()) {
    const response = await fetchImpl(`${options.apiUrl}/api/events/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-skytwin-service-token': options.serviceToken,
      },
      body: JSON.stringify({
        userId,
        signalId: fixtureSignalId(index),
        source: signal.source,
        type: signal.type,
        data: {
          ...signal.data,
          sampleFixtureVersion: PACKAGED_SAMPLE_FIXTURE_VERSION,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(
        `sample signal ingest failed with HTTP ${response.status}`,
      );
    }
    ingested++;
  }
  return { ingested, total: DEMO_SIGNALS.length };
}
