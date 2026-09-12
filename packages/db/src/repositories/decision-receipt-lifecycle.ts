import {
  buildDecisionReceiptEventKey,
  type JoinedDecisionReceiptContent,
  type JoinedDecisionReceiptContentV1,
} from '@skytwin/shared-types';
import type { PoolClient } from 'pg';
import type { DecisionRow } from '../types.js';
import { decisionReceiptRowArtifactRefV1 } from './decision-receipt-artifacts.js';
import { decisionReceiptRepository, type AppendDecisionReceiptResult } from './decision-receipt-repository.js';

export interface AppendDecisionReceiptLifecycleInput {
  /** Stable durable event UUID; never generate a fresh ID on retry. */
  eventId: string;
  /** Lower-case lifecycle namespace, for example decision_created. */
  eventKind: string;
  expectedPreviousDigest: string | null;
  content: JoinedDecisionReceiptContent;
  /** Optional caller-owned IDs keep a larger transaction stable across retries. */
  receiptId?: string;
  revisionId?: string;
  /** Optional caller-owned timestamp keeps a larger transaction stable across retries. */
  createdAt?: string;
}

/** Canonical first snapshot for a decision row persisted in the same unit of work. */
export function buildDecisionRecordedReceiptContentV1(decision: DecisionRow): JoinedDecisionReceiptContentV1 {
  return {
    version: 1,
    stage: 'decision_recorded',
    disposition: 'pending',
    decision: decisionReceiptRowArtifactRefV1('decision', { ...decision }),
    policyEvaluations: [],
    evidence: [],
    inference: { receipts: [] },
    feedbackEvents: [],
    corrections: [],
  };
}

export const decisionReceiptLifecycleRepository = {
  /**
   * Transaction-composable lifecycle append. Artifact ownership, retained
   * chain integrity, compare-and-swap, and replay identity remain enforced by
   * the receipt repository in the caller's transaction.
   */
  async appendForUser(
    client: PoolClient,
    userId: string,
    input: AppendDecisionReceiptLifecycleInput,
  ): Promise<AppendDecisionReceiptResult> {
    let eventKey;
    try {
      eventKey = buildDecisionReceiptEventKey(input.eventKind, input.eventId);
    } catch {
      return { success: false, code: 'invalid_content' };
    }
    return decisionReceiptRepository.appendForUserInTransaction(client, userId, {
      eventKey,
      expectedPreviousDigest: input.expectedPreviousDigest,
      content: input.content,
      receiptId: input.receiptId,
      revisionId: input.revisionId,
      createdAt: input.createdAt,
    });
  },
};
