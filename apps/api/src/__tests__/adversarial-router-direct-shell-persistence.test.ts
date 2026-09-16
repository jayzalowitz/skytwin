import express from "express";
import type { Express } from "express";
import { expect, it, vi } from "vitest";
import {
  AdapterRegistry,
  DIRECT_TRUST_PROFILE,
  ExecutionRouter,
  InvariantViolationError,
} from "@skytwin/execution-router";
import type { IronClawAdapter } from "@skytwin/ironclaw-adapter";
import type {
  CandidateAction,
  ExecutionPlan,
  ExplanationRecord,
  RiskAssessment,
  RollbackResult,
} from "@skytwin/shared-types";
import {
  ConfidenceLevel,
  RiskDimension,
  RiskTier,
} from "@skytwin/shared-types";

const mocks = vi.hoisted(() => ({
  interpret: vi.fn(),
  evaluate: vi.fn(),
  reevaluate: vi.fn(),
  generateExplanation: vi.fn(),
  findDecision: vi.fn(),
  saveDecision: vi.fn(),
  saveCandidates: vi.fn(),
  saveOutcome: vi.fn(),
  getOutcome: vi.fn(),
  getRiskAssessment: vi.fn(),
  getExplanation: vi.fn(),
  createReceipts: vi.fn(),
  getContinuation: vi.fn(),
  claimExecution: vi.fn(),
  recordPreparationDisposition: vi.fn(),
  getRouter: vi.fn(),
  findUser: vi.fn(),
  getProviders: vi.fn(),
  recordSignal: vi.fn(),
  createApproval: vi.fn(),
}));

vi.mock("@skytwin/decision-engine", () => ({
  SituationInterpreter: vi.fn(function SituationInterpreter() {
    return { interpret: mocks.interpret };
  }),
  DecisionMaker: vi.fn(function DecisionMaker() {
    return {
      evaluate: mocks.evaluate,
      reevaluatePreparedCandidates: mocks.reevaluate,
    };
  }),
  LlmSituationStrategy: vi.fn(),
  LlmCandidateGenerator: vi.fn(),
  FallbackSituationStrategy: vi.fn(),
  FallbackCandidateGenerator: vi.fn(),
  RuleBasedCandidateGenerator: vi.fn(),
  SenderAwareCandidateGenerator: vi.fn(),
  CompositeCandidateGenerator: vi.fn(),
}));

vi.mock("@skytwin/twin-model", () => ({
  TwinService: vi.fn(function TwinService() {
    return {
      getOrCreateProfile: vi.fn().mockResolvedValue({}),
      getRelevantPreferences: vi.fn().mockResolvedValue([]),
      getPatterns: vi.fn().mockResolvedValue([]),
      getTraits: vi.fn().mockResolvedValue([]),
      getTemporalProfile: vi.fn().mockResolvedValue({}),
    };
  }),
}));

vi.mock("@skytwin/policy-engine", () => ({
  PolicyEvaluator: vi.fn(function PolicyEvaluator() {
    return {
      evaluate: vi
        .fn()
        .mockResolvedValue({ allowed: true, requiresApproval: false }),
    };
  }),
}));

vi.mock("@skytwin/explanations", () => ({
  ExplanationGenerator: vi.fn(function ExplanationGenerator() {
    return { generate: mocks.generateExplanation };
  }),
}));

vi.mock("@skytwin/db", () => ({
  approvalRepository: {
    create: mocks.createApproval,
    findByDecisionId: vi.fn(),
  },
  oauthRepository: { getToken: vi.fn() },
  executionRepository: {
    createPlan: vi.fn(),
    createEvent: vi.fn(),
    updatePlanStatus: vi.fn(),
    createResult: vi.fn(),
    getByDecisionId: vi.fn(),
  },
  executionAdmissionRepository: {
    recordPolicyDenial: vi.fn(),
    recordReceiptPreparationDisposition: mocks.recordPreparationDisposition,
    findReceiptExecutionDisposition: vi.fn(),
  },
  userRepository: { findById: mocks.findUser },
  aiProviderRepository: { getEnabledForUser: mocks.getProviders },
  inferenceReceiptRepository: {
    createManyForUser: mocks.createReceipts,
    getContinuationForDecision: mocks.getContinuation,
    claimExecutionForDecision: mocks.claimExecution,
    isExecutionDispatchableForDecision: vi.fn(),
    markExecutionTerminalForDecision: vi.fn(),
    markExecutionFailedBeforeDispatchForDecision: vi.fn(),
    markNonEffectForDecision: vi.fn(),
    escalateExecutionToApproval: vi.fn(),
  },
  emailLabelRepository: {
    topLabelsForSender: vi.fn().mockResolvedValue([]),
    topLabelsForListId: vi.fn().mockResolvedValue([]),
  },
  mempalaceRepository: { getEpisodes: vi.fn().mockResolvedValue([]) },
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  decisionRepositoryAdapter: {
    findBySignalId: mocks.findDecision,
    saveDecision: mocks.saveDecision,
    saveCandidates: mocks.saveCandidates,
    saveOutcome: mocks.saveOutcome,
    getOutcome: mocks.getOutcome,
    getRiskAssessment: mocks.getRiskAssessment,
  },
  explanationRepositoryAdapter: { getByDecisionId: mocks.getExplanation },
  policyRepositoryAdapter: { getAllPolicies: vi.fn().mockResolvedValue([]) },
  getPolicyAuthorityRevision: vi.fn().mockResolvedValue("policy-revision-1"),
}));

