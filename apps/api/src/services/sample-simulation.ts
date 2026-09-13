import {
  ConfidenceLevel,
  RiskDimension,
  RiskTier,
  SituationType,
  TrustTier,
} from '@skytwin/shared-types';
import type {
  ActionProvenance,
  CandidateAction,
  DecisionContext,
  DecisionObject,
  DecisionOutcome,
  Preference,
  RiskAssessment,
  SampleSimulationCommand,
  SampleSimulationActionType,
  SampleSimulationExplanation,
  SampleSimulationLearning,
  SampleSimulationProposal,
  SampleSimulationProposalId,
  SampleSimulationStateResponse,
  SampleSimulationStatus,
} from '@skytwin/shared-types';
import {
  PolicyEvaluator,
  type PolicyDecision,
  type PolicyRepositoryPort,
} from '@skytwin/policy-engine';
import {
  ExplanationGenerator,
  type ExplanationRepositoryPort,
} from '@skytwin/explanations';
import { DEMO_USER_ID } from '../auth/demo-session.js';

interface CatalogEntry {
  id: SampleSimulationProposalId;
  title: string;
  situation: string;
  situationType: SituationType;
  domain: string;
  actionType: SampleSimulationActionType;
  proposedAction: string;
  provenance?: ActionProvenance;
  source: string;
  estimatedCostCents: number;
  reversible: boolean;
  riskTier: RiskTier;
  allowedCommands: Array<'approve' | 'reject' | 'correct'>;
}

interface SessionRecord {
  expiresAtMs: number;
  revision: number;
  statuses: Record<SampleSimulationProposalId, SampleSimulationStatus>;
  learning: SampleSimulationLearning[];
  resultMessages: Partial<Record<SampleSimulationProposalId, string>>;
  proposalSnapshots: Partial<
    Record<SampleSimulationProposalId, SampleSimulationProposal>
  >;
}

interface SimulationTerminalReceipt {
  status: 'simulated_completed';
  externalEffects: false;
}

/**
 * Deliberately terminal, dependency-free simulation boundary.
 *
 * This class cannot resolve an execution adapter: it accepts only the fixed
 * catalog identifier and returns a receipt. It has no constructor ports and
 * performs no I/O. Approval means "show the simulated outcome", never "run".
 */
class SampleSimulationTerminal {
  complete(_proposalId: SampleSimulationProposalId): SimulationTerminalReceipt {
    return { status: 'simulated_completed', externalEffects: false };
  }
}

export class SampleSimulationCommandError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 401 | 409 | 429,
  ) {
    super(message);
    this.name = 'SampleSimulationCommandError';
  }
}

const unusablePolicyRepository: PolicyRepositoryPort = {
  getAllPolicies: async () => {
    throw new Error('Simulation may not load persisted policies.');
  },
  getEnabledPolicies: async () => {
    throw new Error('Simulation may not load persisted policies.');
  },
  getPolicy: async () => {
    throw new Error('Simulation may not load persisted policies.');
  },
  getPoliciesByDomain: async () => {
    throw new Error('Simulation may not load persisted policies.');
  },
  savePolicy: async () => {
    throw new Error('Simulation may not persist policies.');
  },
  updatePolicy: async () => {
    throw new Error('Simulation may not persist policies.');
  },
  deletePolicy: async () => {
    throw new Error('Simulation may not persist policies.');
  },
};

const noPersistenceExplanationRepository: ExplanationRepositoryPort = {
  save: async (record) => record,
  getByDecisionId: async () => null,
  getByUserId: async () => [],
};

function defaultStatuses(): Record<
  SampleSimulationProposalId,
  SampleSimulationStatus
> {
  return {
    'calendar-focus': 'pending',
    'newsletter-triage': 'pending',
    'focus-time-preference': 'pending',
    'untrusted-document': 'contained',
  };
}

