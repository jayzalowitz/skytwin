export { SituationInterpreter } from './situation-interpreter.js';
export { DecisionMaker, type DecisionRepositoryPort } from './decision-maker.js';
export { RiskAssessor } from './risk-assessor.js';
export { ProactiveEvaluator } from './proactive-evaluator.js';

// Strategy interfaces and implementations
export type { SituationStrategy } from './strategies/situation-strategy.js';
export type { CandidateGenerator } from './strategies/candidate-strategy.js';
export { LlmSituationStrategy } from './strategies/llm-situation.js';
export { LlmCandidateGenerator } from './strategies/llm-candidates.js';
export { FallbackSituationStrategy, FallbackCandidateGenerator } from './strategies/fallback-strategy.js';
export { RuleBasedCandidateGenerator } from './strategies/rule-based-candidates.js';

export type {
  WhatWouldIDoRequest,
  WhatWouldIDoResponse,
} from '@skytwin/shared-types';
