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
 *   - Sessions / recovery codes / pairing state — machine-local, not "my data".
 *
 * Reads go through the repository layer and `query` (CLAUDE.md: all DB access
 * via `@skytwin/db`). The restore writes inside a single `withTransaction` so a
 * fresh install is rehydrated atomically — a partial restore never leaves a
 * half-imported twin.
 */

import { query, withTransaction } from '../connection.js';
import { snapshotInferenceReceipt, verifyInferenceReceiptSeal } from '@skytwin/shared-types';
import { twinRepository } from '../repositories/twin-repository.js';
import { userRepository } from '../repositories/user-repository.js';
import type {
  CandidateActionRow,
  DecisionOutcomeRow,
  DecisionRow,
  ExplanationRecordRow,
  InferenceReceiptRow,
  PreferenceRow,
  TwinProfileRow,
  TwinProfileVersionRow,
  UserRow,
} from '../types.js';
import type { DecisionEffectState } from '../repositories/inference-receipt-repository.js';

/** Bumped so older readers reject replay-state archives instead of dropping their guard. */
export const BACKUP_SCHEMA_VERSION = 3;
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
  /** Required (but possibly null) in schema v3. Older archives omit it. */
  ingestState?: DecisionIngestBackupState | null;
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
}

export type CollectBackupResult =
  | { success: true; data: BackupData }
  | { success: false; reason: 'user_not_found'; message: string };

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
  const user = await userRepository.findById(userId);
  if (!user) {
    return {
      success: false,
      reason: 'user_not_found',
      message: `no user with id ${userId}`,
    };
  }

  const twinProfile = await twinRepository.getProfile(userId);
  // getProfileHistory caps at `limit`; pull the full history explicitly so a
  // backup never silently drops old versions.
  const twinProfileVersions = twinProfile
    ? (
        await query<TwinProfileVersionRow>(
          `SELECT * FROM twin_profile_versions
            WHERE profile_id = $1
            ORDER BY version ASC`,
          [twinProfile.id],
        )
      ).rows
    : [];

  const preferences = (
    await query<PreferenceRow>(
      'SELECT * FROM preferences WHERE user_id = $1 ORDER BY created_at ASC',
      [userId],
    )
  ).rows;

  const decisions = await collectDecisions(userId);

  return {
    success: true,
    data: {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      user,
      twinProfile,
      twinProfileVersions,
      preferences,
      decisions,
    },
  };
}

