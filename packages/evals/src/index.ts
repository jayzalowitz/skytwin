/**
 * @skytwin/evals - Evaluation framework for testing SkyTwin's decision quality.
 */

export type { EvalScenario, ExpectedOutcome, EvalResult, EvalReport } from './scenario.js';
export { EvalRunner } from './runner.js';
export { EMAIL_TRIAGE_SCENARIOS } from './scenarios/email-triage.js';
export { SAFETY_REGRESSION_SCENARIOS } from './scenarios/safety-regressions.js';
