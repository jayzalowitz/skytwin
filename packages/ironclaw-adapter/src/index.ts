// Core adapter interface (unchanged — the contract SkyTwin codes against)
export type { IronClawAdapter } from './ironclaw-adapter.js';

// Extended executor interface (includes getStatus)
export type { IronClawExecutor } from './adapter-interface.js';

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
export { ActionHandlerRegistry } from './handler-registry.js';

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
export { MockIronClawAdapter as BasicMockAdapter } from './mock-ironclaw-adapter.js';
export {
  MockIronClawAdapter,
  type OperationLog,
  type MockAdapterConfig,
} from './mock-adapter.js';
