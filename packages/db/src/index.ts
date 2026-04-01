/**
 * @skytwin/db - Database layer for SkyTwin.
 *
 * Exports connection utilities, type definitions, repositories, and schema helpers.
 */

// Connection pool
export { getPool, query, withTransaction, healthCheck, closePool, getPoolStats } from './connection.js';
export type { DatabaseConfig } from './connection.js';

// Row types
export type {
  UserRow,
  ConnectedAccountRow,
  TwinProfileRow,
  TwinProfileVersionRow,
  PreferenceRow,
  DecisionRow,
  CandidateActionRow,
  DecisionOutcomeRow,
  ActionPolicyRow,
  ApprovalRequestRow,
  ExecutionPlanRow,
  ExecutionResultRow,
  ExplanationRecordRow,
  FeedbackEventRow,
  OAuthTokenRow,
  SignalRow,
  PreferenceProposalRow,
  TwinExportRow,
  SkillGapRow,
  ProactiveScanRow,
  BriefingRow,
  PaginationOptions,
  DateRangeOptions,
  UserQueryOptions,
  DecisionWithContext,
} from './types.js';

// Repositories
export {
  userRepository,
  twinRepository,
  decisionRepository,
  policyRepository,
  explanationRepository,
  feedbackRepository,
} from './repositories/index.js';
export type {
  CreateUserInput,
  UpdateUserInput,
  UpdateProfileInput,
  CreateDecisionInput,
  CreateCandidateActionInput,
  CreateOutcomeInput,
  CreatePolicyInput,
  UpdatePolicyInput,
  CreateExplanationInput,
  CreateFeedbackInput,
} from './repositories/index.js';

export { oauthRepository, approvalRepository, patternRepository, executionRepository } from './repositories/index.js';
export type {
  CreateExecutionPlanInput,
  CreateExecutionResultInput,
  ExecutionPlanWithResult,
} from './repositories/index.js';

export { signalRepository, proposalRepository, skillGapRepository, proactiveScanRepository } from './repositories/index.js';
export type {
  CreateSignalInput,
  CreateProposalInput,
  CreateSkillGapInput,
  CreateScanInput,
  CreateBriefingInput,
} from './repositories/index.js';

// Adapters
export {
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  decisionRepositoryAdapter,
  explanationRepositoryAdapter,
  policyRepositoryAdapter,
} from './adapters/index.js';

// Schema metadata
export { TABLE_NAMES, SCHEMA_PATH } from './schemas/index.js';
export type { TableName } from './schemas/index.js';
