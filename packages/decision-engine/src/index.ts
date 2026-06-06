export { SituationInterpreter } from './situation-interpreter.js';
export {
  DecisionMaker,
  type DecisionRepositoryPort,
  type LabelInferencePort,
  type SenderLabelHint,
} from './decision-maker.js';
export { RiskAssessor } from './risk-assessor.js';
export { ProactiveEvaluator } from './proactive-evaluator.js';
export { getAssessmentForAction } from './decision-helpers.js';

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
// Multi-source normalization (spec 07): the channel-agnostic accessor + matrix
// that make commitment/deadline/security/clustering/entity capabilities
// source-agnostic.
export {
  toSignalText,
  isAuthoredByUser,
  type SignalText,
} from './signal-text.js';
export {
  CAPABILITY_SOURCE_MATRIX,
  capabilityCoversSource,
  sourcesForCapability,
  type Capability,
} from './capability-source-matrix.js';
export {
  extractDeadline,
  type DeadlineSource,
  type ExtractedDeadline,
} from './deadline-extractor.js';
export {
  extractCommitments,
  type Commitment,
  type CommitmentStrategy,
} from './commitment-extractor.js';
export {
  clusterSignals,
  type ClusterSignal,
  type TopicCluster,
  type ClusterOptions,
  type ClusterStrategy,
} from './topic-clusterer.js';
export {
  computeCoverage,
  type SourceCoverage,
  type CapabilityStatus,
  type ConnectedAccountInfo,
  type CoverageCapability,
} from './source-coverage.js';
export {
  isHidden,
  filterVisible,
  type SignalVisibilityMeta,
} from './visibility-filter.js';
export { resolveLanguage, resolveTimezone, isNonEnglish } from './locale.js';
export {
  buildDigest,
  type Digest,
  type DigestItem,
  type DigestTodo,
  type DigestTopic,
  type DigestTopicItem,
  type BuildDigestOptions,
} from './digest.js';

export { isTrivialAutoEmail } from './cost-gate.js';
export type {
  CostGatePort,
  CostGateDecision,
  CostGateReservation,
} from './cost-gate.js';

export {
  runEvalBench,
  scorePair,
  evalResultConfidence,
  DEFAULT_EVAL_THRESHOLDS,
} from './eval-bench.js';
export type {
  EvalPair,
  EvalThresholds,
  EvalResult,
  PairScore,
  UserReplyLengthStats,
} from './eval-bench.js';

export type {
  WhatWouldIDoRequest,
  WhatWouldIDoResponse,
} from '@skytwin/shared-types';
