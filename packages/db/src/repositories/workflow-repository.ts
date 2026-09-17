import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  assertWorkflowProviderIdentity,
  canonicalizeWorkflowPayload,
  snapshotWorkflowAuthoringMetadata,
  snapshotWorkflowInferenceMetadata,
  workflowVersionContentHash,
  type AdaptiveWorkflow,
  type AdaptiveWorkflowProposal,
  type AdaptiveWorkflowVersion,
  type WorkflowActivationEvent,
  type WorkflowAuthoringMetadataV1,
  type WorkflowInferenceMetadataV1,
  type WorkflowJsonObject,
  type WorkflowProposalKind,
} from '@skytwin/shared-types';
import { query, withTransaction } from '../connection.js';
import { databaseSafeInteger } from './database-values.js';

interface WorkflowRow {
  id: string;
  user_id: string;
  provider_key: string;
  active_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowVersionRow {
  id: string;
  workflow_id: string;
  user_id: string;
  version_number: number | string;
  provider_key: string;
  provider_schema_version: string;
  canonical_payload: WorkflowJsonObject;
  content_hash: string;
  parent_version_id: string | null;
  authoring_metadata: WorkflowAuthoringMetadataV1;
  inference_metadata: WorkflowInferenceMetadataV1 | null;
  created_at: Date;
}

interface WorkflowProposalRow {
  id: string;
  workflow_id: string;
  user_id: string;
  base_version_id: string | null;
  proposed_version_id: string;
  kind: WorkflowProposalKind;
  created_at: Date;
}

interface WorkflowActivationEventRow {
  id: string;
  workflow_id: string;
  user_id: string;
  event_sequence: number | string;
  previous_version_id: string | null;
  activated_version_id: string;
  proposal_id: string | null;
  kind: 'activate' | 'rollback';
  created_at: Date;
}

export interface CreateWorkflowDraftInput {
  userId: string;
  providerKey: string;
  providerSchemaVersion: string;
  payload: unknown;
  authoring: WorkflowAuthoringMetadataV1;
  inference?: WorkflowInferenceMetadataV1 | null;
}

export interface CreateWorkflowDraftWithProposalInput extends CreateWorkflowDraftInput {
  kind?: Extract<WorkflowProposalKind, 'initial' | 'import'>;
}

interface CreateWorkflowVersionInput {
  userId: string;
  workflowId: string;
  parentVersionId: string;
  providerSchemaVersion: string;
  payload: unknown;
  authoring: WorkflowAuthoringMetadataV1;
  inference?: WorkflowInferenceMetadataV1 | null;
}

export interface CreateWorkflowVersionWithProposalInput extends CreateWorkflowVersionInput {
  kind: Extract<WorkflowProposalKind, 'edit' | 'feedback'>;
}

export type CreateWorkflowVersionWithProposalResult =
  | { success: true; version: AdaptiveWorkflowVersion; proposal: AdaptiveWorkflowProposal }
  | {
    success: false;
    reason: 'workflow_not_found' | 'parent_version_not_found' | 'active_version_conflict';
  };

interface PreparedVersion {
  providerSchemaVersion: string;
  canonicalPayload: WorkflowJsonObject;
  authoring: WorkflowAuthoringMetadataV1;
  inference: WorkflowInferenceMetadataV1 | null;
}

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

function toVersion(row: WorkflowVersionRow): AdaptiveWorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    userId: row.user_id,
    versionNumber: databaseSafeInteger(row.version_number, 'workflow_versions.version_number'),
    providerKey: row.provider_key,
    providerSchemaVersion: row.provider_schema_version,
    canonicalPayload: row.canonical_payload,
    contentHash: row.content_hash,
    parentVersionId: row.parent_version_id,
    authoring: row.authoring_metadata,
    inference: row.inference_metadata,
    createdAt: row.created_at,
  };
}

