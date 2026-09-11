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
const PACKAGED_SAMPLE_FIXTURE_ID_SEGMENT = PACKAGED_SAMPLE_FIXTURE_VERSION
  .toString(16)
  .padStart(4, '0');

function fixtureSignalId(index: number): string {
  return `51a7e000-${PACKAGED_SAMPLE_FIXTURE_ID_SEGMENT}-4000-8000-${String(index + 1).padStart(12, '0')}`;
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
    `INSERT INTO users (id, email, name, trust_tier, autonomy_settings, is_demo, demo_ready)
     VALUES ($1, $2, $3, $4, $5, true, false)
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

  // Reassert the side-effect-free policy before every ingest and make the
  // profile unavailable until the complete fixture is confirmed below.
  await client.query(
    `UPDATE users
        SET trust_tier = 'observer',
            autonomy_settings = $2,
            demo_ready = false,
            updated_at = now()
      WHERE id = $1 AND is_demo = true`,
    [DEMO_USER_ID, JSON.stringify({ maxAutoSpend: 0 })],
  );

  await client.query(
    `INSERT INTO twin_profiles (user_id, version)
     VALUES ($1, 1)
     ON CONFLICT (user_id) DO NOTHING`,
    [DEMO_USER_ID],
  );
  return { created: inserted.rowCount === 1, userId: DEMO_USER_ID };
}

export async function markPackagedSampleReadyWithClient(client: Db): Promise<void> {
  const result = await client.query(
    `UPDATE users SET demo_ready = true, updated_at = now()
      WHERE id = $1 AND is_demo = true
      RETURNING id`,
    [DEMO_USER_ID],
  );
  if (result.rowCount !== 1) {
    throw new Error('reserved sample identity is missing');
  }
}

export async function markPackagedSampleReady(): Promise<void> {
  getPool();
  try {
    await withTransaction(markPackagedSampleReadyWithClient);
  } finally {
    await closePool();
  }
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
  let apiUrl: URL;
  try {
    apiUrl = new URL(options.apiUrl);
  } catch {
    throw new Error('sample ingest requires a valid loopback API URL');
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (
    !['http:', 'https:'].includes(apiUrl.protocol) ||
    !loopbackHosts.has(apiUrl.hostname.toLowerCase()) ||
    apiUrl.username !== '' ||
    apiUrl.password !== '' ||
    (apiUrl.pathname !== '' && apiUrl.pathname !== '/')
  ) {
    throw new Error('sample ingest is restricted to a loopback API URL');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const userId = options.userId ?? DEMO_USER_ID;
  if (userId !== DEMO_USER_ID)
    throw new Error('sample ingest is restricted to the reserved identity');

  let ingested = 0;
  for (const [index, signal] of DEMO_SIGNALS.entries()) {
    const response = await fetchImpl(
      new URL('/api/events/ingest', apiUrl).toString(),
      {
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
      },
    );
    if (!response.ok) {
      throw new Error(
        `sample signal ingest failed with HTTP ${response.status}`,
      );
    }
    ingested++;
  }
  return { ingested, total: DEMO_SIGNALS.length };
}
