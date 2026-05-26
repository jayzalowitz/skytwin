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
  OAuthTokenRowWithEncrypted,
  CredentialVaultMetaRow,
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
  ExecutionEventRow,
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
  SpendRecordRow,
  TrustTierAuditRow,
  DomainAutonomyPolicyRow,
  EscalationTriggerRow,
  PreferenceHistoryRow,
  MemoryWingRow,
  MemoryRoomRow,
  MemoryDrawerRow,
  MemoryClosetRow,
  MemoryTunnelRow,
  KnowledgeEntityRow,
  KnowledgeTripleRow,
  EpisodicMemoryRow,
  EntityCodeRow,
  ServiceCredentialRow,
  CredentialRequirementRow,
  IronClawToolRow,
  AIProviderSettingsRow,
  OauthPkcePendingRow,
  OauthPendingSigninRow,
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

export {
  oauthRepository,
  oauthPkcePendingRepository,
  oauthPendingSigninRepository,
  approvalRepository,
  patternRepository,
  executionRepository,
  connectorHealthRepository,
} from './repositories/index.js';
export type { ConnectorHealthRow } from './repositories/index.js';
export type {
  RememberPendingSigninInput,
  ConsumedPendingSignin,
} from './repositories/index.js';
export type {
  CreateExecutionPlanInput,
  CreateExecutionResultInput,
  CreateExecutionEventInput,
  ExecutionPlanWithResult,
} from './repositories/index.js';

export { signalRepository, proposalRepository, skillGapRepository, proactiveScanRepository } from './repositories/index.js';

export { trustTierAuditRepository, spendRepository, domainAutonomyRepository, escalationTriggerRepository, preferenceHistoryRepository, sessionRepository, mempalaceRepository, serviceCredentialRepository, credentialRequirementRepository, aiProviderRepository, ironClawToolRepository, forwardedSignalsRepository, connectorCursorRepository, emailLabelRepository, assistantRepository, deriveThreadTitle, appSuggestionRepository, mcpServerRepository, riskProfileRepository, provenanceRepository, briefingRepository } from './repositories/index.js';
export type { AppSuggestionRow, UpsertPendingSuggestionInput } from './repositories/index.js';
export type { McpServerRow } from './repositories/index.js';
export { promotionOffersRepository } from './repositories/index.js';
export type {
  PromotionOfferRow,
  CreatePromotionOfferInput,
  PromotionOfferResponse,
} from './repositories/index.js';
export { draftEmailEvalRunsRepository } from './repositories/index.js';
export type {
  DraftEmailEvalRunRow,
  RecordEvalRunInput,
} from './repositories/index.js';
export type { ProvenanceNodeRow, ProvenanceEdgeRow, WriteNodeInput } from './repositories/index.js';
export type { TwinBriefingRow, CreateTwinBriefingInput } from './repositories/index.js';
export type {
  RiskProfileRow,
  UpsertRiskProfileInput,
  UpdateInterpretedCapsInput,
} from './repositories/index.js';
export type { AssistantThread, AssistantMessage } from './repositories/index.js';
export { onboardingRepository } from './repositories/index.js';
export type { OnboardingStateRow } from './repositories/index.js';

export { externalAgentTokenRepository } from './repositories/index.js';
export type {
  ExternalAgentTokenRow,
  CreateExternalAgentTokenInput,
} from './repositories/index.js';

export { dxtExportRepository } from './repositories/index.js';
export type {
  DxtExportRow,
  DxtExportMetadataRow,
  CreateDxtExportInput,
} from './repositories/index.js';

export { dxtImportRepository } from './repositories/index.js';
export type {
  DxtImportRow,
  CreateDxtImportInput,
} from './repositories/index.js';

export { lifebookRepository } from './repositories/index.js';
export type {
  LifebookRow,
  LifebookImportance,
  UpsertLifebookInput,
} from './repositories/index.js';

export {
  federationPeerRepository,
  federationPairingCodeRepository,
} from './repositories/index.js';
export type {
  FederationPeerRow,
  PairingCodeRow,
  CreatePeerInput,
  UpdateSyncStatusInput,
} from './repositories/index.js';

export {
  recoveryCodeRepository,
  vacationModeRepository,
  generatePlainCode,
} from './repositories/index.js';
export type { RecoveryCodeRow } from './repositories/index.js';

export { modelDownloadRepository } from './repositories/index.js';
export type {
  ModelDownloadRow,
  ModelDownloadStatus,
  CreateModelDownloadInput,
} from './repositories/index.js';

export { mcpServerMetricsRepository } from './repositories/index.js';

export { credentialVaultMetaRepository } from './repositories/index.js';
export type { CredentialVaultMetaRow as CredentialVaultMetaRepositoryRow } from './repositories/index.js';
export type {
  WriteBucketInput,
  MetricsBucketRow,
  SparklinePoint,
} from './repositories/index.js';
export type { ForwardedSignalRow } from './repositories/index.js';

export { mcpServerChangelogRepository } from './repositories/index.js';
export type {
  McpServerChangelogRow,
  UpsertChangelogInput,
  PendingSkillOptInRow,
} from './repositories/index.js';
export type { ConnectorCursorRow } from './repositories/index.js';
export type { SessionRow } from './repositories/index.js';
export type {
  EmailLabelObservation,
  SenderLabelStat,
  PruneOptions,
  PruneResult,
} from './repositories/index.js';
export type { UpsertServiceCredentialInput } from './repositories/index.js';
export type { RegisterCredentialRequirementInput } from './repositories/index.js';
export type { UpsertIronClawToolInput } from './repositories/index.js';
export type { CreateTierAuditInput } from './repositories/index.js';
export type { CreateSpendRecordInput } from './repositories/index.js';
export { draftEmailCallsRepository } from './repositories/index.js';
export type {
  DraftEmailCallRow,
  RecordDraftEmailCallInput,
} from './repositories/index.js';
export type { UpsertDomainAutonomyInput } from './repositories/index.js';
export type { CreateEscalationTriggerInput } from './repositories/index.js';
export type { CreatePreferenceHistoryInput } from './repositories/index.js';
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