async function collectDecisions(userId: string): Promise<DecisionBundle[]> {
  // Walk decisions in pages by created_at so a user with a long history
  // doesn't pull an unbounded result set into one query.
  const allDecisions: DecisionRow[] = [];
  let offset = 0;
  for (;;) {
    const page = (
      await query<DecisionRow>(
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

  const actions = await query<CandidateActionRow>(
    'SELECT * FROM candidate_actions WHERE decision_id = ANY($1) ORDER BY created_at ASC',
    [decisionIds],
  );
  const outcomes = await query<DecisionOutcomeRow>(
    'SELECT * FROM decision_outcomes WHERE decision_id = ANY($1)',
    [decisionIds],
  );
  const explanations = await query<ExplanationRecordRow>(
    'SELECT * FROM explanation_records WHERE decision_id = ANY($1) ORDER BY created_at ASC',
    [decisionIds],
  );
  const receipts = await query<InferenceReceiptRow>(
    `SELECT id, version::INT4 AS version, decision_id, explanation_id,
       status, receipt, trusted, created_at
       FROM inference_receipts WHERE decision_id = ANY($1) ORDER BY created_at ASC`,
    [decisionIds],
  );
  const ingestStates = await query<{
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

  return allDecisions.map((decision) => ({
    decision,
    candidateActions: actionsByDecision.get(decision.id) ?? [],
    outcome: outcomeByDecision.get(decision.id) ?? null,
    explanations: explanationsByDecision.get(decision.id) ?? [],
    inferenceReceipts: receiptsByDecision.get(decision.id) ?? [],
    ingestState: stateByDecision.get(decision.id) ?? null,
  }));
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

/**
 * Minimal structural validation of a decoded payload before we trust it enough
 * to write to the DB. We do NOT trust the archive's contents — it may have been
 * hand-edited or produced by a different build. Returns a list of problems;
 * empty means it passed.
 */
export function validateBackupData(value: unknown): string[] {
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
      if ((data.schemaVersion === BACKUP_SCHEMA_VERSION ||
          data.schemaVersion === RECEIPT_BACKUP_SCHEMA_VERSION) && bundle.inferenceReceipts === undefined) {
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
      for (const [receiptIndex, receipt] of receipts.entries()) {
        const signed = snapshotInferenceReceipt(receipt?.receipt);
        const linkedExplanation = explanations.some((explanation) =>
          sameUuid(explanation.id, receipt?.explanation_id));
        if (!receipt || !sameUuid(receipt.decision_id, bundle.decision.id) ||
            !linkedExplanation || !signed || !verifyInferenceReceiptSeal(signed) ||
            !sameUuid(signed.id, receipt.id) || !sameUuid(signed.decisionId, receipt.decision_id) ||
            !sameUuid(signed.explanationId, receipt.explanation_id) ||
            !sameUuid(signed.userId, data.user?.id) ||
            signed.version !== receipt.version || signed.status !== receipt.status) {
          problems.push(`decisions[${index}].inferenceReceipts[${receiptIndex}] has inconsistent linkage`);
        }
      }
      if (data.schemaVersion === BACKUP_SCHEMA_VERSION && bundle.ingestState === undefined) {
        problems.push(`decisions[${index}].ingestState is required by schema version ${BACKUP_SCHEMA_VERSION}`);
      }
      if ((data.schemaVersion === LEGACY_BACKUP_SCHEMA_VERSION ||
          data.schemaVersion === RECEIPT_BACKUP_SCHEMA_VERSION) && bundle.ingestState !== undefined) {
        problems.push(`decisions[${index}].ingestState requires schema version ${BACKUP_SCHEMA_VERSION}`);
      }
      if (bundle.ingestState !== undefined && bundle.ingestState !== null) {
        const state = bundle.ingestState;
        const effectStates: DecisionEffectState[] = [
          'non_effect', 'ready', 'running', 'completed', 'failed', 'restored_non_replay',
        ];
        const executionStatuses = ['completed', 'failed', 'ambiguous', null];
        if (state.decisionId !== bundle.decision.id ||
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
                  .test(state.sourceExecutionPlanId))) ||
            (state.receiptCaptureComplete &&
              (typeof state.receiptExplanationId !== 'string' ||
                !explanationIds.has(state.receiptExplanationId))) ||
            (!state.receiptCaptureComplete && state.receiptExplanationId !== null)) {
          problems.push(`decisions[${index}].ingestState has inconsistent linkage or classification`);
        }
      }
    }
  }
  if (!Array.isArray(data.twinProfileVersions)) {
    problems.push('twinProfileVersions is not an array');
  }
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
      data.schemaVersion !== RECEIPT_BACKUP_SCHEMA_VERSION &&
      data.schemaVersion !== LEGACY_BACKUP_SCHEMA_VERSION) {
    return {
      success: false,
      reason: 'unsupported_schema',
      message: `backup schema version ${data.schemaVersion} is not supported by this build (expected ${LEGACY_BACKUP_SCHEMA_VERSION}, ${RECEIPT_BACKUP_SCHEMA_VERSION}, or ${BACKUP_SCHEMA_VERSION})`,
    };
  }

  const existing = await userRepository.findById(data.user.id);
  if (existing) {
    return {
      success: false,
      reason: 'user_exists',
      message: `user ${data.user.id} already exists; restore targets a fresh install — purge the user first`,
    };
  }

  const counts: Record<string, number> = {};
  const bump = (table: string, n = 1): void => {
    counts[table] = (counts[table] ?? 0) + n;
  };

  await withTransaction(async (client) => {
    const u = data.user;
    await client.query(
      `INSERT INTO users (id, email, name, trust_tier, autonomy_settings, ironclaw_channel, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        u.id,
        u.email,
        u.name,
        u.trust_tier,
        JSON.stringify(u.autonomy_settings ?? {}),
        u.ironclaw_channel ?? null,
        u.created_at,
        u.updated_at,
      ],
    );
    bump('users');

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
             id, decision_id, what_happened, evidence_used, preferences_invoked,
             confidence_reasoning, action_rationale, escalation_rationale,
             correction_guidance, capability_provenance_node_id, created_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            e.id,
            e.decision_id,
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

      for (const r of bundle.inferenceReceipts ?? []) {
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
             id, version, decision_id, explanation_id, status, receipt, trusted, created_at
           ) SELECT $1,$2,d.id,e.id,$5,$6,false,$7
             FROM decisions d JOIN explanation_records e ON e.decision_id = d.id
            WHERE d.id=$3 AND e.id=$4`,
          [r.id, r.version, r.decision_id, r.explanation_id, r.status,
            JSON.stringify(signed), r.created_at],
        );
        if (insertedReceipt.rowCount !== 1) {
          throw new Error(`receipt ${r.id} could not be linked during restore`);
        }
        bump('inference_receipts');
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
            // Execution plans are not portable; replay classification is
            // retained by the ingest guard below without a dangling FK.
            null,
            o.created_at,
          ],
        );
        bump('decision_outcomes');
      }

      const state = bundle.ingestState;
      if (data.schemaVersion === BACKUP_SCHEMA_VERSION &&
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
          data.schemaVersion === BACKUP_SCHEMA_VERSION ? state?.receiptExplanationId ?? null : null,
          data.schemaVersion === BACKUP_SCHEMA_VERSION ? state?.continuationKind ?? 'non_effect' : 'non_effect',
          data.schemaVersion === BACKUP_SCHEMA_VERSION && state?.continuationKind === 'approval'
            ? state.confirmationLevel ?? 'dual'
            : null,
          data.schemaVersion === BACKUP_SCHEMA_VERSION
            ? state?.sourceEffectState ?? state?.effectState ?? null
            : null,
          data.schemaVersion === BACKUP_SCHEMA_VERSION ? state?.sourceExecutionStatus ?? null : 'ambiguous',
          data.schemaVersion === BACKUP_SCHEMA_VERSION ? state?.sourceExecutionPlanId ?? null : null,
          state?.completedAt ?? d.created_at,
        ],
      );
      bump('decision_ingest_guards');
    }
  });

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { success: true, summary: { counts, total } };
}
