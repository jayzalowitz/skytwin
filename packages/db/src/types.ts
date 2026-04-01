/**
 * Database-level type definitions for SkyTwin.
 * These represent the raw row shapes as returned from CockroachDB.
 */

// ============================================================================
// Users
// ============================================================================

export interface UserRow {
  id: string;
  email: string;
  name: string;
  trust_tier: string;
  autonomy_settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ConnectedAccountRow {
  id: string;
  user_id: string;
  provider: string;
  account_id: string;
  scopes: string[];
  is_active: boolean;
  connected_at: Date;
}

// ============================================================================
// Twin Profiles
// ============================================================================

export interface TwinProfileRow {
  id: string;
  user_id: string;
  version: number;
  preferences: unknown[];
  inferences: unknown[];
  risk_tolerance: Record<string, unknown>;
  spend_norms: Record<string, unknown>;
  communication_style: Record<string, unknown>;
  routines: unknown[];
  domain_heuristics: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface TwinProfileVersionRow {
  id: string;
  profile_id: string;
  version: number;
  snapshot: Record<string, unknown>;
  changed_fields: string[];
  reason: string | null;
  created_at: Date;
}

// ============================================================================
// Preferences
// ============================================================================

export interface PreferenceRow {
  id: string;
  user_id: string;
  domain: string;
  key: string;
  value: unknown;
  confidence: string;
  source: string;
  evidence: unknown[];
  version: number;
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// Decisions
// ============================================================================

export interface DecisionRow {
  id: string;
  user_id: string;
  situation_type: string;
  raw_event: Record<string, unknown>;
  interpreted_situation: Record<string, unknown>;
  domain: string;
  urgency: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface CandidateActionRow {
  id: string;
  decision_id: string;
  action_type: string;
  description: string;
  parameters: Record<string, unknown>;
  predicted_user_preference: string;
  risk_assessment: Record<string, unknown>;
  reversible: boolean;
  estimated_cost: number | null;
  created_at: Date;
}

export interface DecisionOutcomeRow {
  id: string;
  decision_id: string;
  selected_action_id: string | null;
  auto_executed: boolean;
  requires_approval: boolean;
  escalation_reason: string | null;
  explanation: string;
  confidence: number;
  created_at: Date;
}

// ============================================================================
// Policies
// ============================================================================

export interface ActionPolicyRow {
  id: string;
  user_id: string;
  name: string;
  domain: string;
  rules: unknown[];
  priority: number;
  is_active: boolean;
  created_at: Date;
}

// ============================================================================
// Approval Requests
// ============================================================================

export interface ApprovalRequestRow {
  id: string;
  user_id: string;
  decision_id: string;
  candidate_action: Record<string, unknown>;
  reason: string;
  urgency: string;
  status: string;
  requested_at: Date;
  responded_at: Date | null;
  response: Record<string, unknown> | null;
  expires_at: Date;
  batch_id: string | null;
}

// ============================================================================
// Execution
// ============================================================================

export interface ExecutionPlanRow {
  id: string;
  decision_id: string;
  action_id: string;
  status: string;
  steps: unknown[];
  created_at: Date;
}

export interface ExecutionResultRow {
  id: string;
  plan_id: string;
  success: boolean;
  outputs: Record<string, unknown>;
  error: string | null;
  rollback_available: boolean;
  completed_at: Date;
}

// ============================================================================
// Explanation / Audit
// ============================================================================

export interface ExplanationRecordRow {
  id: string;
  decision_id: string;
  what_happened: string;
  evidence_used: unknown[];
  preferences_invoked: string[];
  confidence_reasoning: string;
  action_rationale: string;
  escalation_rationale: string | null;
  correction_guidance: string;
  created_at: Date;
}

// ============================================================================
// Feedback
// ============================================================================

export interface FeedbackEventRow {
  id: string;
  user_id: string;
  decision_id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: Date;
}

// ============================================================================
// OAuth Tokens
// ============================================================================

export interface OAuthTokenRow {
  id: string;
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string;
  expires_at: Date;
  scopes: string[];
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// Signals (cross-domain correlation)
// ============================================================================

export interface SignalRow {
  id: string;
  user_id: string;
  source: string;
  type: string;
  domain: string;
  data: Record<string, unknown>;
  timestamp: Date;
  retention_until: Date;
  created_at: Date;
}

// ============================================================================
// Preference Proposals (archaeology)
// ============================================================================

export interface PreferenceProposalRow {
  id: string;
  user_id: string;
  domain: string;
  key: string;
  value: unknown;
  confidence: string;
  supporting_evidence: unknown[];
  status: string;
  detected_at: Date;
  responded_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

// ============================================================================
// Twin Exports
// ============================================================================

export interface TwinExportRow {
  id: string;
  user_id: string;
  format: string;
  exported_at: Date;
}

// ============================================================================
// Skill Gap Log
// ============================================================================

export interface SkillGapRow {
  id: string;
  action_type: string;
  action_description: string;
  attempted_adapters: unknown[];
  user_id: string;
  decision_id: string | null;
  ironclaw_issue_url: string | null;
  logged_at: Date;
}

// ============================================================================
// Proactive Scans
// ============================================================================

export interface ProactiveScanRow {
  id: string;
  user_id: string;
  scan_type: string;
  items_found: number;
  items_auto_executed: number;
  items_queued_approval: number;
  started_at: Date;
  completed_at: Date | null;
}

// ============================================================================
// Briefings
// ============================================================================

export interface BriefingRow {
  id: string;
  user_id: string;
  scan_id: string | null;
  items: unknown[];
  email_sent: boolean;
  created_at: Date;
}

// ============================================================================
// Spend Records
// ============================================================================

export interface SpendRecordRow {
  id: string;
  user_id: string;
  action_id: string;
  decision_id: string;
  estimated_cost_cents: number;
  actual_cost_cents: number | null;
  recorded_at: Date;
  reconciled_at: Date | null;
}

// ============================================================================
// Trust Tier Audit
// ============================================================================

export interface TrustTierAuditRow {
  id: string;
  user_id: string;
  old_tier: string;
  new_tier: string;
  direction: string;
  trigger_reason: string;
  evidence: Record<string, unknown>;
  created_at: Date;
}

// ============================================================================
// Common query options
// ============================================================================

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface DateRangeOptions {
  from?: Date;
  to?: Date;
}

export interface UserQueryOptions extends PaginationOptions, DateRangeOptions {
  domain?: string;
}

/**
 * Represents the full decision context including related records.
 */
export interface DecisionWithContext {
  decision: DecisionRow;
  candidateActions: CandidateActionRow[];
  outcome: DecisionOutcomeRow | null;
  explanation: ExplanationRecordRow | null;
  feedback: FeedbackEventRow[];
}
