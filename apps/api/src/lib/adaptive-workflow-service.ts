import {
  signalRepository,
  userRepository,
  WorkflowProposalIdempotencyConflictError,
  workflowRepository,
  workflowWatchProjectionRepository,
} from '@skytwin/db';
import {
  compileSignalDigestV1,
  computeNextRun,
  diffSignalDigestV1,
  SIGNAL_DIGEST_V1_PROVIDER_KEY,
  SIGNAL_DIGEST_V1_SCHEMA_VERSION,
  simulateSignalDigestV1,
  type SignalDigestCompileResult,
  type SignalDigestDiffResult,
  type SignalDigestReplayResult,
  type SignalDigestReplaySimulation,
  type SignalDigestV1Payload,
} from '@skytwin/routines';
import type {
  AdaptiveWorkflow,
  AdaptiveWorkflowProposal,
  AdaptiveWorkflowVersion,
  WorkflowActivationEvent,
  WorkflowInferenceMetadataV1,
} from '@skytwin/shared-types';
import {
  AI_SUMMARY_UNAVAILABLE,
  workflowAuthoringService,
  type SignalDigestAuthoringResult,
  type WorkflowAuthoringReadiness,
  type WorkflowReplaySynthesis,
} from './workflow-authoring.js';

type WorkflowRepositoryPort = Pick<
  typeof workflowRepository,
  | 'createDraftWithProposal'
  | 'createVersionWithProposal'
  | 'getForUser'
  | 'listForUser'
  | 'getVersionForUser'
  | 'listVersionsForUser'
  | 'listProposalsForUser'
  | 'listActivationEventsForUser'
>;

type WorkflowAuthoringPort = Pick<
  typeof workflowAuthoringService,
  'authorSignalDigest' | 'reviseSignalDigest' | 'probeReadiness' | 'summarizeSignalDigestReplay'
>;

type SignalRepositoryPort = Pick<typeof signalRepository, 'listInWindowBounded'>;
type WorkflowProjectionRepositoryPort = Pick<
  typeof workflowWatchProjectionRepository,
  'materializeVersion'
>;
type UserLocaleRepositoryPort = Pick<typeof userRepository, 'getLocale'>;

export interface AdaptiveWorkflowServiceDependencies {
  repository?: WorkflowRepositoryPort;
  signals?: SignalRepositoryPort;
  projectionRepository?: WorkflowProjectionRepositoryPort;
  userLocales?: UserLocaleRepositoryPort;
  authoring?: WorkflowAuthoringPort;
  compileSignalDigest?: (input: unknown) => SignalDigestCompileResult;
  diffSignalDigest?: (before: unknown, after: unknown) => SignalDigestDiffResult;
  simulateSignalDigest?: (payload: unknown, records: readonly unknown[]) => SignalDigestReplaySimulation;
  now?: () => Date;
}

const REPLAY_LOOKBACK_HOURS = 7 * 24;
const MAX_REPLAY_SIGNALS = 2_000;

export interface WorkflowCandidateReplay {
  sourceReady: boolean;
  sourceReadyBasis: 'recent_signal_evidence';
  dataAccess: {
    kind: 'real_signals';
    status: 'available' | 'unavailable';
    synthetic: false;
    requestedSources: string[];
    observedSources: string[];
    recordsFound: number;
    recordsEvaluated: number;
    truncated: boolean;
  };
  window: {
    start: string;
    end: string;
    lookbackHours: typeof REPLAY_LOOKBACK_HOURS;
    bounds: '(start,end]';
  };
  schedule: {
    timezone: string;
    nextRunAt: string;
  };
  simulation: SignalDigestReplayResult | null;
  synthesis: WorkflowReplaySynthesis;
}

