# Issue 009: Build the Feedback Learning Loop

**Milestone:** [M4 -- Learning + Evals](./milestone-4-learning-and-evals.md)
**Priority:** P1
**Estimate:** 5-6 days
**Assignee:** TBD
**Labels:** `feedback`, `learning`, `twin-model`, `M4`
**Depends on:** [Issue 003](./issue-003-build-twin-model.md), [Issue 005](./issue-005-build-decision-engine.md), M3 completion

## Problem

SkyTwin makes decisions based on the twin profile, but the twin profile is only as good as the data it's built from. Without a feedback loop, the system never learns. It makes the same mistakes repeatedly, never improves its confidence, and the twin profile stagnates. The user has to manually correct preferences forever instead of the system learning from their behavior.

## Why It Matters

This is CLAUDE.md safety invariant #6: "Feedback flows back. User approvals, rejections, edits, and undos must update the twin model. If feedback isn't being recorded, the system is broken."

The feedback loop is what makes SkyTwin a learning system rather than a static rule engine. It's the mechanism by which:
- Good decisions reinforce the preferences that produced them
- Bad decisions trigger preference corrections
- The twin model evolves to match the user's changing behavior
- Confidence calibrates to match actual approval rates
- The system gets better over time, not just different

## Scope

### Feedback Ingestion

#### FeedbackProcessor API

```typescript
interface FeedbackProcessor {
  /**
   * Process a feedback event from the user.
   * Updates the twin profile based on feedback semantics.
   */
  processFeedback(event: FeedbackEvent): Promise<FeedbackResult>;

  /**
   * Get feedback history for a user.
   */
  getFeedbackHistory(userId: string, options?: FeedbackQueryOptions): Promise<FeedbackEvent[]>;

  /**
   * Get feedback for a specific decision.
   */
  getDecisionFeedback(decisionId: string): Promise<FeedbackEvent[]>;

  /**
   * Get aggregate feedback statistics for a user.
   */
  getFeedbackStats(userId: string, options?: StatsOptions): Promise<FeedbackStats>;
}

interface FeedbackResult {
  processed: boolean;
  twinUpdates: TwinUpdate[];       // What changed in the twin profile
  preferenceChanges: PreferenceChange[];  // How preferences were affected
  tierImpact: TierImpact | null;   // Whether this affected trust tier
  newVersion: number;              // The new twin profile version
}

interface FeedbackQueryOptions {
  limit?: number;
  offset?: number;
  type?: FeedbackEvent['type'];
  domain?: string;
  since?: Date;
  until?: Date;
}

interface FeedbackStats {
  totalDecisions: number;
  totalFeedback: number;
  approvalRate: number;
  rejectionRate: number;
  editRate: number;
  undoRate: number;
  byDomain: Record<string, DomainFeedbackStats>;
  byTrustTier: Record<TrustTier, TierFeedbackStats>;
}
```

#### Feedback Type Semantics

Each feedback type has precise semantics for how it updates the twin:

##### `approve`
The user accepted the decision as-is.
- **Twin update:** Strengthen the preference(s) that led to this decision.
  - If the preference was `INFERRED` with `MODERATE` confidence, bump to `HIGH`.
  - If it was `HIGH`, keep at `HIGH` (already strong).
  - If it was `CONFIRMED`, no change needed.
  - If no preference existed, create one from the action with `source: 'inferred'`, `confidence: LOW`.
- **Evidence:** Create a `TwinEvidence` record linking approval to the preference.
- **Trust tier:** Count toward progression criteria (one more successful decision).

##### `reject`
The user rejected the decision entirely.
- **Twin update:** Weaken or contradict the inference that led to this decision.
  - Decrease confidence by one level (e.g., `HIGH` -> `MODERATE`, `MODERATE` -> `LOW`).
  - If confidence drops to `SPECULATIVE`, flag the inference for review.
  - Add the rejection as contradicting evidence.
- **Evidence:** Create a `TwinEvidence` record with type `rejection`.
- **Trust tier:** Count as a failure. Three consecutive rejections trigger tier regression.

##### `edit`
The user accepted the action but modified it (e.g., approved the email response but edited the text).
- **Twin update:** The original preference is slightly weakened. A new preference is created or updated based on the edited version.
  - Original preference: decrease confidence by half a level (not a full level -- the action was partially right).
  - New preference: create with `source: 'corrected'`, `confidence: MODERATE` (the user explicitly chose this).
- **Evidence:** Create evidence linking both the original action and the edit.
- **Trust tier:** Counts as a partial success (0.5 weight toward progression, not a full approval but not a rejection).

