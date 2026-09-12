// Core adapter interfaces
export type {
  IronClawAdapter,
  IronClawEnhancedAdapter,
  IronClawCredentialInfo,
} from './ironclaw-adapter.js';
export { isIronClawEnhancedAdapter } from './ironclaw-adapter.js';

// Real adapter: talks to IronClaw's HTTP webhook API
export { RealIronClawAdapter } from './real-adapter.js';

// HTTP client and config types for direct instantiation
export {
  IronClawHttpClient,
  type IronClawClientConfig,
  type IronClawMessage,
  type IronClawResponse,
} from './ironclaw-http-client.js';

// Direct execution adapter: local handler dispatch (fallback when IronClaw is unavailable)
export { DirectExecutionAdapter } from './direct-execution-adapter.js';
export { GmailInboxMutationService, gmailInboxMutationLimits } from './gmail-inbox-mutation-port.js';
export {
  DbGmailInboxObservationCredentials,
  GmailArchiveRecoveryObservationCoordinator,
  GmailInboxObservationService,
  gmailInboxObservationLimits,
} from './gmail-inbox-observation-port.js';
export {
  GMAIL_ARCHIVE_ATTEMPT_SCHEMA,
  GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
} from '@skytwin/shared-types';
export type {
  GmailArchiveAttemptPhase,
  GmailArchiveAttemptStateV1,
  GmailInboxMutationBinding,
  GmailInboxMutationCommand,
  GmailInboxMutationDispatchGate,
  GmailInboxMutationDispatchGateResult,
  GmailInboxMutationPort,
  GmailInboxMutationResult,
  GmailInboxMutationTarget,
  GmailInboxObservationBinding,
  GmailInboxObservationCommand,
  GmailInboxObservationPort,
  GmailInboxObservationResult,
  GmailInboxObservationUnavailableCode,
} from '@skytwin/shared-types';
export type { GmailInboxMutationServiceOptions } from './gmail-inbox-mutation-port.js';
export type {
  DbGmailInboxObservationCredentialsOptions,
  GmailArchiveRecoveryObservationCoordinatorOptions,
  GmailArchiveRecoveryObservationCoordinatorResult,
  GmailArchiveRecoveryObservationTargetResolver,
  GmailInboxObservationCredential,
  GmailInboxObservationCredentialRequest,
  GmailInboxObservationCredentialsPort,
  GmailInboxObservationServiceOptions,
  GmailInboxObservationTargetResolver,
} from './gmail-inbox-observation-port.js';
export { ActionHandlerRegistry } from './handler-registry.js';
export { DbCredentialProvider, NoopCredentialProvider } from './credential-provider.js';
export type { CredentialProvider } from './credential-provider.js';

// Action handlers (used by DirectExecutionAdapter, not by RealIronClawAdapter)
export { EmailActionHandler } from './handlers/email-action-handler.js';
export { CalendarActionHandler } from './handlers/calendar-action-handler.js';
export { GenericActionHandler } from './handlers/generic-action-handler.js';
export { FinanceActionHandler } from './handlers/finance-action-handler.js';
export { TaskActionHandler } from './handlers/task-action-handler.js';
export { SmartHomeActionHandler } from './handlers/smart-home-action-handler.js';
export { SocialActionHandler } from './handlers/social-action-handler.js';
export { DocumentActionHandler } from './handlers/document-action-handler.js';
export { HealthActionHandler } from './handlers/health-action-handler.js';

// Mock implementations for development and testing
export { SimpleIronClawMock, SimpleIronClawMock as BasicMockAdapter } from './mock-ironclaw-adapter.js';
export {
  MockIronClawAdapter,
  type OperationLog,
  type MockAdapterConfig,
} from './mock-adapter.js';
