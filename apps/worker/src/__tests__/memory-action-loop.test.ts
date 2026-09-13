import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildExecutableActionPlan } from '@skytwin/shared-types';
import { NoRequestExecutionError } from '@skytwin/execution-router';
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
  mockExecutionAdmissionRepository,
  mockPolicyRepositoryAdapter,
  mockServiceCredentialRepository,
  mockCredentialRequirementRepository,
  mockSkillGapRepository,
  mockGetPolicyAuthorityRevision,
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
    finalizeAdmittedPlan: vi.fn(),
  },
  mockExecutionAdmissionRepository: {
    admitMemoryExecution: vi.fn(),
    isDispatchable: vi.fn(),
    findByScope: vi.fn(),
    observeTerminal: vi.fn(),
    failBeforeDispatch: vi.fn(),
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
  mockGetPolicyAuthorityRevision: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  memoryActionOpportunityRepository: mockMemoryActionOpportunityRepository,
  userRepository: mockUserRepository,
  decisionRepository: mockDecisionRepository,
  decisionRepositoryAdapter: mockDecisionRepositoryAdapter,
  approvalRepository: mockApprovalRepository,
  explanationRepository: mockExplanationRepository,
  executionRepository: mockExecutionRepository,
  executionAdmissionRepository: mockExecutionAdmissionRepository,
  policyRepositoryAdapter: mockPolicyRepositoryAdapter,
  serviceCredentialRepository: mockServiceCredentialRepository,
  credentialRequirementRepository: mockCredentialRequirementRepository,
  skillGapRepository: mockSkillGapRepository,
  getPolicyAuthorityRevision: mockGetPolicyAuthorityRevision,
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
    execution_authority_revision: 'authority-revision-1',
  });
  mockGetPolicyAuthorityRevision.mockResolvedValue('policy-authority-revision-1');
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
  mockExecutionRepository.finalizeAdmittedPlan.mockResolvedValue({
    id: '44444444-4444-4444-4444-444444444444',
  });
  mockExecutionAdmissionRepository.admitMemoryExecution.mockResolvedValue({
    created: true,
    barrier: {
      id: '55555555-5555-4555-8555-555555555555',
      status: 'in_progress',
      decision_id: '22222222-2222-2222-2222-222222222222',
      updated_at: new Date('2026-09-13T00:00:00.000Z'),
    },
    plan: { id: '44444444-4444-4444-4444-444444444444' },
  });
  mockExecutionAdmissionRepository.observeTerminal.mockResolvedValue({});
  mockExecutionAdmissionRepository.findByScope.mockResolvedValue(null);
  mockExecutionAdmissionRepository.isDispatchable.mockResolvedValue(true);
  mockExecutionAdmissionRepository.failBeforeDispatch.mockResolvedValue({ status: 'failed' });
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
    expect(router.executeWithRouting.mock.calls[0]![0]).toMatchObject({
      parameters: { executionPlanId: '44444444-4444-4444-4444-444444444444' },
    });
    expect(mockExecutionAdmissionRepository.admitMemoryExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionId: '22222222-2222-2222-2222-222222222222',
        actionId: expect.any(String),
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

  it('does not dispatch when the exact owner/admission fence is revoked', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy',
      autonomy_settings: {
        maxSpendPerActionCents: 0, maxDailySpendCents: 0,
        allowedDomains: [], blockedDomains: [], requireApprovalForIrreversible: true,
      },
      ironclaw_channel: null,
    });
    mockExecutionAdmissionRepository.isDispatchable.mockResolvedValue(false);
    const router = {
      route: vi.fn().mockResolvedValue({
        selectedAdapter: 'direct', fallbackChain: [], trustProfile: {},
        riskModifierApplied: 0, modifiedRiskAssessment: {}, reasoning: 'direct',
      }),
      executeWithRouting: vi.fn(),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator: { evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'allowed',
      }) },
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(router.executeWithRouting).not.toHaveBeenCalled();
    expect(mockExecutionAdmissionRepository.failBeforeDispatch).toHaveBeenCalledWith({
      admission: expect.objectContaining({ created: true }),
      userId: 'user-1',
      error: 'Execution owner or admitted graph was revoked before router invocation.',
    });
    expect(mockMemoryActionOpportunityRepository.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'execution_failed' }),
    );
    expect(summary.executionFailed).toBe(1);
  });

  it('durably closes a router-proven no-request refusal as failed', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {},
      ironclaw_channel: 'trusted-channel', execution_authority_revision: 'authority-revision-1',
    });
    const router = {
      route: vi.fn().mockResolvedValue({
        selectedAdapter: 'direct', fallbackChain: [], trustProfile: {},
        riskModifierApplied: 0, modifiedRiskAssessment: {}, reasoning: 'direct',
      }),
      executeWithRouting: vi.fn().mockRejectedValue(
        new NoRequestExecutionError('request-start authority refused'),
      ),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator: { evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'allowed',
      }) },
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(mockExecutionAdmissionRepository.failBeforeDispatch).toHaveBeenCalledWith({
      admission: expect.objectContaining({ created: true }),
      userId: 'user-1',
      error: '[redacted:execution-error]',
    });
    expect(mockExecutionAdmissionRepository.observeTerminal).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ambiguous' }),
    );
    expect(mockMemoryActionOpportunityRepository.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'execution_failed' }),
    );
    expect(summary.executionFailed).toBe(1);
  });

  it('lets request-start refuse a channel revision changed during final worker awaits', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {},
      ironclaw_channel: 'old-channel', execution_authority_revision: 'old-channel-revision',
    });
    let policyReads = 0;
    let channelChanged = false;
    const router = {
      route: vi.fn().mockResolvedValue({
        selectedAdapter: 'ironclaw', fallbackChain: [], trustProfile: {},
        riskModifierApplied: 0, modifiedRiskAssessment: {}, reasoning: 'ironclaw',
      }),
      executeWithRouting: vi.fn(async (
        action: { parameters: Record<string, unknown> },
        _risk: unknown,
        _userId: string,
        context: { ironclawChannel?: string },
      ) => {
        expect(channelChanged).toBe(true);
        expect(action.parameters['credentialAuthorityRevision']).toBe('old-channel-revision');
        expect(context.ironclawChannel).toBe('old-channel');
        throw new NoRequestExecutionError('channel authority changed before request start');
      }),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator: { evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'allowed',
      }) },
      loadPolicies: async () => {
        policyReads += 1;
        if (policyReads === 2) channelChanged = true;
        return [];
      },
      getExecutionRouter: async () => router,
    });

    expect(router.executeWithRouting).toHaveBeenCalledOnce();
    expect(mockExecutionAdmissionRepository.failBeforeDispatch).toHaveBeenCalledOnce();
    expect(mockExecutionAdmissionRepository.observeTerminal).not.toHaveBeenCalled();
    expect(summary.executionFailed).toBe(1);
  });

  it('redacts echoed credentials and arbitrary adapter bodies from memory execution ledgers', async () => {
    const opportunity = makeOpportunity('create_task');
    const secret = 'opaque-memory-token';
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {}, ironclaw_channel: null,
    });
    const router = {
      route: vi.fn().mockResolvedValue({
        selectedAdapter: 'direct', fallbackChain: [], trustProfile: {}, riskModifierApplied: 0,
        modifiedRiskAssessment: {}, reasoning: 'direct route',
      }),
      executeWithRouting: vi.fn().mockResolvedValue({
        planId: 'adapter-plan-failed', status: 'failed', startedAt: new Date(),
        completedAt: new Date(),
        output: {
          adapter_used: 'direct',
          accessToken: secret,
          headers: { authorization: `Bearer ${secret}` },
          responseUrl: `https://adapter.test/result?access_token=${secret}`,
          body: { echoed: secret },
          summary: `opaque ${secret}`,
        },
        error: `adapter echoed ${secret}`,
      }),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator: { evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'All policies passed.',
      }) },
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(summary.executionFailed).toBe(1);
    const persisted = JSON.stringify({
      barrier: mockExecutionAdmissionRepository.observeTerminal.mock.calls,
      result: mockExecutionRepository.finalizeAdmittedPlan.mock.calls,
      memory: mockMemoryActionOpportunityRepository.markStatus.mock.calls,
      report: summary.reports,
    });
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('?access_token=');
    expect(persisted).not.toContain('echoed');
    expect(persisted).toContain('[redacted:execution-error]');
    expect(persisted).toContain('[redacted:unapproved-evidence]');
  });

  it('rechecks a stored opportunity and fences a pause that lands after admission', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy',
      autonomy_settings: {}, ironclaw_channel: null,
    });
    const policyEvaluator = {
      evaluate: vi.fn()
        .mockResolvedValueOnce({ allowed: true, requiresApproval: false, reason: 'initially allowed' })
        .mockResolvedValueOnce({ allowed: true, requiresApproval: false, reason: 'allowed at admission' })
        .mockResolvedValueOnce({ allowed: false, requiresApproval: true, reason: 'operator paused' }),
    };
    const router = {
      route: vi.fn().mockResolvedValue({
        selectedAdapter: 'direct', fallbackChain: [], trustProfile: {},
        riskModifierApplied: 0, modifiedRiskAssessment: {}, reasoning: 'direct',
      }),
      executeWithRouting: vi.fn(),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator,
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(policyEvaluator.evaluate).toHaveBeenCalledTimes(3);
    expect(mockExecutionAdmissionRepository.admitMemoryExecution).toHaveBeenCalledOnce();
    expect(mockExecutionAdmissionRepository.isDispatchable).not.toHaveBeenCalled();
    expect(router.executeWithRouting).not.toHaveBeenCalled();
    expect(summary.executionFailed).toBe(1);
    expect(mockExecutionAdmissionRepository.failBeforeDispatch).toHaveBeenCalledOnce();
  });

  it('records an ambiguous adapter outcome without a failed plan or retryable failure state', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy',
      autonomy_settings: {}, ironclaw_channel: null,
    });
    const policyEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'All policies passed.',
      }),
    };
    const router = {
      route: vi.fn().mockResolvedValue({
        selectedAdapter: 'ironclaw', fallbackChain: [], trustProfile: {},
        riskModifierApplied: 0, modifiedRiskAssessment: {}, reasoning: 'preferred',
      }),
      executeWithRouting: vi.fn().mockResolvedValue({
        planId: 'adapter-plan-unresolved', status: 'pending', startedAt: new Date(),
      }),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator,
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(summary.executionAmbiguous).toBe(1);
    expect(summary.executionFailed).toBe(0);
    expect(mockExecutionAdmissionRepository.admitMemoryExecution).toHaveBeenCalledOnce();
    expect(mockExecutionRepository.finalizeAdmittedPlan).not.toHaveBeenCalled();
    expect(mockMemoryActionOpportunityRepository.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'execution_ambiguous',
        nextStep: expect.stringContaining('Reconcile'),
      }),
    );
    expect(mockExecutionAdmissionRepository.admitMemoryExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        preEffectOutcome: expect.objectContaining({ explanation: expect.stringContaining('before adapter dispatch') }),
        preEffectExplanation: expect.objectContaining({ whatHappened: expect.stringContaining('before adapter dispatch') }),
      }),
    );
  });

  it('preserves a returned completion when every secondary ledger write fails', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {}, ironclaw_channel: null,
    });
    mockExecutionAdmissionRepository.observeTerminal.mockRejectedValue(new Error('commit response lost'));
    mockExecutionRepository.finalizeAdmittedPlan.mockRejectedValue(new Error('result DB unavailable'));
    mockDecisionRepository.recordOutcome.mockRejectedValue(new Error('outcome DB unavailable'));
    mockMemoryActionOpportunityRepository.markStatus.mockRejectedValue(new Error('opportunity DB unavailable'));
    const router = {
      route: vi.fn().mockResolvedValue({
        selectedAdapter: 'direct', fallbackChain: [], trustProfile: {}, riskModifierApplied: 0,
        modifiedRiskAssessment: {}, reasoning: 'direct route',
      }),
      executeWithRouting: vi.fn().mockResolvedValue({
        planId: 'adapter-plan-completed', status: 'completed', startedAt: new Date(),
        completedAt: new Date(), output: { adapter_used: 'direct' },
      }),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator: { evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'All policies passed.',
      }) },
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(summary.autoExecuted).toBe(1);
    expect(summary.executionFailed).toBe(0);
    expect(summary.executionAmbiguous).toBe(0);
    expect(router.executeWithRouting).toHaveBeenCalledOnce();
    expect(mockExecutionAdmissionRepository.observeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('does not dispatch when the durable admission response is lost', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {}, ironclaw_channel: null,
    });
    mockExecutionAdmissionRepository.admitMemoryExecution.mockRejectedValue(
      new Error('commit response lost'),
    );
    mockExecutionAdmissionRepository.findByScope.mockResolvedValueOnce({
      created: false,
      barrier: { status: 'in_progress' },
      plan: { id: '44444444-4444-4444-4444-444444444444' },
    });
    const router = {
      route: vi.fn().mockResolvedValue({
        selectedAdapter: 'direct', fallbackChain: [], trustProfile: {}, riskModifierApplied: 0,
        modifiedRiskAssessment: {}, reasoning: 'direct route',
      }),
      executeWithRouting: vi.fn(),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator: { evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'All policies passed.',
      }) },
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(router.executeWithRouting).not.toHaveBeenCalled();
    expect(summary.executionAmbiguous).toBe(1);
    expect(summary.executionFailed).toBe(0);
    expect(summary.reports[0]).toMatchObject({
      executionPlanId: '44444444-4444-4444-4444-444444444444',
    });
  });

  it('preserves an explicit failed barrier when suppressing a duplicate memory execution', async () => {
    const opportunity = makeOpportunity('create_task');
    mockCommon(opportunity);
    mockUserRepository.findById.mockResolvedValue({
      id: 'user-1', trust_tier: 'high_autonomy', autonomy_settings: {}, ironclaw_channel: null,
    });
    mockExecutionAdmissionRepository.admitMemoryExecution.mockResolvedValueOnce({
      created: false,
      barrier: {
        status: 'failed',
        decision_id: '22222222-2222-2222-2222-222222222222',
      },
      plan: { id: '44444444-4444-4444-4444-444444444444' },
    });
    const router = {
      route: vi.fn().mockResolvedValue({
        selectedAdapter: 'direct', fallbackChain: [], trustProfile: {}, riskModifierApplied: 0,
        modifiedRiskAssessment: {}, reasoning: 'direct route',
      }),
      executeWithRouting: vi.fn(),
    };

    const summary = await runMemoryActionLoopJob({
      userIds: ['user-1'],
      fetchBundle: async () => ({ suggestions: [], pagesById: new Map() }),
      policyEvaluator: { evaluate: vi.fn().mockResolvedValue({
        allowed: true, requiresApproval: false, reason: 'All policies passed.',
      }) },
      loadPolicies: async () => [],
      getExecutionRouter: async () => router,
    });

    expect(router.executeWithRouting).not.toHaveBeenCalled();
    expect(summary.executionFailed).toBe(1);
    expect(summary.executionAmbiguous).toBe(0);
    expect(summary.reports[0]).toMatchObject({
      status: 'execution_failed',
      executionPlanId: '44444444-4444-4444-4444-444444444444',
      summary: expect.stringContaining('explicit failure'),
    });
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
