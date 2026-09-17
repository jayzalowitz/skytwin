/**
 * backup.ts — collect and restore a single user's SkyTwin data (#400).
 *
 * The backup/restore CLI (`skytwin-backup`, see `src/bin/backup-cli.ts`) is
 * the "I can take my data with me" half of the data-ownership story that the
 * GDPR delete endpoint (#376, `userPurgeRepository`) is the other half of.
 *
 * Scope (per issue #400): the data that *is* the user's twin —
 *   - the `users` row,
 *   - the current `twin_profiles` row + its `twin_profile_versions` history,
 *   - all `preferences`,
 *   - all `decisions` with their `candidate_actions`, `decision_outcomes`,
 *     and `explanation_records`.
 *
 * Deliberately NOT exported:
 *   - OAuth tokens / credential-vault secrets. A backup is a portable file the
 *     user may store anywhere; re-keying provider access on a fresh install is
 *     a re-auth, not a restore. Exporting encrypted-at-rest tokens whose
 *     envelope key lives in a *different* keystore would export ciphertext the
 *     restore target can't read anyway. Connectors re-authorize on restore.
 *   - Credential dispatch leases. They are machine-local request-start
 *     authority tied to exact OAuth row revisions, not portable or resumable.
 *   - Sessions / recovery codes / pairing state — machine-local, not "my data".
 *
 * Reads go through the repository layer and `query` (CLAUDE.md: all DB access
 * via `@skytwin/db`). The restore writes inside a single `withTransaction` so a
 * fresh install is rehydrated atomically — a partial restore never leaves a
 * half-imported twin.
 */

import { query, withTransaction } from '../connection.js';
import {
  assertWorkflowProviderIdentity,
  canonicalizeWorkflowPayload,
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  joinedDecisionReceiptRevisionDigest,
  isDecisionReceiptEventKey,
  snapshotInferenceReceipt,
  snapshotWorkflowAuthoringMetadata,
  snapshotWorkflowInferenceMetadata,
  workflowVersionContentHash,
  preservesJoinedDecisionReceiptLinks,
  normalizeDecisionReceiptSequence,
  verifyInferenceReceiptSeal,
  verifyJoinedDecisionReceiptChain,
} from '@skytwin/shared-types';
import type {
  RoutineFilter,
  RoutineSpec,
  RoutineStatus,
  WorkflowAuthoringMetadataV1,
  WorkflowInferenceMetadataV1,
  WorkflowJsonObject,
  WorkflowProposalKind,
} from '@skytwin/shared-types';
import {
  compileSignalDigestV1,
  SIGNAL_DIGEST_V1_PROVIDER_KEY,
  SIGNAL_DIGEST_V1_SCHEMA_VERSION,
} from '@skytwin/routines';
import type {
  CandidateActionRow,
  DecisionOutcomeRow,
  DecisionRow,
  DecisionReceiptRevisionRow,
  DecisionReceiptRow,
  ExplanationRecordRow,
  ExecutionPlanRow,
  InferenceReceiptRow,
  PreferenceRow,
  TwinProfileRow,
  TwinProfileVersionRow,
  UserRow,
} from '../types.js';
import type { DecisionEffectState } from '../repositories/inference-receipt-repository.js';
import type { PoolClient } from 'pg';
import { decisionReceiptRowArtifactV1 } from '../repositories/decision-receipt-artifacts.js';
import {
  gmailArchiveTerminalExplanationSemantics,
  gmailArchiveResultAllowedForAttemptPhase,
  parseGmailArchiveTerminalExplanationBinding,
} from '../repositories/gmail-archive-terminalization-repository.js';
import {
  gmailArchiveReconciliationExplanationSemantics,
  parseGmailArchiveReconciliationExplanationEvidence,
} from '../repositories/gmail-archive-reconciliation-repository.js';
import { GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS } from '../repositories/gmail-archive-recovery-policy.js';
import { databaseSafeInteger } from '../repositories/database-values.js';

/**
 * V5 adds immutable adaptive workflows, sanitized authoring/inference
 * metadata, proposals, and activation history. Keeping this distinct from v4
 * makes older readers reject archives they would otherwise accept while
 * silently dropping user-authored behavior.
 */
export const BACKUP_SCHEMA_VERSION = 5;
const EXECUTION_BACKUP_SCHEMA_VERSION = 4;
const INGEST_BACKUP_SCHEMA_VERSION = 3;
const RECEIPT_BACKUP_SCHEMA_VERSION = 2;
const LEGACY_BACKUP_SCHEMA_VERSION = 1;

