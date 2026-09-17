import { Client, type PoolClient } from 'pg';
import { DEMO_USER_ID, isLocalDbTarget } from './demo-guard.js';
import { DEMO_SIGNALS } from './demo-fixtures/signals.js';

type Db = Pick<PoolClient, 'query'>;

const OWNED_SAMPLE_CONNECTION_TIMEOUT_MS = 5_000;
const OWNED_SAMPLE_QUERY_TIMEOUT_MS = 30_000;

export interface PackagedSampleEnvironment {
  desktopMode: string | undefined;
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  bundledDatabaseUrl: string | undefined;
  databaseOwnership: 'managed-child' | 'preexisting';
  managedDataDir: string | null;
  bundledDataDir: string;
  packaged: boolean;
}

export interface OwnedSampleClient extends Db {
  connect(): Promise<unknown>;
  end(): Promise<void>;
}

export interface PackagedSampleProvisionOptions extends PackagedSampleEnvironment {
  /** Revalidates the exact CockroachDB child capability for this launch. */
  authorize: () => boolean;
  /** Test seam for proving connection and authority sequencing. */
  createClient?: (connectionString: string) => OwnedSampleClient;
}

export type PackagedSampleGuardResult = { ok: true } | { ok: false; reason: string };

export interface PackagedSampleProvisionResult {
  created: boolean;
  userId: string;
}

export interface PackagedSampleIngestResult {
  ingested: number;
  total: number;
}

const PACKAGED_SAMPLE_FIXTURE_VERSION = 1;
const PACKAGED_SAMPLE_FIXTURE_ID_SEGMENT = PACKAGED_SAMPLE_FIXTURE_VERSION.toString(16).padStart(4, '0');

function fixtureSignalId(index: number): string {
  return `51a7e000-${PACKAGED_SAMPLE_FIXTURE_ID_SEGMENT}-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

class NonRetryableSampleIngestError extends Error {}

function requireOwnedSampleAuthority(authorize: () => boolean): void {
  if (!authorize()) {
    throw new Error('CockroachDB ownership changed; refusing packaged sample write');
  }
}

function ownedSampleClient(connectionString: string): OwnedSampleClient {
  return new Client({
    connectionString,
    connectionTimeoutMillis: OWNED_SAMPLE_CONNECTION_TIMEOUT_MS,
    query_timeout: OWNED_SAMPLE_QUERY_TIMEOUT_MS,
  });
}

/**
 * This bootstrap is deliberately narrower than the developer demo fixture.
 * It is valid only inside the packaged desktop runtime and only against the
 * bundled loopback database. An operator-supplied hosted DATABASE_URL must
 * never receive synthetic data merely because the desktop app started.
 */
export function assertPackagedSampleSafe(env: PackagedSampleEnvironment): PackagedSampleGuardResult {
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
  if (
    env.databaseOwnership !== 'managed-child' ||
    env.managedDataDir === null ||
    env.managedDataDir !== env.bundledDataDir
  ) {
    return {
      ok: false,
      reason: 'sample bootstrap requires a desktop-managed database process and data directory',
    };
  }
  if (
    !env.databaseUrl ||
    !env.bundledDatabaseUrl ||
    env.databaseUrl !== env.bundledDatabaseUrl ||
    !isLocalDbTarget(env.databaseUrl)
  ) {
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
  authorize: () => boolean,
): Promise<PackagedSampleProvisionResult> {
  requireOwnedSampleAuthority(authorize);
  const inserted = await client.query(
    `INSERT INTO users (id, email, name, trust_tier, autonomy_settings, is_demo)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [DEMO_USER_ID, 'sample@local.invalid', 'Sample User', 'observer', JSON.stringify({ maxAutoSpend: 0 })],
  );

  if (inserted.rowCount === 0) {
    requireOwnedSampleAuthority(authorize);
    const existing = await client.query<{ is_demo: boolean }>(`SELECT is_demo FROM users WHERE id = $1`, [
      DEMO_USER_ID,
    ]);
    if (existing.rows[0]?.is_demo !== true) {
      throw new Error('reserved sample identity is occupied by a non-sample account');
    }
  }

  requireOwnedSampleAuthority(authorize);
  await client.query(
    `INSERT INTO twin_profiles (user_id, version)
     VALUES ($1, 1)
     ON CONFLICT (user_id) DO NOTHING`,
    [DEMO_USER_ID],
  );
  return { created: inserted.rowCount === 1, userId: DEMO_USER_ID };
}

