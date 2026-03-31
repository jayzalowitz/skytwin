# Milestone 4: Learning + Evals

**Status:** Not Started
**Target:** Week 13-16
**Owner:** Core team + ML/evaluation team
**Depends on:** [Milestone 3 -- Real Workflows](./milestone-3-real-workflows.md)

## Goal

Make SkyTwin learn from user feedback and prove that it's measurably correct. After M4, the system ingests feedback events (approve, reject, edit, undo, restate preference), updates the twin profile accordingly, calibrates its confidence over time, and has a regression suite that quantifies decision quality. An engineer can run the eval harness and get a report showing interruption rate, false autonomy rate, and escalation correctness.

## Scope

### In scope

#### Feedback Ingestion and Twin Updates

- **Feedback event processing (`@skytwin/twin-model` + `@skytwin/connectors`):**
  - Accept all feedback types: `approve`, `reject`, `edit`, `undo`, `restate_preference`, `reward`, `punish`
  - Each feedback type has defined semantics for how it updates the twin:
    - `approve`: Strengthen the preference/inference that led to the decision. Increase confidence.
    - `reject`: Weaken or contradict the inference. Record contradicting evidence. Decrease confidence.
    - `edit`: The user accepted the action but modified it. Infer the preferred modification as a new preference.
    - `undo`: The user reversed the action. Treat as stronger-than-reject signal. Flag the inference for review.
    - `restate_preference`: The user explicitly stated a preference. Record as `source: 'explicit'` with `ConfidenceLevel.CONFIRMED`.
    - `reward`: Positive reinforcement signal. Increase confidence of related inferences.
    - `punish`: Negative reinforcement signal. Decrease confidence. Trigger escalation threshold adjustment.
  - Feedback creates `TwinEvidence` records linked to the relevant inferences.
  - Feedback triggers twin profile version bump (every feedback cycle is a new version).

- **Preference evolution tracking:**
  - Track how each preference changes over time (confidence trajectory, source transitions).
  - Detect preference drift: when a user's behavior shifts away from established preferences.
  - Detect preference conflicts: when feedback contradicts multiple existing preferences.
  - Preference decay: preferences that haven't been reinforced recently lose confidence over time (configurable decay rate).

- **Confidence calibration:**
  - Compare predicted confidence against actual approval rate.
  - If the system says "HIGH confidence" but the user rejects 40% of the time, confidence is miscalibrated.
  - Calibration runs as a background job that adjusts inference confidence based on historical feedback.
  - Calibration is per-user and per-domain (the system might be well-calibrated for email but poorly calibrated for travel).

- **CockroachDB replay:**
  - Given a point in time, reconstruct the twin state at that moment (using `twin_profile_versions`).
  - Replay a decision against the historical twin state to see if the system would make the same decision today.
  - Useful for debugging: "why did the system auto-archive that email last Tuesday?"
  - Replay produces a diff: current decision vs historical decision, with explanation of what changed.

#### Evaluation Harness

- **Scenario framework (`@skytwin/evals`):**
  - Define evaluation scenarios as structured data: input event, expected behavior, assertions.
  - Scenarios can assert on: decision outcome, selected action type, whether approval was required, explanation content, risk assessment tier.
  - Scenarios support parameterization: same scenario with different trust tiers, different preference sets, different spend limits.
  - Scenario runner executes scenarios against the real pipeline (not mocks) with a test database.

- **Email triage scenario suite:**
  - 20+ scenarios covering: spam detection, VIP sender handling, urgent vs FYI classification, newsletter auto-archive, response drafting, thread context sensitivity.
  - Scenarios test both the happy path and edge cases (unknown sender, ambiguous urgency, sender in both VIP and newsletter lists).

- **Safety regression suite:**
  - Dedicated scenarios that verify every safety invariant:
    - Spend limit enforcement (at boundary, over boundary, just under)
    - Trust tier gating (each tier with each risk level)
    - Irreversible action handling
    - Domain blocklist enforcement
    - Escalation triggers
  - These scenarios are the "do not break" tests. If any fails, the build is red.

- **Metrics calculation:**
  - **Interruption rate:** Percentage of decisions that required user approval. Lower is better (to a point).
  - **False autonomy rate:** Percentage of auto-executed decisions that the user later rejected/undid. Lower is always better. This is the most important safety metric.
  - **Escalation correctness:** Of decisions that were escalated, what percentage did the user approve? If the user approves most escalations, the system is being too conservative.
  - **Preference accuracy:** Percentage of inferred preferences that match user behavior. Measured by holdout evaluation (infer from 80% of feedback, test against 20%).
  - **Confidence calibration score:** How well does stated confidence correlate with actual approval rate? Measured by expected calibration error (ECE).
  - Metrics are computed per-user, per-domain, and aggregate.

- **Review tooling:**
  - CLI tool that runs the eval suite and produces a structured report (JSON + human-readable summary).
  - Report includes: total scenarios, pass/fail counts, metrics, worst-performing scenarios, regression detection (comparison against previous run).
  - Integration with CI: eval harness runs on every PR, report is posted as a PR comment.

### Out of scope

- ML model training (use rule-based feedback processing).
- A/B testing framework.
- Production monitoring dashboards.
- Real-time metrics streaming.
- Automated trust tier adjustment based on eval results (requires human review).

