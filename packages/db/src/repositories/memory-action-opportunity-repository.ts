import type {
  ActionProvenance,
  DailyMemorySuggestion,
  MemoryActionLoopReport,
  MemoryActionOpportunitySnapshot,
  MemoryActionOpportunityStatus,
} from '@skytwin/shared-types';
import { query } from '../connection.js';
import type { MemoryActionOpportunityRow } from '../types.js';

export interface UpsertMemoryActionOpportunityInput {
  userId: string;
  fingerprint: string;
  suggestion: DailyMemorySuggestion;
  provenance: ActionProvenance;
}

export interface ClaimDueOptions {
  limit?: number;
  retryAfterHours?: number;
}

export interface MarkMemoryActionOpportunityInput {
  id: string;
  status: MemoryActionOpportunityStatus;
  report: MemoryActionLoopReport;
  decisionId?: string;
  approvalRequestId?: string;
  executionPlanId?: string;
  adapterName?: string;
  policyReason?: string;
  routeReason?: string;
  nextStep?: string;
}

const RETRYABLE_STATUSES: MemoryActionOpportunityStatus[] = [
  'suggested',
  'blocked_by_policy',
  'learning_needed',
  'execution_failed',
];

export const memoryActionOpportunityRepository = {
  async upsertFromSuggestion(
    input: UpsertMemoryActionOpportunityInput,
  ): Promise<MemoryActionOpportunitySnapshot> {
    const s = input.suggestion;
    const plan = s.actionPlan;
    const result = await query<MemoryActionOpportunityRow>(
      `INSERT INTO memory_action_opportunities
         (user_id, fingerprint, suggestion_id, title, reason, suggested_action,
          action_type, action_label, action_plan, source_refs, memory_refs,
          source_types, novelty, confidence, provenance, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'suggested')
       ON CONFLICT (user_id, fingerprint)
       DO UPDATE SET
         suggestion_id      = EXCLUDED.suggestion_id,
         title              = EXCLUDED.title,
         reason             = EXCLUDED.reason,
         suggested_action   = EXCLUDED.suggested_action,
         action_type        = EXCLUDED.action_type,
         action_label       = EXCLUDED.action_label,
         action_plan        = EXCLUDED.action_plan,
         source_refs        = EXCLUDED.source_refs,
         memory_refs        = EXCLUDED.memory_refs,
         source_types       = EXCLUDED.source_types,
         novelty            = EXCLUDED.novelty,
         confidence         = GREATEST(memory_action_opportunities.confidence, EXCLUDED.confidence),
         provenance         = EXCLUDED.provenance,
         last_suggested_at  = now(),
         updated_at         = now()
       RETURNING *`,
      [
        input.userId,
        input.fingerprint,
        s.id,
        s.title,
        s.reason,
        s.suggestedAction,
        plan.actionType,
        plan.label,
        JSON.stringify(plan),
        s.sourceRefs,
        s.memoryRefs,
        s.sourceTypes,
        s.novelty,
        s.confidence,
        input.provenance,
      ],
    );
    return toSnapshot(result.rows[0]!);
  },

  async claimDueForUser(
    userId: string,
    opts: ClaimDueOptions = {},
  ): Promise<MemoryActionOpportunitySnapshot[]> {
    const limit = Math.min(Math.max(1, opts.limit ?? 5), 25);
    const retryAfterHours = Math.max(1, opts.retryAfterHours ?? 24);
    const result = await query<MemoryActionOpportunityRow>(
      `UPDATE memory_action_opportunities
          SET attempt_count = attempt_count + 1,
              last_attempted_at = now(),
              updated_at = now()
        WHERE id IN (
          SELECT id
            FROM memory_action_opportunities
           WHERE user_id = $1
             AND status = ANY($2)
             AND (
               last_attempted_at IS NULL OR
               last_attempted_at <= now() - ($3::INT * INTERVAL '1 hour')
             )
           ORDER BY
             CASE novelty WHEN 'connection' THEN 0 ELSE 1 END,
             confidence DESC,
             last_suggested_at DESC
           LIMIT $4
          )
        RETURNING *`,
      [userId, RETRYABLE_STATUSES, retryAfterHours, limit],
    );
    return result.rows.map(toSnapshot);
  },

  async listUsersWithDue(
    opts: ClaimDueOptions = {},
  ): Promise<string[]> {
    const limit = Math.min(Math.max(1, opts.limit ?? 500), 5000);
    const retryAfterHours = Math.max(1, opts.retryAfterHours ?? 24);
    const result = await query<{ user_id: string }>(
      `SELECT DISTINCT user_id
         FROM memory_action_opportunities
        WHERE status = ANY($1)
          AND (
            last_attempted_at IS NULL OR
            last_attempted_at <= now() - ($2::INT * INTERVAL '1 hour')
          )
        ORDER BY user_id
        LIMIT $3`,
      [RETRYABLE_STATUSES, retryAfterHours, limit],
    );
    return result.rows.map((row) => row.user_id);
  },

  async markStatus(
    input: MarkMemoryActionOpportunityInput,
  ): Promise<MemoryActionOpportunitySnapshot | null> {
    const result = await query<MemoryActionOpportunityRow>(
      `UPDATE memory_action_opportunities
          SET status = $2,
              last_report = $3,
              decision_id = COALESCE($4, decision_id),
              approval_request_id = COALESCE($5, approval_request_id),
              execution_plan_id = COALESCE($6, execution_plan_id),
              adapter_name = COALESCE($7, adapter_name),
              policy_reason = COALESCE($8, policy_reason),
              route_reason = COALESCE($9, route_reason),
              next_step = COALESCE($10, next_step),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        input.id,
        input.status,
        JSON.stringify(input.report),
        input.decisionId ?? null,
        input.approvalRequestId ?? null,
        input.executionPlanId ?? null,
        input.adapterName ?? null,
        input.policyReason ?? null,
        input.routeReason ?? null,
        input.nextStep ?? null,
      ],
    );
    return result.rows[0] ? toSnapshot(result.rows[0]) : null;
  },

  async listRecentReportsForUser(
    userId: string,
    since: Date,
    limit: number = 10,
  ): Promise<MemoryActionLoopReport[]> {
    const capped = Math.min(Math.max(1, limit), 50);
    const result = await query<MemoryActionOpportunityRow>(
      `SELECT *
         FROM memory_action_opportunities
        WHERE user_id = $1
          AND last_report IS NOT NULL
          AND (
            last_attempted_at >= $2 OR
            last_suggested_at >= $2
          )
        ORDER BY last_attempted_at DESC NULLS LAST, last_suggested_at DESC
        LIMIT $3`,
      [userId, since, capped],
    );
    return result.rows.map((row) => {
      const stored = row.last_report;
      if (stored && typeof stored === 'object') {
        return stored as unknown as MemoryActionLoopReport;
      }
      return reportFromRow(row);
    });
  },
};

function toSnapshot(row: MemoryActionOpportunityRow): MemoryActionOpportunitySnapshot {
  return {
    id: row.id,
    userId: row.user_id,
    fingerprint: row.fingerprint,
    suggestionId: row.suggestion_id,
    title: row.title,
    reason: row.reason,
    suggestedAction: row.suggested_action,
    actionType: row.action_type,
    actionLabel: row.action_label,
    actionPlan: row.action_plan as unknown as MemoryActionOpportunitySnapshot['actionPlan'],
    sourceRefs: row.source_refs ?? [],
    memoryRefs: row.memory_refs ?? [],
    sourceTypes: row.source_types ?? [],
    novelty: row.novelty === 'connection' ? 'connection' : 'resurface',
    confidence: Number(row.confidence ?? 0),
    provenance: parseProvenance(row.provenance),
    status: parseStatus(row.status),
    attemptCount: row.attempt_count,
    lastSuggestedAt: row.last_suggested_at,
    lastAttemptedAt: row.last_attempted_at,
    lastReport: row.last_report as unknown as MemoryActionLoopReport | null,
    decisionId: row.decision_id,
    approvalRequestId: row.approval_request_id,
    executionPlanId: row.execution_plan_id,
    adapterName: row.adapter_name,
    policyReason: row.policy_reason,
    routeReason: row.route_reason,
    nextStep: row.next_step,
  };
}

function reportFromRow(row: MemoryActionOpportunityRow): MemoryActionLoopReport {
  return {
    opportunityId: row.id,
    status: parseStatus(row.status),
    title: row.title,
    actionType: row.action_type,
    actionLabel: row.action_label,
    adapterName: row.adapter_name ?? undefined,
    decisionId: row.decision_id ?? undefined,
    approvalRequestId: row.approval_request_id ?? undefined,
    executionPlanId: row.execution_plan_id ?? undefined,
    policyReason: row.policy_reason ?? undefined,
    routeReason: row.route_reason ?? undefined,
    summary: row.reason,
    nextStep: row.next_step ?? 'Review the opportunity.',
    attemptedAt: (row.last_attempted_at ?? row.last_suggested_at).toISOString(),
  };
}

function parseStatus(value: string): MemoryActionOpportunityStatus {
  return RETRYABLE_STATUSES.includes(value as MemoryActionOpportunityStatus) ||
    value === 'queued_approval' ||
    value === 'auto_executed' ||
    value === 'skipped'
    ? value as MemoryActionOpportunityStatus
    : 'suggested';
}

function parseProvenance(value: string): ActionProvenance {
  if (value === 'user_originated' || value === 'trusted_context' || value === 'untrusted_external') {
    return value;
  }
  return 'untrusted_external';
}
