import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  canonicalizeWorkflowPayload,
  snapshotWorkflowAuthoringMetadata,
  workflowVersionContentHash,
  type RoutineFilter,
  type RoutineSpec,
} from '@skytwin/shared-types';
import {
  computeNextRun,
  compileSignalDigestV1,
  SIGNAL_DIGEST_V1_PROJECTION_VERSION,
  SIGNAL_DIGEST_V1_PROVIDER_KEY,
  SIGNAL_DIGEST_V1_SCHEMA_VERSION,
  validateSignalDigestV1Payload,
  type SignalDigestV1Payload,
} from '@skytwin/routines';
import { withTransaction } from '../connection.js';
import { databaseNullableSafeInteger } from './database-values.js';

const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 100;
const LEGACY_WATCH_QUARANTINE_PROVIDER_KEY = 'legacy_watch.quarantine.v1';
const LEGACY_WATCH_QUARANTINE_SCHEMA_VERSION = '1';

/** Deterministic, bounded intent for legacy Watches that predate authored summaries. */
export const LEGACY_WATCH_SUMMARY_INSTRUCTION =
  'Summarize matching signals concisely and cite the source signals.';

interface LegacyWatchRow {
  id: string;
  user_id: string;
  name: string;
  source_text: string;
  cadence: RoutineSpec['cadence'];
  /** CockroachDB INT uses the PostgreSQL int8 wire type, which pg returns as a string. */
  hour_of_day: number | string | null;
  day_of_week: number | string | null;
  filter: Record<string, unknown> | null;
  action: RoutineSpec['action'];
  status: 'draft' | 'active' | 'paused';
  next_run_at: Date | null;
  timezone: string | null;
}

interface ActiveWorkflowVersionRow {
  workflow_id: string;
  user_id: string;
  version_id: string;
  provider_key: string;
  provider_schema_version: string;
  canonical_payload: Record<string, unknown>;
  content_hash: string;
  timezone: string | null;
}

export interface ReconcileLegacyWatchWorkflowsInput {
  /** Total work items (legacy Watches plus missing active projections) to process. */
  limit?: number;
  /** Injectable clock for deterministic scheduling tests. */
  now?: Date;
}

export interface ReconcileLegacyWatchWorkflowsResult {
  legacyWatchesMigrated: number;
  activeWorkflowProjectionsMaterialized: number;
  /** A conservative hint; callers should keep scheduling bounded reconciliation. */
  mayHaveMore: boolean;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('Legacy Watch reconciliation limit must be a positive integer');
  }
  return Math.min(limit, MAX_BATCH_LIMIT);
}

function normalizedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().replace(/\s+/gu, ' ').toLowerCase())
    .filter(Boolean)
    .map((entry) => entry.slice(0, 200)))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .slice(0, 50);
}

function normalizedFilter(filter: Record<string, unknown> | null): Required<RoutineFilter> {
  return {
    sources: normalizedList(filter?.['sources']),
    fromContains: normalizedList(filter?.['fromContains']),
    keywords: normalizedList(filter?.['keywords']),
    domains: normalizedList(filter?.['domains']),
  };
}

function weekdayInTimeZone(date: Date | null, timezone: string | null): number {
  if (!date || !timezone) return -1;
  try {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    }).format(date);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  } catch {
    return -1;
  }
}

function legacyPayload(watch: LegacyWatchRow): SignalDigestV1Payload {
  const name = watch.name.trim().replace(/\s+/gu, ' ').slice(0, 120) || 'Signal digest';
  const hourOfDay = databaseNullableSafeInteger(
    watch.hour_of_day,
    'watches.hour_of_day',
  ) ?? 8;
  const dayOfWeek = databaseNullableSafeInteger(
    watch.day_of_week,
    'watches.day_of_week',
  )
    ?? weekdayInTimeZone(watch.next_run_at, watch.timezone);
  return {
    name,
    cadence: watch.cadence,
    action: watch.action,
    filter: normalizedFilter(watch.filter),
    summaryInstruction: LEGACY_WATCH_SUMMARY_INSTRUCTION,
    timezone: watch.timezone ?? 'UTC',
    ...(watch.cadence !== 'hourly' ? { hourOfDay } : {}),
    ...(watch.cadence === 'weekly' ? { dayOfWeek } : {}),
  };
}

function storedFilter(spec: RoutineSpec): Required<RoutineFilter> {
  return {
    sources: spec.filter.sources ?? [],
    fromContains: spec.filter.fromContains ?? [],
    keywords: spec.filter.keywords ?? [],
    domains: spec.filter.domains ?? [],
  };
}