##### `undo`
The user reversed the action after execution.
- **Twin update:** Stronger signal than `reject`. The user actively undid something the system did.
  - Decrease confidence by two levels (e.g., `HIGH` -> `LOW`).
  - If the preference was `source: 'inferred'`, consider removing it entirely.
  - Add strong contradicting evidence.
- **Evidence:** Create evidence with type `undo`, flagged as high-weight.
- **Trust tier:** Counts as a strong failure. May trigger immediate tier regression depending on severity.

##### `restate_preference`
The user explicitly stated a preference (e.g., "Always archive newsletters from this sender").
- **Twin update:** Create or update the preference with `source: 'explicit'`, `confidence: CONFIRMED`.
  - If a conflicting preference exists, the explicit restatement overrides it.
  - The overridden preference is archived with a reference to the restatement.
- **Evidence:** Create evidence with type `explicit_preference`.
- **Trust tier:** No direct impact, but increases system confidence which may affect future auto-execution.

##### `reward`
Positive reinforcement signal (e.g., user stars or likes a decision).
- **Twin update:** Increase confidence of related preferences by half a level. Lighter touch than `approve`.
- **Evidence:** Create evidence with type `reward`.
- **Trust tier:** Minor positive signal (0.25 weight toward progression).

##### `punish`
Negative reinforcement signal (e.g., user flags a decision as bad).
- **Twin update:** Decrease confidence by one level. Also adjusts the escalation threshold for this domain downward (the system should be more cautious here).
- **Evidence:** Create evidence with type `punish`, flagged as high-weight.
- **Trust tier:** Counts as a failure (full weight).

### Preference Evolution Tracking

```typescript
interface PreferenceEvolutionTracker {
  /**
   * Get the history of a specific preference over time.
   */
  getPreferenceHistory(
    userId: string,
    preferenceId: string
  ): Promise<PreferenceSnapshot[]>;

  /**
   * Detect preferences that are drifting (changing direction).
   */
  detectDrift(userId: string, domain?: string): Promise<DriftReport>;

  /**
   * Detect preferences that conflict with each other.
   */
  detectConflicts(userId: string, domain?: string): Promise<ConflictReport>;

  /**
   * Apply time-based preference decay.
   */
  applyDecay(userId: string, decayConfig: DecayConfig): Promise<DecayResult>;
}

interface PreferenceSnapshot {
  preferenceId: string;
  version: number;
  confidence: ConfidenceLevel;
  value: unknown;
  source: PreferenceSource;
  timestamp: Date;
  trigger: string;   // What caused this change (feedback ID, calibration run, decay)
}

interface DriftReport {
  driftingPreferences: DriftingPreference[];
  stablePreferences: number;
  totalPreferences: number;
}

interface DriftingPreference {
  preference: Preference;
  direction: 'strengthening' | 'weakening' | 'oscillating';
  changeCount: number;     // Number of changes in the observation window
  windowDays: number;
}

interface DecayConfig {
  decayRatePerDay: number;           // Confidence decay per day without reinforcement (e.g., 0.01)
  minimumConfidence: ConfidenceLevel; // Don't decay below this level
  exemptSources: PreferenceSource[];  // Don't decay explicit preferences
  windowDays: number;                 // Only decay preferences not reinforced within this window
}
```

#### Drift Detection

A preference is "drifting" when the user's behavior is shifting away from the established preference:

- **Strengthening drift:** Confidence has increased 2+ times in 30 days without decrease. The system is getting more confident.
- **Weakening drift:** Confidence has decreased 2+ times in 30 days. The user may be changing their mind.
- **Oscillating drift:** Confidence has gone up and down 3+ times in 30 days. The preference is unstable, possibly context-dependent.

Drift detection runs as a background job (not on every feedback event). Results are used by the decision engine to adjust confidence weighting.

#### Preference Decay

Preferences that aren't reinforced should gradually lose confidence:

- Default decay rate: 0.01 per day (meaning a `HIGH` preference drops to `MODERATE` after ~30 days without reinforcement).
- Explicit preferences (`source: 'explicit'`) are exempt from decay.
- Decay does not remove preferences, only reduces confidence.
- Decay is applied by a background job, not on every read.

### Confidence Calibration