## Success Criteria

1. **Feedback updates twin:** An `approve` feedback for a decision increases the confidence of the related preference. A `reject` decreases it. A `restate_preference` sets it to `CONFIRMED`.
2. **Preference evolution is visible:** After 10 feedback events on the same domain, the system can show a timeline of how the preference confidence changed.
3. **Confidence calibration improves:** After running calibration on a user with 50+ feedback events, the calibration error decreases compared to the uncalibrated baseline.
4. **Replay works:** Given a historical decision ID, the system can reconstruct the twin state at that time, replay the decision, and show a diff.
5. **Eval harness runs 50+ scenarios:** The harness processes all scenarios and produces a structured report with pass/fail and metrics.
6. **Safety regression suite is green:** All safety scenarios pass, and the suite catches intentionally introduced safety violations.
7. **False autonomy rate is measurable:** The harness can compute false autonomy rate from a set of decisions + feedback, and the rate is below 5% for the test scenarios.
8. **CI integration works:** The eval harness runs in CI, and a failing safety scenario blocks the PR.

## Issues

| Issue | Title | Status | Estimate |
|-------|-------|--------|----------|
| [009](./issue-009-build-feedback-loop.md) | Build the Feedback Learning Loop | Not started | 5-6 days |
| [010](./issue-010-build-evals-harness.md) | Build the Evaluation Harness | Not started | 5-7 days |

## Dependency Graph

```
M3 (Real Workflows)
 ├── 009 (Feedback Loop)
 │    ├── Feedback ingestion
 │    ├── Twin update logic
 │    ├── Preference evolution tracking
 │    ├── Confidence calibration
 │    └── CockroachDB replay
 │
 └── 010 (Evals Harness)
      ├── Scenario framework
      ├── Email triage scenarios
      ├── Safety regression suite
      ├── Metrics calculation
      └── Review tooling + CI integration
```

Issues 009 and 010 can be developed in parallel. The eval harness (010) does not depend on the feedback loop (009) -- it evaluates the decision pipeline, not the learning loop. However, some eval scenarios will test feedback-driven behavior once 009 is complete.

## Estimated Effort

| Phase | Estimate | Notes |
|-------|----------|-------|
| Issue 009 (Feedback Loop) | 5-6 days | Feedback processing, twin updates, calibration |
| Issue 010 (Evals Harness) | 5-7 days | Framework, scenarios, metrics, CI |
| Integration (feedback + evals) | 2 days | Scenarios that test learning behavior |
| **Total elapsed** | **7-9 days** | With parallelization |
| **Total effort** | **12-15 person-days** | |

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Feedback processing creates infinite loops (feedback triggers twin update triggers new decision triggers new feedback) | Critical | Medium | Feedback processing is strictly one-way: feedback -> twin update. Twin updates do not trigger new decisions. Guard against re-entrant processing. |
| Confidence calibration requires more data than we have | Medium | High | Start with simple calibration (moving average of approval rate per confidence bucket). Defer sophisticated calibration (isotonic regression, Platt scaling) to a later milestone. |
| Preference decay is hard to tune | Medium | High | Make decay rate configurable. Default to no decay in M4. Introduce decay only after we have eval data showing it helps. |
| Eval scenarios are brittle (break on minor changes) | Medium | Medium | Scenarios assert on behavior categories (e.g., "action is auto-executed") not exact values (e.g., "action ID is abc-123"). |
| CockroachDB replay is slow for users with many versions | Low | Medium | Add index on `(profile_id, version)` (already in schema). Limit replay to last 90 days by default. |

## Metrics Framework

### Key Metrics Definitions

| Metric | Formula | Target | Interpretation |
|--------|---------|--------|----------------|
| Interruption Rate | `approvals_requested / total_decisions` | 20-40% | Too low = over-autonomous; too high = useless |
| False Autonomy Rate | `(auto_executed AND later_rejected) / auto_executed` | < 5% | The most important safety metric |
| Escalation Correctness | `approved_escalations / total_escalations` | 60-80% | Too high = too conservative; too low = bad judgment |
| Preference Accuracy | `correct_predictions / total_predictions` | > 80% | Measured by holdout evaluation |
| Calibration Error (ECE) | `mean(abs(confidence - actual_approval_rate))` per bucket | < 0.1 | Lower is better |

### Metric Interpretation Guide

- **Interruption Rate 20-40%**: The system is useful but cautious. Below 20%: the system might be taking too many liberties. Above 40%: the system isn't providing enough value.
- **False Autonomy Rate < 5%**: The system rarely acts against the user's wishes without asking. This is the "first, do no harm" metric. Above 5% is a safety concern.
- **Escalation Correctness 60-80%**: The system escalates mostly the right things. Below 60%: it's bothering the user with things they'd approve. Above 80%: it might not be escalating enough.

## Exit Criteria

M4 is complete when:
- All success criteria above are verified
- The eval harness is integrated into CI and the safety regression suite is passing
- Metrics can be computed for any user with sufficient decision history
- A product manager can read the eval report and understand system performance without engineering help
- The feedback loop is processing all feedback types and the twin is visibly learning
