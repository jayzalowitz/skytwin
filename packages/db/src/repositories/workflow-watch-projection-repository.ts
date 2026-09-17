import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  AdaptiveWorkflow,
  RoutineSpec,
  WorkflowActivationEvent,
  WorkflowActivationKind,
} from '@skytwin/shared-types';
import { compileSignalDigestV1 } from '@skytwin/routines';
import { withTransaction } from '../connection.js';
import { databaseSafeInteger } from './database-values.js';

interface WorkflowRow {
  id: string;
  user_id: string;
  provider_key: string;
  active_version_id: string | null;
  active_activation_event_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  provider_key: string;
  provider_schema_version: string;
  canonical_payload: Record<string, unknown>;
  content_hash: string;
}

interface EventRow {
  id: string;
  workflow_id: string;
  user_id: string;
  event_sequence: number | string;
  previous_version_id: string | null;
  activated_version_id: string;
  proposal_id: string | null;
  kind: WorkflowActivationKind;
  created_at: Date;
}

export interface MaterializeWorkflowVersionInput {
  userId: string;
  workflowId: string;
  versionId: string;
  expectedActiveVersionId: string | null;
  proposalId?: string;
  kind: WorkflowActivationKind;
  sourceText: string;
  nextRunAt: Date;
}

export type MaterializeWorkflowVersionResult =
  | { success: true; workflow: AdaptiveWorkflow; event: WorkflowActivationEvent; watchId: string }
  | {
      success: false;
      reason:
        | 'workflow_not_found'
        | 'version_not_found'
        | 'proposal_not_found'
        | 'active_version_conflict'
        | 'not_previously_active'
        | 'projection_mismatch';
    };

