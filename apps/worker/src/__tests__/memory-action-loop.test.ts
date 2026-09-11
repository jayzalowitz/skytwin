import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildExecutableActionPlan, RiskTier } from '@skytwin/shared-types';
import { AmbiguousExecutionError, InvariantViolationError } from '@skytwin/execution-router';
import type {
  CandidateAction,
  DailyMemorySuggestion,
  MemoryActionOpportunitySnapshot,
  RiskAssessment,
  RoutingDecision,
} from '@skytwin/shared-types';

const {
  mockMemoryActionOpportunityRepository,
  mockUserRepository,
  mockDecisionRepository,
  mockDecisionRepositoryAdapter,
  mockApprovalRepository,
  mockExplanationRepositoryAdapter,
  mockPreEffectBarrierRepository,
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
    saveOutcome: vi.fn(),
  },
  mockApprovalRepository: {
    create: vi.fn(),
  },
  mockExplanationRepositoryAdapter: {
    save: vi.fn(),
  },
  mockPreEffectBarrierRepository: {
    reserve: vi.fn(),
    markPrepared: vi.fn(),
    updatePreparedPolicy: vi.fn(),
    claimPrepared: vi.fn(),
    markTerminal: vi.fn(),
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
  explanationRepositoryAdapter: mockExplanationRepositoryAdapter,
  preEffectBarrierRepository: mockPreEffectBarrierRepository,
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
  mockDecisionRepositoryAdapter.saveOutcome.mockImplementation(async (outcome) => outcome);
  mockExplanationRepositoryAdapter.save.mockImplementation(async (record) => ({
    ...record,
    id: '55555555-5555-5555-5555-555555555555',
  }));
  mockPreEffectBarrierRepository.reserve.mockResolvedValue({
    row: {
      id: '66666666-6666-6666-6666-666666666666',
      status: 'reserved',
      decision_id: null,
      effect_result: {},
    },
    created: true,
  });
  mockPreEffectBarrierRepository.markPrepared.mockResolvedValue({ status: 'prepared' });
  mockPreEffectBarrierRepository.updatePreparedPolicy.mockResolvedValue({ status: 'prepared' });
  mockPreEffectBarrierRepository.claimPrepared.mockResolvedValue({ status: 'in_progress' });
  mockPreEffectBarrierRepository.markTerminal.mockResolvedValue({ status: 'succeeded' });
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

function makeRouter(options: { executeError?: Error; riskTier?: RiskAssessment['overallTier'] } = {}) {
  const route = vi.fn(async (
    _candidate: CandidateAction,
    risk: RiskAssessment,
  ): Promise<RoutingDecision> => ({
    selectedAdapter: 'direct',
    fallbackChain: ['ironclaw'],
    trustProfile: {
      name: 'direct',
      reversibilityGuarantee: 'partial',
      authModel: 'none',
      auditTrail: true,
      riskModifier: 0,
    },
    riskModifierApplied: 0,
    modifiedRiskAssessment: {
      ...risk,
      overallTier: options.riskTier ?? risk.overallTier,
      reasoning: `${risk.reasoning} Adapter route: direct.`,
    },
    reasoning: 'Direct is the selected immutable route.',
  }));
  const prepareExecution = vi.fn(async (candidate: CandidateAction, routing: RoutingDecision) => ({
    selectedAdapter: routing.selectedAdapter,
    routingDecision: routing,
    plan: {
      id: 'prepared-plan-1',
      decisionId: candidate.decisionId,
      action: candidate,
      steps: [],
      rollbackSteps: [],
      createdAt: new Date(),
    },
  }));
  const executePrepared = options.executeError
    ? vi.fn().mockRejectedValue(options.executeError)
    : vi.fn().mockResolvedValue({
        planId: 'direct-plan-1',
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        output: { adapter_used: 'direct', routing_decision: 'direct', fallbacks_attempted: 0 },
      });
  return { route, prepareExecution, executePrepared };
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
    const loadPolicies = vi.fn().mockResolvedValue([]);

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
      loadPolicies,
    });

    expect(summary.approvalsQueued).toBe(1);
    expect(loadPolicies).toHaveBeenCalledWith('user-1');
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
    const router = makeRouter({ riskTier: RiskTier.HIGH });

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
    expect(policyEvaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(policyEvaluator.evaluate.mock.calls[1]![3]).toEqual(
      expect.objectContaining({ overallTier: RiskTier.HIGH, reasoning: expect.stringContaining('Adapter route: direct') }),
    );
    expect(router.executePrepared).toHaveBeenCalledOnce();
    expect(router.executePrepared).toHaveBeenCalledWith(
      expect.objectContaining({ selectedAdapter: 'direct' }),
      'user-1',
    );
    expect(mockExplanationRepositoryAdapter.save.mock.invocationCallOrder[0]).toBeLessThan(
      router.executePrepared.mock.invocationCallOrder[0]!,
    );
    expect(mockPreEffectBarrierRepository.claimPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      router.executePrepared.mock.invocationCallOrder[0]!,
    );
    expect(mockPreEffectBarrierRepository.markPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        explanationId: '55555555-5555-5555-5555-555555555555',
        policySnapshot: expect.objectContaining({
          riskAssessment: expect.objectContaining({ overallTier: RiskTier.HIGH }),
          routing: expect.objectContaining({ selectedAdapter: 'direct' }),
        }),
      }),
    );
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

  it('blocks before dispatch when adapter-adjusted risk fails the final policy gate', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {}, ironclaw_channel: null,
    });
    const policyEvaluator = {
      evaluate: vi.fn()
        .mockResolvedValueOnce({ allowed: true, requiresApproval: false, reason: 'Base risk allowed.' })
        .mockResolvedValueOnce({ allowed: false, requiresApproval: false, reason: 'Adjusted risk denied.' }),
    };
    const router = makeRouter({ riskTier: RiskTier.HIGH });

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator,
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(summary.blocked).toBe(1);
    expect(policyEvaluator.evaluate.mock.calls[1]![3]).toEqual(
      expect.objectContaining({ overallTier: RiskTier.HIGH }),
    );
    expect(router.prepareExecution).toHaveBeenCalledOnce();
    expect(router.executePrepared).not.toHaveBeenCalled();
    expect(mockPreEffectBarrierRepository.markTerminal).toHaveBeenCalledWith(
      'user-1',
      '66666666-6666-6666-6666-666666666666',
      'blocked',
      expect.objectContaining({
        finalPolicy: expect.objectContaining({
          allowed: false,
          routing: expect.objectContaining({ selectedAdapter: 'direct' }),
          riskAssessment: expect.objectContaining({ overallTier: RiskTier.HIGH }),
        }),
      }),
      'Adjusted risk denied.',
    );
  });

  it('fails closed with zero adapter effects when the intended explanation cannot persist', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1',
      trust_tier: 'high_autonomy',
      autonomy_settings: {},
      ironclaw_channel: null,
    });
    mockExplanationRepositoryAdapter.save.mockRejectedValueOnce(new Error('audit store unavailable'));
    const policyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: true,
        requiresApproval: false,
        reason: 'All policies passed.',
      }),
    };
    const router = makeRouter();

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator,
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(summary.autoExecuted).toBe(0);
    expect(router.route).toHaveBeenCalledOnce();
    expect(router.prepareExecution).toHaveBeenCalledOnce();
    expect(router.executePrepared).not.toHaveBeenCalled();
    expect(mockPreEffectBarrierRepository.claimPrepared).not.toHaveBeenCalled();
  });

  it('does not duplicate an adapter effect after an interrupted in-progress attempt', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {}, ironclaw_channel: null,
    });
    const policyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'All policies passed.',
      }),
    };
    const router = makeRouter({
      executeError: new AmbiguousExecutionError('direct', new Error('SECRET_MARKER connection lost after dispatch')),
    });
    const deps = {
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator,
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    };

    await runMemoryActionLoopJob(deps);
    expect(router.executePrepared).toHaveBeenCalledOnce();
    expect(mockPreEffectBarrierRepository.markTerminal).toHaveBeenCalledWith(
      'user-1',
      '66666666-6666-6666-6666-666666666666',
      'unknown',
      {},
      'adapter_dispatch_ambiguous',
    );
    expect(mockMemoryActionOpportunityRepository.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'execution_unknown' }),
    );
    expect(JSON.stringify([
      mockPreEffectBarrierRepository.markTerminal.mock.calls,
      mockMemoryActionOpportunityRepository.markStatus.mock.calls,
      mockExplanationRepositoryAdapter.save.mock.calls,
    ])).not.toContain('SECRET_MARKER');

    mockPreEffectBarrierRepository.reserve.mockResolvedValueOnce({
      row: {
        id: '66666666-6666-6666-6666-666666666666',
        status: 'unknown',
        decision_id: '22222222-2222-2222-2222-222222222222',
        effect_result: {},
      },
      created: false,
    });
    await runMemoryActionLoopJob(deps);
    expect(router.executePrepared).toHaveBeenCalledOnce();
  });

  it('records a prepared-handle invariant failure as known no-dispatch failure', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {}, ironclaw_channel: null,
    });
    const router = makeRouter({
      executeError: new InvariantViolationError('prepared adapter was replaced'),
    });

    await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator: { evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'All policies passed.',
      }) },
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(mockPreEffectBarrierRepository.markTerminal).toHaveBeenCalledWith(
      'user-1',
      '66666666-6666-6666-6666-666666666666',
      'failed',
      {},
      'prepared_execution_invalid',
    );
    expect(mockMemoryActionOpportunityRepository.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'execution_failed' }),
    );
    expect(mockPreEffectBarrierRepository.markTerminal.mock.calls.some((call) => call[2] === 'unknown'))
      .toBe(false);
  });

  it('preserves a known succeeded barrier when later execution-ledger persistence fails', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {}, ironclaw_channel: null,
    });
    const policyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'All policies passed.',
      }),
    };
    const router = makeRouter();
    mockExecutionRepository.createPlan.mockRejectedValueOnce(new Error('execution ledger unavailable'));

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator,
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(summary.autoExecuted).toBe(0);
    expect(router.executePrepared).toHaveBeenCalledOnce();
    expect(mockPreEffectBarrierRepository.markTerminal.mock.calls.map((call) => call[2])).toEqual(['succeeded']);
    expect(mockDecisionRepositoryAdapter.saveOutcome).toHaveBeenCalledTimes(2);
  });

  it('does not downgrade a known result when terminal explanation fails after outcome persistence', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {}, ironclaw_channel: null,
    });
    const policyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'All policies passed.',
      }),
    };
    const router = makeRouter();
    mockExplanationRepositoryAdapter.save
      .mockImplementationOnce(async (record) => ({
        ...record,
        id: '55555555-5555-5555-5555-555555555555',
      }))
      .mockRejectedValueOnce(new Error('terminal explanation unavailable'));

    await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator,
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(router.executePrepared).toHaveBeenCalledOnce();
    expect(mockDecisionRepositoryAdapter.saveOutcome).toHaveBeenCalledTimes(2);
    expect(mockDecisionRepositoryAdapter.saveOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoExecute: true, reasoning: expect.stringContaining('Auto-executed') }),
    );
    expect(mockPreEffectBarrierRepository.markTerminal.mock.calls.map((call) => call[2])).toEqual(['succeeded']);
    expect(mockMemoryActionOpportunityRepository.markStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'execution_unknown' }),
    );
  });

  it('marks outbound email memory actions irreversible before policy evaluation', async () => {
    const opportunity = makeOpportunity('draft_email');
    mockCommon(opportunity);
    const policyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: true,
        requiresApproval: true,
        reason: 'Irreversible outbound email requires approval.',
      }),
    };

    await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator,
      loadPolicies: async () => [],
    });

    expect(policyEvaluator.evaluate.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        actionType: 'draft_email',
        reversible: false,
      }),
    );
  });
});
