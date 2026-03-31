// Pre-existing adapter interface (includes buildPlan)
export type { IronClawAdapter } from './ironclaw-adapter.js';

// Pre-existing mock implementation
export { MockIronClawAdapter as BasicMockAdapter } from './mock-ironclaw-adapter.js';

// Extended executor interface (includes getStatus)
export type { IronClawExecutor } from './adapter-interface.js';

// Full-featured mock with logging, configurable failures, and rollback
export {
  MockIronClawAdapter,
  type OperationLog,
  type MockAdapterConfig,
} from './mock-adapter.js';

// Real adapter with handler dispatch
export { RealIronClawAdapter } from './real-adapter.js';
export { ActionHandlerRegistry } from './handler-registry.js';

// Action handlers
export { EmailActionHandler } from './handlers/email-action-handler.js';
export { CalendarActionHandler } from './handlers/calendar-action-handler.js';
export { GenericActionHandler } from './handlers/generic-action-handler.js';
