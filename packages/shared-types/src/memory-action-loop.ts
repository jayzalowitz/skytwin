import type { ActionProvenance } from './action-safety.js';
import type { ExecutableActionPlan } from './action-capabilities.js';
import type { DailyMemorySuggestion } from './daily-memory-suggestions.js';

export type MemoryActionOpportunityStatus =
  | 'suggested'
  | 'queued_approval'
  | 'auto_executed'
  | 'blocked_by_policy'
  | 'learning_needed'
  | 'execution_failed'
  | 'skipped';

export interface MemoryActionLoopReport {
  opportunityId: string;
  status: MemoryActionOpportunityStatus;
  title: string;
  actionType: string;
  actionLabel: string;
  adapterName?: string;
  decisionId?: string;
  approvalRequestId?: string;
  executionPlanId?: string;
  policyReason?: string;
  routeReason?: string;
  summary: string;
  nextStep: string;
  attemptedAt: string;
}

export interface MemoryActionOpportunitySnapshot {
  id: string;
  userId: string;
  fingerprint: string;
  suggestionId: string;
  title: string;
  reason: string;
  suggestedAction: string;
  actionType: string;
  actionLabel: string;
  actionPlan: ExecutableActionPlan;
  sourceRefs: string[];
  memoryRefs: string[];
  sourceTypes: string[];
  novelty: DailyMemorySuggestion['novelty'];
  confidence: number;
  provenance: ActionProvenance;
  status: MemoryActionOpportunityStatus;
  attemptCount: number;
  lastSuggestedAt: Date;
  lastAttemptedAt: Date | null;
  lastReport: MemoryActionLoopReport | null;
  decisionId: string | null;
  approvalRequestId: string | null;
  executionPlanId: string | null;
  adapterName: string | null;
  policyReason: string | null;
  routeReason: string | null;
  nextStep: string | null;
}

export function buildMemoryActionFingerprint(
  suggestion: Pick<DailyMemorySuggestion, 'actionPlan' | 'memoryRefs' | 'sourceRefs' | 'novelty'>,
): string {
  const refs = suggestion.memoryRefs.length > 0
    ? [...suggestion.memoryRefs].sort()
    : [...suggestion.sourceRefs].sort();
  const raw = [
    suggestion.actionPlan.actionType,
    suggestion.novelty,
    refs.join('|'),
  ].join('::');
  return `memory-action-${fnv1a32(raw)}`;
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
