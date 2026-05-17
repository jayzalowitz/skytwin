export { SituationInterpreter } from './situation-interpreter.js';
export {
  DecisionMaker,
  type DecisionRepositoryPort,
  type LabelInferencePort,
  type SenderLabelHint,
} from './decision-maker.js';
export { RiskAssessor } from './risk-assessor.js';
export { ProactiveEvaluator } from './proactive-evaluator.js';

// Strategy interfaces and implementations
export type { SituationStrategy } from './strategies/situation-strategy.js';
export type { CandidateGenerator } from './strategies/candidate-strategy.js';
export { LlmSituationStrategy } from './strategies/llm-situation.js';
export { LlmCandidateGenerator } from './strategies/llm-candidates.js';
export { FallbackSituationStrategy, FallbackCandidateGenerator } from './strategies/fallback-strategy.js';
export { CompositeCandidateGenerator } from './strategies/composite-candidates.js';
export { RuleBasedCandidateGenerator } from './strategies/rule-based-candidates.js';
export { SenderAwareCandidateGenerator } from './strategies/sender-aware-candidates.js';
export {
  DraftEmailCandidateGenerator,
  buildDraftPrompt,
  DEFAULT_AUTHORED_EXAMPLE_COUNT,
  MAX_EXAMPLE_CHARS,
} from './strategies/draft-email-candidate.js';
export type {
  AuthoredExamplesPort,
  DraftEmailCandidateGeneratorOptions,
} from './strategies/draft-email-candidate.js';
export { isTrivialAutoEmail } from './cost-gate.js';
export type {
  CostGatePort,
  CostGateDecision,
  CostGateReservation,
} from './cost-gate.js';

export type {
  WhatWouldIDoRequest,
  WhatWouldIDoResponse,
} from '@skytwin/shared-types';
