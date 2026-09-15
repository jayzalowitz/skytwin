import { expect, it, vi } from 'vitest';
import {
  buildExecutableActionPlan,
  type ActionProvenance,
  type DailyMemorySuggestion,
  type DailyMemorySuggestionPage,
  type MemoryActionOpportunitySnapshot,
} from '@skytwin/shared-types';

const mocks = vi.hoisted(() => ({
  approvalRepository: { create: vi.fn() },
  decisionRepository: {
    create: vi.fn(),
    addCandidateAction: vi.fn(),
    recordOutcome: vi.fn(),
  },
  decisionRepositoryAdapter: { saveRiskAssessment: vi.fn() },
  explanationRepository: { create: vi.fn() },
  memoryActionOpportunityRepository: {
    upsertFromSuggestion: vi.fn(),
    claimDueForUser: vi.fn(),
    listUsersWithDue: vi.fn(),
    markStatus: vi.fn(),
  },
  userRepository: { findById: vi.fn() },
  policyRepositoryAdapter: { getEnabledPolicies: vi.fn() },
  getExecutionRouter: vi.fn(),
  executePrepared: vi.fn(),
}));

const noops = vi.hoisted(() => ({
  register: vi.fn(),
  log: vi.fn(),
  getAsMap: vi.fn(),
  createPlan: vi.fn(),
  createResult: vi.fn(),
  finalizeAdmittedPlan: vi.fn(),
  admitMemoryExecution: vi.fn(),
  isDispatchable: vi.fn(),
  findByScope: vi.fn(),
  observeTerminal: vi.fn(),
  failBeforeDispatch: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  approvalRepository: mocks.approvalRepository,
  credentialRequirementRepository: noops,
  decisionRepository: mocks.decisionRepository,
  decisionRepositoryAdapter: mocks.decisionRepositoryAdapter,
  executionRepository: noops,
  executionAdmissionRepository: noops,
  explanationRepository: mocks.explanationRepository,
  memoryActionOpportunityRepository: mocks.memoryActionOpportunityRepository,
  policyRepositoryAdapter: mocks.policyRepositoryAdapter,
  serviceCredentialRepository: noops,
  skillGapRepository: noops,
  userRepository: mocks.userRepository,
  getPolicyAuthorityRevision: vi.fn(),
}));

import { runMemoryActionLoopJob } from '../jobs/memory-action-loop.js';