export type AuthorSignalDigestDraftResult =
  | {
    success: true;
    workflow: AdaptiveWorkflow;
    version: AdaptiveWorkflowVersion;
    proposal: AdaptiveWorkflowProposal;
    preview: {
      summaryInstruction: string;
      summaryInstructionPersisted: true;
      routineSpec: unknown;
      contentHash: string;
      watchProjection: 'not_materialized';
      replay: WorkflowCandidateReplay;
    };
  }
  | { success: false; kind: 'authoring'; failure: Exclude<SignalDigestAuthoringResult, { success: true }> }
  | { success: false; kind: 'compile'; issues: Extract<SignalDigestCompileResult, { ok: false }>['issues'] }
  | { success: false; kind: 'idempotency'; reason: 'idempotency_conflict' };

export type CreateWorkflowRevisionResult =
  | {
    success: true;
    workflow: AdaptiveWorkflow;
    parentVersion: AdaptiveWorkflowVersion;
    version: AdaptiveWorkflowVersion;
    proposal: AdaptiveWorkflowProposal;
    diff: Extract<SignalDigestDiffResult, { ok: true }>['diff'];
    replay: {
      before: WorkflowCandidateReplay;
      after: WorkflowCandidateReplay;
    };
    activePointerMoved: false;
  }
  | { success: false; kind: 'transition'; failure: Extract<WorkflowTransitionResult, { success: false }> }
  | { success: false; kind: 'compile'; issues: Extract<SignalDigestCompileResult, { ok: false }>['issues'] }
  | {
    success: false;
    kind: 'create_version';
    reason:
      | 'workflow_not_found'
      | 'parent_version_not_found'
      | 'active_version_conflict'
      | 'idempotency_conflict';
  };

export type CreateWorkflowFeedbackRevisionResult =
  | CreateWorkflowRevisionResult
  | { success: false; kind: 'authoring'; failure: Exclude<SignalDigestAuthoringResult, { success: true }> };

export type WorkflowTransitionResult =
  | {
    success: true;
    workflow: AdaptiveWorkflow;
    event: WorkflowActivationEvent;
    version: AdaptiveWorkflowVersion;
    preview: {
      routineSpec: unknown;
      contentHash: string;
      watchProjection: {
        state: 'materialized';
        watchId: string;
        nextRunAt: string;
        timezone: string;
      };
    };
  }
  | {
    success: false;
    reason:
      | 'workflow_not_found'
      | 'version_not_found'
      | 'unsupported_provider'
      | 'invalid_version'
      | 'proposal_not_found'
      | 'active_version_conflict'
      | 'not_previously_active'
      | 'projection_mismatch';
    issues?: Extract<SignalDigestCompileResult, { ok: false }>['issues'];
  };

function inferenceMetadata(
  result: Extract<SignalDigestAuthoringResult, { success: true }>,
): WorkflowInferenceMetadataV1 {
  return {
    version: 1,
    reasoningMode: result.inference.reasoningMode,
    provider: result.inference.provider,
    model: result.inference.model,
    runtimeVersion: result.inference.runtimeVersion,
    ...(result.inference.modelArtifactSha256 === undefined
      ? {}
      : { modelArtifactSha256: result.inference.modelArtifactSha256 }),
    promptVersion: `${result.inference.prompt.name}@${result.inference.prompt.version}`,
    outputSchemaVersion: `${result.inference.schema.name}@${result.inference.schema.version}`,
    requestSha256: result.inference.inputSha256,
    responseSha256: result.inference.outputSha256,
  };
}

function signalDigestPayload(
  result: Extract<SignalDigestAuthoringResult, { success: true }>,
  timezone?: string,
) {
  const intent = result.intent;
  return {
    name: intent.name,
    cadence: intent.cadence,
    action: 'digest' as const,
    filter: intent.filter,
    summaryInstruction: intent.summaryInstruction,
    ...(timezone === undefined ? {} : { timezone }),
    ...(intent.hourOfDay === null ? {} : { hourOfDay: intent.hourOfDay }),
    ...(intent.dayOfWeek === null ? {} : { dayOfWeek: intent.dayOfWeek }),
  };
}