function toWorkflow(row: WorkflowRow): AdaptiveWorkflow {
  return {
    id: row.id,
    userId: row.user_id,
    providerKey: row.provider_key,
    activeVersionId: row.active_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: EventRow): WorkflowActivationEvent {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    userId: row.user_id,
    sequence: databaseSafeInteger(
      row.event_sequence,
      'workflow_activation_events.event_sequence',
    ),
    previousVersionId: row.previous_version_id,
    activatedVersionId: row.activated_version_id,
    proposalId: row.proposal_id,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

function storedFilter(spec: RoutineSpec): Required<RoutineSpec['filter']> {
  return {
    sources: spec.filter.sources ?? [],
    fromContains: spec.filter.fromContains ?? [],
    keywords: spec.filter.keywords ?? [],
    domains: spec.filter.domains ?? [],
  };
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

/** Atomically select a version and materialize it into the existing Watch scheduler. */
export const workflowWatchProjectionRepository = {
  async materializeVersion(
    input: MaterializeWorkflowVersionInput,
  ): Promise<MaterializeWorkflowVersionResult> {
    if (!input.sourceText.trim() || Buffer.byteLength(input.sourceText, 'utf8') > 4_096) {
      throw new TypeError('Workflow projection source text must be 1-4096 UTF-8 bytes');
    }
    if (Number.isNaN(input.nextRunAt.getTime())) {
      throw new TypeError('Workflow projection next run must be a valid date');
    }

    const eventId = randomUUID();
    const newWatchId = randomUUID();
    return withSerializableRetry(async (client) => {
      const owned = await client.query<WorkflowRow>(
        `SELECT * FROM workflows WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [input.workflowId, input.userId],
      );
      const workflow = owned.rows[0];
      if (!workflow) return { success: false, reason: 'workflow_not_found' };
      if (input.kind === 'rollback' && input.versionId === input.expectedActiveVersionId) {
        return { success: false, reason: 'not_previously_active' };
      }

      const versionResult = await client.query<VersionRow>(
        `SELECT id, provider_key, provider_schema_version, canonical_payload, content_hash
           FROM workflow_versions
          WHERE id = $1 AND workflow_id = $2 AND user_id = $3`,
        [input.versionId, input.workflowId, input.userId],
      );
      const version = versionResult.rows[0];
      if (!version) return { success: false, reason: 'version_not_found' };
      const compiled = compileSignalDigestV1(version.canonical_payload);
      if (!compiled.ok) return { success: false, reason: 'projection_mismatch' };
      const projection = compiled.artifact;
      if (workflow.provider_key !== projection.providerKey
          || version.provider_key !== projection.providerKey
          || version.provider_schema_version !== projection.providerSchemaVersion
          || version.content_hash !== projection.contentHash) {
        return { success: false, reason: 'projection_mismatch' };
      }

      if (workflow.active_version_id === input.versionId
          && input.expectedActiveVersionId !== input.versionId) {
        const alreadyApplied = await client.query<{
          watch_id: string;
          event_id: string;
          workflow_id: string;
          user_id: string;
          event_sequence: number | string;
          previous_version_id: string | null;
          activated_version_id: string;
          proposal_id: string | null;
          kind: WorkflowActivationKind;
          created_at: Date;
        }>(
          `SELECT w.id AS watch_id, e.id AS event_id, e.workflow_id, e.user_id,
                  e.event_sequence, e.previous_version_id, e.activated_version_id, e.proposal_id,
                  e.kind, e.created_at
             FROM watches AS w
             JOIN workflow_activation_events AS e
               ON e.workflow_id = w.workflow_id AND e.user_id = w.user_id
            WHERE w.workflow_id = $1 AND w.user_id = $2
              AND w.workflow_version_id = $3
              AND w.workflow_provider_key = $4
              AND w.workflow_provider_schema_version = $5
              AND w.content_hash = $6 AND w.projection_version = $7
              AND e.activated_version_id = $3
              AND e.previous_version_id IS NOT DISTINCT FROM $8
              AND e.proposal_id IS NOT DISTINCT FROM $9
              AND e.kind = $10
              AND e.id = $11
            LIMIT 1`,
          [
            input.workflowId, input.userId, input.versionId, projection.providerKey,
            projection.providerSchemaVersion, projection.contentHash, projection.projectionVersion,
            input.expectedActiveVersionId,
            input.kind === 'activate' ? input.proposalId ?? null : null,
            input.kind,
            workflow.active_activation_event_id,
          ],
        );
        const applied = alreadyApplied.rows[0];
        if (applied) {
          return {
            success: true,
            workflow: toWorkflow(workflow),
            event: toEvent({
              id: applied.event_id,
              workflow_id: applied.workflow_id,
              user_id: applied.user_id,
              event_sequence: applied.event_sequence,
              previous_version_id: applied.previous_version_id,
              activated_version_id: applied.activated_version_id,
              proposal_id: applied.proposal_id,
              kind: applied.kind,
              created_at: applied.created_at,
            }),
            watchId: applied.watch_id,
          };
        }
      }
      if (workflow.active_version_id !== input.expectedActiveVersionId) {
        return { success: false, reason: 'active_version_conflict' };
      }

      const proposalId = input.kind === 'activate' ? input.proposalId ?? null : null;
      if (input.kind === 'activate') {
        if (proposalId === null) return { success: false, reason: 'proposal_not_found' };
        const proposal = await client.query<{ id: string }>(
          `SELECT id FROM workflow_proposals
            WHERE id = $1 AND workflow_id = $2 AND user_id = $3
              AND proposed_version_id = $4
              AND base_version_id IS NOT DISTINCT FROM $5
              AND NOT EXISTS (
                SELECT 1 FROM workflow_activation_events AS consumed
                 WHERE consumed.proposal_id = workflow_proposals.id
              )`,
          [proposalId, input.workflowId, input.userId, input.versionId, input.expectedActiveVersionId],
        );
        if (!proposal.rows[0]) return { success: false, reason: 'proposal_not_found' };
      } else {
        if (input.expectedActiveVersionId === null) {
          return { success: false, reason: 'active_version_conflict' };
        }
        const prior = await client.query<{ id: string }>(
          `SELECT id FROM workflow_activation_events
            WHERE workflow_id = $1 AND user_id = $2 AND activated_version_id = $3
            LIMIT 1`,
          [input.workflowId, input.userId, input.versionId],
        );
        if (!prior.rows[0]) return { success: false, reason: 'not_previously_active' };
      }

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM watches WHERE workflow_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.workflowId, input.userId],
      );
      let watchId: string;
      if (existing.rows[0]) {
        watchId = existing.rows[0].id;
        const updated = await client.query<{ id: string }>(
          `UPDATE watches
              SET name = $3, source_text = $4, cadence = $5,
                  hour_of_day = $6, day_of_week = $7, filter = $8::JSONB,
                  action = $9,
                  next_run_at = CASE WHEN status = 'active' THEN $10 ELSE NULL END,
                  workflow_version_id = $11, workflow_provider_key = $12,
                  workflow_provider_schema_version = $13, content_hash = $14,
                  projection_version = $15, schedule_revision = gen_random_uuid(),
                  updated_at = now()
            WHERE id = $1 AND user_id = $2 AND workflow_id = $16
          RETURNING id`,
          [
            watchId, input.userId, projection.routineSpec.name, input.sourceText.trim(),
            projection.routineSpec.cadence, projection.routineSpec.hourOfDay ?? null,
            projection.routineSpec.dayOfWeek ?? null,
            JSON.stringify(storedFilter(projection.routineSpec)), projection.routineSpec.action,
            input.nextRunAt, input.versionId, projection.providerKey,
            projection.providerSchemaVersion, projection.contentHash,
            projection.projectionVersion, input.workflowId,
          ],
        );
        if (!updated.rows[0]) throw new Error('Workflow Watch projection update lost its lock');
      } else {
        watchId = newWatchId;
        await client.query(
          `INSERT INTO watches
             (id, user_id, name, source_text, cadence, hour_of_day, day_of_week,
              filter, action, status, next_run_at, workflow_id, workflow_version_id,
              workflow_provider_key, workflow_provider_schema_version, content_hash,
              projection_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9, 'active', $10,
                   $11, $12, $13, $14, $15, $16)`,
          [
            watchId, input.userId, projection.routineSpec.name, input.sourceText.trim(),
            projection.routineSpec.cadence, projection.routineSpec.hourOfDay ?? null,
            projection.routineSpec.dayOfWeek ?? null,
            JSON.stringify(storedFilter(projection.routineSpec)), projection.routineSpec.action,
            input.nextRunAt, input.workflowId, input.versionId, projection.providerKey,
            projection.providerSchemaVersion, projection.contentHash,
            projection.projectionVersion,
          ],
        );
      }

      const event = await client.query<EventRow>(
        `INSERT INTO workflow_activation_events
           (id, workflow_id, user_id, previous_version_id,
            activated_version_id, proposal_id, kind, event_sequence)
         SELECT $1, $2, $3, $4, $5, $6, $7,
                COALESCE(max(event_sequence), 0) + 1
           FROM workflow_activation_events
          WHERE workflow_id = $2 AND user_id = $3
         RETURNING *`,
        [eventId, input.workflowId, input.userId, input.expectedActiveVersionId,
          input.versionId, proposalId, input.kind],
      );
      const updatedWorkflow = await client.query<WorkflowRow>(
        `UPDATE workflows
            SET active_version_id = $3, active_activation_event_id = $5, updated_at = now()
          WHERE id = $1 AND user_id = $2
            AND active_version_id IS NOT DISTINCT FROM $4
        RETURNING *`,
        [
          input.workflowId,
          input.userId,
          input.versionId,
          input.expectedActiveVersionId,
          eventId,
        ],
      );
      if (!updatedWorkflow.rows[0]) {
        throw new Error('Workflow active version changed after its owner lock');
      }
      return {
        success: true,
        workflow: toWorkflow(updatedWorkflow.rows[0]),
        event: toEvent(event.rows[0]!),
        watchId,
      };
    });
  },
};