function makeRecord(expiresAtMs: number): SessionRecord {
  return {
    expiresAtMs,
    revision: 0,
    statuses: defaultStatuses(),
    learning: [],
    resultMessages: {},
    proposalSnapshots: {},
  };
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return {
    expiresAtMs: record.expiresAtMs,
    revision: record.revision,
    statuses: { ...record.statuses },
    learning: record.learning.map((item) => ({ ...item })),
    resultMessages: { ...record.resultMessages },
    proposalSnapshots: Object.fromEntries(
      Object.entries(record.proposalSnapshots).map(([key, proposal]) => [
        key,
        proposal
          ? {
              ...proposal,
              policy: { ...proposal.policy },
              explanation: {
                ...proposal.explanation,
                evidence: [...proposal.explanation.evidence],
                preferences: [...proposal.explanation.preferences],
              },
              allowedCommands: [...proposal.allowedCommands],
              correctionOptions: proposal.correctionOptions.map((item) => ({
                ...item,
              })),
            }
          : proposal,
      ]),
    ) as SessionRecord['proposalSnapshots'],
  };
}

function catalog(record: SessionRecord): CatalogEntry[] {
  const prefersAfternoons = record.learning.some(
    (item) =>
      item.key === 'preferred_focus_window' && item.value === 'afternoon',
  );
  return [
    {
      id: 'calendar-focus',
      title: 'Protect a focus block',
      situation:
        'A fictional teammate asks to move a low-priority sync into Alex’s focus block.',
      situationType: SituationType.CALENDAR_CONFLICT,
      domain: 'calendar',
      actionType: 'decline_event',
      proposedAction:
        'Decline the conflicting sync and suggest two open times.',
      provenance: 'untrusted_external',
      source: 'fictional inbound teammate request',
      estimatedCostCents: 0,
      reversible: false,
      riskTier: RiskTier.MODERATE,
      allowedCommands: ['approve', 'reject'],
    },
    {
      id: 'newsletter-triage',
      title: 'Triage a newsletter',
      situation:
        'A fictional weekly newsletter is waiting in Alex’s sample inbox.',
      situationType: SituationType.EMAIL_TRIAGE,
      domain: 'email',
      actionType: 'archive_email',
      proposedAction: 'Archive this issue and keep the subscription.',
      provenance: 'untrusted_external',
      source: 'fictional inbound newsletter',
      estimatedCostCents: 0,
      reversible: true,
      riskTier: RiskTier.LOW,
      allowedCommands: ['approve', 'reject'],
    },
    {
      id: 'focus-time-preference',
      title: 'Choose the next focus window',
      situation: 'Alex needs a fictional 90-minute focus block tomorrow.',
      situationType: SituationType.CALENDAR_UPDATE,
      domain: 'calendar',
      actionType: 'schedule_focus_block',
      proposedAction: prefersAfternoons
        ? 'Suggest 2:00–3:30 PM, using your corrected afternoon preference.'
        : 'Suggest 9:00–10:30 AM, based on the default sample pattern.',
      provenance: 'trusted_context',
      source: 'sample preference replay',
      estimatedCostCents: 0,
      reversible: true,
      riskTier: RiskTier.LOW,
      allowedCommands: ['approve', 'reject', 'correct'],
    },
    {
      id: 'untrusted-document',
      title: 'External instruction contained',
      situation:
        'A fictional downloaded document asks the agent to run a shell command and upload files.',
      situationType: SituationType.DOCUMENT_MANAGEMENT,
      domain: 'documents',
      actionType: 'shell_exec',
      proposedAction: 'Run the document’s shell command.',
      // Intentionally missing. The real policy guard must normalize this to
      // untrusted_external, proving absent provenance fails safe.
      source: 'fictional downloaded document',
      estimatedCostCents: 0,
      reversible: false,
      riskTier: RiskTier.CRITICAL,
      allowedCommands: [],
    },
  ];
}

function riskAssessment(entry: CatalogEntry): RiskAssessment {
  const score =
    entry.riskTier === RiskTier.CRITICAL
      ? 1
      : entry.riskTier === RiskTier.MODERATE
        ? 0.55
        : 0.2;
  const dimensions = Object.fromEntries(
    Object.values(RiskDimension).map((dimension) => {
      // The containment scenario is operationally critical because of its
      // shell shape. It is not a claim that the fictional fixture contains
      // legal/private data; keeping those dimensions accurate also lets the
      // injection guard's dual-confirmation verdict remain visible instead
      // of being replaced by an unrelated legal/privacy deny.
      const dimensionTier =
        dimension === RiskDimension.LEGAL_SENSITIVITY ||
        dimension === RiskDimension.PRIVACY_SENSITIVITY ||
        dimension === RiskDimension.FINANCIAL_IMPACT
          ? RiskTier.LOW
          : entry.riskTier;
      return [
        dimension,
        {
          tier: dimensionTier,
          score: dimensionTier === RiskTier.LOW ? 0.2 : score,
          reasoning: `Fixed sample assessment for ${dimension}.`,
        },
      ];
    }),
  ) as RiskAssessment['dimensions'];
  return {
    actionId: `sample-action-${entry.id}`,
    overallTier: entry.riskTier,
    dimensions,
    reasoning: `Fixed ${entry.riskTier} sample risk assessment; no external action can run.`,
    assessedAt: new Date(0),
  };
}