function inheritScheduleTimezone(input: unknown, fallback: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  return record['timezone'] === undefined ? { ...record, timezone: fallback } : input;
}

function canonicalPayload(
  compiled: Extract<SignalDigestCompileResult, { ok: true }>,
): SignalDigestV1Payload {
  // The compiler emits canonical JSON only after strict provider validation.
  // Persist that exact normalized value so the durable hash covers synthesis
  // intent as well as the current Watch/RoutineSpec projection.
  return JSON.parse(compiled.artifact.canonicalPayloadJson) as SignalDigestV1Payload;
}

export function createAdaptiveWorkflowService(
  dependencies: AdaptiveWorkflowServiceDependencies = {},
) {
  const repository = dependencies.repository ?? workflowRepository;
  const signals = dependencies.signals ?? signalRepository;
  const projectionRepository = dependencies.projectionRepository
    ?? workflowWatchProjectionRepository;
  const userLocales = dependencies.userLocales ?? userRepository;
  const authoring = dependencies.authoring ?? workflowAuthoringService;
  const compile = dependencies.compileSignalDigest ?? compileSignalDigestV1;
  const diff = dependencies.diffSignalDigest ?? diffSignalDigestV1;
  const simulate = dependencies.simulateSignalDigest ?? simulateSignalDigestV1;
  const now = dependencies.now ?? (() => new Date());

  function replayWindow() {
    const end = now();
    const start = new Date(end.getTime() - REPLAY_LOOKBACK_HOURS * 60 * 60 * 1_000);
    return {
      start,
      end,
      metadata: {
        start: start.toISOString(),
        end: end.toISOString(),
        lookbackHours: REPLAY_LOOKBACK_HOURS,
        bounds: '(start,end]' as const,
      },
    };
  }

  async function replaysForCandidates(
    userId: string,
    candidates: readonly SignalDigestV1Payload[],
  ): Promise<WorkflowCandidateReplay[]> {
    const window = replayWindow();
    const locale = await userLocales.getLocale(userId).catch(() => ({
      language: null,
      timezone: null,
    }));
    const scheduleFor = (candidate: SignalDigestV1Payload) => {
      const timezone = candidate.timezone ?? locale.timezone ?? 'UTC';
      return {
        timezone,
        nextRunAt: computeNextRun(candidate, window.end, timezone).toISOString(),
      };
    };
    let records: readonly unknown[];
    let recordsFound: number;
    let truncated: boolean;
    try {
      const bounded = await signals.listInWindowBounded(
        userId,
        window.start,
        window.end,
        MAX_REPLAY_SIGNALS,
      );
      records = bounded.records;
      recordsFound = bounded.totalCount;
      truncated = bounded.truncated;
    } catch {
      return candidates.map((candidate) => ({
        sourceReady: false,
        sourceReadyBasis: 'recent_signal_evidence',
        dataAccess: {
          kind: 'real_signals',
          status: 'unavailable',
          synthetic: false,
          requestedSources: [...(candidate.filter.sources ?? [])],
          observedSources: [],
          recordsFound: 0,
          recordsEvaluated: 0,
          truncated: false,
        },
        window: window.metadata,
        schedule: scheduleFor(candidate),
        simulation: null,
        synthesis: { available: false, text: AI_SUMMARY_UNAVAILABLE },
      }));
    }

    const observedSources = [...new Set(records.flatMap((record) => {
      if (typeof record !== 'object' || record === null || Array.isArray(record)) return [];
      const source = (record as Record<string, unknown>)['source'];
      return typeof source === 'string' && source.trim() ? [source.trim()] : [];
    }))].sort().slice(0, 32);
    return Promise.all(candidates.map(async (candidate) => {
      const replay = simulate(candidate, records);
      const simulation = replay.ok ? replay.result : null;
      const requestedSources = new Set(candidate.filter.sources ?? []);
      const sourceReady = records.some((record) => {
        if (requestedSources.size === 0) return true;
        if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
        const source = (record as Record<string, unknown>)['source'];
        return typeof source === 'string' && requestedSources.has(source);
      });
      let synthesis: WorkflowReplaySynthesis = {
        available: false,
        text: AI_SUMMARY_UNAVAILABLE,
      };
      if (simulation) {
        try {
          synthesis = await authoring.summarizeSignalDigestReplay(userId, {
            summaryInstruction: candidate.summaryInstruction,
            replay: simulation,
          });
        } catch {
          // Deterministic matching and citations remain usable when inference
          // is unavailable or a provider returns a malformed synthesis.
        }
      }
      return {
        sourceReady,
        sourceReadyBasis: 'recent_signal_evidence' as const,
        dataAccess: {
          kind: 'real_signals' as const,
          status: 'available' as const,
          synthetic: false as const,
          requestedSources: [...(candidate.filter.sources ?? [])],
          observedSources,
          recordsFound,
          recordsEvaluated: records.length,
          truncated,
        },
        window: window.metadata,
        schedule: scheduleFor(candidate),
        simulation,
        synthesis,
      };
    }));
  }

  async function readiness(userId: string): Promise<WorkflowAuthoringReadiness> {
    return authoring.probeReadiness(userId);
  }

  async function authorSignalDigestDraft(input: {
    userId: string;
    description: string;
    allowClarification?: boolean;
    idempotencyKey: string;
  }): Promise<AuthorSignalDigestDraftResult> {
    const authored = await authoring.authorSignalDigest(input.userId, input.description, {
      allowClarification: input.allowClarification,
    });
    if (!authored.success) {
      return { success: false, kind: 'authoring', failure: authored };
    }

    const locale = await userLocales.getLocale(input.userId).catch(() => ({
      language: null,
      timezone: null,
    }));
    const compiled = compile(signalDigestPayload(authored, locale.timezone ?? 'UTC'));
    if (!compiled.ok) return { success: false, kind: 'compile', issues: compiled.issues };

    let created: Awaited<ReturnType<WorkflowRepositoryPort['createDraftWithProposal']>>;
    try {
      created = await repository.createDraftWithProposal({
        userId: input.userId,
        providerKey: compiled.artifact.providerKey,
        providerSchemaVersion: compiled.artifact.providerSchemaVersion,
        payload: canonicalPayload(compiled),
        authoring: { version: 1, source: 'llm_assisted', sourceReferences: [] },
        inference: inferenceMetadata(authored),
        kind: 'initial',
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: JSON.stringify({
          operation: 'signal_digest_draft',
          description: input.description,
          allowClarification: input.allowClarification ?? true,
        }),
      });
    } catch (error) {
      if (error instanceof WorkflowProposalIdempotencyConflictError) {
        return { success: false, kind: 'idempotency', reason: 'idempotency_conflict' };
      }
      throw error;
    }
    if (created.version.contentHash !== compiled.artifact.contentHash) {
      throw new Error('workflow_compiler_persistence_hash_mismatch');
    }

    const [replay] = await replaysForCandidates(input.userId, [canonicalPayload(compiled)]);

    return {
      success: true,
      workflow: created.workflow,
      version: created.version,
      proposal: created.proposal,
      preview: {
        summaryInstruction: authored.intent.summaryInstruction,
        summaryInstructionPersisted: true,
        routineSpec: compiled.artifact.routineSpec,
        contentHash: compiled.artifact.contentHash,
        watchProjection: 'not_materialized',
        replay: replay!,
      },
    };
  }

  async function createRevision(input: {
    userId: string;
    workflowId: string;
    parentVersionId: string;
    payload: unknown;
    proposalKind?: 'edit' | 'feedback';
    authoringSource?: 'user' | 'llm_assisted';
    inference?: WorkflowInferenceMetadataV1 | null;
    idempotencyKey: string;
    requestFingerprint?: string;
  }): Promise<CreateWorkflowRevisionResult> {
    const parent = await loadCompiledVersion(
      input.userId,
      input.workflowId,
      input.parentVersionId,
    );
    if (!parent.success) return { success: false, kind: 'transition', failure: parent };

    const candidate = compile(inheritScheduleTimezone(
      input.payload,
      parent.compiled.artifact.scheduleTimezone ?? 'UTC',
    ));
    if (!candidate.ok) return { success: false, kind: 'compile', issues: candidate.issues };
    const candidatePayload = canonicalPayload(candidate);
    const authoritativeDiff = diff(parent.version.canonicalPayload, candidatePayload);
    if (!authoritativeDiff.ok) {
      return {
        success: false,
        kind: 'transition',
        failure: { success: false, reason: 'invalid_version' },
      };
    }
    const [beforeReplay, afterReplay] = await replaysForCandidates(input.userId, [
      authoritativeDiff.before,
      authoritativeDiff.after,
    ]);

    const created = await repository.createVersionWithProposal({
      userId: input.userId,
      workflowId: input.workflowId,
      parentVersionId: input.parentVersionId,
      providerSchemaVersion: candidate.artifact.providerSchemaVersion,
      payload: candidatePayload,
      authoring: {
        version: 1,
        source: input.authoringSource ?? 'user',
        sourceReferences: [],
      },
      inference: input.inference ?? null,
      kind: input.proposalKind ?? 'edit',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint ?? JSON.stringify({
        operation: 'workflow_revision',
        workflowId: input.workflowId,
        parentVersionId: input.parentVersionId,
        payload: candidatePayload,
      }),
    });
    if (!created.success) return { success: false, kind: 'create_version', reason: created.reason };
    if (created.version.contentHash !== candidate.artifact.contentHash) {
      throw new Error('workflow_compiler_persistence_hash_mismatch');
    }

    return {
      success: true,
      workflow: parent.workflow,
      parentVersion: parent.version,
      version: created.version,
      proposal: created.proposal,
      diff: authoritativeDiff.diff,
      replay: { before: beforeReplay!, after: afterReplay! },
      activePointerMoved: false,
    };
  }

  async function reviseFromFeedback(input: {
    userId: string;
    workflowId: string;
    parentVersionId: string;
    feedback: string;
    idempotencyKey: string;
  }): Promise<CreateWorkflowFeedbackRevisionResult> {
    const parent = await loadCompiledVersion(
      input.userId,
      input.workflowId,
      input.parentVersionId,
    );
    if (!parent.success) return { success: false, kind: 'transition', failure: parent };
    const authored = await authoring.reviseSignalDigest(
      input.userId,
      parent.version.canonicalPayload,
      input.feedback,
    );
    if (!authored.success) {
      return { success: false, kind: 'authoring', failure: authored };
    }
    return createRevision({
      userId: input.userId,
      workflowId: input.workflowId,
      parentVersionId: input.parentVersionId,
      payload: signalDigestPayload(
        authored,
        parent.compiled.artifact.scheduleTimezone ?? 'UTC',
      ),
      proposalKind: 'feedback',
      authoringSource: 'llm_assisted',
      inference: inferenceMetadata(authored),
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: JSON.stringify({
        operation: 'workflow_feedback_revision',
        workflowId: input.workflowId,
        parentVersionId: input.parentVersionId,
        feedback: input.feedback,
      }),
    });
  }

  async function list(userId: string): Promise<AdaptiveWorkflow[]> {
    return repository.listForUser(userId);
  }

  async function detail(userId: string, workflowId: string) {
    const workflow = await repository.getForUser(workflowId, userId);
    if (!workflow) return null;
    const [versions, proposals, activationEvents] = await Promise.all([
      repository.listVersionsForUser(workflowId, userId),
      repository.listProposalsForUser(workflowId, userId),
      repository.listActivationEventsForUser(workflowId, userId),
    ]);
    return {
      workflow,
      versions,
      proposals,
      activationEvents,
      activeVersion: workflow.activeVersionId === null
        ? null
        : versions.find((version) => version.id === workflow.activeVersionId) ?? null,
    };
  }

  async function versions(userId: string, workflowId: string) {
    const workflow = await repository.getForUser(workflowId, userId);
    if (!workflow) return null;
    return repository.listVersionsForUser(workflowId, userId);
  }

  /** Rebuild the newest still-activatable proposal after reload or a lost response. */
  async function resumableDraft(userId: string) {
    const workflows = await repository.listForUser(userId);
    const candidates = (await Promise.all(workflows.map(async (workflow) => {
      const [versions, proposals, activationEvents] = await Promise.all([
        repository.listVersionsForUser(workflow.id, userId),
        repository.listProposalsForUser(workflow.id, userId),
        repository.listActivationEventsForUser(workflow.id, userId),
      ]);
      const consumedProposalIds = new Set(activationEvents
        .filter((event) => event.kind === 'activate' && event.proposalId !== null)
        .map((event) => event.proposalId));
      const proposal = proposals.find((entry) =>
        entry.baseVersionId === workflow.activeVersionId
        && entry.proposedVersionId !== workflow.activeVersionId
        && !consumedProposalIds.has(entry.id));
      if (!proposal) return null;
      const version = versions.find((entry) => entry.id === proposal.proposedVersionId);
      if (!version) return null;
      const compiled = compile(version.canonicalPayload);
      if (!compiled.ok || compiled.artifact.contentHash !== version.contentHash) return null;
      return { workflow, version, proposal, versions, compiled };
    })))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) =>
        right.proposal.createdAt.getTime() - left.proposal.createdAt.getTime())[0];
    if (!candidates) return null;

    const compiled = candidates.compiled;
    const proposedPayload = canonicalPayload(compiled);
    if (candidates.workflow.activeVersionId === null) {
      const [replay] = await replaysForCandidates(userId, [proposedPayload]);
      return {
        kind: 'initial' as const,
        workflow: candidates.workflow,
        version: candidates.version,
        proposal: candidates.proposal,
        preview: {
          summaryInstruction: proposedPayload.summaryInstruction,
          summaryInstructionPersisted: true as const,
          routineSpec: compiled.artifact.routineSpec,
          contentHash: compiled.artifact.contentHash,
          watchProjection: 'not_materialized' as const,
          replay: replay!,
        },
      };
    }

    const parentVersion = candidates.versions.find(
      (entry) => entry.id === candidates.workflow.activeVersionId,
    );
    if (!parentVersion) return null;
    const authoritativeDiff = diff(parentVersion.canonicalPayload, proposedPayload);
    if (!authoritativeDiff.ok) return null;
    const [beforeReplay, afterReplay] = await replaysForCandidates(userId, [
      authoritativeDiff.before,
      authoritativeDiff.after,
    ]);
    return {
      kind: 'revision' as const,
      workflow: candidates.workflow,
      parentVersion,
      version: candidates.version,
      proposal: candidates.proposal,
      diff: authoritativeDiff.diff,
      replay: { before: beforeReplay!, after: afterReplay! },
      activePointerMoved: false as const,
      preview: {
        summaryInstruction: proposedPayload.summaryInstruction,
        routineSpec: compiled.artifact.routineSpec,
        contentHash: compiled.artifact.contentHash,
        replay: afterReplay!,
      },
    };
  }

  async function loadCompiledVersion(
    userId: string,
    workflowId: string,
    versionId: string,
  ): Promise<
    | { success: true; workflow: AdaptiveWorkflow; version: AdaptiveWorkflowVersion; compiled: Extract<SignalDigestCompileResult, { ok: true }> }
    | Extract<WorkflowTransitionResult, { success: false }>
  > {
    const workflow = await repository.getForUser(workflowId, userId);
    if (!workflow) return { success: false, reason: 'workflow_not_found' };
    if (workflow.providerKey !== SIGNAL_DIGEST_V1_PROVIDER_KEY) {
      return { success: false, reason: 'unsupported_provider' };
    }
    const version = await repository.getVersionForUser(versionId, workflowId, userId);
    if (!version) return { success: false, reason: 'version_not_found' };
    if (version.providerSchemaVersion !== SIGNAL_DIGEST_V1_SCHEMA_VERSION) {
      return { success: false, reason: 'invalid_version' };
    }
    const compiled = compile(version.canonicalPayload);
    if (!compiled.ok) {
      return { success: false, reason: 'invalid_version', issues: compiled.issues };
    }
    if (compiled.artifact.contentHash !== version.contentHash) {
      return { success: false, reason: 'invalid_version' };
    }
    return { success: true, workflow, version, compiled };
  }

  async function activate(input: {
    userId: string;
    workflowId: string;
    versionId: string;
    expectedActiveVersionId: string | null;
    proposalId: string;
  }): Promise<WorkflowTransitionResult> {
    const loaded = await loadCompiledVersion(input.userId, input.workflowId, input.versionId);
    if (!loaded.success) return loaded;
    const locale = await userLocales.getLocale(input.userId).catch(() => ({
      language: null,
      timezone: null,
    }));
    const timezone = loaded.compiled.artifact.scheduleTimezone ?? locale.timezone ?? 'UTC';
    const nextRunAt = computeNextRun(loaded.compiled.artifact.routineSpec, now(), timezone);
    const transitioned = await projectionRepository.materializeVersion({
      ...input,
      kind: 'activate',
      sourceText: loaded.compiled.artifact.routineSpec.name,
      nextRunAt,
    });
    if (!transitioned.success) return transitioned;
    return {
      success: true,
      workflow: transitioned.workflow,
      event: transitioned.event,
      version: loaded.version,
      preview: {
        routineSpec: loaded.compiled.artifact.routineSpec,
        contentHash: loaded.compiled.artifact.contentHash,
        watchProjection: {
          state: 'materialized',
          watchId: transitioned.watchId,
          nextRunAt: nextRunAt.toISOString(),
          timezone,
        },
      },
    };
  }

  async function rollbackWorkflowVersion(input: {
    userId: string;
    workflowId: string;
    versionId: string;
    expectedActiveVersionId: string;
  }): Promise<WorkflowTransitionResult> {
    if (input.versionId === input.expectedActiveVersionId) {
      return { success: false, reason: 'not_previously_active' };
    }
    const loaded = await loadCompiledVersion(input.userId, input.workflowId, input.versionId);
    if (!loaded.success) return loaded;
    const locale = await userLocales.getLocale(input.userId).catch(() => ({
      language: null,
      timezone: null,
    }));
    const timezone = loaded.compiled.artifact.scheduleTimezone ?? locale.timezone ?? 'UTC';
    const nextRunAt = computeNextRun(loaded.compiled.artifact.routineSpec, now(), timezone);
    const transitioned = await projectionRepository.materializeVersion({
      ...input,
      kind: 'rollback',
      sourceText: loaded.compiled.artifact.routineSpec.name,
      nextRunAt,
    });
    if (!transitioned.success) return transitioned;
    return {
      success: true,
      workflow: transitioned.workflow,
      event: transitioned.event,
      version: loaded.version,
      preview: {
        routineSpec: loaded.compiled.artifact.routineSpec,
        contentHash: loaded.compiled.artifact.contentHash,
        watchProjection: {
          state: 'materialized',
          watchId: transitioned.watchId,
          nextRunAt: nextRunAt.toISOString(),
          timezone,
        },
      },
    };
  }

  return Object.freeze({
    readiness,
    authorSignalDigestDraft,
    createRevision,
    reviseFromFeedback,
    list,
    detail,
    versions,
    resumableDraft,
    activate,
    rollbackWorkflowVersion,
  });
}

export const adaptiveWorkflowService = createAdaptiveWorkflowService();
