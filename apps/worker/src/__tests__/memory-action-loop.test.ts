import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildExecutableActionPlan } from '@skytwin/shared-types';
import type {
  DailyMemorySuggestion,
  MemoryActionOpportunitySnapshot,
} from '@skytwin/shared-types';

const {
  mockMemoryActionOpportunityRepository,
  mockUserRepository,
  mockDecisionRepository,
  mockDecisionRepositoryAdapter,
  mockApprovalRepository,
  mockExplanationRepository,
  mockExecutionRepository,
  mockPolicyRepositoryAdapter,
  mockServiceCredentialRepository,
  mockCredentialRequirementRepository,
  mockSkillGapRepository,
} = vi.hoisted(() => ({
  mockMemoryActionOpportunityRepository: {
    upsertFromSuggestion: vi.fn(),
    claimDueForUser: vi.fn(),
    markStatus: vi.fn(),
  },
  mockUserRepository: {
    findById: vi.fn(),
  },
  mockDecisionRepository: {
    create: vi.fn(),
    addCandidateAction: vi.fn(),
    recordOutcome: vi.fn(),
  },
  mockDecisionRepositoryAdapter: {
    saveRiskAssessment: vi.fn(),
  },
  mockApprovalRepository: {
    create: vi.fn(),
  },
  mockExplanationRepository: {
    create: vi.fn(),
  },
  mockExecutionRepository: {
    createPlan: vi.fn(),
    createResult: vi.fn(),
  },
  mockPolicyRepositoryAdapter: {
    getEnabledPolicies: vi.fn(),
  },
  mockServiceCredentialRepository: {
    getAsMap: vi.fn(),
  },
  mockCredentialRequirementRepository: {
    register: vi.fn(),
  },
  mockSkillGapRepository: {
    log: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  memoryActionOpportunityRepository: mockMemoryActionOpportunityRepository,
  userRepository: mockUserRepository,
  decisionRepository: mockDecisionRepository,
  decisionRepositoryAdapter: mockDecisionRepositoryAdapter,
  approvalRepository: mockApprovalRepository,
  explanationRepository: mockExplanationRepository,
  executionRepository: mockExecutionRepository,
  policyRepositoryAdapter: mockPolicyRepositoryAdapter,
  serviceCredentialRepository: mockServiceCredentialRepository,
  credentialRequirementRepository: mockCredentialRequirementRepository,
  skillGapRepository: mockSkillGapRepository,
}));

const { runMemoryActionLoopJob } = await import('../jobs/memory-action-loop.js');

function makeSuggestion(actionType = 'create_task'): DailyMemorySuggestion {
  return {
    id: 'memory-resurface-page-1',
    title: 'Madrid launch checklist',
    reason: 'New memory worth carrying forward.',
    suggestedAction: 'Try creating a task.',
    sourceRefs: ['sig-1'],
    memoryRefs: ['page-1'],
    sourceTypes: ['voice'],
    novelty: 'resurface',
    confidence: 0.72,
    actionPlan: buildExecutableActionPlan(actionType, 'create a follow-up task'),
  };
}

function makeOpportunity(actionType = 'create_task'): MemoryActionOpportunitySnapshot {
  const suggestion = makeSuggestion(actionType);
  return {
    id: '11111111-1111-1111-1111-111111111111',
    userId: 'user-1',
    fingerprint: 'memory-action-1',
    suggestionId: suggestion.id,
    title: suggestion.title,
    reason: suggestion.reason,
    suggestedAction: suggestion.suggestedAction,
    actionType,
    actionLabel: suggestion.actionPlan.label,
    actionPlan: suggestion.actionPlan,
    sourceRefs: suggestion.sourceRefs,
    memoryRefs: suggestion.memoryRefs,
    sourceTypes: suggestion.sourceTypes,
    novelty: suggestion.novelty,
    confidence: suggestion.confidence,
    provenance: 'user_originated',
    status: 'suggested',
    attemptCount: 0,
    lastSuggestedAt: new Date('2026-06-25T12:00:00Z'),
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

function mockCommon(opportunity = makeOpportunity()) {
  mockMemoryActionOpportunityRepository.upsertFromSuggestion.mockResolvedValue(opportunity);
  mockMemoryActionOpportunityRepository.claimDueForUser.mockResolvedValue([{
    ...opportunity,
    attemptCount: opportunity.attemptCount + 1,
    lastAttemptedAt: new Date('2026-06-25T12:05:00Z'),
  }]);
  mockMemoryActionOpportunityRepository.markStatus.mockImplementation(async (input) => ({
    ...opportunity,
    status: input.status,
    lastReport: input.report,
  }));
  mockUserRepository.findById.mockResolvedValue({
    id: 'user-1',
    trust_tier: 'suggest',
    autonomy_settings: {},
    ironclaw_channel: 'skytwin',
  });
  mockDecisionRepository.create.mockResolvedValue({
    row: {
      id: '22222222-2222-2222-2222-222222222222',
    },
    created: true,
  });
  mockDecisionRepository.addCandidateAction.mockResolvedValue({});
  mockDecisionRepository.recordOutcome.mockResolvedValue({});
  mockDecisionRepositoryAdapter.saveRiskAssessment.mockResolvedValue({});
  mockExplanationRepository.create.mockResolvedValue({});
  mockPolicyRepositoryAdapter.getEnabledPolicies.mockResolvedValue([]);
  mockApprovalRepository.create.mockResolvedValue({
    row: { id: '33333333-3333-3333-3333-333333333333' },
    created: true,
  });
  mockExecutionRepository.createPlan.mockResolvedValue({
    id: '44444444-4444-4444-4444-444444444444',
  });
  mockExecutionRepository.createResult.mockResolvedValue({});
  mockSkillGapRepository.log.mockResolvedValue({
    id: 'skill-gap-1',
  });
}

describe('runMemoryActionLoopJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues approval when policy requires approval', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    const policyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: true,
        requiresApproval: true,
        reason: 'Suggest trust tier requires approval for all actions.',
      }),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      now: new Date('2026-06-25T12:05:00Z'),
      fetchBundle: async () => ({
        suggestions: [makeSuggestion('create_task')],
        pagesById: new Map([
          ['page-1', {
            id: 'page-1',
            content: 'I will send the Madrid launch checklist tomorrow.',
            source: 'signal',
            metadata: { signalSource: 'voice', authoringTier: 'user_sent_originated' },
            createdAt: new Date(),
          }],
        ]),
      }),
      policyEvaluator,
      loadPolicies: async () => [],
    });

    expect(summary.approvalsQueued).toBe(1);
    expect(mockApprovalRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        decisionId: '22222222-2222-2222-2222-222222222222',
        reason: 'Suggest trust tier requires approval for all actions.',
      }),
    );
    expect(mockMemoryActionOpportunityRepository.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'queued_approval',
        approvalRequestId: '33333333-3333-3333-3333-333333333333',
      }),
    );
  });

  it('records learning_needed for unknown action plans without queuing approval', async () => {
    const opportunity = makeOpportunity('invent_new_skill');
    mockCommon(opportunity);

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
    });

    expect(summary.learningNeeded).toBe(1);
    expect(mockApprovalRepository.create).not.toHaveBeenCalled();
    expect(mockSkillGapRepository.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'invent_new_skill',
        attemptedAdapters: ['openclaw', 'mcp-host'],
        userId: 'user-1',
        decisionId: '22222222-2222-2222-2222-222222222222',
      }),
    );
    expect(mockMemoryActionOpportunityRepository.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'learning_needed',
        routeReason: expect.stringContaining('No known built-in action type'),
      }),
    );
  });

  it('executes through the router when policy allows auto-execution', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1',
      trust_tier: 'high_autonomy',
      autonomy_settings: {
        maxSpendPerActionCents: 0,
        maxDailySpendCents: 0,
        allowedDomains: [],
        blockedDomains: [],
        requireApprovalForIrreversible: true,
      },
      ironclaw_channel: null,
    });
    const policyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: true,
        requiresApproval: false,
        reason: 'All policies passed.',
      }),
    };
    const router = {
      route: vi.fn().mockResolvedValue({
        selectedAdapter: 'ironclaw',
        fallbackChain: ['direct'],
        trustProfile: {},
        riskModifierApplied: 0,
        modifiedRiskAssessment: {},
        reasoning: 'IronClaw is preferred; Direct can fall back for create_task.',
      }),
      executeWithRouting: vi.fn().mockResolvedValue({
        planId: 'direct-plan-1',
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        output: { adapter_used: 'direct', routing_decision: 'ironclaw', fallbacks_attempted: 1 },
      }),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator,
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(summary.autoExecuted).toBe(1);
    expect(policyEvaluator.evaluate.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        actionType: 'create_task',
        costZeroIntent: 'verified_zero',
      }),
    );
    expect(router.executeWithRouting).toHaveBeenCalledOnce();
    expect(mockExecutionRepository.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionId: '22222222-2222-2222-2222-222222222222',
        actionId: expect.any(String),
        status: 'completed',
      }),
    );
    expect(mockMemoryActionOpportunityRepository.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'auto_executed',
        adapterName: 'direct',
        executionPlanId: '44444444-4444-4444-4444-444444444444',
        report: expect.objectContaining({
          adapterName: 'direct',
          summary: expect.stringContaining('direct'),
        }),
      }),
    );
  });
});
