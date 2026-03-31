# Milestone 1: Decision Core

**Status:** Not Started
**Target:** Week 3-5
**Owner:** Core team
**Depends on:** [Milestone 0 -- Foundations](./milestone-0-foundations.md)

## Goal

Get the core decision loop working end-to-end. A raw event enters the system, gets interpreted into a `DecisionObject`, is enriched with twin profile data into a `DecisionContext`, produces `CandidateAction`s with risk assessments, passes through the policy engine, yields a `DecisionOutcome`, and generates an `ExplanationRecord`. By the end of M1, a developer can fire a mock event at the pipeline and trace the entire decision path from input to explanation.

## Scope

### In scope

- **Twin Model Service (`@skytwin/twin-model`):** Full `TwinService` implementation with:
  - Profile CRUD (create, read, update, delete)
  - Preference management (add, update, query by domain)
  - Inference engine that derives preferences from evidence
  - Evidence tracking (store, retrieve, link to inferences)
  - Version history -- every mutation creates a `TwinProfileVersion` with snapshot and changed fields
  - CockroachDB persistence via `@skytwin/db` repository layer

- **Situation Interpreter (`@skytwin/decision-engine`):** Transform raw incoming events into typed `DecisionObject`s:
  - Parse raw event payloads (email, calendar, subscription, grocery, travel, generic)
  - Classify situation type using `SituationType` enum
  - Extract domain, urgency, and structured summary
  - Handle malformed or unrecognized events gracefully (classify as `generic`)

- **Decision Engine (`@skytwin/decision-engine`):** The `DecisionMaker` that:
  - Accepts a `DecisionContext` (situation + twin profile + trust tier + relevant preferences)
  - Generates `CandidateAction[]` -- possible responses to the situation
  - Assesses risk for each candidate across all `RiskDimension`s
  - Selects the best action (or no action) based on confidence, risk, and preference alignment
  - Determines whether the selected action can auto-execute or requires approval
  - Produces a `DecisionOutcome` with full reasoning