vi.mock("@skytwin/llm-client", () => ({
  LlmClient: vi.fn(),
  emitInferenceReceipt: vi.fn(),
  snapshotInferenceTrace: vi.fn((trace: unknown) => structuredClone(trace)),
}));

vi.mock("../lib/user-llm-client.js", () => ({
  resolveUserLlmClient: vi.fn(async () => {
    await mocks.getProviders();
    return {
      state: "no_provider",
      client: null,
      reason: "No provider in test",
    };
  }),
}));
vi.mock("../workflows/registry.js", () => ({
  WorkflowHandlerRegistry: vi.fn(function WorkflowHandlerRegistry() {
    return { register: vi.fn() };
  }),
}));
vi.mock("../workflows/calendar-conflict.js", () => ({
  processCalendarConflict: vi.fn(),
}));
vi.mock("../workflows/subscription-renewal.js", () => ({
  processSubscriptionRenewal: vi.fn(),
}));
vi.mock("../workflows/grocery-reorder.js", () => ({
  processGroceryReorder: vi.fn(),
}));
vi.mock("../workflows/travel-decision.js", () => ({
  processTravelDecision: vi.fn(),
}));
vi.mock("../execution-setup.js", () => ({
  getExecutionRouter: mocks.getRouter,
}));
vi.mock("../middleware/require-ownership.js", () => ({
  bindUserIdParamOwnership: vi.fn(),
}));
vi.mock("../sse.js", () => ({ sseManager: { emit: vi.fn() } }));
vi.mock("../memory-setup.js", () => ({
  getMemoryPortForUser: vi.fn(async () => ({
    port: {
      recordSignal: mocks.recordSignal,
      searchSemantic: vi.fn().mockResolvedValue([]),
    },
    hybrid: null,
  })),
}));

import { createEventsRouter } from "../routes/events.js";

const userId = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const mappedScenario = {
  runtimeEntryPath: "execution_router.pre_dispatch_guard",
  adapter: "direct",
  criticalShape: "shell",
  action: { actionType: "shell_exec", reversible: false, parameters: {} },
  origin: { kind: "web", source: "web_page" },
  provenance: "untrusted_external",
} as const;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/events", createEventsRouter());
  app.use(
    (
      error: Error,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      response.status(500).json({ error: error.message });
    },
  );
  return app;
}

