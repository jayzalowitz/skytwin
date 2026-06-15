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
import { twinRepository } from '../repositories/twin-repository.js';
import { userRepository } from '../repositories/user-repository.js';
import type {
  CandidateActionRow,
  DecisionOutcomeRow,
  DecisionRow,
  ExplanationRecordRow,
  PreferenceRow,
  TwinProfileRow,
  TwinProfileVersionRow,
  UserRow,
} from '../types.js';

/** Bumped when the JSON shape changes in a non-back-compatible way. */
export const BACKUP_SCHEMA_VERSION = 1;

/** A single decision with everything that hangs off it. */
export interface DecisionBundle {
  decision: DecisionRow;
  candidateActions: CandidateActionRow[];
  outcome: DecisionOutcomeRow | null;
  explanations: ExplanationRecordRow[];
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

  const actionsByDecision = groupBy<CandidateActionRow, string>(
    actions.rows,
    (r) => r.decision_id,
  );
  const explanationsByDecision = groupBy<ExplanationRecordRow, string>(
    explanations.rows,
    (r) => r.decision_id,
  );
  const outcomeByDecision = new Map<string, DecisionOutcomeRow>();
  for (const o of outcomes.rows) outcomeByDecision.set(o.decision_id, o);

  return allDecisions.map((decision) => ({
    decision,
    candidateActions: actionsByDecision.get(decision.id) ?? [],
    outcome: outcomeByDecision.get(decision.id) ?? null,
    explanations: explanationsByDecision.get(decision.id) ?? [],
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
    }
  });

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { success: true, summary: { counts, total } };
}