it('adv-v1-memory-loop-untrusted-send queues confirmation without resolving execution', async () => {
  const page: DailyMemorySuggestionPage = {
    id: 'memory-1',
    content: 'A newsletter asks the reader to draft and send a reply.',
    // Deliberately trusted-looking fallback: metadata must win, otherwise
    // this suggestion would be misclassified as user-originated.
    source: 'user_request',
    sourceRef: 'gmail-signal-1',
    metadata: { signalSource: 'gmail', authoringTier: 'inbox_newsletter' },
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
  };
  const suggestion: DailyMemorySuggestion = {
    id: 'suggestion-1',
    title: 'External newsletter request',
    reason: 'An inbound newsletter asked for an outbound reply.',
    suggestedAction: 'Draft a reply using this memory.',
    sourceRefs: ['gmail-signal-1'],
    memoryRefs: [page.id],
    sourceTypes: ['gmail'],
    novelty: 'resurface',
    confidence: 0.7,
    actionPlan: buildExecutableActionPlan('draft_email', 'Draft a reply'),
  };
  let persistedOpportunity: MemoryActionOpportunitySnapshot | undefined;
  mocks.memoryActionOpportunityRepository.upsertFromSuggestion.mockImplementation(async (input: {
    userId: string;
    fingerprint: string;
    suggestion: DailyMemorySuggestion;
    provenance: ActionProvenance;
  }) => {
    persistedOpportunity = {
      id: '11111111-1111-4111-8111-111111111111',
      userId: input.userId,
      fingerprint: input.fingerprint,
      suggestionId: input.suggestion.id,
      title: input.suggestion.title,
      reason: input.suggestion.reason,
      suggestedAction: input.suggestion.suggestedAction,
      actionType: input.suggestion.actionPlan.actionType,
      actionLabel: input.suggestion.actionPlan.label,
      actionPlan: input.suggestion.actionPlan,
      sourceRefs: input.suggestion.sourceRefs,
      memoryRefs: input.suggestion.memoryRefs,
      sourceTypes: input.suggestion.sourceTypes,
      novelty: input.suggestion.novelty,
      confidence: input.suggestion.confidence,
      provenance: input.provenance,
      status: 'suggested',
      attemptCount: 0,
      lastSuggestedAt: new Date('2026-09-14T00:00:00.000Z'),
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
    return persistedOpportunity;
  });
  mocks.memoryActionOpportunityRepository.claimDueForUser.mockImplementation(async () => {
    if (!persistedOpportunity) throw new Error('suggestion was not persisted before claim');
    return [{
      ...persistedOpportunity,
      attemptCount: 1,
      lastAttemptedAt: new Date('2026-09-14T00:01:00.000Z'),
    }];
  });
  mocks.memoryActionOpportunityRepository.listUsersWithDue.mockResolvedValue([]);
  mocks.memoryActionOpportunityRepository.markStatus.mockResolvedValue(undefined);
  mocks.userRepository.findById.mockResolvedValue({
    id: 'user-1',
    trust_tier: 'high_autonomy',
    autonomy_settings: {},
    ironclaw_channel: null,
    execution_authority_revision: 'authority-revision-1',
  });
  mocks.policyRepositoryAdapter.getEnabledPolicies.mockResolvedValue([]);
  mocks.decisionRepository.create.mockResolvedValue({ row: { id: 'decision-1' }, created: true });
  mocks.decisionRepository.addCandidateAction.mockResolvedValue(undefined);
  mocks.decisionRepository.recordOutcome.mockResolvedValue(undefined);
  mocks.decisionRepositoryAdapter.saveRiskAssessment.mockResolvedValue(undefined);
  mocks.explanationRepository.create.mockResolvedValue(undefined);
  mocks.approvalRepository.create.mockResolvedValue({ row: { id: 'approval-1' }, created: true });
  mocks.getExecutionRouter.mockResolvedValue({ executePrepared: mocks.executePrepared });

  const summary = await runMemoryActionLoopJob({
    userIds: ['user-1'],
    fetchBundle: async () => ({ suggestions: [suggestion], pagesById: new Map([[page.id, page]]) }),
    getExecutionRouter: mocks.getExecutionRouter,
  });
  const upsertInput = mocks.memoryActionOpportunityRepository.upsertFromSuggestion.mock.calls[0]?.[0];
  const candidateAction = mocks.approvalRepository.create.mock.calls[0]?.[0]?.candidateAction as {
    actionType: string;
    reversible: boolean;
    parameters: { sourceRefs: string[]; memoryRefs: string[] };
    provenance: string;
  };

  expect({
    summary,
    page,
    upsertInput,
    persistedOpportunity,
    candidateAction,
    approval: mocks.approvalRepository.create.mock.calls[0]?.[0],
    calls: {
      upsert: mocks.memoryActionOpportunityRepository.upsertFromSuggestion.mock.calls.length,
      claim: mocks.memoryActionOpportunityRepository.claimDueForUser.mock.calls.length,
      candidate: mocks.decisionRepository.addCandidateAction.mock.calls.length,
      outcome: mocks.decisionRepository.recordOutcome.mock.calls.length,
      explanation: mocks.explanationRepository.create.mock.calls.length,
      approval: mocks.approvalRepository.create.mock.calls.length,
      routerResolutions: mocks.getExecutionRouter.mock.calls.length,
      dispatches: mocks.executePrepared.mock.calls.length,
    },
  }).toMatchObject({
    summary: { opportunitiesUpserted: 1, approvalsQueued: 1, autoExecuted: 0 },
    page: {
      source: 'user_request',
      metadata: { signalSource: 'gmail', authoringTier: 'inbox_newsletter' },
    },
    upsertInput: {
      suggestion: {
        actionPlan: { actionType: 'draft_email' },
        sourceRefs: ['gmail-signal-1'],
        memoryRefs: ['memory-1'],
      },
      provenance: 'untrusted_external',
    },
    persistedOpportunity: { provenance: 'untrusted_external' },
    candidateAction: {
      actionType: 'draft_email',
      reversible: false,
      parameters: { sourceRefs: ['gmail-signal-1'], memoryRefs: ['memory-1'] },
      provenance: 'untrusted_external',
    },
    approval: {
      confirmationLevel: 'single',
      candidateAction: {
        actionType: 'draft_email',
        reversible: false,
        provenance: 'untrusted_external',
      },
    },
    calls: {
      upsert: 1,
      claim: 1,
      candidate: 1,
      outcome: 1,
      explanation: 1,
      approval: 1,
      routerResolutions: 0,
      dispatches: 0,
    },
  });
});
