/**
 * Awareness disposition for the memory action loop (#601 follow-up).
 *
 * The ingest route's awareness gate (apps/api) only covers signal ingestion.
 * The memory action loop is a SECOND write path that creates one approval per
 * memory-derived opportunity; at observer/suggest tier that floods the queue
 * with passive "note your interest in this topic" cards from newsletters. These
 * tests pin the worker-side gate: a passive, reversible, verified-free note that
 * the injection guard did NOT escalate is recorded as FYI WITHOUT an approval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicyDecision } from '@skytwin/policy-engine';
import type { ExecutionRouter } from '@skytwin/execution-router';
import type { ActionProvenance, MemoryActionOpportunitySnapshot } from '@skytwin/shared-types';

type RouterStub = Pick<ExecutionRouter, 'route' | 'executeWithRouting'>;

// ── Mocks ─────────────────────────────────────────────────────────────────

const {
  mockApprovalRepository,
  mockDecisionRepository,
  mockDecisionRepositoryAdapter,
  mockExplanationRepository,
  mockMemoryActionOpportunityRepository,
  mockUserRepository,
  noop,
} = vi.hoisted(() => {
  const noop = {
    register: vi.fn(),
    log: vi.fn(),
    getAsMap: vi.fn(async () => ({})),
    getEnabledPolicies: vi.fn(async () => []),
    createPlan: vi.fn(),
    createResult: vi.fn(),
  };
  return {
    mockApprovalRepository: { create: vi.fn(async () => ({ row: { id: 'approval-1' } })) },
    mockDecisionRepository: {
      create: vi.fn(async () => ({ row: { id: 'decision-1' } })),
      addCandidateAction: vi.fn(async () => undefined),
      recordOutcome: vi.fn(async () => undefined),
    },
    mockDecisionRepositoryAdapter: { saveRiskAssessment: vi.fn(async () => undefined) },
    mockExplanationRepository: { create: vi.fn(async () => undefined) },
    mockMemoryActionOpportunityRepository: {
      upsertFromSuggestion: vi.fn(async () => undefined),
      claimDueForUser: vi.fn(async (): Promise<MemoryActionOpportunitySnapshot[]> => []),
      listUsersWithDue: vi.fn(async (): Promise<string[]> => []),
      markStatus: vi.fn(async () => undefined),
    },
    mockUserRepository: {
      findById: vi.fn(async () => ({
        id: 'user-1',
        trust_tier: 'observer',
        autonomy_settings: {},
        ironclaw_channel: null,
      })),
    },
    noop,
  };
});

vi.mock('@skytwin/db', () => ({
  approvalRepository: mockApprovalRepository,
  credentialRequirementRepository: noop,
  decisionRepository: mockDecisionRepository,
  decisionRepositoryAdapter: mockDecisionRepositoryAdapter,
  executionRepository: noop,
  explanationRepository: mockExplanationRepository,
  memoryActionOpportunityRepository: mockMemoryActionOpportunityRepository,
  policyRepositoryAdapter: noop,
  serviceCredentialRepository: noop,
  skillGapRepository: noop,
  userRepository: mockUserRepository,
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  isAwarenessOnlyMemoryAction,
  runMemoryActionLoopJob,
} from '../jobs/memory-action-loop.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeOpportunity(
  actionType: string,
  provenance: ActionProvenance = 'untrusted_external',
): MemoryActionOpportunitySnapshot {
  return {
    id: 'opp-1',
    userId: 'user-1',
    fingerprint: 'memory-action-abc',
    suggestionId: 'sugg-1',
    title: 'Acme Weekly — issue 42',
    reason: 'A newsletter you read covered this topic.',
    suggestedAction: 'note your interest in this topic',
    actionType,
    actionLabel: actionType === 'create_note' ? 'note your interest in this topic' : 'draft a reply using this memory',
    actionPlan: {
      actionType,
      label: 'plan',
      primaryAdapter: 'openclaw',
      fallbackAdapters: ['direct'],
      readiness: 'known_action_type',
    } as MemoryActionOpportunitySnapshot['actionPlan'],
    sourceRefs: ['sig-1'],
    memoryRefs: ['mem-1'],
    sourceTypes: ['gmail'],
    novelty: 'resurface',
    confidence: 0.7,
    provenance,
    status: 'suggested',
    attemptCount: 1,
    lastSuggestedAt: new Date('2026-06-27T00:00:00Z'),
    lastAttemptedAt: null,
    lastReport: null,
    decisionId: null,
    approvalRequestId: null,
    executionPlanId: null,
    adapterName: null,
    policyReason: null,
    routeReason: null,
    nextStep: null,
  };
}

const trustTierApproval: PolicyDecision = {
  allowed: true,
  requiresApproval: true,
  reason: 'Approval required by policy "Trust Tier Gating".',
  // No confirmationLevel — a plain trust-tier approval, not an injection escalation.
};

const injectionEscalation: PolicyDecision = {
  allowed: true,
  requiresApproval: true,
  reason: 'Injection guard: external content, irreversible — explicit confirmation required.',
  confirmationLevel: 'single',
};

// The action type under test is set via the claimDueForUser mock (makeOpportunity);
// runWith only varies the policy decision.
function runWith(policyDecision: PolicyDecision) {
  return runMemoryActionLoopJob({
    userIds: ['user-1'],
    fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
    policyEvaluator: { evaluate: vi.fn(async () => policyDecision) },
    loadPolicies: async () => [],
    getExecutionRouter: async () => ({ route: vi.fn(), executeWithRouting: vi.fn() }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('isAwarenessOnlyMemoryAction', () => {
  const passiveNote = {
    actionType: 'create_note',
    reversible: true,
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero' as const,
    provenance: 'untrusted_external' as const,
  };

  it('is true for a passive, untrusted note with no injection escalation', () => {
    expect(isAwarenessOnlyMemoryAction(passiveNote, {})).toBe(true);
  });

  it('is false when the injection guard escalated (confirmationLevel set)', () => {
    expect(isAwarenessOnlyMemoryAction(passiveNote, { confirmationLevel: 'single' })).toBe(false);
    expect(isAwarenessOnlyMemoryAction(passiveNote, { confirmationLevel: 'dual' })).toBe(false);
  });

  it('is false for trusted / user-authored provenance (only untrusted awareness is disposed)', () => {
    expect(isAwarenessOnlyMemoryAction({ ...passiveNote, provenance: 'user_originated' }, {})).toBe(false);
    expect(isAwarenessOnlyMemoryAction({ ...passiveNote, provenance: 'trusted_context' }, {})).toBe(false);
  });

  it('is false for an outward / irreversible action', () => {
    expect(isAwarenessOnlyMemoryAction({ ...passiveNote, actionType: 'draft_email', reversible: false }, {})).toBe(false);
  });
});

describe('runMemoryActionLoopJob — awareness disposition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMemoryActionOpportunityRepository.claimDueForUser.mockResolvedValue([]);
    mockMemoryActionOpportunityRepository.listUsersWithDue.mockResolvedValue([]);
  });
  const prev = process.env['AWARENESS_DISPOSITION_GATE'];
  afterEach(() => {
    if (prev === undefined) delete process.env['AWARENESS_DISPOSITION_GATE'];
    else process.env['AWARENESS_DISPOSITION_GATE'] = prev;
  });

  it('gate ON: a passive newsletter note is recorded as FYI, no approval row', async () => {
    process.env['AWARENESS_DISPOSITION_GATE'] = 'on';
    mockMemoryActionOpportunityRepository.claimDueForUser.mockResolvedValue([makeOpportunity('create_note')]);

    const summary = await runWith(trustTierApproval);

    expect(mockApprovalRepository.create).not.toHaveBeenCalled();
    expect(summary.approvalsQueued).toBe(0);
    expect(summary.notedAwareness).toBe(1);
    // Outcome recorded as NOT requiring approval → the digest buckets it as FYI.
    expect(mockDecisionRepository.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ requiresApproval: false, autoExecuted: false }),
    );
    expect(mockMemoryActionOpportunityRepository.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'noted_awareness' }),
    );
  });

  it('gate OFF: the same note still queues an approval', async () => {
    delete process.env['AWARENESS_DISPOSITION_GATE'];
    mockMemoryActionOpportunityRepository.claimDueForUser.mockResolvedValue([makeOpportunity('create_note')]);

    const summary = await runWith(trustTierApproval);

    expect(mockApprovalRepository.create).toHaveBeenCalledTimes(1);
    expect(summary.approvalsQueued).toBe(1);
    expect(summary.notedAwareness).toBe(0);
  });

  it('gate ON: an injection-escalated draft still queues an approval (never disposed)', async () => {
    process.env['AWARENESS_DISPOSITION_GATE'] = 'on';
    mockMemoryActionOpportunityRepository.claimDueForUser.mockResolvedValue([makeOpportunity('draft_email')]);

    const summary = await runWith(injectionEscalation);

    expect(mockApprovalRepository.create).toHaveBeenCalledTimes(1);
    expect(summary.approvalsQueued).toBe(1);
    expect(summary.notedAwareness).toBe(0);
  });

  it('gate ON: a user-authored (trusted) note still queues an approval (not disposed)', async () => {
    process.env['AWARENESS_DISPOSITION_GATE'] = 'on';
    mockMemoryActionOpportunityRepository.claimDueForUser.mockResolvedValue([
      makeOpportunity('create_note', 'user_originated'),
    ]);

    const summary = await runWith(trustTierApproval);

    expect(mockApprovalRepository.create).toHaveBeenCalledTimes(1);
    expect(summary.approvalsQueued).toBe(1);
    expect(summary.notedAwareness).toBe(0);
  });

  it('gate ON: label_email is NOT disposed — its zero cost is unverified (costZeroIntent unknown)', async () => {
    // buildCandidateForOpportunity stamps label_email costZeroIntent='unknown'
    // (not in VERIFIED_ZERO_MEMORY_ACTION_TYPES), so the shape predicate rejects
    // it and it stays an approval even though label_email is in the passive set.
    process.env['AWARENESS_DISPOSITION_GATE'] = 'on';
    mockMemoryActionOpportunityRepository.claimDueForUser.mockResolvedValue([makeOpportunity('label_email')]);

    const summary = await runWith(trustTierApproval);

    expect(mockApprovalRepository.create).toHaveBeenCalledTimes(1);
    expect(summary.approvalsQueued).toBe(1);
    expect(summary.notedAwareness).toBe(0);
  });

  it('gate ON + higher tier (policy auto-executes): the note runs, it is NOT disposed as FYI', async () => {
    // The gate only intercepts the approval path (requiresApproval). When policy
    // allows auto-execution, the note must execute, not get FYI-bucketed. Guards
    // the `policyDecision.requiresApproval &&` conjunct in the gate condition.
    process.env['AWARENESS_DISPOSITION_GATE'] = 'on';
    noop.createPlan.mockResolvedValue({ id: 'plan-1' });
    noop.createResult.mockResolvedValue({});
    mockMemoryActionOpportunityRepository.claimDueForUser.mockResolvedValue([makeOpportunity('create_note')]);

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator: { evaluate: vi.fn(async () => ({ allowed: true, requiresApproval: false, reason: 'tier allows auto' })) },
      loadPolicies: async () => [],
      getExecutionRouter: async () => ({
        route: vi.fn(async () => ({ selectedAdapter: 'direct', reasoning: 'direct ok' })),
        executeWithRouting: vi.fn(async () => ({ status: 'completed', output: {}, planId: 'p1' })),
      }) as unknown as RouterStub,
    });

    expect(summary.notedAwareness).toBe(0);
    expect(summary.autoExecuted).toBe(1);
    expect(mockApprovalRepository.create).not.toHaveBeenCalled();
    expect(mockMemoryActionOpportunityRepository.markStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'noted_awareness' }),
    );
  });
});
