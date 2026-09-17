export { parseRoutineSpec } from './parser.js';
export { computeNextRun } from './schedule.js';
export { matchesFilter, type MatchableSignal } from './match.js';
export {
  SIGNAL_DIGEST_V1_PROVIDER_KEY,
  SIGNAL_DIGEST_V1_SCHEMA_VERSION,
  SIGNAL_DIGEST_V1_PROJECTION_VERSION,
  signalDigestV1Provider,
  validateSignalDigestV1Payload,
  canonicalSignalDigestV1Json,
  signalDigestV1ContentHash,
  projectSignalDigestFilterForRuntime,
  compileSignalDigestV1,
  diffSignalDigestV1,
  simulateSignalDigestV1,
  type SignalDigestV1Payload,
  type SignalDigestValidationIssue,
  type SignalDigestValidationResult,
  type SignalDigestV1WatchProjection,
  type SignalDigestCompileResult,
  type SignalDigestChangeClassification,
  type SignalDigestDiffDimension,
  type SignalDigestSemanticDiff,
  type SignalDigestDiffResult,
  type SignalDigestReplayRecord,
  type SignalDigestReplayCitation,
  type SignalDigestReplayResult,
  type SignalDigestReplaySimulation,
} from './adaptive-signal-digest.js';