function sameUuid(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

export interface DecisionIngestBackupState {
  decisionId: string;
  receiptCaptureComplete: boolean;
  receiptExplanationId: string | null;
  continuationKind: 'auto_execute' | 'approval' | 'non_effect';
  confirmationLevel: 'single' | 'dual' | null;
  effectState: DecisionEffectState;
  sourceEffectState: DecisionEffectState | null;
  sourceExecutionStatus: 'completed' | 'failed' | 'ambiguous' | null;
  sourceExecutionPlanId: string | null;
  completedAt: Date | null;
}

/** A single decision with everything that hangs off it. */
export interface DecisionBundle {
  decision: DecisionRow;
  candidateActions: CandidateActionRow[];
  outcome: DecisionOutcomeRow | null;
  explanations: ExplanationRecordRow[];
  /** Absent only in receipt-free schema-v1 backups. */
  inferenceReceipts?: InferenceReceiptRow[];
  /** Required (but possibly null) in schema v3 and later. Older archives omit it. */
  ingestState?: DecisionIngestBackupState | null;
  /** Sanitized plan metadata needed by decision_outcomes.execution_plan_id (v4+). */
  executionPlans?: ExecutionPlanRow[];
  /** Optional because decisions created before the joined-receipt migration have no root. */
  joinedReceipt?: {
    root: DecisionReceiptRow;
    revisions: DecisionReceiptRevisionRow[];
  };
}

export interface WorkflowBackupRecord {
  id: string;
  userId: string;
  providerKey: string;
  activeVersionId: string | null;
  activeActivationEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersionBackupRecord {
  id: string;
  workflowId: string;
  userId: string;
  versionNumber: number;
  providerKey: string;
  providerSchemaVersion: string;
  canonicalPayload: WorkflowJsonObject;
  contentHash: string;
  parentVersionId: string | null;
  authoring: WorkflowAuthoringMetadataV1;
  inference: WorkflowInferenceMetadataV1 | null;
  createdAt: string;
}

export interface WorkflowProposalBackupRecord {
  id: string;
  workflowId: string;
  userId: string;
  baseVersionId: string | null;
  proposedVersionId: string;
  kind: WorkflowProposalKind;
  createdAt: string;
}

export interface WorkflowActivationBackupRecord {
  id: string;
  workflowId: string;
  userId: string;
  previousVersionId: string | null;
  activatedVersionId: string;
  proposalId: string | null;
  kind: 'activate' | 'rollback';
  eventSequence: number;
  createdAt: string;
}

/** Portable scheduler state for the single Watch compiled from an active workflow. */
export interface WorkflowWatchProjectionBackupRecord {
  /** Distinguishes compiler-verifiable projections from fail-closed durable snapshots. */
  kind: 'compiled_signal_digest.v1' | 'quarantined_watch_snapshot.v1';
  id: string;
  workflowId: string;
  workflowVersionId: string;
  userId: string;
  providerKey: string;
  providerSchemaVersion: string;
  contentHash: string;
  projectionVersion: number;
  sourceText: string;
  status: RoutineStatus;
  scheduleRevision: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** Exact stored Watch fields. Required so quarantine does not lose the original inert state. */
  snapshot: {
    name: string;
    cadence: RoutineSpec['cadence'];
    hourOfDay: number | null;
    dayOfWeek: number | null;
    filter: Required<RoutineFilter>;
    action: RoutineSpec['action'];
  };
}

export interface WorkflowBackupBundle {
  workflow: WorkflowBackupRecord;
  versions: WorkflowVersionBackupRecord[];
  proposals: WorkflowProposalBackupRecord[];
  activationEvents: WorkflowActivationBackupRecord[];
  /** Null for inactive or non-Watch workflow providers. */
  watchProjection: WorkflowWatchProjectionBackupRecord | null;
}

/** The full exported payload for one user. */
export interface BackupData {
  schemaVersion: number;
  /** ISO timestamp the backup was taken. */
  exportedAt: string;
  user: UserRow;
  twinProfile: TwinProfileRow | null;
  twinProfileVersions: TwinProfileVersionRow[];
  preferences: PreferenceRow[];
  decisions: DecisionBundle[];
  /** Required in schema v5. Older archives omit adaptive workflows entirely. */
  workflows?: WorkflowBackupBundle[];
  /**
   * Connector identities, OAuth credentials, cursors, raw signals, and Gmail
   * message references are intentionally excluded.
   * Gmail archive recovery leases are intentionally excluded too. They are
   * installation-local operational evidence, and provider targets are invalid
   * without a live, freshly-authorized account binding on the restore destination.
   */
}

export type CollectBackupResult =
  | { success: true; data: BackupData }
  | { success: false; reason: 'user_not_found' | 'inconsistent_snapshot'; message: string };

export interface RestoreSummary {
  /** Per-table inserted-row counts. */
  counts: Record<string, number>;
  /** Total rows written. */
  total: number;
}

export type RestoreBackupResult =
  | { success: true; summary: RestoreSummary }
  | {
      success: false;
      reason: 'user_exists' | 'unsupported_schema' | 'invalid_data';
      message: string;
    };

/** Page size for walking a user's decision history. */
const DECISION_PAGE_SIZE = 500;

/**
 * Read every backup-scoped row for `userId` and assemble a {@link BackupData}.
 * Returns `user_not_found` (not a throw) when the user does not exist — an
 * expected outcome for `skytwin-backup export --user <stale-id>`.
 */
export async function collectBackup(userId: string): Promise<CollectBackupResult> {
  return withTransaction(async (client) => {
    const user = (await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    if (!user) {
      return {
        success: false as const,
        reason: 'user_not_found' as const,
        message: `no user with id ${userId}`,
      };
    }

    const twinProfile = (await client.query<TwinProfileRow>(
      'SELECT * FROM twin_profiles WHERE user_id = $1', [userId],
    )).rows[0] ?? null;
    const twinProfileVersions = twinProfile
      ? (
        await client.query<TwinProfileVersionRow>(
          `SELECT * FROM twin_profile_versions
            WHERE profile_id = $1
            ORDER BY version ASC`,
          [twinProfile.id],
        )
      ).rows
    : [];

    const preferences = (
    await client.query<PreferenceRow>(
      'SELECT * FROM preferences WHERE user_id = $1 ORDER BY created_at ASC',
      [userId],
    )
  ).rows;

    const decisions = await collectDecisions(client, userId);
    const workflows = await collectWorkflows(client, userId);

    const data: BackupData = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      user,
      twinProfile,
      twinProfileVersions,
      preferences,
      decisions,
      workflows,
    };
    const problems = validateBackupData(data);
    if (problems.length > 0) {
      return {
        success: false as const,
        reason: 'inconsistent_snapshot' as const,
        message: `backup snapshot failed validation: ${problems.join('; ')}`,
      };
    }
    return { success: true as const, data };
  });
}

interface WorkflowBackupRow {
  id: string;
  user_id: string;
  provider_key: string;
  active_version_id: string | null;
  active_activation_event_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowVersionBackupRow {
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

interface WorkflowProposalBackupRow {
  id: string;
  workflow_id: string;
  user_id: string;
  base_version_id: string | null;
  proposed_version_id: string;
  kind: WorkflowProposalKind;
  created_at: Date;
}

interface WorkflowActivationBackupRow {
  id: string;
  workflow_id: string;
  user_id: string;
  previous_version_id: string | null;
  activated_version_id: string;
  proposal_id: string | null;
  kind: 'activate' | 'rollback';
  event_sequence: number | string;
  created_at: Date;
}

interface WorkflowWatchProjectionBackupRow {
  id: string;
  user_id: string;
  name: string;
  source_text: string;
  cadence: RoutineSpec['cadence'];
  hour_of_day: number | string | null;
  day_of_week: number | string | null;
  filter: Required<RoutineFilter>;
  action: RoutineSpec['action'];
  status: RoutineStatus;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
  next_run_at: Date | null;
  schedule_revision: string;
  workflow_id: string;
  workflow_version_id: string;
  workflow_provider_key: string;
  workflow_provider_schema_version: string;
  content_hash: string;
  projection_version: number | string;
}

async function collectWorkflows(client: PoolClient, userId: string): Promise<WorkflowBackupBundle[]> {
  const workflows = (await client.query<WorkflowBackupRow>(
    `SELECT * FROM workflows WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
    [userId],
  )).rows;
  if (workflows.length === 0) return [];
  const workflowIds = workflows.map((workflow) => workflow.id);
  const versions = (await client.query<WorkflowVersionBackupRow>(
    `SELECT * FROM workflow_versions
      WHERE user_id = $1 AND workflow_id = ANY($2)
      ORDER BY workflow_id ASC, version_number ASC`,
    [userId, workflowIds],
  )).rows;
  const proposals = (await client.query<WorkflowProposalBackupRow>(
    `SELECT * FROM workflow_proposals
      WHERE user_id = $1 AND workflow_id = ANY($2)
      ORDER BY workflow_id ASC, created_at ASC, id ASC`,
    [userId, workflowIds],
  )).rows;
  const activationEvents = (await client.query<WorkflowActivationBackupRow>(
    `SELECT * FROM workflow_activation_events
      WHERE user_id = $1 AND workflow_id = ANY($2)
      ORDER BY workflow_id ASC, event_sequence ASC`,
    [userId, workflowIds],
  )).rows;
  const watchProjections = (await client.query<WorkflowWatchProjectionBackupRow>(
    `SELECT id, user_id, name, source_text, cadence, hour_of_day, day_of_week,
            filter, action, status, created_at, updated_at,
            last_run_at, next_run_at, schedule_revision, workflow_id,
            workflow_version_id, workflow_provider_key,
            workflow_provider_schema_version, content_hash, projection_version
       FROM watches
      WHERE user_id = $1 AND workflow_id = ANY($2)
      ORDER BY workflow_id ASC`,
    [userId, workflowIds],
  )).rows;
  const versionsByWorkflow = groupBy(versions, (version) => version.workflow_id);
  const proposalsByWorkflow = groupBy(proposals, (proposal) => proposal.workflow_id);
  const eventsByWorkflow = groupBy(activationEvents, (event) => event.workflow_id);
  const projectionsByWorkflow = groupBy(watchProjections, (projection) => projection.workflow_id);
  return workflows.map((workflow) => ({
    workflow: {
      id: workflow.id,
      userId: workflow.user_id,
      providerKey: workflow.provider_key,
      activeVersionId: workflow.active_version_id,
      activeActivationEventId: workflow.active_activation_event_id,
      createdAt: workflow.created_at.toISOString(),
      updatedAt: workflow.updated_at.toISOString(),
    },
    versions: (versionsByWorkflow.get(workflow.id) ?? []).map((version) => ({
      id: version.id,
      workflowId: version.workflow_id,
      userId: version.user_id,
      versionNumber: databaseSafeInteger(
        version.version_number,
        'workflow_versions.version_number',
      ),
      providerKey: version.provider_key,
      providerSchemaVersion: version.provider_schema_version,
      canonicalPayload: version.canonical_payload,
      contentHash: version.content_hash,
      parentVersionId: version.parent_version_id,
      authoring: version.authoring_metadata,
      inference: version.inference_metadata,
      createdAt: version.created_at.toISOString(),
    })),
    proposals: (proposalsByWorkflow.get(workflow.id) ?? []).map((proposal) => ({
      id: proposal.id,
      workflowId: proposal.workflow_id,
      userId: proposal.user_id,
      baseVersionId: proposal.base_version_id,
      proposedVersionId: proposal.proposed_version_id,
      kind: proposal.kind,
      createdAt: proposal.created_at.toISOString(),
    })),
    activationEvents: (eventsByWorkflow.get(workflow.id) ?? []).map((event) => ({
      id: event.id,
      workflowId: event.workflow_id,
      userId: event.user_id,
      previousVersionId: event.previous_version_id,
      activatedVersionId: event.activated_version_id,
      proposalId: event.proposal_id,
      kind: event.kind,
      eventSequence: databaseSafeInteger(event.event_sequence, 'workflow_activation_events.event_sequence'),
      createdAt: event.created_at.toISOString(),
    })),
    watchProjection: (() => {
      const projections = projectionsByWorkflow.get(workflow.id) ?? [];
      if (projections.length > 1) {
        throw new Error(`workflow ${workflow.id} has more than one Watch projection`);
      }
      const projection = projections[0];
      if (!projection) return null;
      const pinnedVersion = (versionsByWorkflow.get(workflow.id) ?? []).find(
        (version) => version.id === projection.workflow_version_id,
      );
      const compiled = workflow.provider_key === SIGNAL_DIGEST_V1_PROVIDER_KEY && pinnedVersion
        ? compileSignalDigestV1(pinnedVersion.canonical_payload)
        : null;
      const isCompilerVerified = compiled?.ok === true
        && pinnedVersion?.provider_schema_version === SIGNAL_DIGEST_V1_SCHEMA_VERSION
        && compiled.artifact.contentHash === pinnedVersion.content_hash
        && compiled.artifact.contentHash === projection.content_hash;
      return {
        kind: isCompilerVerified
          ? 'compiled_signal_digest.v1' as const
          : 'quarantined_watch_snapshot.v1' as const,
        id: projection.id,
        workflowId: projection.workflow_id,
        workflowVersionId: projection.workflow_version_id,
        userId: projection.user_id,
        providerKey: projection.workflow_provider_key,
        providerSchemaVersion: projection.workflow_provider_schema_version,
        contentHash: projection.content_hash,
        projectionVersion: databaseSafeInteger(
          projection.projection_version,
          'watches.projection_version',
        ),
        sourceText: projection.source_text,
        status: projection.status,
        scheduleRevision: projection.schedule_revision,
        createdAt: projection.created_at.toISOString(),
        updatedAt: projection.updated_at.toISOString(),
        lastRunAt: projection.last_run_at?.toISOString() ?? null,
        nextRunAt: projection.next_run_at?.toISOString() ?? null,
        snapshot: {
          name: projection.name,
          cadence: projection.cadence,
          hourOfDay: projection.hour_of_day === null ? null : databaseSafeInteger(
            projection.hour_of_day,
            'watches.hour_of_day',
          ),
          dayOfWeek: projection.day_of_week === null ? null : databaseSafeInteger(
            projection.day_of_week,
            'watches.day_of_week',
          ),
          filter: projection.filter,
          action: projection.action,
        },
      };
    })(),
  }));
}

async function collectDecisions(client: PoolClient, userId: string): Promise<DecisionBundle[]> {
  // Walk decisions in pages by created_at so a user with a long history
  // doesn't pull an unbounded result set into one query.
  const allDecisions: DecisionRow[] = [];
  let offset = 0;
  for (;;) {
    const page = (
      await client.query<DecisionRow>(
        `SELECT * FROM decisions
          WHERE user_id = $1
          ORDER BY created_at ASC, id ASC
          LIMIT $2 OFFSET $3`,
        [userId, DECISION_PAGE_SIZE, offset],
      )
    ).rows;
    allDecisions.push(...page);
    if (page.length < DECISION_PAGE_SIZE) break;
    offset += DECISION_PAGE_SIZE;
  }

  if (allDecisions.length === 0) return [];

  const decisionIds = allDecisions.map((d) => d.id);

  const actions = await client.query<CandidateActionRow>(
    'SELECT * FROM candidate_actions WHERE decision_id = ANY($1) ORDER BY created_at ASC',
    [decisionIds],
  );
  const outcomes = await client.query<DecisionOutcomeRow>(
    'SELECT * FROM decision_outcomes WHERE decision_id = ANY($1)',
    [decisionIds],
  );
  const explanations = await client.query<ExplanationRecordRow>(
    'SELECT * FROM explanation_records WHERE decision_id = ANY($1) ORDER BY created_at ASC',
    [decisionIds],
  );
  // Plans are metadata-only in portable backups. Provider payloads in steps
  // are intentionally replaced with an empty array while retaining the row
  // identity/status needed by outcomes and joined-receipt commitments.
  const executionPlans = await client.query<ExecutionPlanRow>(
    `SELECT id, decision_id, action_id, status, '[]'::JSONB AS steps, created_at, updated_at
       FROM execution_plans WHERE decision_id = ANY($1) ORDER BY created_at ASC`,
    [decisionIds],
  );
  const receipts = await client.query<InferenceReceiptRow>(
    `SELECT id, version::INT4 AS version, decision_id, explanation_id,
       capture_ordinal::INT4 AS capture_ordinal, status, receipt, trusted, created_at
       FROM inference_receipts WHERE decision_id = ANY($1)
       ORDER BY decision_id ASC, capture_ordinal ASC, created_at ASC, id ASC`,
    [decisionIds],
  );
  const ingestStates = await client.query<{
    decision_id: string;
    receipt_capture_complete: boolean;
    receipt_explanation_id: string | null;
    continuation_kind: 'auto_execute' | 'approval' | 'non_effect' | null;
    confirmation_level: 'single' | 'dual' | null;
    effect_state: DecisionEffectState | null;
    source_effect_state: DecisionEffectState | null;
    source_execution_status: 'completed' | 'failed' | 'ambiguous' | null;
    source_execution_plan_id: string | null;
    completed_at: Date | null;
  }>(
    `SELECT d.id AS decision_id,
       (irc.decision_id IS NOT NULL) AS receipt_capture_complete,
       COALESCE(g.receipt_explanation_id, irc.explanation_id) AS receipt_explanation_id,
       g.continuation_kind, g.confirmation_level, g.effect_state,
       g.source_effect_state, g.source_execution_status,
       g.source_execution_plan_id, irc.completed_at
     FROM decisions d
     LEFT JOIN inference_receipt_completions irc ON irc.decision_id = d.id
     LEFT JOIN decision_ingest_guards g ON g.decision_id = d.id
     WHERE d.id = ANY($1) AND (irc.decision_id IS NOT NULL OR g.decision_id IS NOT NULL)`,
    [decisionIds],
  );
  const joinedRoots = await client.query<DecisionReceiptRow>(
    'SELECT * FROM decision_receipts WHERE decision_id = ANY($1) ORDER BY created_at ASC',
    [decisionIds],
  );
  const joinedRevisions = joinedRoots.rows.length === 0
    ? { rows: [] as DecisionReceiptRevisionRow[] }
    : await client.query<DecisionReceiptRevisionRow>(
        `SELECT * FROM decision_receipt_revisions
          WHERE receipt_id = ANY($1) ORDER BY receipt_id ASC, sequence ASC`,
        [joinedRoots.rows.map((root) => root.id)],
      );

  const actionsByDecision = groupBy<CandidateActionRow, string>(
    actions.rows,
    (r) => r.decision_id,
  );
  const explanationsByDecision = groupBy<ExplanationRecordRow, string>(
    explanations.rows,
    (r) => r.decision_id,
  );
  const receiptsByDecision = groupBy<InferenceReceiptRow, string>(
    receipts.rows,
    (r) => r.decision_id,
  );
  const plansByDecision = groupBy<ExecutionPlanRow, string>(executionPlans.rows, (row) => row.decision_id);
  const joinedRootByDecision = new Map(joinedRoots.rows.map((root) => [root.decision_id, root]));
  const joinedRevisionsByRoot = groupBy<DecisionReceiptRevisionRow, string>(
    joinedRevisions.rows,
    (revision) => revision.receipt_id,
  );
  const outcomeByDecision = new Map<string, DecisionOutcomeRow>();
  for (const o of outcomes.rows) outcomeByDecision.set(o.decision_id, o);
  const stateByDecision = new Map<string, DecisionIngestBackupState>();
  for (const state of ingestStates.rows) {
    stateByDecision.set(state.decision_id, {
      decisionId: state.decision_id,
      receiptCaptureComplete: state.receipt_capture_complete,
      receiptExplanationId: state.receipt_explanation_id,
      continuationKind: state.continuation_kind ?? 'auto_execute',
      confirmationLevel: state.continuation_kind === 'approval'
        ? state.confirmation_level ?? 'dual'
        : null,
      effectState: state.effect_state ?? 'restored_non_replay',
      sourceEffectState: state.source_effect_state,
      sourceExecutionStatus: state.source_execution_status ??
        (state.effect_state === null ? 'ambiguous' : null),
      sourceExecutionPlanId: state.source_execution_plan_id,
      completedAt: state.completed_at,
    });
  }

  return allDecisions.map((decision) => {
    const joinedRoot = joinedRootByDecision.get(decision.id);
    return {
      decision,
      candidateActions: actionsByDecision.get(decision.id) ?? [],
      outcome: outcomeByDecision.get(decision.id) ?? null,
      explanations: explanationsByDecision.get(decision.id) ?? [],
      executionPlans: plansByDecision.get(decision.id) ?? [],
      inferenceReceipts: receiptsByDecision.get(decision.id) ?? [],
      ingestState: stateByDecision.get(decision.id) ?? null,
      ...(joinedRoot ? {
        joinedReceipt: {
          root: joinedRoot,
          revisions: joinedRevisionsByRoot.get(joinedRoot.id) ?? [],
        },
      } : {}),
    };
  });
}

function groupBy<T, K>(rows: T[], keyOf: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

const FORBIDDEN_WORKFLOW_PAYLOAD_KEYS = new Set([
  'apikey', 'accesstoken', 'refreshtoken', 'oauthtoken', 'password', 'secret',
  'credential', 'credentials', 'authorization', 'sourcebody', 'messagebody',
  'rawevent', 'rawsource', 'requestbody', 'responsebody', 'prompt', 'response',
  'chainofthought',
]);
const LEGACY_WATCH_QUARANTINE_PROVIDER_KEY = 'legacy_watch.quarantine.v1';

function isBoundedStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 50 && value.every((entry) =>
    typeof entry === 'string' && Buffer.byteLength(entry, 'utf8') <= 200);
}

function isWatchSnapshot(value: unknown): value is WorkflowWatchProjectionBackupRecord['snapshot'] {
  if (!isRecord(value) || !isRecord(value.filter)) return false;
  const hourValid = value.hourOfDay === null ||
    (Number.isSafeInteger(value.hourOfDay) && Number(value.hourOfDay) >= 0 && Number(value.hourOfDay) <= 23);
  const dayValid = value.dayOfWeek === null ||
    (Number.isSafeInteger(value.dayOfWeek) && Number(value.dayOfWeek) >= 0 && Number(value.dayOfWeek) <= 6);
  return typeof value.name === 'string' && Buffer.byteLength(value.name, 'utf8') <= 4_096 &&
    (value.cadence === 'hourly' || value.cadence === 'daily' || value.cadence === 'weekly') &&
    hourValid && dayValid &&
    isBoundedStringList(value.filter.sources) &&
    isBoundedStringList(value.filter.fromContains) &&
    isBoundedStringList(value.filter.keywords) &&
    isBoundedStringList(value.filter.domains) &&
    (value.action === 'digest' || value.action === 'notify');
}

function routineSnapshot(spec: RoutineSpec): WorkflowWatchProjectionBackupRecord['snapshot'] {
  return {
    name: spec.name,
    cadence: spec.cadence,
    hourOfDay: spec.hourOfDay ?? null,
    dayOfWeek: spec.dayOfWeek ?? null,
    filter: {
      sources: spec.filter.sources ?? [],
      fromContains: spec.filter.fromContains ?? [],
      keywords: spec.filter.keywords ?? [],
      domains: spec.filter.domains ?? [],
    },
    action: spec.action,
  };
}

function signalDigestQuarantineSnapshot(): WorkflowWatchProjectionBackupRecord['snapshot'] {
  return {
    name: 'Workflow projection unavailable',
    cadence: 'hourly',
    hourOfDay: null,
    dayOfWeek: null,
    filter: { sources: [], fromContains: [], keywords: [], domains: [] },
    action: 'digest',
  };
}

function watchSnapshotsEqual(
  left: WorkflowWatchProjectionBackupRecord['snapshot'],
  right: WorkflowWatchProjectionBackupRecord['snapshot'],
): boolean {
  const hasExactKeys = (value: object, keys: string[]): boolean => {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  };
  const listsEqual = (leftList: string[], rightList: string[]): boolean =>
    leftList.length === rightList.length && leftList.every(
      (entry, index) => entry === rightList[index],
    );
  return hasExactKeys(left, [
    'name', 'cadence', 'hourOfDay', 'dayOfWeek', 'filter', 'action',
  ]) && hasExactKeys(left.filter, [
    'sources', 'fromContains', 'keywords', 'domains',
  ]) && left.name === right.name && left.cadence === right.cadence &&
    left.hourOfDay === right.hourOfDay && left.dayOfWeek === right.dayOfWeek &&
    left.action === right.action &&
    listsEqual(left.filter.sources, right.filter.sources) &&
    listsEqual(left.filter.fromContains, right.filter.fromContains) &&
    listsEqual(left.filter.keywords, right.filter.keywords) &&
    listsEqual(left.filter.domains, right.filter.domains);
}

function containsForbiddenWorkflowPayloadKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenWorkflowPayloadKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return FORBIDDEN_WORKFLOW_PAYLOAD_KEYS.has(normalized) ||
      containsForbiddenWorkflowPayloadKey(child);
  });
}

function validateWorkflowBackups(
  data: Partial<BackupData>,
  ownerId: unknown,
  uuid: RegExp,
): string[] {
  const problems: string[] = [];
  const carriesWorkflows = data.schemaVersion === BACKUP_SCHEMA_VERSION;
  const knownOlderSchema = data.schemaVersion === EXECUTION_BACKUP_SCHEMA_VERSION ||
    data.schemaVersion === INGEST_BACKUP_SCHEMA_VERSION ||
    data.schemaVersion === RECEIPT_BACKUP_SCHEMA_VERSION ||
    data.schemaVersion === LEGACY_BACKUP_SCHEMA_VERSION;
  if (carriesWorkflows && !Array.isArray(data.workflows)) {
    return [`workflows is required by schema version ${BACKUP_SCHEMA_VERSION}`];
  }
  if (knownOlderSchema && data.workflows !== undefined &&
      (!Array.isArray(data.workflows) || data.workflows.length > 0)) {
    return [`workflows requires schema version ${BACKUP_SCHEMA_VERSION}`];
  }
  if (!Array.isArray(data.workflows)) return problems;

  const workflowIds = new Set<string>();
  const globalVersionIds = new Set<string>();
  const globalProposalIds = new Set<string>();
  const globalEventIds = new Set<string>();
  for (const [workflowIndex, bundle] of data.workflows.entries()) {
    const prefix = `workflows[${workflowIndex}]`;
    if (!isRecord(bundle) || !isRecord(bundle.workflow) ||
        !Array.isArray(bundle.versions) || !Array.isArray(bundle.proposals) ||
        !Array.isArray(bundle.activationEvents) || !('watchProjection' in bundle) ||
        (bundle.watchProjection !== null && !isRecord(bundle.watchProjection))) {
      problems.push(`${prefix} is malformed`);
      continue;
    }
    const workflow = bundle.workflow as unknown as WorkflowBackupRecord;
    let providerIdentityValid = true;
    try {
      assertWorkflowProviderIdentity(workflow.providerKey, 'v1');
    } catch {
      providerIdentityValid = false;
    }
    if (!uuid.test(workflow.id) || workflowIds.has(workflow.id) ||
        !sameUuid(workflow.userId, ownerId) || !providerIdentityValid ||
        (workflow.activeVersionId !== null && !uuid.test(workflow.activeVersionId)) ||
        (workflow.activeActivationEventId !== null && !uuid.test(workflow.activeActivationEventId)) ||
        ((workflow.activeVersionId === null) !== (workflow.activeActivationEventId === null)) ||
        !isIsoInstant(workflow.createdAt) || !isIsoInstant(workflow.updatedAt)) {
      problems.push(`${prefix}.workflow has invalid identity or ownership`);
    }
    workflowIds.add(workflow.id);

    const versions: WorkflowVersionBackupRecord[] = [];
    const versionById = new Map<string, WorkflowVersionBackupRecord>();
    const versionIntegrityById = new Map<string, {
      portableHashValid: boolean;
      providerCompileValid: boolean;
    }>();
    const versionNumbers = new Set<number>();
    for (const [versionIndex, rawVersion] of bundle.versions.entries()) {
      const versionPrefix = `${prefix}.versions[${versionIndex}]`;
      if (!isRecord(rawVersion)) {
        problems.push(`${versionPrefix} is malformed`);
        continue;
      }
      const version = rawVersion as unknown as WorkflowVersionBackupRecord;
      versions.push(version);
      let contentValid = true;
      let portableHashValid = false;
      let providerCompileValid = true;
      try {
        assertWorkflowProviderIdentity(version.providerKey, version.providerSchemaVersion);
        const canonicalPayload = canonicalizeWorkflowPayload(version.canonicalPayload);
        portableHashValid = workflowVersionContentHash({
              providerKey: version.providerKey,
              providerSchemaVersion: version.providerSchemaVersion,
              canonicalPayload,
            }) === version.contentHash;
        if (containsForbiddenWorkflowPayloadKey(canonicalPayload)) {
          contentValid = false;
        }
        if (version.providerKey === SIGNAL_DIGEST_V1_PROVIDER_KEY) {
          if (version.providerSchemaVersion !== SIGNAL_DIGEST_V1_SCHEMA_VERSION) {
            providerCompileValid = false;
          } else {
            const compiled = compileSignalDigestV1(canonicalPayload);
            if (!compiled.ok || compiled.artifact.contentHash !== version.contentHash) {
              providerCompileValid = false;
            }
          }
        }
        snapshotWorkflowAuthoringMetadata(version.authoring);
        snapshotWorkflowInferenceMetadata(version.inference);
      } catch {
        contentValid = false;
      }
      if (!uuid.test(version.id) || globalVersionIds.has(version.id) ||
          versionById.has(version.id) || !sameUuid(version.workflowId, workflow.id) ||
          !sameUuid(version.userId, ownerId) || version.providerKey !== workflow.providerKey ||
          !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1 ||
          versionNumbers.has(version.versionNumber) ||
          (version.parentVersionId !== null && !uuid.test(version.parentVersionId)) ||
          !isIsoInstant(version.createdAt) || !contentValid) {
        problems.push(`${versionPrefix} has invalid content, identity, or ownership`);
      }
      if (typeof version.id === 'string') {
        globalVersionIds.add(version.id);
        versionById.set(version.id, version);
        versionIntegrityById.set(version.id, { portableHashValid, providerCompileValid });
      }
      versionNumbers.add(version.versionNumber);
    }
    const orderedVersions = [...versions].sort((left, right) => {
      const leftNumber = Number.isSafeInteger(left.versionNumber)
        ? left.versionNumber : Number.MAX_SAFE_INTEGER;
      const rightNumber = Number.isSafeInteger(right.versionNumber)
        ? right.versionNumber : Number.MAX_SAFE_INTEGER;
      return leftNumber - rightNumber;
    });
    if (orderedVersions.length === 0 || orderedVersions.some((version, index) =>
      version.versionNumber !== index + 1 ||
      (index === 0
        ? version.parentVersionId !== null
        : version.parentVersionId === null ||
          (versionById.get(version.parentVersionId)?.versionNumber ?? Number.MAX_SAFE_INTEGER) >=
            version.versionNumber))) {
      problems.push(`${prefix}.versions has invalid lineage`);
    }
    if (workflow.activeVersionId !== null && !versionById.has(workflow.activeVersionId)) {
      problems.push(`${prefix}.workflow active version is not in its version set`);
    }

    const proposals: WorkflowProposalBackupRecord[] = [];
    const proposalById = new Map<string, WorkflowProposalBackupRecord>();
    const proposedVersions = new Set<string>();
    for (const [proposalIndex, rawProposal] of bundle.proposals.entries()) {
      if (!isRecord(rawProposal)) {
        problems.push(`${prefix}.proposals[${proposalIndex}] is malformed`);
        continue;
      }
      const proposal = rawProposal as unknown as WorkflowProposalBackupRecord;
      proposals.push(proposal);
      const proposedVersion = versionById.get(proposal.proposedVersionId);
      const proposalBaseShapeValid =
        ((proposal.kind === 'initial' || proposal.kind === 'import')
          && proposal.baseVersionId === null)
        || ((proposal.kind === 'edit' || proposal.kind === 'feedback')
          && proposal.baseVersionId !== null);
      if (!uuid.test(proposal.id) || globalProposalIds.has(proposal.id) ||
          !sameUuid(proposal.workflowId, workflow.id) || !sameUuid(proposal.userId, ownerId) ||
          (proposal.baseVersionId !== null && !versionById.has(proposal.baseVersionId)) ||
          !proposedVersion || proposedVersion.parentVersionId !== proposal.baseVersionId ||
          proposedVersions.has(proposal.proposedVersionId) ||
          !['initial', 'edit', 'feedback', 'import'].includes(proposal.kind) ||
          !proposalBaseShapeValid ||
          !isIsoInstant(proposal.createdAt)) {
        problems.push(`${prefix}.proposals[${proposalIndex}] has invalid linkage or ownership`);
      }
      if (typeof proposal.id === 'string') {
        globalProposalIds.add(proposal.id);
        proposalById.set(proposal.id, proposal);
      }
      if (typeof proposal.proposedVersionId === 'string') {
        proposedVersions.add(proposal.proposedVersionId);
      }
    }

    const events: WorkflowActivationBackupRecord[] = [];
    for (const [eventIndex, rawEvent] of bundle.activationEvents.entries()) {
      if (!isRecord(rawEvent)) {
        problems.push(`${prefix}.activationEvents[${eventIndex}] is malformed`);
        continue;
      }
      events.push(rawEvent as unknown as WorkflowActivationBackupRecord);
    }
    events.sort((left, right) => {
      const leftSequence = Number.isSafeInteger(left.eventSequence)
        ? left.eventSequence : Number.MAX_SAFE_INTEGER;
      const rightSequence = Number.isSafeInteger(right.eventSequence)
        ? right.eventSequence : Number.MAX_SAFE_INTEGER;
      return leftSequence - rightSequence;
    });
    let activeVersionId: string | null = null;
    const previouslyActive = new Set<string>();
    const consumedProposalIds = new Set<string>();
    for (const [eventIndex, event] of events.entries()) {
      const proposal = event.proposalId === null ? null : proposalById.get(event.proposalId);
      const proposalAlreadyConsumed = event.proposalId !== null &&
        consumedProposalIds.has(event.proposalId);
      const linkageValid = uuid.test(event.id) && !globalEventIds.has(event.id) &&
        Number.isSafeInteger(event.eventSequence) && event.eventSequence === eventIndex + 1 &&
        sameUuid(event.workflowId, workflow.id) && sameUuid(event.userId, ownerId) &&
        event.previousVersionId === activeVersionId && versionById.has(event.activatedVersionId) &&
        event.activatedVersionId !== event.previousVersionId && isIsoInstant(event.createdAt) &&
        !proposalAlreadyConsumed &&
        ((event.kind === 'activate' && proposal !== undefined && proposal !== null &&
          proposal.proposedVersionId === event.activatedVersionId &&
          proposal.baseVersionId === event.previousVersionId) ||
         (event.kind === 'rollback' && event.proposalId === null &&
          previouslyActive.has(event.activatedVersionId)));
      if (!linkageValid) {
        problems.push(`${prefix}.activationEvents[${eventIndex}] has invalid transition or ownership`);
      }
      if (typeof event.id === 'string') globalEventIds.add(event.id);
      if (typeof event.proposalId === 'string') consumedProposalIds.add(event.proposalId);
      if (typeof event.activatedVersionId === 'string') {
        previouslyActive.add(event.activatedVersionId);
        activeVersionId = event.activatedVersionId;
      }
    }
    if (activeVersionId !== workflow.activeVersionId) {
      problems.push(`${prefix}.activationEvents do not resolve to the active version`);
    }
    const finalActivationEventId = events.at(-1)?.id ?? null;
    if (!((finalActivationEventId === null && workflow.activeActivationEventId === null) ||
          sameUuid(finalActivationEventId, workflow.activeActivationEventId))) {
      problems.push(`${prefix}.activationEvents do not resolve to the active activation event`);
    }

    const rawProjection = bundle.watchProjection;
    const knownWatchProvider = workflow.providerKey === SIGNAL_DIGEST_V1_PROVIDER_KEY;
    if (rawProjection === null) {
      if (knownWatchProvider && workflow.activeVersionId !== null) {
        problems.push(`${prefix}.watchProjection is required for the active signal digest`);
      }
      for (const [versionIndex, version] of versions.entries()) {
        const integrity = versionIntegrityById.get(version.id);
        if (!integrity?.portableHashValid || !integrity.providerCompileValid) {
          problems.push(`${prefix}.versions[${versionIndex}] has invalid content, identity, or ownership`);
        }
      }
      continue;
    }
    const projection = rawProjection as unknown as WorkflowWatchProjectionBackupRecord;
    const pinnedVersion = typeof projection.workflowVersionId === 'string'
      ? versionById.get(projection.workflowVersionId)
      : undefined;
    const activeVersion = workflow.activeVersionId === null ? undefined
      : versionById.get(workflow.activeVersionId);
    let projectionMatchesCompiledVersion = false;
    if (knownWatchProvider && activeVersion
        && activeVersion.providerSchemaVersion === SIGNAL_DIGEST_V1_SCHEMA_VERSION) {
      const compiled = compileSignalDigestV1(activeVersion.canonicalPayload);
      projectionMatchesCompiledVersion = compiled.ok
        && projection.providerKey === compiled.artifact.providerKey
        && projection.providerSchemaVersion === compiled.artifact.providerSchemaVersion
        && projection.contentHash === compiled.artifact.contentHash
        && projection.projectionVersion === compiled.artifact.projectionVersion
        && isWatchSnapshot(projection.snapshot)
        && watchSnapshotsEqual(projection.snapshot, routineSnapshot(compiled.artifact.routineSpec));
    }
    const validStatus = projection.status === 'active' || projection.status === 'paused'
      || projection.status === 'draft';
    const validScheduleState = validStatus && (projection.status === 'active'
      ? isIsoInstant(projection.nextRunAt)
      : projection.nextRunAt === null);
    const commonProjectionValid = uuid.test(projection.id) &&
        sameUuid(projection.workflowId, workflow.id) &&
        sameUuid(projection.userId, ownerId) && pinnedVersion !== undefined &&
        projection.providerKey === pinnedVersion.providerKey &&
        projection.providerSchemaVersion === pinnedVersion.providerSchemaVersion &&
        projection.contentHash === pinnedVersion.contentHash &&
        projection.projectionVersion === 1 &&
        typeof projection.sourceText === 'string' && projection.sourceText.trim().length > 0 &&
        Buffer.byteLength(projection.sourceText, 'utf8') <= 4_096;
    const commonRuntimeValid = uuid.test(projection.scheduleRevision) &&
        isIsoInstant(projection.createdAt) && isIsoInstant(projection.updatedAt) &&
        (projection.lastRunAt === null || isIsoInstant(projection.lastRunAt)) &&
        validScheduleState && isWatchSnapshot(projection.snapshot);
    const isCompiledProjection = projection.kind === 'compiled_signal_digest.v1' &&
      knownWatchProvider && workflow.activeVersionId !== null && activeVersion !== undefined &&
      sameUuid(projection.workflowVersionId, workflow.activeVersionId) &&
      projectionMatchesCompiledVersion;
    const pinnedIntegrity = pinnedVersion
      ? versionIntegrityById.get(pinnedVersion.id)
      : undefined;
    const isLegacyQuarantine = projection.kind === 'quarantined_watch_snapshot.v1' &&
      workflow.providerKey === LEGACY_WATCH_QUARANTINE_PROVIDER_KEY &&
      workflow.activeVersionId === null && projection.status !== 'active' &&
      projection.nextRunAt === null && pinnedVersion?.providerKey === LEGACY_WATCH_QUARANTINE_PROVIDER_KEY &&
      pinnedIntegrity?.portableHashValid === true;
    const isSignalDigestQuarantine = projection.kind === 'quarantined_watch_snapshot.v1' &&
      knownWatchProvider && workflow.activeVersionId !== null &&
      sameUuid(projection.workflowVersionId, workflow.activeVersionId) &&
      projection.status === 'paused' && projection.nextRunAt === null &&
      projection.sourceText.startsWith('Projection quarantined: ') &&
      isWatchSnapshot(projection.snapshot) &&
      watchSnapshotsEqual(projection.snapshot, signalDigestQuarantineSnapshot()) &&
      pinnedIntegrity !== undefined &&
      (!pinnedIntegrity.portableHashValid || !pinnedIntegrity.providerCompileValid);
    const quarantineVersionId = isLegacyQuarantine || isSignalDigestQuarantine
      ? projection.workflowVersionId
      : null;
    if (!commonProjectionValid || !commonRuntimeValid ||
        (!isCompiledProjection && !isLegacyQuarantine && !isSignalDigestQuarantine)) {
      problems.push(`${prefix}.watchProjection has invalid state, identity, or version pin`);
    }
    for (const [versionIndex, version] of versions.entries()) {
      const integrity = versionIntegrityById.get(version.id);
      const explicitQuarantineException = quarantineVersionId !== null &&
        sameUuid(version.id, quarantineVersionId) &&
        (isSignalDigestQuarantine || (isLegacyQuarantine && integrity?.portableHashValid === true));
      if ((!integrity?.portableHashValid || !integrity.providerCompileValid) &&
          !explicitQuarantineException) {
        problems.push(`${prefix}.versions[${versionIndex}] has invalid content, identity, or ownership`);
      }
    }
  }
  return problems;
}

/**
 * Minimal structural validation of a decoded payload before we trust it enough
 * to write to the DB. We do NOT trust the archive's contents — it may have been
 * hand-edited or produced by a different build. Returns a list of problems;
 * empty means it passed.
 */
export function validateBackupData(value: unknown): string[] {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['payload is not an object'];
  }
  const data = value as Partial<BackupData>;
  if (typeof data.schemaVersion !== 'number') problems.push('missing schemaVersion');
  if (typeof data.user !== 'object' || data.user === null) {
    problems.push('missing user');
  } else if (typeof (data.user as UserRow).id !== 'string') {
    problems.push('user.id is not a string');
  }
  if (!Array.isArray(data.preferences)) problems.push('preferences is not an array');
  if (!Array.isArray(data.decisions)) problems.push('decisions is not an array');
  else {
    const archiveCandidateIds = new Set<string>();
    for (const [index, bundle] of data.decisions.entries()) {
      if (!bundle || typeof bundle !== 'object' || !bundle.decision || typeof bundle.decision.id !== 'string') {
        problems.push(`decisions[${index}] is malformed`);
        continue;
      }
      if (!sameUuid(bundle.decision.user_id, data.user?.id)) {
        problems.push(`decisions[${index}] has inconsistent owner`);
      }
      if (!Array.isArray(bundle.candidateActions)) {
        problems.push(`decisions[${index}].candidateActions is not an array`);
      }
      if (!Array.isArray(bundle.explanations)) {
        problems.push(`decisions[${index}].explanations is not an array`);
      }
      if (bundle.executionPlans !== undefined && !Array.isArray(bundle.executionPlans)) {
        problems.push(`decisions[${index}].executionPlans is not an array`);
      }
      const carriesExecutionMetadata = data.schemaVersion === BACKUP_SCHEMA_VERSION ||
        data.schemaVersion === EXECUTION_BACKUP_SCHEMA_VERSION;
      if (!carriesExecutionMetadata && bundle.executionPlans !== undefined) {
        problems.push(
          `decisions[${index}].executionPlans requires schema version ${EXECUTION_BACKUP_SCHEMA_VERSION} or later`,
        );
      }
      const plans = Array.isArray(bundle.executionPlans) ? bundle.executionPlans : [];
      const planIds = new Set(plans.map((plan) => plan && typeof plan === 'object' ? plan.id : undefined));
      const candidateRows = Array.isArray(bundle.candidateActions) ? bundle.candidateActions : [];
      const candidateIds = new Set(candidateRows
        .filter((action) => action && typeof action === 'object')
        .map((action) => action.id));
      if (candidateRows.some((action) => !action || typeof action !== 'object' ||
          !uuid.test(action.id) || action.decision_id !== bundle.decision.id ||
          archiveCandidateIds.has(action.id)) || candidateIds.size !== candidateRows.length) {
        problems.push(`decisions[${index}] has inconsistent candidate linkage`);
      }
      for (const action of candidateRows) {
        if (action && typeof action === 'object' && typeof action.id === 'string') {
          archiveCandidateIds.add(action.id);
        }
      }
      if (plans.some((plan) => !plan || typeof plan !== 'object' ||
          !uuid.test(plan.id) || plan.decision_id !== bundle.decision.id ||
          !Array.isArray(plan.steps) || plan.steps.length !== 0 ||
          (plan.action_id !== null && !candidateIds.has(plan.action_id))) ||
          planIds.size !== plans.length ||
          (carriesExecutionMetadata &&
            bundle.outcome?.execution_plan_id && !planIds.has(bundle.outcome.execution_plan_id))) {
        problems.push(`decisions[${index}] has inconsistent execution linkage`);
      }
      if (bundle.outcome !== null && (!bundle.outcome || typeof bundle.outcome !== 'object' ||
          !uuid.test(bundle.outcome.id) || bundle.outcome.decision_id !== bundle.decision.id ||
          (bundle.outcome.selected_action_id !== null &&
            !candidateIds.has(bundle.outcome.selected_action_id)) ||
          (carriesExecutionMetadata &&
            bundle.outcome.execution_plan_id !== null &&
            !planIds.has(bundle.outcome.execution_plan_id)))) {
        problems.push(`decisions[${index}] has inconsistent outcome linkage`);
      }
      if ((data.schemaVersion === BACKUP_SCHEMA_VERSION ||
          data.schemaVersion === EXECUTION_BACKUP_SCHEMA_VERSION ||
          data.schemaVersion === INGEST_BACKUP_SCHEMA_VERSION ||
          data.schemaVersion === RECEIPT_BACKUP_SCHEMA_VERSION) &&
          bundle.inferenceReceipts === undefined) {
        problems.push(`decisions[${index}].inferenceReceipts is required by schema version ${data.schemaVersion}`);
      } else if (bundle.inferenceReceipts !== undefined && !Array.isArray(bundle.inferenceReceipts)) {
        problems.push(`decisions[${index}].inferenceReceipts is not an array`);
      }
      if (data.schemaVersion === LEGACY_BACKUP_SCHEMA_VERSION && bundle.inferenceReceipts !== undefined) {
        problems.push(`decisions[${index}].inferenceReceipts requires schema version ${RECEIPT_BACKUP_SCHEMA_VERSION}`);
      }
      const explanations = Array.isArray(bundle.explanations) ? bundle.explanations : [];
      const receipts = Array.isArray(bundle.inferenceReceipts) ? bundle.inferenceReceipts : [];
      if (data.schemaVersion === RECEIPT_BACKUP_SCHEMA_VERSION && receipts.length > 1) {
        problems.push(`decisions[${index}].inferenceReceipts must contain at most one receipt`);
      }
      for (const [explanationIndex, explanation] of explanations.entries()) {
        if (!sameUuid(explanation.decision_id, bundle.decision.id)) {
          problems.push(`decisions[${index}].explanations[${explanationIndex}] has inconsistent linkage`);
        }
      }
      const receiptIds = new Set<string>();
      const captureOrdinals = new Set<number>();
      for (const [receiptIndex, receipt] of receipts.entries()) {
        const signed = snapshotInferenceReceipt(receipt?.receipt);
        const normalizedReceiptId = typeof receipt?.id === 'string'
          ? receipt.id.toLowerCase()
          : null;
        if (normalizedReceiptId !== null && receiptIds.has(normalizedReceiptId)) {
          problems.push(`decisions[${index}].inferenceReceipts[${receiptIndex}] duplicates a receipt id`);
        } else if (normalizedReceiptId !== null) {
          receiptIds.add(normalizedReceiptId);
        }
        const captureOrdinal = receipt?.capture_ordinal ?? receiptIndex;
        if (Number.isSafeInteger(captureOrdinal) && captureOrdinal >= 0) {
          if (captureOrdinals.has(captureOrdinal)) {
            problems.push(`decisions[${index}].inferenceReceipts[${receiptIndex}] duplicates a capture ordinal`);
          } else {
            captureOrdinals.add(captureOrdinal);
          }
        }
        const linkedExplanation = explanations.some((explanation) =>
          sameUuid(explanation.id, receipt?.explanation_id));
        if (!receipt || !sameUuid(receipt.decision_id, bundle.decision.id) ||
            !Number.isSafeInteger(captureOrdinal) || captureOrdinal < 0 ||
            !linkedExplanation || !signed || !verifyInferenceReceiptSeal(signed) ||
            !sameUuid(signed.id, receipt.id) || !sameUuid(signed.decisionId, receipt.decision_id) ||
            !sameUuid(signed.explanationId, receipt.explanation_id) ||
            !sameUuid(signed.userId, data.user?.id) ||
            signed.version !== receipt.version || signed.status !== receipt.status) {
          problems.push(`decisions[${index}].inferenceReceipts[${receiptIndex}] has inconsistent linkage`);
        }
      }
      const carriesIngestState = data.schemaVersion === BACKUP_SCHEMA_VERSION ||
        data.schemaVersion === EXECUTION_BACKUP_SCHEMA_VERSION ||
        data.schemaVersion === INGEST_BACKUP_SCHEMA_VERSION;
      if (carriesIngestState && bundle.ingestState === undefined) {
        problems.push(`decisions[${index}].ingestState is required by schema version ${data.schemaVersion}`);
      }
      if ((data.schemaVersion === LEGACY_BACKUP_SCHEMA_VERSION ||
          data.schemaVersion === RECEIPT_BACKUP_SCHEMA_VERSION) && bundle.ingestState !== undefined) {
        problems.push(`decisions[${index}].ingestState requires schema version ${INGEST_BACKUP_SCHEMA_VERSION} or later`);
      }
      if (bundle.ingestState !== undefined && bundle.ingestState !== null) {
        const state = bundle.ingestState;
        const effectStates: DecisionEffectState[] = [
          'non_effect', 'ready', 'running', 'completed', 'failed', 'restored_non_replay',
        ];
        const executionStatuses = ['completed', 'failed', 'ambiguous', null];
        if (!sameUuid(state.decisionId, bundle.decision.id) ||
            typeof state.receiptCaptureComplete !== 'boolean' ||
            !['auto_execute', 'approval', 'non_effect'].includes(state.continuationKind) ||
            (state.continuationKind === 'approval'
              ? state.confirmationLevel !== 'single' && state.confirmationLevel !== 'dual'
              : state.confirmationLevel !== null) ||
            !effectStates.includes(state.effectState) ||
            (state.sourceEffectState !== null && !effectStates.includes(state.sourceEffectState)) ||
            !executionStatuses.includes(state.sourceExecutionStatus) ||
            (state.sourceExecutionPlanId !== null &&
              (typeof state.sourceExecutionPlanId !== 'string' ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                  .test(state.sourceExecutionPlanId) ||
                (carriesExecutionMetadata &&
                  !planIds.has(state.sourceExecutionPlanId)))) ||
            (state.receiptCaptureComplete &&
              (typeof state.receiptExplanationId !== 'string' ||
                !explanations.some((explanation) =>
                  sameUuid(explanation.id, state.receiptExplanationId)))) ||
            (!state.receiptCaptureComplete && state.receiptExplanationId !== null)) {
          problems.push(`decisions[${index}].ingestState has inconsistent linkage or classification`);
        }
      }
      if (!carriesExecutionMetadata && bundle.joinedReceipt !== undefined) {
        problems.push(
          `decisions[${index}].joinedReceipt requires schema version ${EXECUTION_BACKUP_SCHEMA_VERSION} or later`,
        );
      }
      if (carriesExecutionMetadata && bundle.joinedReceipt !== undefined) {
        if (!bundle.joinedReceipt || typeof bundle.joinedReceipt !== 'object' ||
            !bundle.joinedReceipt.root || typeof bundle.joinedReceipt.root !== 'object' ||
            !Array.isArray(bundle.joinedReceipt.revisions) ||
            bundle.joinedReceipt.revisions.length === 0) {
          problems.push(`decisions[${index}].joinedReceipt is malformed`);
          continue;
        }
        const { root, revisions } = bundle.joinedReceipt;
        if (!uuid.test(root.id) || root.user_id !== data.user?.id ||
            root.decision_id !== bundle.decision.id) {
          problems.push(`decisions[${index}].joinedReceipt.root has inconsistent ownership`);
        }
        if (!verifyJoinedDecisionReceiptChain({
          receiptId: root.id,
          decisionId: bundle.decision.id,
          userId: String(data.user?.id),
          revisions,
        })) {
          problems.push(`decisions[${index}].joinedReceipt failed chain verification`);
        }
        const eventKeys = new Set<string>();
        const priorRevisionDigests = new Map<string, string>();
        const candidateById = new Map(candidateRows
          .filter((row) => row && typeof row === 'object')
          .map((row) => [row.id, row]));
        const explanationById = new Map(explanations.map((row) => [row.id, row]));
        const inferenceById = new Map(receipts.map((row) => [row.id, row]));
        const planById = new Map(plans.map((row) => [row.id, row]));
        const decisionHash = joinedDecisionReceiptArtifactDigest(
          'decision', decisionReceiptRowArtifactV1(
            'decision', bundle.decision as unknown as Record<string, unknown>,
          ),
        );
        let priorDigest: string | null = null;
        let priorContent: DecisionReceiptRevisionRow['content'] | null = null;
        let priorContentValid = false;
        let tailContentValid = false;
        for (const [revisionIndex, revision] of revisions.entries()) {
          if (!revision || typeof revision !== 'object' ||
              !uuid.test(revision.id) || !uuid.test(revision.receipt_id) ||
              !revision.content || typeof revision.content !== 'object') {
            problems.push(`decisions[${index}].joinedReceipt.revisions[${revisionIndex}] is malformed`);
            continue;
          }
          let computed = '';
          let computedRevision = '';
          let contentValid = false;
          const sequence = normalizeDecisionReceiptSequence(revision.sequence);
          try {
            if (sequence === null) throw new TypeError('invalid receipt sequence');
            computed = joinedDecisionReceiptContentDigest(revision.content);
            computedRevision = joinedDecisionReceiptRevisionDigest({
              revisionId: revision.id,
              receiptId: root.id,
              decisionId: bundle.decision.id,
              userId: String(data.user?.id),
              sequence,
              eventKey: revision.event_key,
              previousDigest: priorDigest,
              contentDigest: computed,
            });
            contentValid = true;
          } catch {
            problems.push(`decisions[${index}].joinedReceipt.revisions[${revisionIndex}] has invalid content`);
          }
          const correctionId = revision.content?.correctionOfRevision?.id;
          const transitionValid = revisionIndex === 0 || (
            priorContent !== null && priorContentValid && contentValid &&
            preservesJoinedDecisionReceiptLinks(priorContent, revision.content)
          );
          if (revision.receipt_id !== root.id || sequence !== revisionIndex + 1 ||
              revision.previous_digest !== priorDigest || revision.content_digest !== computed ||
              revision.revision_digest !== computedRevision ||
              revision.content?.decision?.id !== bundle.decision.id ||
              revision.content?.decision?.canonicalHash !== decisionHash ||
              (revisionIndex === 0 && revision.content.stage !== 'decision_recorded') ||
              !transitionValid ||
              !isDecisionReceiptEventKey(revision.event_key) || eventKeys.has(revision.event_key) ||
              typeof revision.trusted !== 'boolean' ||
              revision.stage !== revision.content?.stage ||
              revision.disposition !== revision.content?.disposition ||
              revision.candidate_action_id !== (revision.content?.candidateAction?.id ?? null) ||
              revision.barrier_id !== (revision.content?.barrier?.id ?? null) ||
              revision.explanation_id !== (revision.content?.explanation?.id ?? null) ||
              revision.approval_request_id !== (revision.content?.approvalRequest?.id ?? null) ||
              revision.execution_plan_id !== (revision.content?.executionPlan?.id ?? null) ||
              revision.execution_result_id !== (revision.content?.executionResult?.id ?? null) ||
              revision.execution_disposition !== (revision.content?.executionDisposition ?? null) ||
              revision.correction_of_revision_id !== (correctionId ?? null) ||
              (correctionId !== undefined &&
                priorRevisionDigests.get(correctionId) !== revision.content.correctionOfRevision?.canonicalHash)) {
            problems.push(`decisions[${index}].joinedReceipt.revisions[${revisionIndex}] has inconsistent chain`);
          }
          eventKeys.add(revision.event_key);
          priorRevisionDigests.set(revision.id, revision.revision_digest);
          priorDigest = revision.revision_digest;
          priorContent = revision.content;
          priorContentValid = contentValid;
          if (revisionIndex === revisions.length - 1) tailContentValid = contentValid;
        }
        // Never traverse nested artifact references until the tail has passed
        // exact-key and semantic content validation. Chain errors are reported
        // above; malformed archive input must not escape as a runtime error.
        const tail = tailContentValid ? revisions[revisions.length - 1]?.content : undefined;
        if (tail?.candidateAction) {
          const row = candidateById.get(tail.candidateAction.id);
          if (!row || joinedDecisionReceiptArtifactDigest(
            'candidate_action', decisionReceiptRowArtifactV1(
              'candidate_action', row as unknown as Record<string, unknown>,
            ),
          ) !== tail.candidateAction.canonicalHash) {
            problems.push(`decisions[${index}].joinedReceipt has inconsistent candidate snapshot`);
          }
        }
        for (const evaluation of tail?.policyEvaluations ?? []) {
          const row = explanationById.get(evaluation.explanation.id);
          if (!row || joinedDecisionReceiptArtifactDigest(
            'explanation', decisionReceiptRowArtifactV1(
              'explanation', row as unknown as Record<string, unknown>,
            ),
          ) !== evaluation.explanation.canonicalHash) {
            problems.push(`decisions[${index}].joinedReceipt has inconsistent explanation snapshot`);
            break;
          }
        }
        if (tail?.version === 2 ||
            (tail?.version === 3 && tail.executionExplanation !== undefined)) {
          const ref = tail.executionExplanation as Partial<typeof tail.executionExplanation> | undefined;
          const row = typeof ref?.id === 'string' ? explanationById.get(ref.id) : undefined;
          if (!row || typeof ref?.canonicalHash !== 'string' || joinedDecisionReceiptArtifactDigest(
            'explanation', decisionReceiptRowArtifactV1(
              'explanation', row as unknown as Record<string, unknown>,
            ),
          ) !== ref.canonicalHash) {
            problems.push(
              `decisions[${index}].joinedReceipt has inconsistent execution explanation snapshot`,
            );
          }
          const terminalCandidate = tail.candidateAction?.id
            ? candidateById.get(tail.candidateAction.id)
            : undefined;
          if (terminalCandidate?.action_type === 'archive_email') {
            const binding = parseGmailArchiveTerminalExplanationBinding(row?.evidence_used);
            const result = binding?.result;
            const reconciliation = result ? null :
              parseGmailArchiveReconciliationExplanationEvidence(row?.evidence_used);
            const expectedDisposition = result?.outcome === 'confirmed' ? 'succeeded'
              : result?.outcome === 'known_failure' ? 'failed'
                : result?.outcome === 'unknown' ? 'unknown'
                  : reconciliation?.outcome ?? null;
            const semantics = result ? gmailArchiveTerminalExplanationSemantics(result)
              : reconciliation
                ? gmailArchiveReconciliationExplanationSemantics(reconciliation)
                : null;
            const observationBinding = reconciliation?.evidence.kind === 'mailbox_observed' ||
              reconciliation?.evidence.kind === 'mailbox_observation_unavailable'
              ? reconciliation.evidence
              : null;
            const mutationBinding = result && 'binding' in result ? result.binding : null;
            const candidateMessageRefId = terminalCandidate.parameters?.['messageRefId'];
            const executionRecorded = revisions.filter(
              (revision) => revision.stage === 'execution_recorded',
            );
            const r7 = executionRecorded.length === 1 ? executionRecorded[0] : undefined;
            const r7Content = r7?.content.version === 2 ? r7.content : undefined;
            const terminalAt = r7 ? new Date(r7.created_at).getTime() : Number.NaN;
            const terminalIso = Number.isFinite(terminalAt)
              ? new Date(terminalAt).toISOString()
              : null;
            const reconciliationTimeInvalid = reconciliation !== null && (
              terminalIso === null || !r7Content ||
              r7Content.barrier?.snapshot.updatedAt !== terminalIso ||
              r7Content.executionPlan?.snapshot.updatedAt !== terminalIso ||
              new Date(row?.created_at ?? Number.NaN).getTime() !== terminalAt ||
              (r7Content.executionResult !== undefined &&
                r7Content.executionResult.snapshot.completedAt !== terminalIso) ||
              Date.parse(reconciliation.phaseChangedAt) +
                GMAIL_ARCHIVE_RECOVERY_GRACE_SECONDS * 1_000 > terminalAt ||
              (reconciliation.evidence.kind === 'mailbox_observed' &&
                (Date.parse(reconciliation.evidence.observedAt) <
                  Date.parse(reconciliation.phaseChangedAt) ||
                 Date.parse(reconciliation.evidence.observedAt) > terminalAt))
            );
            if (!row || (!result && !reconciliation) ||
                (result && binding?.attemptPhase !== null && binding?.attemptPhase !== undefined &&
                  !gmailArchiveResultAllowedForAttemptPhase(result, binding.attemptPhase)) ||
                (observationBinding !== null &&
                  (observationBinding.binding.userId !== data.user?.id ||
                    observationBinding.binding.admissionId !== tail.barrier?.id ||
                    observationBinding.binding.messageRefId !== candidateMessageRefId)) ||
                (mutationBinding !== null &&
                  (mutationBinding.userId !== data.user?.id ||
                    mutationBinding.admissionId !== tail.barrier?.id ||
                    mutationBinding.messageRefId !== candidateMessageRefId)) ||
                reconciliationTimeInvalid ||
                expectedDisposition !== tail.executionDisposition ||
                expectedDisposition !== tail.disposition ||
                row.what_happened !== semantics?.whatHappened ||
                row.confidence_reasoning !== semantics?.confidenceReasoning ||
                row.escalation_rationale !== semantics?.escalationRationale ||
                row.correction_guidance !== semantics?.correctionGuidance) {
              problems.push(
                `decisions[${index}].joinedReceipt has invalid Gmail terminal explanation`,
              );
            }
          }
        }
        for (const ref of tail?.inference.receipts ?? []) {
          const row = inferenceById.get(ref.id);
          // User-deleted inference bytes are intentionally absent; the joined
          // chain retains their commitment. Any row still present must match.
          if (row && joinedDecisionReceiptArtifactDigest('inference_receipt', row.receipt) !== ref.canonicalHash) {
            problems.push(`decisions[${index}].joinedReceipt has inconsistent inference snapshot`);
            break;
          }
        }
        if (tail?.executionPlan) {
          const row = planById.get(tail.executionPlan.id);
          const planSnapshot = row ? {
            version: 1 as const,
            status: row.status,
            decisionId: row.decision_id,
            candidateActionId: row.action_id,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
          } : null;
          if (!planSnapshot || joinedDecisionReceiptArtifactDigest(
            'execution_plan', planSnapshot,
          ) !== tail.executionPlan.canonicalHash) {
            problems.push(`decisions[${index}].joinedReceipt has inconsistent execution-plan snapshot`);
          }
        }
        // Barrier, approval, result, feedback, and preference-history source
        // rows are intentionally absent from the portable archive. The first
        // four retain allowlisted immutable snapshots/digests; preference
        // history additionally commits to old/new value hashes without
        // exporting those values. Restored revisions remain permanently
        // untrusted, integrity-only historical archive entries; this format
        // has no promotion or source-revalidation path.
      }
    }
  }
  if (!Array.isArray(data.twinProfileVersions)) {
    problems.push('twinProfileVersions is not an array');
  }
  problems.push(...validateWorkflowBackups(data, data.user?.id, uuid));
  return problems;
}

/**
 * Rehydrate a {@link BackupData} into a fresh install.
 *
 * "Fresh install" is enforced: if a user with the same id already exists, the
 * restore refuses (`user_exists`) rather than clobbering live data. To restore
 * over an existing install, purge the user first (`userPurgeRepository`) — the
 * delete + restore pairing is intentional and mirrors the GDPR story.
 *
 * The whole restore runs in one serializable transaction: either the entire
 * twin lands or nothing does.
 */
export async function restoreBackup(value: unknown): Promise<RestoreBackupResult> {
  const problems = validateBackupData(value);
  if (problems.length > 0) {
    return {
      success: false,
      reason: 'invalid_data',
      message: `backup payload failed validation: ${problems.join('; ')}`,
    };
  }
  const data = value as BackupData;

  if (data.schemaVersion !== BACKUP_SCHEMA_VERSION &&
      data.schemaVersion !== EXECUTION_BACKUP_SCHEMA_VERSION &&
      data.schemaVersion !== INGEST_BACKUP_SCHEMA_VERSION &&
      data.schemaVersion !== RECEIPT_BACKUP_SCHEMA_VERSION &&
      data.schemaVersion !== LEGACY_BACKUP_SCHEMA_VERSION) {
    return {
      success: false,
      reason: 'unsupported_schema',
      message: `backup schema version ${data.schemaVersion} is not supported by this build (expected ${LEGACY_BACKUP_SCHEMA_VERSION}, ${RECEIPT_BACKUP_SCHEMA_VERSION}, ${INGEST_BACKUP_SCHEMA_VERSION}, ${EXECUTION_BACKUP_SCHEMA_VERSION}, or ${BACKUP_SCHEMA_VERSION})`,
    };
  }

  for (let attempt = 0; ; attempt += 1) {
    const counts: Record<string, number> = {};
    const bump = (table: string, n = 1): void => {
      counts[table] = (counts[table] ?? 0) + n;
    };
    let restored: boolean;
    try {
      restored = await withTransaction(async (client) => {
        const existing = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [data.user.id]);
        if (existing.rows[0]) return false;
    const u = data.user;
    await client.query(
      `INSERT INTO users (
         id, email, name, trust_tier, autonomy_settings, ironclaw_channel,
         execution_authority_revision, language, timezone, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::UUID, gen_random_uuid()), $8, $9, $10, $11)`,
      [
        u.id,
        u.email,
        u.name,
        u.trust_tier,
        JSON.stringify(u.autonomy_settings ?? {}),
        u.ironclaw_channel ?? null,
        u.execution_authority_revision ?? null,
        u.language ?? null,
        u.timezone ?? null,
        u.created_at,
        u.updated_at,
      ],
    );
    bump('users');

    for (const bundle of data.workflows ?? []) {
      const workflow = bundle.workflow;
      await client.query(
        `INSERT INTO workflows
           (id, user_id, provider_key, active_version_id, created_at, updated_at)
         VALUES ($1,$2,$3,NULL,$4,$5)`,
        [
          workflow.id,
          workflow.userId,
          workflow.providerKey,
          workflow.createdAt,
          workflow.updatedAt,
        ],
      );
      bump('workflows');

      for (const version of [...bundle.versions].sort(
        (left, right) => left.versionNumber - right.versionNumber,
      )) {
        await client.query(
          `INSERT INTO workflow_versions (
             id, workflow_id, user_id, version_number, provider_key,
             provider_schema_version, canonical_payload, content_hash,
             parent_version_id, authoring_metadata, inference_metadata, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8,$9,$10::JSONB,$11::JSONB,$12)`,
          [
            version.id,
            version.workflowId,
            version.userId,
            version.versionNumber,
            version.providerKey,
            version.providerSchemaVersion,
            JSON.stringify(version.canonicalPayload),
            version.contentHash,
            version.parentVersionId,
            JSON.stringify(version.authoring),
            version.inference === null ? null : JSON.stringify(version.inference),
            version.createdAt,
          ],
        );
        bump('workflow_versions');
      }

      for (const proposal of bundle.proposals) {
        await client.query(
          `INSERT INTO workflow_proposals (
             id, workflow_id, user_id, base_version_id,
             proposed_version_id, kind, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            proposal.id,
            proposal.workflowId,
            proposal.userId,
            proposal.baseVersionId,
            proposal.proposedVersionId,
            proposal.kind,
            proposal.createdAt,
          ],
        );
        bump('workflow_proposals');
      }

      const orderedActivationEvents = [...bundle.activationEvents].sort(
        (left, right) => left.eventSequence - right.eventSequence,
      );
      for (const event of orderedActivationEvents) {
        await client.query(
          `INSERT INTO workflow_activation_events (
             id, workflow_id, user_id, previous_version_id,
             activated_version_id, proposal_id, kind, event_sequence, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            event.id,
            event.workflowId,
            event.userId,
            event.previousVersionId,
            event.activatedVersionId,
            event.proposalId,
            event.kind,
            event.eventSequence,
            event.createdAt,
          ],
        );
        bump('workflow_activation_events');
      }

      if (workflow.activeVersionId !== null) {
        const activeActivationEventId = workflow.activeActivationEventId;
        if (!activeActivationEventId) {
          throw new Error(`workflow ${workflow.id} active activation event is missing during restore`);
        }
        const activated = await client.query(
          `UPDATE workflows
              SET active_version_id = $3, active_activation_event_id = $4
            WHERE id = $1 AND user_id = $2
              AND active_version_id IS NULL AND active_activation_event_id IS NULL`,
          [workflow.id, workflow.userId, workflow.activeVersionId, activeActivationEventId],
        );
        if (activated.rowCount !== 1) {
          throw new Error(`workflow ${workflow.id} active version could not be linked during restore`);
        }
      }

      const projection = bundle.watchProjection;
      if (projection !== null) {
        const spec = projection.snapshot;
        await client.query(
          `INSERT INTO watches (
             id, user_id, name, source_text, cadence, hour_of_day, day_of_week,
             filter, action, status, created_at, updated_at, last_run_at,
             next_run_at, schedule_revision, workflow_id, workflow_version_id,
             workflow_provider_key, workflow_provider_schema_version,
             content_hash, projection_version
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8::JSONB,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19,$20,$21
           )`,
          [
            projection.id,
            projection.userId,
            spec.name,
            projection.sourceText,
            spec.cadence,
            spec.hourOfDay,
            spec.dayOfWeek,
            JSON.stringify(spec.filter),
            spec.action,
            projection.status,
            projection.createdAt,
            projection.updatedAt,
            projection.lastRunAt,
            projection.nextRunAt,
            projection.scheduleRevision,
            projection.workflowId,
            projection.workflowVersionId,
            projection.providerKey,
            projection.providerSchemaVersion,
            projection.contentHash,
            projection.projectionVersion,
          ],
        );
        bump('watches');
      }
    }

    if (data.twinProfile) {
      const p = data.twinProfile;
      await client.query(
        `INSERT INTO twin_profiles (
           id, user_id, version, preferences, inferences, risk_tolerance,
           spend_norms, communication_style, routines, domain_heuristics,
           drafts_enabled, drafts_daily_call_cap, drafts_eval_passed_at,
           created_at, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          p.id,
          p.user_id,
          p.version,
          JSON.stringify(p.preferences ?? []),
          JSON.stringify(p.inferences ?? []),
          JSON.stringify(p.risk_tolerance ?? {}),
          JSON.stringify(p.spend_norms ?? {}),
          JSON.stringify(p.communication_style ?? {}),
          JSON.stringify(p.routines ?? []),
          JSON.stringify(p.domain_heuristics ?? {}),
          p.drafts_enabled ?? false,
          p.drafts_daily_call_cap ?? 100,
          p.drafts_eval_passed_at ?? null,
          p.created_at,
          p.updated_at,
        ],
      );
      bump('twin_profiles');

      for (const v of data.twinProfileVersions) {
        await client.query(
          `INSERT INTO twin_profile_versions (id, profile_id, version, snapshot, changed_fields, reason, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            v.id,
            v.profile_id,
            v.version,
            JSON.stringify(v.snapshot ?? {}),
            v.changed_fields ?? [],
            v.reason ?? null,
            v.created_at,
          ],
        );
        bump('twin_profile_versions');
      }
    }

    for (const pref of data.preferences) {
      await client.query(
        `INSERT INTO preferences (
           id, user_id, domain, key, value, confidence, source, evidence, version, created_at, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          pref.id,
          pref.user_id,
          pref.domain,
          pref.key,
          JSON.stringify(pref.value ?? null),
          pref.confidence,
          pref.source,
          JSON.stringify(pref.evidence ?? []),
          pref.version,
          pref.created_at,
          pref.updated_at,
        ],
      );
      bump('preferences');
    }

    for (const bundle of data.decisions) {
      const d = bundle.decision;
      await client.query(
        `INSERT INTO decisions (
           id, user_id, situation_type, raw_event, interpreted_situation,
           domain, urgency, metadata, signal_id, created_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          d.id,
          d.user_id,
          d.situation_type,
          JSON.stringify(d.raw_event ?? {}),
          JSON.stringify(d.interpreted_situation ?? {}),
          d.domain,
          d.urgency,
          JSON.stringify(d.metadata ?? {}),
          d.signal_id ?? null,
          d.created_at,
        ],
      );
      bump('decisions');

      for (const a of bundle.candidateActions) {
        await client.query(
          `INSERT INTO candidate_actions (
             id, decision_id, action_type, description, parameters,
             predicted_user_preference, risk_assessment, reversible,
             estimated_cost, created_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            a.id,
            a.decision_id,
            a.action_type,
            a.description,
            JSON.stringify(a.parameters ?? {}),
            a.predicted_user_preference,
            JSON.stringify(a.risk_assessment ?? {}),
            a.reversible,
            a.estimated_cost ?? null,
            a.created_at,
          ],
        );
        bump('candidate_actions');
      }

      for (const e of bundle.explanations) {
        await client.query(
          `INSERT INTO explanation_records (
             id, decision_id, type, what_happened, evidence_used, preferences_invoked,
             confidence_reasoning, action_rationale, escalation_rationale,
             correction_guidance, capability_provenance_node_id, created_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            e.id,
            e.decision_id,
            e.type ?? 'action',
            e.what_happened,
            JSON.stringify(e.evidence_used ?? []),
            e.preferences_invoked ?? [],
            e.confidence_reasoning,
            e.action_rationale,
            e.escalation_rationale ?? null,
            e.correction_guidance,
            e.capability_provenance_node_id ?? null,
            e.created_at,
          ],
        );
        bump('explanation_records');
      }

      for (const [captureOrdinal, r] of (bundle.inferenceReceipts ?? []).entries()) {
        const signed = snapshotInferenceReceipt(r.receipt);
        if (!signed || !verifyInferenceReceiptSeal(signed) || !sameUuid(signed.id, r.id) ||
            !sameUuid(signed.userId, data.user.id) ||
            !sameUuid(signed.decisionId, bundle.decision.id) ||
            !sameUuid(signed.decisionId, r.decision_id) ||
            !sameUuid(signed.explanationId, r.explanation_id) ||
            signed.version !== r.version || signed.status !== r.status) {
          throw new Error(`receipt ${r.id} changed or failed validation during restore`);
        }
        const insertedReceipt = await client.query(
          `INSERT INTO inference_receipts (
             id, version, decision_id, explanation_id, capture_ordinal,
             status, receipt, trusted, created_at
           ) SELECT $1,$2,d.id,e.id,$5,$6,$7,false,$8
             FROM decisions d JOIN explanation_records e ON e.decision_id = d.id
            WHERE d.id=$3 AND e.id=$4`,
          [r.id, r.version, r.decision_id, r.explanation_id,
            r.capture_ordinal ?? captureOrdinal, r.status, JSON.stringify(signed), r.created_at],
        );
        if (insertedReceipt.rowCount !== 1) {
          throw new Error(`receipt ${r.id} could not be linked during restore`);
        }
        bump('inference_receipts');
      }

      for (const plan of bundle.executionPlans ?? []) {
        await client.query(
          `INSERT INTO execution_plans
             (id, decision_id, action_id, status, steps, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [plan.id, plan.decision_id, plan.action_id, plan.status,
            JSON.stringify(plan.steps ?? []), plan.created_at, plan.updated_at],
        );
        bump('execution_plans');
      }
      // Outcome FKs the (optional) selected candidate action, so it must be
      // inserted after the actions above.
      if (bundle.outcome) {
        const o = bundle.outcome;
        await client.query(
          `INSERT INTO decision_outcomes (
             id, decision_id, selected_action_id, auto_executed,
             requires_approval, escalation_reason, explanation, confidence,
             execution_plan_id, created_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            o.id,
            o.decision_id,
            o.selected_action_id ?? null,
            o.auto_executed,
            o.requires_approval,
            o.escalation_reason ?? null,
            o.explanation,
            o.confidence,
            // V4 carries only sanitized plan metadata. Older archives retain
            // replay classification in the ingest guard without a dangling FK.
            (data.schemaVersion === BACKUP_SCHEMA_VERSION ||
              data.schemaVersion === EXECUTION_BACKUP_SCHEMA_VERSION)
              ? o.execution_plan_id ?? null
              : null,
            o.created_at,
          ],
        );
        bump('decision_outcomes');
      }
      const state = bundle.ingestState;
      const carriesIngestState = data.schemaVersion === BACKUP_SCHEMA_VERSION ||
        data.schemaVersion === EXECUTION_BACKUP_SCHEMA_VERSION ||
        data.schemaVersion === INGEST_BACKUP_SCHEMA_VERSION;
      if (carriesIngestState &&
          state?.receiptCaptureComplete && state.receiptExplanationId) {
        const completion = await client.query(
          `INSERT INTO inference_receipt_completions (
             decision_id, explanation_id, completed_at
           ) SELECT d.id, e.id, $3
             FROM decisions d JOIN explanation_records e ON e.decision_id = d.id
            WHERE d.id = $1 AND e.id = $2`,
          [d.id, state.receiptExplanationId, state.completedAt ?? d.created_at],
        );
        if (completion.rowCount !== 1) {
          throw new Error(`receipt completion for decision ${d.id} could not be linked during restore`);
        }
        bump('inference_receipt_completions');
      }

      // Backups are historical data, never execution queues. Preserve source
      // classification for audit but mint no fresh dispatch authority. This
      // also fail-safes schema-v1/v2 decisions that predate portable state.
      await client.query(
        `INSERT INTO decision_ingest_guards (
           decision_id, receipt_explanation_id, continuation_kind,
           confirmation_level, effect_state, source_effect_state,
           source_execution_status, source_execution_plan_id,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'restored_non_replay',$5,$6,$7,$8,now())`,
        [
          d.id,
          carriesIngestState ? state?.receiptExplanationId ?? null : null,
          carriesIngestState ? state?.continuationKind ?? 'non_effect' : 'non_effect',
          carriesIngestState && state?.continuationKind === 'approval'
            ? state.confirmationLevel ?? 'dual'
            : null,
          carriesIngestState
            ? state?.sourceEffectState ?? state?.effectState ?? null
            : null,
          carriesIngestState ? state?.sourceExecutionStatus ?? null : 'ambiguous',
          carriesIngestState ? state?.sourceExecutionPlanId ?? null : null,
          state?.completedAt ?? d.created_at,
        ],
      );
      bump('decision_ingest_guards');

      if (bundle.joinedReceipt) {
        const { root, revisions } = bundle.joinedReceipt;
        await client.query(
          `INSERT INTO decision_receipts (id, user_id, decision_id, created_at)
           VALUES ($1, $2, $3, $4)`,
          [root.id, root.user_id, root.decision_id, root.created_at],
        );
        bump('decision_receipts');
        for (const revision of revisions) {
          await client.query(
            `INSERT INTO decision_receipt_revisions (
               id, receipt_id, sequence, event_key, previous_digest, content_digest,
               revision_digest, stage, disposition, content, trusted, candidate_action_id, barrier_id,
               explanation_id, approval_request_id, execution_plan_id,
               execution_result_id, execution_disposition, correction_of_revision_id, created_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::JSONB,false,$11,$12,$13,$14,$15,$16,$17,$18,$19
             )`,
            [revision.id, revision.receipt_id,
              normalizeDecisionReceiptSequence(revision.sequence)!, revision.event_key,
              revision.previous_digest, revision.content_digest, revision.revision_digest,
              revision.stage, revision.disposition, JSON.stringify(revision.content),
              revision.candidate_action_id, revision.barrier_id,
              revision.explanation_id, revision.approval_request_id,
              revision.execution_plan_id, revision.execution_result_id,
              revision.execution_disposition, revision.correction_of_revision_id,
              revision.created_at],
          );
          bump('decision_receipt_revisions');
        }
      }
    }
        return true;
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code : undefined;
      if (code === '40001' && attempt < 2) continue;
      if (code !== '23505') throw error;

      // A unique violation is `user_exists` only when the conflicting primary
      // key is now demonstrably the archive owner. Email or nested-artifact
      // collisions are malformed/incompatible backup data, not proof that the
      // requested user already existed.
      const sameId = await query('SELECT id FROM users WHERE id = $1', [data.user.id]);
      if (!sameId.rows[0]) {
        return {
          success: false,
          reason: 'invalid_data',
          message: 'backup restore encountered a conflicting unique artifact',
        };
      }
      restored = false;
    }
    if (!restored) {
      return {
        success: false,
        reason: 'user_exists',
        message: `user ${data.user.id} already exists; restore targets a fresh install — purge the user first`,
      };
    }
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return { success: true, summary: { counts, total } };
  }
}