function validationReason(issues: ReadonlyArray<{ path: string; code: string }>): string {
  return issues.slice(0, 20).map((issue) => `${issue.path}:${issue.code}`).join(',')
    || 'unknown_validation_failure';
}

function quarantinePayload(watch: LegacyWatchRow, reason: string) {
  return canonicalizeWorkflowPayload({
    kind: 'legacy_watch_quarantine.v1',
    reasonCode: 'invalid_signal_digest_payload',
    reason,
    sourceWatchId: watch.id,
    originalStatus: watch.status,
  });
}

async function withSerializableRetry<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTransaction(fn);
    } catch (error) {
      lastError = error;
      if ((error as { code?: unknown } | null)?.code !== '40001' || attempt === 2) throw error;
    }
  }
  throw lastError;
}

async function migrateOneLegacyWatch(): Promise<boolean> {
  // IDs are allocated outside the retry callback so a Cockroach restart uses
  // the exact same identities. The Watch row lock decides the durable winner.
  const workflowId = randomUUID();
  const versionId = randomUUID();
  const proposalId = randomUUID();
  const activationEventId = randomUUID();
  return withSerializableRetry(async (client) => {
    const claimed = await client.query<LegacyWatchRow>(
      `SELECT w.id, w.user_id, w.name, w.source_text, w.cadence,
              w.hour_of_day, w.day_of_week, w.filter, w.action, w.status,
              w.next_run_at, u.timezone
        FROM watches AS w
        JOIN users AS u ON u.id = w.user_id
        WHERE w.workflow_id IS NULL
        ORDER BY w.created_at ASC, w.id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    const watch = claimed.rows[0];
    if (!watch) return false;

    const candidatePayload = legacyPayload(watch);
    const validation = validateSignalDigestV1Payload(candidatePayload);
    const isQuarantined = !validation.ok;
    const payload = validation.ok ? validation.payload : candidatePayload;
    const providerKey = isQuarantined
      ? LEGACY_WATCH_QUARANTINE_PROVIDER_KEY
      : SIGNAL_DIGEST_V1_PROVIDER_KEY;
    const providerSchemaVersion = isQuarantined
      ? LEGACY_WATCH_QUARANTINE_SCHEMA_VERSION
      : SIGNAL_DIGEST_V1_SCHEMA_VERSION;
    const canonicalPayload = validation.ok
      ? canonicalizeWorkflowPayload(payload)
      : quarantinePayload(watch, validationReason(validation.issues));
    const contentHash = workflowVersionContentHash({
      providerKey,
      providerSchemaVersion,
      canonicalPayload,
    });
    const authoring = snapshotWorkflowAuthoringMetadata({
      version: 1,
      source: 'migration',
      sourceReferences: [{ kind: 'watch', id: watch.id }],
    });

    await client.query(
      `INSERT INTO workflows (id, user_id, provider_key)
       VALUES ($1, $2, $3)`,
      [workflowId, watch.user_id, providerKey],
    );
    await client.query(
      `INSERT INTO workflow_versions
         (id, workflow_id, user_id, version_number, provider_key,
          provider_schema_version, canonical_payload, content_hash,
          parent_version_id, authoring_metadata, inference_metadata)
       VALUES ($1, $2, $3, 1, $4, $5, $6::JSONB, $7, NULL, $8::JSONB, NULL)`,
      [versionId, workflowId, watch.user_id, providerKey,
        providerSchemaVersion, JSON.stringify(canonicalPayload), contentHash,
        JSON.stringify(authoring)],
    );
    await client.query(
      `INSERT INTO workflow_proposals
         (id, workflow_id, user_id, base_version_id, proposed_version_id, kind)
       VALUES ($1, $2, $3, NULL, $4, 'initial')`,
      [proposalId, workflowId, watch.user_id, versionId],
    );

    // The workflow pointer selects the immutable intent version; Watch status
    // independently controls whether its projection is scheduled. Preserve
    // paused/draft operational state while still giving every valid migrated
    // Watch a selected version that can later be resumed safely.
    if (!isQuarantined) {
      await client.query(
        `INSERT INTO workflow_activation_events
           (id, workflow_id, user_id, previous_version_id,
            activated_version_id, proposal_id, kind, event_sequence)
         VALUES ($1, $2, $3, NULL, $4, $5, 'activate', 1)`,
        [activationEventId, workflowId, watch.user_id, versionId, proposalId],
      );
      const activated = await client.query<{ id: string }>(
        `UPDATE workflows
            SET active_version_id = $3, active_activation_event_id = $4, updated_at = now()
          WHERE id = $1 AND user_id = $2 AND active_version_id IS NULL
        RETURNING id`,
        [workflowId, watch.user_id, versionId, activationEventId],
      );
      if (!activated.rows[0]) throw new Error('Legacy Watch workflow activation lost its lock');
    }

    const updated = isQuarantined
      ? await client.query<{ id: string }>(
        `UPDATE watches
            SET status = CASE WHEN status = 'active' THEN 'paused' ELSE status END,
                next_run_at = NULL,
                schedule_revision = CASE
                  WHEN status = 'active' OR next_run_at IS NOT NULL THEN gen_random_uuid()
                                         ELSE schedule_revision END,
                workflow_id = $3, workflow_version_id = $4,
                workflow_provider_key = $5, workflow_provider_schema_version = $6,
                content_hash = $7, projection_version = $8,
                updated_at = CASE
                  WHEN status = 'active' OR next_run_at IS NOT NULL THEN now()
                  ELSE updated_at END
          WHERE id = $1 AND user_id = $2 AND workflow_id IS NULL
        RETURNING id`,
        [watch.id, watch.user_id, workflowId, versionId, providerKey,
          providerSchemaVersion, contentHash, SIGNAL_DIGEST_V1_PROJECTION_VERSION],
      )
      : await client.query<{ id: string }>(
        `UPDATE watches
            SET name = $3, cadence = $4, hour_of_day = $5, day_of_week = $6,
                filter = $7::JSONB, action = $8,
                next_run_at = CASE WHEN status = 'active' THEN next_run_at ELSE NULL END,
                schedule_revision = CASE
                  WHEN status <> 'active' AND next_run_at IS NOT NULL THEN gen_random_uuid()
                  ELSE schedule_revision END,
                workflow_id = $9, workflow_version_id = $10,
                workflow_provider_key = $11, workflow_provider_schema_version = $12,
                content_hash = $13, projection_version = $14,
                updated_at = CASE
                  WHEN status <> 'active' AND next_run_at IS NOT NULL THEN now()
                  ELSE updated_at END
          WHERE id = $1 AND user_id = $2 AND workflow_id IS NULL
        RETURNING id`,
        [watch.id, watch.user_id, payload.name, payload.cadence, payload.hourOfDay ?? null,
          payload.dayOfWeek ?? null, JSON.stringify(storedFilter(payload)), payload.action,
          workflowId, versionId, providerKey, providerSchemaVersion, contentHash,
          SIGNAL_DIGEST_V1_PROJECTION_VERSION],
      );
    if (!updated.rows[0]) throw new Error('Legacy Watch pin update lost its owner lock');
    return true;
  });
}

async function materializeOneMissingActiveProjection(now: Date): Promise<boolean> {
  const watchId = randomUUID();
  return withSerializableRetry(async (client) => {
    const claimed = await client.query<ActiveWorkflowVersionRow>(
      `SELECT wf.id AS workflow_id, wf.user_id, wv.id AS version_id,
              wv.provider_key, wv.provider_schema_version,
              wv.canonical_payload, wv.content_hash, u.timezone
         FROM workflows AS wf
         JOIN users AS u ON u.id = wf.user_id
         JOIN workflow_versions AS wv
           ON wv.id = wf.active_version_id
          AND wv.workflow_id = wf.id
          AND wv.user_id = wf.user_id
        WHERE wf.provider_key = $1
          AND wv.provider_key = $1
          AND NOT EXISTS (
            SELECT 1 FROM watches AS w
             WHERE w.workflow_id = wf.id AND w.user_id = wf.user_id
          )
        ORDER BY wf.created_at ASC, wf.id ASC
        LIMIT 1`,
      [SIGNAL_DIGEST_V1_PROVIDER_KEY],
    );
    const version = claimed.rows[0];
    if (!version) return false;

    // Cockroach does not reliably combine SKIP LOCKED with the joined
    // anti-join above. Lock the selected workflow explicitly, then re-check
    // both its active pointer and the absence of a projection under that lock.
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM workflows
        WHERE id = $1 AND user_id = $2 AND provider_key = $3
          AND active_version_id = $4
        FOR UPDATE`,
      [version.workflow_id, version.user_id, SIGNAL_DIGEST_V1_PROVIDER_KEY, version.version_id],
    );
    if (!locked.rows[0]) return false;
    const existingProjection = await client.query<{ id: string }>(
      `SELECT id FROM watches WHERE workflow_id = $1 AND user_id = $2 LIMIT 1`,
      [version.workflow_id, version.user_id],
    );
    if (existingProjection.rows[0]) return false;
    const supportedIdentity = version.provider_key === SIGNAL_DIGEST_V1_PROVIDER_KEY
      && version.provider_schema_version === SIGNAL_DIGEST_V1_SCHEMA_VERSION;
    const compiled = supportedIdentity ? compileSignalDigestV1(version.canonical_payload) : null;
    const expectedHash = compiled?.ok
      ? workflowVersionContentHash({
        providerKey: version.provider_key,
        providerSchemaVersion: version.provider_schema_version,
        canonicalPayload: canonicalizeWorkflowPayload(
          JSON.parse(compiled.artifact.canonicalPayloadJson),
        ),
      })
      : null;
    let quarantineReason: string | null = null;
    if (!supportedIdentity) {
      quarantineReason = `unsupported_provider_schema:${version.provider_schema_version.slice(0, 128)}`;
    } else if (!compiled?.ok) {
      quarantineReason = `invalid_provider_payload:${validationReason(compiled?.issues ?? [])}`;
    } else if (compiled.artifact.contentHash !== version.content_hash
        || expectedHash !== version.content_hash) {
      quarantineReason = 'content_hash_mismatch';
    }

    if (quarantineReason !== null) {
      await client.query(
        `INSERT INTO watches
           (id, user_id, name, source_text, cadence, hour_of_day, day_of_week,
            filter, action, status, next_run_at, workflow_id, workflow_version_id,
            workflow_provider_key, workflow_provider_schema_version, content_hash,
            projection_version)
         VALUES ($1, $2, 'Workflow projection unavailable', $3, 'hourly', NULL, NULL,
                 $4::JSONB, 'digest', 'paused', NULL, $5, $6, $7, $8, $9, $10)`,
        [watchId, version.user_id, `Projection quarantined: ${quarantineReason}`,
          JSON.stringify({ sources: [], fromContains: [], keywords: [], domains: [] }),
          version.workflow_id, version.version_id, version.provider_key,
          version.provider_schema_version, version.content_hash,
          SIGNAL_DIGEST_V1_PROJECTION_VERSION],
      );
      return true;
    }
    if (!compiled?.ok) throw new Error('Validated workflow compiler state was lost');

    await client.query(
      `INSERT INTO watches
         (id, user_id, name, source_text, cadence, hour_of_day, day_of_week,
          filter, action, status, next_run_at, workflow_id, workflow_version_id,
          workflow_provider_key, workflow_provider_schema_version, content_hash,
          projection_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9, 'active', $10,
               $11, $12, $13, $14, $15, $16)`,
      [watchId, version.user_id, compiled.artifact.routineSpec.name,
        'Restored from the active adaptive workflow version.',
        compiled.artifact.routineSpec.cadence,
        compiled.artifact.routineSpec.hourOfDay ?? null,
        compiled.artifact.routineSpec.dayOfWeek ?? null,
        JSON.stringify(storedFilter(compiled.artifact.routineSpec)),
        compiled.artifact.routineSpec.action,
        computeNextRun(
          compiled.artifact.routineSpec,
          now,
          compiled.artifact.scheduleTimezone ?? version.timezone ?? 'UTC',
        ),
        version.workflow_id, version.version_id, version.provider_key,
        version.provider_schema_version, version.content_hash,
        SIGNAL_DIGEST_V1_PROJECTION_VERSION],
    );
    return true;
  });
}

