import express from "express";
import type { Express } from "express";
import { expect, it, vi } from "vitest";

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
  getContinuation: vi.fn(),
  findApproval: vi.fn(),
  createApproval: vi.fn(),
  findDisposition: vi.fn(),
  getRouter: vi.fn(),
  getProviders: vi.fn(),
  recordSignal: vi.fn(),
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
    return { evaluate: vi.fn() };
  }),
}));

vi.mock("@skytwin/explanations", () => ({
  ExplanationGenerator: vi.fn(function ExplanationGenerator() {
    return { generate: mocks.generateExplanation };
  }),
}));

vi.mock("@skytwin/db", () => ({
  signalRepository: {
    persistUnboundSignal: vi.fn(async (input: Record<string, unknown>) => ({
      created: true,
      signal: { source: input['source'], type: input['type'], source_signal_id: input['sourceSignalId'], data: input['data'] },
    })),
  },
  approvalRepository: {
    create: mocks.createApproval,
    findByDecisionId: mocks.findApproval,
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
    recordReceiptPreparationDisposition: vi.fn(),
    findReceiptExecutionDisposition: mocks.findDisposition,
  },
  userRepository: { findById: vi.fn() },
  aiProviderRepository: { getEnabledForUser: mocks.getProviders },
  inferenceReceiptRepository: {
    createManyForUser: vi.fn(),
    getContinuationForDecision: mocks.getContinuation,
    claimExecutionForDecision: vi.fn(),
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
  runtimeEntryPath: "api.events_ingest",
  adapter: "none",
  criticalShape: "send",
  action: { actionType: "send_email", reversible: false, parameters: {} },
  origin: { kind: "email", source: "gmail", authoringTier: "inbox_automated" },
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

it("adv-v1-events-no-replay-explanation returns only the integrity-bound persisted explanation", async () => {
  vi.clearAllMocks();
  const persistedExplanation = {
    id: "explanation-1",
    decisionId: "decision-1",
    summary: "The earlier send remains unresolved; SkyTwin will not replay it.",
    riskTier: "high",
    overallConfidence: 0.73,
  };
  const persistedAction = {
    id: "action-1",
    decisionId: "decision-1",
    ...mappedScenario.action,
    description: "Send email",
    domain: "email",
    estimatedCostCents: 0,
    confidence: "high",
    reasoning: "Prior evaluation",
    provenance: "untrusted_external",
  };
  mocks.findDecision.mockResolvedValue({
    id: "decision-1",
    userId,
    signalId: "signal-1",
    situationType: "email_triage",
    domain: "email",
    urgency: "medium",
    summary: "Inbound email",
    rawData: {},
    interpretedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  mocks.getContinuation.mockResolvedValue({
    receiptCaptureComplete: true,
    receiptExplanationId: persistedExplanation.id,
    continuationKind: "auto_execute",
    confirmationLevel: null,
    effectState: "running",
    sourceEffectState: null,
    sourceExecutionStatus: null,
    sourceExecutionPlanId: null,
    continuation: {
      outcome: {
        id: "outcome-1",
        decisionId: "decision-1",
        selectedAction: persistedAction,
        allCandidates: [persistedAction],
        riskAssessment: null,
        autoExecute: true,
        requiresApproval: false,
        reasoning: "Prior run",
      },
      explanation: persistedExplanation,
    },
  });
  mocks.findApproval.mockResolvedValue(null);
  mocks.findDisposition.mockResolvedValue(null);

  expect({
    runtimeEntryPath: mappedScenario.runtimeEntryPath,
    adapter: mappedScenario.adapter,
    criticalShape: mappedScenario.criticalShape,
    action: {
      actionType: persistedAction.actionType,
      reversible: persistedAction.reversible,
      parameters: persistedAction.parameters,
    },
    origin: mappedScenario.origin,
    provenance: persistedAction.provenance,
  }).toEqual(mappedScenario);

  const response = await post(buildApp(), {
    userId,
    signalId: "signal-1",
    source: mappedScenario.origin.source,
    type: mappedScenario.origin.kind,
    data: { authoringTier: mappedScenario.origin.authoringTier },
  });

  expect(response).toEqual({
    status: 200,
    body: expect.objectContaining({
      reIngested: true,
      replaySuppressed: true,
      execution: { status: "ambiguous", planId: null },
      explanation: {
        summary: persistedExplanation.summary,
        riskTier: persistedExplanation.riskTier,
        confidence: persistedExplanation.overallConfidence,
      },
    }),
  });
  expect(mocks.getContinuation).toHaveBeenCalledOnce();
  expect(mocks.getContinuation).toHaveBeenCalledWith(userId, "decision-1");
  expect(mocks.findDisposition).toHaveBeenCalledWith(
    userId,
    "decision-1",
    "action-1",
  );
  expect(mocks.getExplanation).not.toHaveBeenCalled();
  expect(mocks.generateExplanation).not.toHaveBeenCalled();
  expect(mocks.evaluate).not.toHaveBeenCalled();
  expect(mocks.saveDecision).not.toHaveBeenCalled();
  expect(mocks.saveCandidates).not.toHaveBeenCalled();
  expect(mocks.saveOutcome).not.toHaveBeenCalled();
  expect(mocks.createApproval).not.toHaveBeenCalled();
  expect(mocks.getRouter).not.toHaveBeenCalled();
  expect(mocks.getProviders).not.toHaveBeenCalled();
  expect(mocks.recordSignal).not.toHaveBeenCalled();
});
