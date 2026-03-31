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