export const legacyWatchWorkflowReconciliationRepository = {
  async reconcileBatch(
    input: ReconcileLegacyWatchWorkflowsInput = {},
  ): Promise<ReconcileLegacyWatchWorkflowsResult> {
    const limit = boundedLimit(input.limit);
    const now = input.now ?? new Date();
    if (Number.isNaN(now.getTime())) throw new TypeError('Reconciliation clock must be valid');
    let legacyWatchesMigrated = 0;
    let activeWorkflowProjectionsMaterialized = 0;
    let exhausted = false;

    for (let processed = 0; processed < limit; processed += 1) {
      // Recover already-active durable intent before bookkeeping-only legacy
      // conversion. This minimizes time where a restored workflow is active
      // but has no scheduler projection.
      if (await materializeOneMissingActiveProjection(now)) {
        activeWorkflowProjectionsMaterialized += 1;
        continue;
      }
      if (await migrateOneLegacyWatch()) {
        legacyWatchesMigrated += 1;
        continue;
      }
      exhausted = true;
      break;
    }
    return {
      legacyWatchesMigrated,
      activeWorkflowProjectionsMaterialized,
      mayHaveMore: !exhausted
        && legacyWatchesMigrated + activeWorkflowProjectionsMaterialized === limit,
    };
  },
};