- **Policy Engine skeleton (`@skytwin/policy-engine`):** Basic `PolicyEvaluator` with:
  - Accept/deny/require_approval evaluation for a `CandidateAction` given a user's policies
  - Trust tier gating (action allowed only if user's tier permits it)
  - Spend limit check (per-action and daily)
  - Default safety policies that apply to all users
  - Pluggable rule evaluation (rules stored as JSONB, evaluated in priority order)

- **Explanation Layer (`@skytwin/explanations`):** `ExplanationGenerator` that:
  - Takes a `DecisionOutcome` and produces an `ExplanationRecord`
  - Answers: what happened, what evidence was used, what preferences were invoked, why this action over alternatives, how to correct it
  - Writes to CockroachDB `explanation_records` table
  - Supports both human-readable text and structured JSON formats

- **Twin persistence with versioning:** Every profile update creates a version record. The system can reconstruct the twin's state at any point in time.

### Out of scope

- Trust tier progression logic (M2).
- Advanced policy rules like domain allowlists/blocklists (M2).
- Real external service integrations (M3).
- Feedback loop and learning (M4).
- Production API endpoints (will use direct function calls and test harnesses).

## Success Criteria

1. **End-to-end pipeline test passes:** A test fires a mock email triage event and receives a `DecisionOutcome` with a selected action and explanation.
2. **Twin profile CRUD works:** Can create a twin profile, add preferences, query preferences by domain, and see version history accumulate.
3. **Situation interpretation covers all types:** Each `SituationType` has at least one test case that parses correctly from raw event data.
4. **Risk assessment is populated:** Every `CandidateAction` in the test output has a `RiskAssessment` with all six `RiskDimension`s scored.
5. **Policy evaluation blocks unsafe actions:** A test demonstrates that a high-cost action is blocked for a `TrustTier.OBSERVER` user and allowed for a `TrustTier.HIGH_AUTONOMY` user.
6. **Explanations are complete:** Every `ExplanationRecord` has non-empty values for `whatHappened`, `actionRationale`, and `correctionGuidance`.
7. **Version history works:** After three profile updates, three `TwinProfileVersion` records exist with correct snapshots.
8. **All packages compile and tests pass:** `pnpm build && pnpm test` is green.

## Issues

| Issue | Title | Status | Estimate |
|-------|-------|--------|----------|
| [003](./issue-003-build-twin-model.md) | Build the Twin Model service | Not started | 3-4 days |
| [004](./issue-004-build-situation-interpreter.md) | Build the Situation Interpreter | Not started | 2-3 days |
| [005](./issue-005-build-decision-engine.md) | Build the Decision Engine | Not started | 3-4 days |
| [006](./issue-006-build-policy-engine.md) | Build the Policy Engine (skeleton) | Not started | 2-3 days |
| [008](./issue-008-build-explanation-layer.md) | Build the Explanation Layer | Not started | 2-3 days |

## Dependency Graph

```
M0 (Foundations)
 ├── 003 (Twin Model) ─────────────────────┐
 ├── 004 (Situation Interpreter) ──────────┤
 │                                          ├── 005 (Decision Engine)
 ├── 006 (Policy Engine skeleton) ─────────┤
 │                                          │
 └── 008 (Explanation Layer) ──────────────┘
```

- Issues 003, 004, 006, and 008 can begin in parallel once M0 is complete.
- Issue 005 (Decision Engine) depends on 003, 004, and 006 because it consumes `TwinProfile` data, `DecisionObject`s from the interpreter, and `PolicyEvaluator` results.
- Issue 008 (Explanation Layer) can be built independently but needs integration testing with 005.

## Estimated Effort

| Phase | Estimate | Notes |
|-------|----------|-------|
| Parallel work (003, 004, 006, 008) | 3-4 days | Four engineers can work simultaneously |
| Decision Engine (005) | 3-4 days | Blocked on parallel work |
| Integration testing | 1-2 days | End-to-end pipeline validation |
| **Total elapsed** | **7-10 days** | With parallelization |
| **Total effort** | **12-17 person-days** | |

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Interface mismatches between packages | High | Medium | Define all interfaces in `@skytwin/shared-types` first; write integration contract tests early |
| Decision engine candidate generation is under-specified | High | Medium | Start with simple rule-based generation; defer ML/LLM-based generation to later milestone |
| Policy rule JSONB structure is too rigid or too loose | Medium | Medium | Start with a small set of well-defined rule types; add extensibility later |
| Version history creates excessive CockroachDB writes | Low | Low | Batch version creation; monitor write amplification in tests |
| Explanation quality is subjective | Medium | High | Define minimum required fields; defer "good explanations" quality bar to evals (M4) |

## Architecture Notes

### Decision Pipeline Flow

```
Raw Event
  │
  ▼
SituationInterpreter.interpret(rawEvent)
  │
  ▼
DecisionObject
  │
  ▼
TwinService.getProfile(userId) + PolicyEngine.getUserPolicies(userId)
  │
  ▼
DecisionContext { decision, twinProfile, trustTier, preferences }
  │
  ▼
DecisionMaker.evaluate(context)
  ├── generateCandidates(context) → CandidateAction[]
  ├── assessRisk(candidates) → RiskAssessment[]
  ├── PolicyEvaluator.evaluate(candidates, policies) → filtered candidates
  └── selectAction(filteredCandidates) → DecisionOutcome
  │
  ▼
ExplanationGenerator.explain(outcome) → ExplanationRecord
  │
  ▼
Persist: decisions, candidate_actions, decision_outcomes, explanation_records
```

### Key Design Decisions

1. **Candidate generation is rule-based in M1.** Each `SituationType` has a registered handler that produces candidates. LLM-based generation is a future enhancement.
2. **Policy evaluation is synchronous.** Rules are loaded from the DB and evaluated in-memory. No external policy service.
3. **The decision engine does not execute actions.** It produces a `DecisionOutcome` that says what to do. Execution is a separate concern (M3).
4. **Twin versioning is append-only.** We never update a version record; we only create new ones.

## Exit Criteria

M1 is complete when:
- All success criteria above are verified
- The end-to-end pipeline integration test is checked into CI and passing
- All five issues are closed
- A developer can trace a decision from raw event to explanation using only log output and DB queries