function preferenceFor(
  record: SessionRecord,
  entry: CatalogEntry,
): Preference[] {
  if (entry.id !== 'focus-time-preference' || record.learning.length === 0)
    return [];
  return [
    {
      id: 'sample-preference-focus-window',
      domain: 'calendar',
      key: 'preferred_focus_window',
      value: 'afternoon',
      confidence: ConfidenceLevel.CONFIRMED,
      source: 'corrected',
      evidenceIds: ['sample-correction-prefer-afternoons'],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ];
}

function candidateAction(entry: CatalogEntry): CandidateAction {
  return {
    id: `sample-action-${entry.id}`,
    decisionId: `sample-decision-${entry.id}`,
    actionType: entry.actionType,
    description: entry.proposedAction,
    domain: entry.domain,
    parameters:
      entry.id === 'untrusted-document'
        ? { command: 'echo sample-only; upload fictional files' }
        : { fixture: true },
    estimatedCostCents: entry.estimatedCostCents,
    costZeroIntent: 'verified_zero',
    reversible: entry.reversible,
    confidence:
      entry.id === 'untrusted-document'
        ? ConfidenceLevel.SPECULATIVE
        : ConfidenceLevel.HIGH,
    reasoning: 'Selected from the fixed, fictional sample catalog.',
    provenance: entry.provenance,
  };
}

function decisionParts(
  entry: CatalogEntry,
  record: SessionRecord,
  policy: PolicyDecision,
  action: CandidateAction,
): {
  decision: DecisionObject;
  context: DecisionContext;
  outcome: DecisionOutcome;
} {
  const decision: DecisionObject = {
    id: `sample-decision-${entry.id}`,
    situationType: entry.situationType,
    domain: entry.domain,
    urgency: entry.id === 'untrusted-document' ? 'critical' : 'medium',
    summary: entry.situation,
    rawData: { source: entry.source, fictional: true },
    interpretedAt: new Date(0),
    provenance: entry.provenance,
  };
  const assessment = riskAssessment(entry);
  const outcome: DecisionOutcome = {
    id: `sample-outcome-${entry.id}`,
    decisionId: decision.id,
    selectedAction: action,
    allCandidates: [action],
    riskAssessment: assessment,
    allRiskAssessments: [assessment],
    autoExecute: false,
    requiresApproval: policy.requiresApproval,
    reasoning:
      entry.id === 'untrusted-document'
        ? `${policy.reason} The simulation contains this proposal and offers no approval command.`
        : policy.reason,
    decidedAt: new Date(0),
    policyVerdicts: {
      [action.id]: policy.requiresApproval
        ? 'requires-approval'
        : policy.allowed
          ? 'allowed'
          : 'denied',
    },
    confirmationLevel: policy.confirmationLevel,
  };
  const context: DecisionContext = {
    userId: DEMO_USER_ID,
    decision,
    trustTier: TrustTier.OBSERVER,
    relevantPreferences: preferenceFor(record, entry),
    timestamp: new Date(0),
  };
  return { decision, context, outcome };
}

function presentExplanation(
  record: Awaited<ReturnType<ExplanationGenerator['generate']>>,
): SampleSimulationExplanation {
  return {
    summary: record.summary,
    evidence: record.evidenceUsed.map(
      (item) => `${item.summary} — ${item.relevance}`,
    ),
    preferences: record.preferencesInvoked.map((item) => item.howUsed),
    confidenceReasoning: record.confidenceReasoning,
    actionRationale: record.actionRationale,
    escalationRationale: record.escalationRationale ?? null,
    correctionGuidance: record.correctionGuidance,
    riskTier: record.riskTier,
  };
}

function isKnownProposalId(
  value: unknown,
): value is SampleSimulationProposalId {
  return (
    value === 'calendar-focus' ||
    value === 'newsletter-triage' ||
    value === 'focus-time-preference' ||
    value === 'untrusted-document'
  );
}

export function parseSampleSimulationCommand(
  body: unknown,
): SampleSimulationCommand {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SampleSimulationCommandError(
      'Command body must be an object.',
      400,
    );
  }
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (value['type'] === 'reset') {
    if (keys.length !== 1)
      throw new SampleSimulationCommandError(
        'Reset accepts no other fields.',
        400,
      );
    return { type: 'reset' };
  }
  if (
    value['type'] !== 'approve' &&
    value['type'] !== 'reject' &&
    value['type'] !== 'correct'
  ) {
    throw new SampleSimulationCommandError('Unknown simulation command.', 400);
  }
  if (
    !isKnownProposalId(value['proposalId']) ||
    value['proposalId'] === 'untrusted-document'
  ) {
    throw new SampleSimulationCommandError(
      'Proposal is not available for that command.',
      400,
    );
  }
  if (value['type'] === 'correct') {
    if (
      value['proposalId'] !== 'focus-time-preference' ||
      value['correctionId'] !== 'prefer-afternoons' ||
      keys.length !== 3
    ) {
      throw new SampleSimulationCommandError('Unknown correction.', 400);
    }
    return {
      type: 'correct',
      proposalId: 'focus-time-preference',
      correctionId: 'prefer-afternoons',
    };
  }
  if (keys.length !== 2)
    throw new SampleSimulationCommandError(
      'Command has unexpected fields.',
      400,
    );
  return { type: value['type'], proposalId: value['proposalId'] };
}