```typescript
interface ConfidenceCalibrator {
  /**
   * Run calibration for a user: compare stated confidence against actual outcomes.
   */
  calibrate(userId: string, options?: CalibrationOptions): Promise<CalibrationResult>;

  /**
   * Get calibration metrics without modifying anything.
   */
  getCalibrationMetrics(userId: string): Promise<CalibrationMetrics>;
}

interface CalibrationOptions {
  domain?: string;          // Calibrate only for this domain
  windowDays?: number;      // How far back to look (default: 90)
  dryRun?: boolean;         // If true, compute metrics but don't update preferences
}

interface CalibrationResult {
  adjustedPreferences: number;
  totalPreferences: number;
  beforeECE: number;        // Expected calibration error before adjustment
  afterECE: number;         // Expected calibration error after adjustment
  adjustments: CalibrationAdjustment[];
}

interface CalibrationAdjustment {
  preferenceId: string;
  previousConfidence: ConfidenceLevel;
  newConfidence: ConfidenceLevel;
  statedApprovalRate: number;    // What the confidence level implied
  actualApprovalRate: number;    // What actually happened
  sampleSize: number;            // How many decisions this is based on
}

interface CalibrationMetrics {
  overallECE: number;
  byDomain: Record<string, number>;
  byConfidenceLevel: Record<ConfidenceLevel, {
    statedRate: number;    // Expected approval rate for this confidence level
    actualRate: number;    // Actual approval rate
    sampleSize: number;
  }>;
}
```

#### Calibration Logic

Confidence levels imply expected approval rates:

| Confidence | Expected approval rate |
|------------|----------------------|
| CONFIRMED | 95%+ |
| HIGH | 80-95% |
| MODERATE | 60-80% |
| LOW | 40-60% |
| SPECULATIVE | < 40% |

Calibration compares actual approval rate against expected:
- If a `HIGH` confidence preference is only approved 50% of the time, it's over-confident. Lower to `MODERATE`.
- If a `LOW` confidence preference is approved 90% of the time, it's under-confident. Raise to `HIGH`.

Calibration requires a minimum sample size (default: 10 decisions) to avoid noise.

### CockroachDB Replay

```typescript
interface DecisionReplayer {
  /**
   * Replay a historical decision against the twin state at that time.
   */
  replayDecision(decisionId: string): Promise<ReplayResult>;

  /**
   * Replay a decision against the current twin state (to see if the decision would be different today).
   */
  replayWithCurrentTwin(decisionId: string): Promise<ReplayResult>;

  /**
   * Compare two replay results (historical vs current).
   */
  diffReplays(historical: ReplayResult, current: ReplayResult): Promise<ReplayDiff>;
}

interface ReplayResult {
  originalDecision: DecisionOutcome;
  replayedDecision: DecisionOutcome;
  twinStateUsed: TwinProfile;       // The twin state at the time of the decision
  differences: ReplayDifference[];
  replayedAt: Date;
}

interface ReplayDifference {
  field: string;
  originalValue: unknown;
  replayedValue: unknown;
  reason: string;   // Why the value differs
}

interface ReplayDiff {
  sameAction: boolean;
  sameAutoExecute: boolean;
  actionChanged: string | null;      // "archive -> label" or null if same
  confidenceChange: number;          // +/- confidence score change
  preferenceChanges: string[];       // Preferences that changed between then and now
}
```