async function post(
  app: Express,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine test port"));
        return;
      }
      fetch(`http://127.0.0.1:${address.port}/api/events/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (response) => {
          const responseBody = await response.json();
          server.close();
          resolve({ status: response.status, body: responseBody });
        })
        .catch((error) => {
          server.close();
          reject(error);
        });
    });
  });
}

function risk(actionId: string): RiskAssessment {
  const low = {
    tier: RiskTier.LOW,
    score: 0.1,
    reasoning: "Adversarial fixture",
  };
  return {
    actionId,
    overallTier: RiskTier.LOW,
    dimensions: {
      [RiskDimension.REVERSIBILITY]: low,
      [RiskDimension.FINANCIAL_IMPACT]: low,
      [RiskDimension.LEGAL_SENSITIVITY]: low,
      [RiskDimension.PRIVACY_SENSITIVITY]: low,
      [RiskDimension.RELATIONSHIP_SENSITIVITY]: low,
      [RiskDimension.OPERATIONAL_RISK]: low,
    },
    reasoning: "Low input risk must not bypass the router backstop.",
    assessedAt: new Date("2026-09-15T00:00:00.000Z"),
  };
}

it("adv-v1-router-direct-shell-persisted links the generated explanation before router refusal", async () => {
  vi.clearAllMocks();
  const lifecycle: string[] = [];
  const candidate: CandidateAction = {
    id: "action-1",
    decisionId: "decision-1",
    ...mappedScenario.action,
    description: "Run a shell command from web content",
    domain: "system",
    estimatedCostCents: 0,
    confidence: ConfidenceLevel.HIGH,
    reasoning: "Adversarial source-checkout regression",
    provenance: mappedScenario.provenance,
  };
  const assessment = risk(candidate.id);
  const outcome = {
    id: "outcome-1",
    decisionId: "decision-1",
    selectedAction: candidate,
    allCandidates: [candidate],
    riskAssessment: assessment,
    allRiskAssessments: [assessment],
    autoExecute: true,
    requiresApproval: false,
    reasoning: "Injected upstream regression attempted automatic execution.",
    decidedAt: new Date("2026-09-15T00:00:00.000Z"),
    policyVerdicts: { [candidate.id]: "allowed" as const },
  };
  const explanation: ExplanationRecord = {
    id: "explanation-1",
    decisionId: "decision-1",
    userId,
    summary:
      "The action was selected but still must pass the dispatch boundary.",
    evidenceUsed: [],
    preferencesInvoked: [],
    confidenceReasoning: "The adversarial fixture is deterministic.",
    actionRationale: "Exercise the router's independent pre-dispatch guard.",
    correctionGuidance: "Reject the unsafe action or correct its provenance.",
    riskTier: RiskTier.LOW,
    overallConfidence: ConfidenceLevel.HIGH,
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
  };
  const buildPlan = vi.fn<IronClawAdapter["buildPlan"]>(
    async (): Promise<ExecutionPlan> => ({
      id: "direct-plan",
      decisionId: candidate.decisionId,
      action: candidate,
      steps: [],
      rollbackSteps: [],
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
    }),
  );
  const execute = vi.fn<IronClawAdapter["execute"]>();
  const prepareRequestStart =
    vi.fn<NonNullable<IronClawAdapter["prepareRequestStart"]>>();
  const adapter: IronClawAdapter = {
    buildPlan,
    prepareRequestStart,
    execute,
    async getStatus() {
      return "completed";
    },
    async rollback(): Promise<RollbackResult> {
      return { success: true, message: "rolled back" };
    },
    async healthCheck() {
      return { healthy: true, latencyMs: 1 };
    },
  };
  const registry = new AdapterRegistry();
  registry.register("direct", adapter, DIRECT_TRUST_PROFILE);
  const actualRouter = new ExecutionRouter(registry, {
    async start() {
      return {
        success: true as const,
        grant: {
          capability: "capability",
          leaseGeneration: "generation",
          expiresAt: new Date(),
        },
      };
    },
    async terminalize() {
      return true;
    },
  });
  let guardError: unknown;
  const originalPrepare = actualRouter.prepareExecution.bind(actualRouter);
  vi.spyOn(actualRouter, "prepareExecution").mockImplementation(
    async (...args) => {
      lifecycle.push("router-prepare");
      try {
        return await originalPrepare(...args);
      } catch (error) {
        guardError = error;
        throw error;
      }
    },
  );
  mocks.getRouter.mockResolvedValue(actualRouter);
  mocks.findDecision.mockResolvedValue(null);
  mocks.getProviders.mockResolvedValue([]);
  mocks.interpret.mockResolvedValue({
    id: "decision-1",
    situationType: "generic",
    domain: "system",
    urgency: "high",
    summary: "Untrusted web request",
    rawData: { source: "web_page" },
    provenance: "untrusted_external",
    interpretedAt: new Date("2026-09-15T00:00:00.000Z"),
  });
  mocks.saveDecision.mockImplementation(async (decision: unknown) => ({
    decision,
    created: true,
  }));
  mocks.evaluate.mockResolvedValue(outcome);
  mocks.generateExplanation.mockImplementation(async () => {
    lifecycle.push("explanation-generated");
    return explanation;
  });
  let capturedReceiptFinalization:
    | {
        decisionId: string;
        explanationId: string;
        continuationKind: string;
        confirmationLevel: string | null;
        continuation: {
          outcome: typeof outcome;
          explanation: ExplanationRecord;
        };
      }
    | undefined;
  mocks.createReceipts.mockImplementation(
    async (
      _owner: unknown,
      inputs: unknown[],
      completion: typeof capturedReceiptFinalization,
    ) => {
      if (!completion) {
        throw new Error("Receipt finalization metadata is required");
      }
      if (
        completion.explanationId !== explanation.id ||
        completion.continuation.explanation !== explanation
      ) {
        throw new Error(
          "Receipt finalization did not capture the generated explanation",
        );
      }
      lifecycle.push("receipt-finalized");
      capturedReceiptFinalization = structuredClone(completion);
      return { receipts: inputs, continuation: completion.continuation };
    },
  );
  mocks.findUser.mockResolvedValue({
    id: userId,
    trust_tier: "high_autonomy",
    autonomy_settings: {},
    execution_authority_revision: "authority-revision-1",
    ironclaw_channel: "skytwin",
  });
  mocks.recordSignal.mockResolvedValue(undefined);
  const durableDisposition = {
    explanationId: "router-refusal-explanation-1",
    kind: "execution_preparation_refusal",
    status: "failed",
    reason: "[redacted:execution-error]",
    summary:
      "SkyTwin deliberately did not execute because the router refused the unsafe action.",
    riskTier: null,
  };
  mocks.recordPreparationDisposition.mockImplementation(async () => {
    if (!capturedReceiptFinalization) {
      throw new Error("Router refusal occurred before receipt finalization");
    }
    if (
      capturedReceiptFinalization.decisionId !== explanation.decisionId ||
      capturedReceiptFinalization.explanationId !== explanation.id ||
      capturedReceiptFinalization.continuationKind !== "auto_execute" ||
      capturedReceiptFinalization.confirmationLevel !== null ||
      capturedReceiptFinalization.continuation.explanation.id !== explanation.id
    ) {
      throw new Error(
        "Receipt finalization did not link the generated explanation before refusal",
      );
    }
    lifecycle.push("router-refusal-persisted");
    return durableDisposition;
  });

  expect({
    runtimeEntryPath: mappedScenario.runtimeEntryPath,
    adapter: mappedScenario.adapter,
    criticalShape: mappedScenario.criticalShape,
    action: {
      actionType: candidate.actionType,
      reversible: candidate.reversible,
      parameters: candidate.parameters,
    },
    origin: mappedScenario.origin,
    provenance: candidate.provenance,
  }).toEqual(mappedScenario);

  const response = await post(buildApp(), {
    userId,
    signalId: "router-shell-1",
    source: mappedScenario.origin.source,
    type: "generic",
  });

  expect(response).toEqual({
    status: 200,
    body: expect.objectContaining({
      execution: {
        status: "failed",
        planId: null,
        error: durableDisposition.reason,
      },
    }),
  });
  expect(mocks.generateExplanation).toHaveBeenCalledOnce();
  expect(mocks.createReceipts).toHaveBeenCalledOnce();
  expect(mocks.createReceipts).toHaveBeenCalledWith(userId, [], {
    decisionId: "decision-1",
    explanationId: explanation.id,
    continuationKind: "auto_execute",
    confirmationLevel: null,
    continuation: { outcome, explanation },
  });
  expect(capturedReceiptFinalization).toEqual({
    decisionId: "decision-1",
    explanationId: explanation.id,
    continuationKind: "auto_execute",
    confirmationLevel: null,
    continuation: { outcome, explanation },
  });
  expect(lifecycle).toEqual([
    "explanation-generated",
    "receipt-finalized",
    "router-prepare",
    "router-refusal-persisted",
  ]);
  expect(mocks.recordPreparationDisposition).toHaveBeenCalledOnce();
  expect(mocks.recordPreparationDisposition).toHaveBeenCalledWith({
    userId,
    decisionId: "decision-1",
    actionId: candidate.id,
    ambiguous: false,
    reason: "[redacted:execution-error]",
  });
  expect(durableDisposition.explanationId).toBe("router-refusal-explanation-1");
  expect(durableDisposition.explanationId).not.toBe(explanation.id);
  expect(guardError).toBeInstanceOf(InvariantViolationError);
  expect((guardError as Error).message).toContain("two-step confirmation");
  expect(buildPlan).not.toHaveBeenCalled();
  expect(prepareRequestStart).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(mocks.claimExecution).not.toHaveBeenCalled();
  expect(mocks.createApproval).not.toHaveBeenCalled();
});