export class SampleSimulationService {
  private readonly records = new Map<string, SessionRecord>();
  private readonly mutationGenerations = new Map<string, number>();
  private nextMutationGeneration = 0;
  private readonly terminal = new SampleSimulationTerminal();
  private readonly policy: Pick<PolicyEvaluator, 'evaluate'>;
  private readonly maxSessions: number;
  private readonly clock: () => number;
  private readonly explanations = new ExplanationGenerator(
    noPersistenceExplanationRepository,
  );

  constructor(
    policy?: Pick<PolicyEvaluator, 'evaluate'>,
    maxSessions = 1_000,
    clock: () => number = Date.now,
  ) {
    this.policy =
      policy ??
      new PolicyEvaluator(unusablePolicyRepository, { globallyPaused: false });
    this.maxSessions = maxSessions;
    this.clock = clock;
  }

  async getState(
    sessionKey: string,
    expiresAtMs: number,
    nowMs = this.clock(),
    signal?: AbortSignal,
  ): Promise<SampleSimulationStateResponse> {
    this.dropExpired(nowMs);
    this.assertActive(sessionKey, expiresAtMs, nowMs, signal);
    let record = this.records.get(sessionKey);
    if (!record) {
      record = makeRecord(expiresAtMs);
      this.putRecord(sessionKey, record);
    }
    const presented = await this.present(record, () =>
      this.assertActive(sessionKey, expiresAtMs, this.clock(), signal),
    );
    this.assertActive(sessionKey, expiresAtMs, this.clock(), signal);
    if (this.records.get(sessionKey) !== record) {
      throw new SampleSimulationCommandError(
        'The sample changed while this state was being prepared.',
        409,
      );
    }
    return presented;
  }