export async function provisionPackagedSample(
  options: PackagedSampleProvisionOptions,
): Promise<PackagedSampleProvisionResult> {
  const guard = assertPackagedSampleSafe(options);
  if (!guard.ok) throw new Error(guard.reason);
  if (!options.databaseUrl) throw new Error('packaged sample database URL is required');

  const createClient = options.createClient ?? ownedSampleClient;
  const client = createClient(options.databaseUrl);
  let transactionStarted = false;
  try {
    await client.connect();
    requireOwnedSampleAuthority(options.authorize);
    transactionStarted = true;
    await client.query('BEGIN');
    const result = await provisionPackagedSampleWithClient(client, options.authorize);
    requireOwnedSampleAuthority(options.authorize);
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Feed the sample through the normal ingest boundary using the loopback-only service credential. */
export async function ingestPackagedSampleSignals(options: {
  apiUrl: string;
  serviceToken: string;
  userId?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  signal: AbortSignal;
  authorizeRequest: () => Promise<boolean>;
}): Promise<PackagedSampleIngestResult> {
  if (!options.serviceToken) throw new Error('loopback service credential is required');
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
  if (userId !== DEMO_USER_ID) throw new Error('sample ingest is restricted to the reserved identity');
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 250;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000)
    throw new Error('sample ingest request timeout must be between 1 and 30000 ms');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
    throw new Error('sample ingest max attempts must be between 1 and 5');
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000)
    throw new Error('sample ingest retry delay must be between 0 and 5000 ms');

  const assertRequestAuthorized = async (): Promise<void> => {
    if (options.signal.aborted) {
      throw new NonRetryableSampleIngestError('sample ingest launch authority was revoked');
    }
    let authorized = false;
    try {
      authorized = await options.authorizeRequest();
    } catch {
      authorized = false;
    }
    if (!authorized || options.signal.aborted) {
      throw new NonRetryableSampleIngestError('sample ingest target is no longer authorized');
    }
  };

  let ingested = 0;
  for (const [index, signal] of DEMO_SIGNALS.entries()) {
    const requestUrl = new URL('/api/events/ingest', apiUrl).toString();
    const requestBody = JSON.stringify({
      userId,
      signalId: fixtureSignalId(index),
      source: signal.source,
      type: signal.type,
      data: {
        ...signal.data,
        sampleFixtureVersion: PACKAGED_SAMPLE_FIXTURE_VERSION,
      },
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let removeLaunchAbort: (() => void) | undefined;
      try {
        await assertRequestAuthorized();
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('sample signal ingest request timed out'));
          }, requestTimeoutMs);
        });
        const launchAbortPromise = new Promise<never>((_resolve, reject) => {
          const abort = (): void => {
            controller.abort();
            reject(new NonRetryableSampleIngestError('sample ingest launch authority was revoked'));
          };
          if (options.signal.aborted) {
            abort();
            return;
          }
          options.signal.addEventListener('abort', abort, { once: true });
          removeLaunchAbort = () => options.signal.removeEventListener('abort', abort);
        });
        const response = await Promise.race([
          fetchImpl(requestUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-skytwin-service-token': options.serviceToken,
            },
            body: requestBody,
            signal: controller.signal,
          }),
          timeoutPromise,
          launchAbortPromise,
        ]);
        if (response.ok) break;
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const error = new Error(`sample signal ingest failed with HTTP ${response.status}`);
        if (!retryable) throw new NonRetryableSampleIngestError(error.message);
        if (attempt === maxAttempts) throw error;
      } catch (error) {
        if (error instanceof NonRetryableSampleIngestError || attempt === maxAttempts) throw error;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        removeLaunchAbort?.();
      }
      if (retryDelayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            options.signal.removeEventListener('abort', abort);
            resolve();
          }, retryDelayMs);
          const abort = (): void => {
            clearTimeout(timer);
            reject(new NonRetryableSampleIngestError('sample ingest launch authority was revoked'));
          };
          if (options.signal.aborted) {
            abort();
            return;
          }
          options.signal.addEventListener('abort', abort, { once: true });
        });
      }
    }
    ingested++;
  }
  return { ingested, total: DEMO_SIGNALS.length };
}