Replay requires:
1. The original decision record (from `decisions` table)
2. The twin profile version at the time of the decision (from `twin_profile_versions`)
3. The policy state at the time (from `action_policies` -- note: policies don't have version history, so use current policies)
4. Re-running the decision pipeline with historical inputs

Replay is a debugging and evaluation tool, not a production path. It can be slow (reconstructing historical state from version snapshots).

## Implementation Notes

### Feedback Processing is One-Way

Critical design constraint: feedback processing updates the twin, but twin updates DO NOT trigger new decisions. The flow is:

```
User Feedback → FeedbackProcessor → Twin Update → Done
```

NOT:

```
User Feedback → FeedbackProcessor → Twin Update → New Decision → ???
```

This prevents infinite loops where feedback triggers decisions that trigger more feedback.

### Transaction Boundaries

Each feedback event is processed in a single CockroachDB transaction:

1. Read current twin profile
2. Apply feedback semantics (update preferences, create evidence)
3. Bump profile version
4. Create version snapshot
5. Store feedback event
6. Commit

If any step fails, the entire feedback processing is rolled back.

### Idempotency

Feedback events have unique IDs. Processing the same feedback event twice should be idempotent:
- Check if the feedback event ID already exists in the `feedback_events` table
- If it does, return the previous result without re-processing
- This prevents double-counting of approvals/rejections

### Background Jobs

Some feedback processing tasks run as background jobs (via `@skytwin/worker`):
- Preference decay (runs daily)
- Drift detection (runs daily)
- Confidence calibration (runs weekly or on-demand)
- These jobs are not triggered by individual feedback events

### Testing Strategy

1. **Unit tests per feedback type:** For each of the 7 feedback types, test that the twin profile is updated correctly.
2. **Confidence progression tests:** Feed a sequence of approvals and verify confidence increases appropriately.
3. **Confidence regression tests:** Feed a sequence of rejections and verify confidence decreases.
4. **Mixed feedback tests:** Alternate approvals and rejections, verify oscillation detection.
5. **Preference decay tests:** Simulate time passing, verify decay is applied.
6. **Calibration tests:** Set up a user with known confidence/approval rates, run calibration, verify adjustments.
7. **Replay tests:** Create a decision, update the twin, replay the decision with historical and current twin states, verify the diff.
8. **Idempotency tests:** Process the same feedback event twice, verify no double-counting.
9. **Transaction tests:** Introduce a failure mid-processing, verify no partial updates.

## Acceptance Criteria

- [ ] `FeedbackProcessor.processFeedback(event)` handles all 7 feedback types (`approve`, `reject`, `edit`, `undo`, `restate_preference`, `reward`, `punish`).
- [ ] `approve` feedback increases preference confidence by one level.
- [ ] `reject` feedback decreases preference confidence by one level.
- [ ] `edit` feedback creates a new corrected preference with `source: 'corrected'`.
- [ ] `undo` feedback decreases confidence by two levels and adds strong contradicting evidence.
- [ ] `restate_preference` feedback creates/updates a preference with `source: 'explicit'`, `confidence: CONFIRMED`.
- [ ] Every feedback event creates a `TwinEvidence` record linked to the relevant preferences.
- [ ] Every feedback event bumps the twin profile version.
- [ ] Feedback processing is idempotent: same event processed twice produces no additional changes.
- [ ] `PreferenceEvolutionTracker.getPreferenceHistory()` returns the full history of confidence changes.
- [ ] Drift detection identifies weakening, strengthening, and oscillating preferences.
- [ ] Preference decay reduces confidence for preferences not reinforced within the window.
- [ ] Explicit preferences (`source: 'explicit'`) are exempt from decay.
- [ ] `ConfidenceCalibrator.calibrate()` adjusts over-confident and under-confident preferences.
- [ ] Calibration requires minimum 10 decisions before adjusting.
- [ ] `DecisionReplayer.replayDecision()` reconstructs historical twin state and replays the decision.
- [ ] `DecisionReplayer.diffReplays()` identifies differences between historical and current decisions.
- [ ] All feedback processing happens within a single CockroachDB transaction.
- [ ] Background jobs (decay, drift, calibration) run without blocking feedback processing.
- [ ] `FeedbackProcessor.getFeedbackStats()` returns correct aggregate statistics.
- [ ] All tests pass: `pnpm --filter @skytwin/twin-model test` and `pnpm --filter @skytwin/connectors test`.

## Non-Goals

- **Real-time preference updates via streaming:** Feedback is processed synchronously or via the worker queue. No WebSocket-based preference streaming.
- **ML-based feedback interpretation:** Feedback semantics are deterministic rules in M4. ML interpretation is future work.
- **Feedback solicitation:** The system processes feedback when it arrives. It doesn't actively ask users for feedback (that's a UX concern).
- **Multi-user learning:** The twin learns from one user's feedback only. Cross-user learning (collaborative filtering) is out of scope.
- **Feedback weighting by recency:** All feedback within the calibration window is weighted equally. Recency-weighted calibration is future work.

## Dependencies

- [Issue 003](./issue-003-build-twin-model.md): `TwinService` for profile and preference updates.
- [Issue 005](./issue-005-build-decision-engine.md): Decision records and outcomes that feedback references.
- [Issue 006](./issue-006-build-policy-engine.md): Trust tier progression triggered by feedback.
- M3 completion: Real workflows must be in place to generate meaningful feedback.

## Risks and Open Questions

| Item | Type | Notes |
|------|------|-------|
| Confidence level arithmetic is imprecise (what's "one level up from HIGH"?) | Risk | Define a strict ordinal: SPECULATIVE=0, LOW=1, MODERATE=2, HIGH=3, CONFIRMED=4. Arithmetic is integer math on ordinals. Clamp to [0,4]. |
| Feedback on old decisions may reference stale twin state | Risk | Accept this. The feedback updates the current twin state, not the historical state. The replay system is how we reconcile past and present. |
| Preference decay rate is hard to tune | Risk | Default to no decay in initial deployment. Enable decay only after gathering data on how quickly preferences actually change. Make the rate configurable per-domain. |
| Calibration with small sample sizes is noisy | Risk | Require minimum 10 decisions per confidence bucket. If sample is too small, skip calibration for that bucket and log a warning. |
| Undo is a stronger signal than reject, but how much stronger? | Open question | Decision: Undo drops confidence by 2 levels (vs 1 for reject). This is a heuristic. The eval harness (Issue 010) will measure whether this weighting produces good outcomes. |
| Should `reward`/`punish` affect trust tier? | Open question | Decision: Yes, with reduced weight. Reward = 0.25 toward progression. Punish = 1.0 toward regression (same as reject). This asymmetry is conservative (safety over convenience). |