  async command(
    sessionKey: string,
    expiresAtMs: number,
    command: SampleSimulationCommand,
    nowMs = this.clock(),
    signal?: AbortSignal,
    beforeCommit: () => Promise<void> = async () => {},
  ): Promise<SampleSimulationStateResponse> {
    this.dropExpired(nowMs);
    this.assertActive(sessionKey, expiresAtMs, nowMs, signal);
    let existing = this.records.get(sessionKey);
    if (!existing) {
      existing = makeRecord(expiresAtMs);
      this.putRecord(sessionKey, existing);
    }
    if (command.type !== 'reset' && existing.statuses[command.proposalId] !== 'pending') {
      throw new SampleSimulationCommandError(
        'This fictional proposal has already been decided.',
        409,
      );
    }

    // Reserve the next publication without exposing staged state. A later
    // command replaces this generation and wins at the next async boundary.
    const mutationGeneration = ++this.nextMutationGeneration;
    this.mutationGenerations.set(sessionKey, mutationGeneration);
    const mutationIsCurrent = (): boolean =>
      this.records.get(sessionKey) === existing &&
      this.mutationGenerations.get(sessionKey) === mutationGeneration;

    try {
      if (command.type === 'reset') {
        const reset = makeRecord(expiresAtMs);
        const presented = await this.present(reset, () =>
          this.assertActive(sessionKey, expiresAtMs, this.clock(), signal),
        );
        this.assertActive(sessionKey, expiresAtMs, this.clock(), signal);
        if (!mutationIsCurrent()) {
          throw new SampleSimulationCommandError(
            'The sample changed while reset was being prepared.',
            409,
          );
        }
        await beforeCommit();
        this.assertActive(sessionKey, expiresAtMs, this.clock(), signal);
        if (!mutationIsCurrent()) {
          throw new SampleSimulationCommandError(
            'The sample changed while reset was being prepared.',
            409,
          );
        }
        this.putRecord(sessionKey, reset);
        return presented;
      }

      const entry = catalog(existing).find((item) => item.id === command.proposalId)!;
      // Freeze the proposal against pre-command state so later learning cannot
      // rewrite the explanation presented for this choice.
      const proposalBeforeCommand = await this.presentProposal(
        entry,
        existing,
        () => this.assertActive(sessionKey, existing.expiresAtMs, this.clock(), signal),
      );
      this.assertActive(sessionKey, existing.expiresAtMs, this.clock(), signal);
      if (!mutationIsCurrent() || existing.statuses[command.proposalId] !== 'pending') {
        throw new SampleSimulationCommandError(
          'The sample changed while this command was being checked.',
          409,
        );
      }

      const staged = cloneRecord(existing);
      if (command.type === 'approve') {
        if (!proposalBeforeCommand.policy.allowed) {
          throw new SampleSimulationCommandError(
            'The current policy outcome does not allow this simulated approval.',
            409,
          );
        }
        const receipt = this.terminal.complete(command.proposalId);
        if (receipt.externalEffects !== false || receipt.status !== 'simulated_completed') {
          throw new Error('Simulation terminal returned an unsafe receipt.');
        }
        staged.statuses[command.proposalId] = 'simulated_approved';
        staged.resultMessages[command.proposalId] =
          'Approved in simulation. No external action was sent.';
      } else if (command.type === 'reject') {
        staged.statuses[command.proposalId] = 'simulated_rejected';
        staged.resultMessages[command.proposalId] =
          'Rejected in simulation. Nothing was changed outside this session.';
      } else {
        staged.statuses[command.proposalId] = 'simulated_corrected';
        staged.learning = [{
          key: 'preferred_focus_window',
          value: 'afternoon',
          source: 'corrected',
        }];
        staged.resultMessages[command.proposalId] =
          'Correction learned for this sample session only.';
      }
      staged.proposalSnapshots[command.proposalId] = {
        ...proposalBeforeCommand,
        status: staged.statuses[command.proposalId],
        allowedCommands: [],
        correctionOptions: [],
        resultMessage: staged.resultMessages[command.proposalId] ?? null,
      };
      staged.revision += 1;
      const presented = await this.present(staged, () =>
        this.assertActive(sessionKey, expiresAtMs, this.clock(), signal),
      );
      this.assertActive(sessionKey, expiresAtMs, this.clock(), signal);
      if (!mutationIsCurrent() || existing.statuses[command.proposalId] !== 'pending') {
        throw new SampleSimulationCommandError(
          'The sample changed while this command was being checked.',
          409,
        );
      }
      await beforeCommit();
      this.assertActive(sessionKey, expiresAtMs, this.clock(), signal);
      if (!mutationIsCurrent() || existing.statuses[command.proposalId] !== 'pending') {
        throw new SampleSimulationCommandError(
          'The sample changed while this command was being checked.',
          409,
        );
      }
      this.putRecord(sessionKey, staged);
      return presented;
    } finally {
      if (this.mutationGenerations.get(sessionKey) === mutationGeneration) {
        this.mutationGenerations.delete(sessionKey);
      }
    }
  }

  discard(sessionKey: string): void {
    this.records.delete(sessionKey);
    this.mutationGenerations.delete(sessionKey);
  }