function toProposal(row: WorkflowProposalRow): AdaptiveWorkflowProposal {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    userId: row.user_id,
    baseVersionId: row.base_version_id,
    proposedVersionId: row.proposed_version_id,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

function toActivationEvent(row: WorkflowActivationEventRow): WorkflowActivationEvent {
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

function prepareVersion(input: {
  providerSchemaVersion: string;
  payload: unknown;
  authoring: WorkflowAuthoringMetadataV1;
  inference?: WorkflowInferenceMetadataV1 | null;
}): PreparedVersion {
  return {
    providerSchemaVersion: input.providerSchemaVersion,
    canonicalPayload: canonicalizeWorkflowPayload(input.payload),
    authoring: snapshotWorkflowAuthoringMetadata(input.authoring),
    inference: snapshotWorkflowInferenceMetadata(input.inference),
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

async function insertVersion(
  client: PoolClient,
  input: {
    id: string;
    workflow: WorkflowRow;
    versionNumber: number;
    parentVersionId: string | null;
    prepared: PreparedVersion;
  },
): Promise<AdaptiveWorkflowVersion> {
  const contentHash = workflowVersionContentHash({
    providerKey: input.workflow.provider_key,
    providerSchemaVersion: input.prepared.providerSchemaVersion,
    canonicalPayload: input.prepared.canonicalPayload,
  });
  const inserted = await client.query<WorkflowVersionRow>(
    `INSERT INTO workflow_versions
       (id, workflow_id, user_id, version_number, provider_key,
        provider_schema_version, canonical_payload, content_hash,
        parent_version_id, authoring_metadata, inference_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8, $9, $10::JSONB, $11::JSONB)
     RETURNING *`,
    [
      input.id,
      input.workflow.id,
      input.workflow.user_id,
      input.versionNumber,
      input.workflow.provider_key,
      input.prepared.providerSchemaVersion,
      JSON.stringify(input.prepared.canonicalPayload),
      contentHash,
      input.parentVersionId,
      JSON.stringify(input.prepared.authoring),
      input.prepared.inference === null ? null : JSON.stringify(input.prepared.inference),
    ],
  );
  return toVersion(inserted.rows[0]!);
}

export const workflowRepository = {
  async createDraft(input: CreateWorkflowDraftInput): Promise<{
    workflow: AdaptiveWorkflow;
    version: AdaptiveWorkflowVersion;
  }> {
    assertWorkflowProviderIdentity(input.providerKey, input.providerSchemaVersion);
    const prepared = prepareVersion(input);
    const workflowId = randomUUID();
    const versionId = randomUUID();
    return withSerializableRetry(async (client) => {
      const inserted = await client.query<WorkflowRow>(
        `INSERT INTO workflows (id, user_id, provider_key)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [workflowId, input.userId, input.providerKey],
      );
      const workflow = inserted.rows[0]!;
      const version = await insertVersion(client, {
        id: versionId,
        workflow,
        versionNumber: 1,
        parentVersionId: null,
        prepared,
      });
      return { workflow: toWorkflow(workflow), version };
    });
  },

  /** Create the first immutable version and its review proposal in one transaction. */
  async createDraftWithProposal(input: CreateWorkflowDraftWithProposalInput): Promise<{
    workflow: AdaptiveWorkflow;
    version: AdaptiveWorkflowVersion;
    proposal: AdaptiveWorkflowProposal;
  }> {
    assertWorkflowProviderIdentity(input.providerKey, input.providerSchemaVersion);
    const prepared = prepareVersion(input);
    const workflowId = randomUUID();
    const versionId = randomUUID();
    const proposalId = randomUUID();
    return withSerializableRetry(async (client) => {
      const inserted = await client.query<WorkflowRow>(
        `INSERT INTO workflows (id, user_id, provider_key)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [workflowId, input.userId, input.providerKey],
      );
      const workflow = inserted.rows[0]!;
      const version = await insertVersion(client, {
        id: versionId,
        workflow,
        versionNumber: 1,
        parentVersionId: null,
        prepared,
      });
      const proposal = await client.query<WorkflowProposalRow>(
        `INSERT INTO workflow_proposals
           (id, workflow_id, user_id, base_version_id, proposed_version_id, kind)
         VALUES ($1, $2, $3, NULL, $4, $5)
         RETURNING *`,
        [proposalId, workflowId, input.userId, versionId, input.kind ?? 'initial'],
      );
      return {
        workflow: toWorkflow(workflow),
        version,
        proposal: toProposal(proposal.rows[0]!),
      };
    });
  },

  /** Persist an active-lineage revision and its review proposal atomically. */
  async createVersionWithProposal(
    input: CreateWorkflowVersionWithProposalInput,
  ): Promise<CreateWorkflowVersionWithProposalResult> {
    const prepared = prepareVersion(input);
    const versionId = randomUUID();
    const proposalId = randomUUID();
    return withSerializableRetry(async (client) => {
      const owned = await client.query<WorkflowRow>(
        `SELECT * FROM workflows
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [input.workflowId, input.userId],
      );
      const workflow = owned.rows[0];
      if (!workflow) return { success: false, reason: 'workflow_not_found' };
      if (workflow.active_version_id !== input.parentVersionId) {
        return { success: false, reason: 'active_version_conflict' };
      }
      assertWorkflowProviderIdentity(workflow.provider_key, input.providerSchemaVersion);

      const parent = await client.query<{ version_number: number | string }>(
        `SELECT version_number FROM workflow_versions
          WHERE id = $1 AND workflow_id = $2 AND user_id = $3
            AND provider_key = $4`,
        [input.parentVersionId, input.workflowId, input.userId, workflow.provider_key],
      );
      if (!parent.rows[0]) return { success: false, reason: 'parent_version_not_found' };
      const next = await client.query<{ version_number: number | string }>(
        `SELECT COALESCE(max(version_number), 0)::INT + 1 AS version_number
           FROM workflow_versions
          WHERE workflow_id = $1 AND user_id = $2`,
        [input.workflowId, input.userId],
      );
      const version = await insertVersion(client, {
        id: versionId,
        workflow,
        versionNumber: databaseSafeInteger(
          next.rows[0]!.version_number,
          'workflow_versions.next_version_number',
        ),
        parentVersionId: input.parentVersionId,
        prepared,
      });
      const proposal = await client.query<WorkflowProposalRow>(
        `INSERT INTO workflow_proposals
           (id, workflow_id, user_id, base_version_id, proposed_version_id, kind)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [proposalId, input.workflowId, input.userId, input.parentVersionId, versionId, input.kind],
      );
      return {
        success: true,
        version,
        proposal: toProposal(proposal.rows[0]!),
      };
    });
  },

  async getForUser(id: string, userId: string): Promise<AdaptiveWorkflow | null> {
    const result = await query<WorkflowRow>(
      'SELECT * FROM workflows WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return result.rows[0] ? toWorkflow(result.rows[0]) : null;
  },

  async listForUser(userId: string): Promise<AdaptiveWorkflow[]> {
    const result = await query<WorkflowRow>(
      'SELECT * FROM workflows WHERE user_id = $1 ORDER BY created_at DESC, id',
      [userId],
    );
    return result.rows.map(toWorkflow);
  },

  async getVersionForUser(
    id: string,
    workflowId: string,
    userId: string,
  ): Promise<AdaptiveWorkflowVersion | null> {
    const result = await query<WorkflowVersionRow>(
      `SELECT * FROM workflow_versions
        WHERE id = $1 AND workflow_id = $2 AND user_id = $3`,
      [id, workflowId, userId],
    );
    return result.rows[0] ? toVersion(result.rows[0]) : null;
  },

  async listVersionsForUser(workflowId: string, userId: string): Promise<AdaptiveWorkflowVersion[]> {
    const result = await query<WorkflowVersionRow>(
      `SELECT * FROM workflow_versions
        WHERE workflow_id = $1 AND user_id = $2
        ORDER BY version_number ASC`,
      [workflowId, userId],
    );
    return result.rows.map(toVersion);
  },

  async listProposalsForUser(workflowId: string, userId: string): Promise<AdaptiveWorkflowProposal[]> {
    const result = await query<WorkflowProposalRow>(
      `SELECT * FROM workflow_proposals
        WHERE workflow_id = $1 AND user_id = $2
        ORDER BY created_at DESC, id`,
      [workflowId, userId],
    );
    return result.rows.map(toProposal);
  },

  async listActivationEventsForUser(
    workflowId: string,
    userId: string,
  ): Promise<WorkflowActivationEvent[]> {
    const result = await query<WorkflowActivationEventRow>(
      `SELECT * FROM workflow_activation_events
        WHERE workflow_id = $1 AND user_id = $2
        ORDER BY event_sequence ASC`,
      [workflowId, userId],
    );
    return result.rows.map(toActivationEvent);
  },

};
