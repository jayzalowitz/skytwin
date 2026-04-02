/**
 * @skytwin/evals - Evaluation framework for testing SkyTwin's decision quality.
 */

export type { EvalScenario, ExpectedOutcome, EvalResult, EvalReport } from './scenario.js';
export { EvalRunner } from './runner.js';
export { EMAIL_TRIAGE_SCENARIOS } from './scenarios/email-triage.js';
export { SAFETY_REGRESSION_SCENARIOS } from './scenarios/safety-regressions.js';
export { CALENDAR_SCENARIOS } from './scenarios/calendar-scenarios.js';
export { SUBSCRIPTION_SCENARIOS } from './scenarios/subscription-scenarios.js';
export { GROCERY_SCENARIOS } from './scenarios/grocery-scenarios.js';
export { TRAVEL_SCENARIOS } from './scenarios/travel-scenarios.js';
export { CROSS_DOMAIN_SCENARIOS } from './scenarios/cross-domain-scenarios.js';
export { FINANCE_SCENARIOS } from './scenarios/finance-scenarios.js';
export { SMART_HOME_SCENARIOS } from './scenarios/smart-home-scenarios.js';
export { TASK_SCENARIOS } from './scenarios/task-scenarios.js';
export { SOCIAL_SCENARIOS } from './scenarios/social-scenarios.js';
export { DOCUMENT_SCENARIOS } from './scenarios/document-scenarios.js';
export { HEALTH_SCENARIOS } from './scenarios/health-scenarios.js';

// Metrics
export { EscalationCorrectnessTracker } from './metrics/escalation-correctness.js';
export { CalibrationErrorTracker } from './metrics/calibration-error.js';
export { DecisionLatencyTracker } from './metrics/decision-latency.js';

// Continuous evaluation
export { RegressionDetector } from './regression-detector.js';
export { AccuracyTracker, type DecisionRecord } from './accuracy-tracker.js';
export {
  ContinuousEvalRunner,
  type EvalRepositoryPort,
  type EvalSuite,
} from './continuous-runner.js';

// Temporal replay
export {
  TemporalReplayEngine,
  type TwinVersionRepositoryPort,
  type PreferenceHistoryReplayPort,
  type TwinProfileSnapshot,
  type PreferenceSnapshot,
  type ReplayResult,
  type ReplayDiff,
} from './replay.js';