  hasSessionForTests(sessionKey: string): boolean {
    return this.records.has(sessionKey);
  }

  private dropExpired(nowMs: number): void {
    for (const [key, record] of this.records) {
      if (record.expiresAtMs <= nowMs) this.records.delete(key);
    }
  }

  private assertActive(
    sessionKey: string,
    expiresAtMs: number,
    nowMs: number,
    signal?: AbortSignal,
  ): void {
    if (expiresAtMs > nowMs && !signal?.aborted) return;
    this.records.delete(sessionKey);
    throw new SampleSimulationCommandError(
      signal?.aborted
        ? 'Sample session is no longer active. Restart the sample to continue.'
        : 'Sample session expired. Restart the sample to continue.',
      401,
    );
  }

  private putRecord(sessionKey: string, record: SessionRecord): void {
    if (
      !this.records.has(sessionKey) &&
      this.records.size >= this.maxSessions
    ) {
      throw new SampleSimulationCommandError(
        'The sample is busy. Reuse an existing session or try again later.',
        429,
      );
    }
    this.records.set(sessionKey, record);
  }

  private async present(
    record: SessionRecord,
    assertStillActive: () => void = () => {},
  ): Promise<SampleSimulationStateResponse> {
    const proposals: SampleSimulationProposal[] = [];
    for (const entry of catalog(record)) {
      assertStillActive();
      const snapshot = record.proposalSnapshots[entry.id];
      proposals.push(
        snapshot ??
          (await this.presentProposal(entry, record, assertStillActive)),
      );
      assertStillActive();
    }
    const changedByLearning = record.learning.length > 0;
    return {
      mode: 'simulation',
      sessionIsolated: true,
      revision: record.revision,
      proposals,
      learning: [...record.learning],
      nextPrediction: {
        label: 'Next fictional focus-block prediction',
        proposedAction: changedByLearning
          ? 'Suggest 2:00–3:30 PM, using your corrected afternoon preference.'
          : 'Suggest 9:00–10:30 AM, based on the default sample pattern.',
        changedByLearning,
      },
    };
  }

  private async presentProposal(
    entry: CatalogEntry,
    record: SessionRecord,
    assertStillActive: () => void = () => {},
  ): Promise<SampleSimulationProposal> {
    const assessment = riskAssessment(entry);
    const action = candidateAction(entry);
    const policy = await this.policy.evaluate(
      action,
      [],
      TrustTier.OBSERVER,
      assessment,
    );
    assertStillActive();
    const parts = decisionParts(entry, record, policy, action);
    const explanation = await this.explanations.generate(
      parts.decision,
      parts.outcome,
      parts.context,
    );
    assertStillActive();
    const normalizedProvenance = entry.provenance ?? 'untrusted_external';
    return {
      id: entry.id,
      title: entry.title,
      situation: entry.situation,
      proposedAction: entry.proposedAction,
      actionType: entry.actionType,
      status: record.statuses[entry.id],
      provenance: normalizedProvenance,
      provenanceNote: entry.provenance
        ? `Fixed fictional source: ${entry.source}.`
        : 'Source provenance was missing, so the policy boundary failed safe to untrusted external.',
      estimatedCostCents: entry.estimatedCostCents,
      reversible: entry.reversible,
      policy: {
        allowed: policy.allowed,
        requiresApproval: policy.requiresApproval,
        reason: policy.reason,
        confirmationLevel:
          policy.confirmationLevel ??
          (policy.requiresApproval ? 'single' : 'none'),
      },
      explanation: presentExplanation(explanation),
      allowedCommands:
        record.statuses[entry.id] === 'pending'
          ? entry.allowedCommands.filter(
              (command) => command !== 'approve' || policy.allowed,
            )
          : [],
      correctionOptions:
        entry.id === 'focus-time-preference' &&
        record.statuses[entry.id] === 'pending'
          ? [
              {
                id: 'prefer-afternoons',
                label: 'I prefer afternoons',
                learnedPreference: 'Prefer afternoon focus blocks.',
              },
            ]
          : [],
      resultMessage:
        record.resultMessages[entry.id] ??
        (entry.id === 'untrusted-document'
          ? 'Contained. This proposal has no approval path and cannot leave the simulation.'
          : null),
      simulationOnly: true,
      externalEffects: false,
    };
  }
}
