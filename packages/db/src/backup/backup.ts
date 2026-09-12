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
import {
  joinedDecisionReceiptArtifactDigest,
  joinedDecisionReceiptContentDigest,
  joinedDecisionReceiptRevisionDigest,
  isDecisionReceiptEventKey,
  preservesJoinedDecisionReceiptLinks,
  normalizeDecisionReceiptSequence,
  verifyJoinedDecisionReceiptChain,
  type InferenceReceiptV1,
} from '@skytwin/shared-types';
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
import type { PoolClient } from 'pg';
import { decisionReceiptRowArtifactV1 } from '../repositories/decision-receipt-artifacts.js';

/** Bumped when the JSON shape changes in a non-back-compatible way. */
export const BACKUP_SCHEMA_VERSION = 1;

/** A single decision with everything that hangs off it. */
export interface DecisionBundle {
  decision: DecisionRow;
  candidateActions: CandidateActionRow[];
  outcome: DecisionOutcomeRow | null;
  explanations: ExplanationRecordRow[];
  /** Sanitized plan metadata needed by decision_outcomes.execution_plan_id. */
  executionPlans?: ExecutionPlanRow[];
  /** Optional so schema-v1 backups produced before receipts remain restorable. */
  inferenceReceipts?: InferenceReceiptRow[];
  /** Optional so backups created before migration 081 remain restorable. */
  joinedReceipt?: {
    root: DecisionReceiptRow;
    revisions: DecisionReceiptRevisionRow[];
  };
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
  /**
   * Connector identities, OAuth credentials, cursors, raw signals, and Gmail
   * message references are intentionally excluded. They are installation-local
   * operational evidence and provider targets are invalid without a live,
   * freshly-authorized account binding on the restore destination.
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

    const data: BackupData = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      user,
      twinProfile,
      twinProfileVersions,
      preferences,
      decisions,
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
  const executionPlans = await client.query<ExecutionPlanRow>(
    `SELECT id, decision_id, action_id, status, '[]'::JSONB AS steps, created_at, updated_at
       FROM execution_plans WHERE decision_id = ANY($1) ORDER BY created_at ASC`,
    [decisionIds],
  );
  const receipts = await client.query<InferenceReceiptRow>(
    'SELECT * FROM inference_receipts WHERE decision_id = ANY($1) ORDER BY created_at ASC',
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

  return allDecisions.map((decision) => {
    const joinedRoot = joinedRootByDecision.get(decision.id);
    return {
      decision,
      candidateActions: actionsByDecision.get(decision.id) ?? [],
      outcome: outcomeByDecision.get(decision.id) ?? null,
      explanations: explanationsByDecision.get(decision.id) ?? [],
      executionPlans: plansByDecision.get(decision.id) ?? [],
      inferenceReceipts: receiptsByDecision.get(decision.id) ?? [],
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
      if (bundle.decision.user_id !== data.user?.id) {
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
          (bundle.outcome?.execution_plan_id && !planIds.has(bundle.outcome.execution_plan_id))) {
        problems.push(`decisions[${index}] has inconsistent execution linkage`);
      }
      if (bundle.outcome !== null && (!bundle.outcome || typeof bundle.outcome !== 'object' ||
          !uuid.test(bundle.outcome.id) || bundle.outcome.decision_id !== bundle.decision.id ||
          (bundle.outcome.selected_action_id !== null &&
            !candidateIds.has(bundle.outcome.selected_action_id)) ||
          (bundle.outcome.execution_plan_id !== null &&
            !planIds.has(bundle.outcome.execution_plan_id)))) {
        problems.push(`decisions[${index}] has inconsistent outcome linkage`);
      }
      if (bundle.inferenceReceipts !== undefined && !Array.isArray(bundle.inferenceReceipts)) {
        problems.push(`decisions[${index}].inferenceReceipts is not an array`);
      }
      const explanations = Array.isArray(bundle.explanations) ? bundle.explanations : [];
      const receipts = Array.isArray(bundle.inferenceReceipts) ? bundle.inferenceReceipts : [];
      const explanationIds = new Set(explanations.map((e) => e.id));
      for (const [explanationIndex, explanation] of explanations.entries()) {
        if (explanation.decision_id !== bundle.decision.id) {
          problems.push(`decisions[${index}].explanations[${explanationIndex}] has inconsistent linkage`);
        }
      }
      for (const [receiptIndex, receipt] of receipts.entries()) {
        const signed = receipt?.receipt as Partial<InferenceReceiptV1> | undefined;
        if (!receipt || receipt.decision_id !== bundle.decision.id ||
            !explanationIds.has(receipt.explanation_id) || !signed ||
            signed.id !== receipt.id || signed.decisionId !== receipt.decision_id ||
            signed.explanationId !== receipt.explanation_id || signed.userId !== data.user?.id ||
            signed.status !== receipt.status) {
          problems.push(`decisions[${index}].inferenceReceipts[${receiptIndex}] has inconsistent linkage`);
        }
      }
      if (bundle.joinedReceipt !== undefined) {
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
        for (const [revisionIndex, revision] of revisions.entries()) {
          if (!revision || typeof revision !== 'object' ||
              !uuid.test(revision.id) || !uuid.test(revision.receipt_id) ||
              !revision.content || typeof revision.content !== 'object') {
            problems.push(`decisions[${index}].joinedReceipt.revisions[${revisionIndex}] is malformed`);
            continue;
          }
          let computed = '';
          let computedRevision = '';
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
          } catch {
            problems.push(`decisions[${index}].joinedReceipt.revisions[${revisionIndex}] has invalid content`);
          }
          const correctionId = revision.content?.correctionOfRevision?.id;
          if (revision.receipt_id !== root.id || sequence !== revisionIndex + 1 ||
              revision.previous_digest !== priorDigest || revision.content_digest !== computed ||
              revision.revision_digest !== computedRevision ||
              revision.content?.decision?.id !== bundle.decision.id ||
              revision.content?.decision?.canonicalHash !== decisionHash ||
              (revisionIndex === 0 && revision.content.stage !== 'decision_recorded') ||
              (priorContent !== null && !preservesJoinedDecisionReceiptLinks(priorContent, revision.content)) ||
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
        }
        const tail = revisions[revisions.length - 1]?.content;
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
        if (tail?.version === 2) {
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

  if (data.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    return {
      success: false,
      reason: 'unsupported_schema',
      message: `backup schema version ${data.schemaVersion} is not supported by this build (expected ${BACKUP_SCHEMA_VERSION})`,
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
        const insertedReceipt = await client.query(
          `INSERT INTO inference_receipts (
             id, version, decision_id, explanation_id, status, receipt, trusted, created_at
           ) SELECT $1,$2,d.id,e.id,$5,$6,false,$7
             FROM decisions d JOIN explanation_records e ON e.decision_id = d.id
            WHERE d.id=$3 AND e.id=$4`,
          [r.id, r.version, r.decision_id, r.explanation_id, r.status,
            JSON.stringify(r.receipt), r.created_at],
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
            o.execution_plan_id ?? null,
            o.created_at,
          ],
        );
        bump('decision_outcomes');
      }

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
