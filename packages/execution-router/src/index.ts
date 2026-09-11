export {
  ExecutionRouter,
  NoAdapterError,
  InvariantViolationError,
  AmbiguousExecutionError,
  EXECUTION_FAILURE_CODES,
  executionFailureCode,
} from './execution-router.js';
export type {
  ExecutionContext,
  RollbackRoutingResult,
  PreparedExecution,
  ExecutionFailureCode,
} from './execution-router.js';

export {
  AdapterRegistry,
  IRONCLAW_TRUST_PROFILE,
  OPENCLAW_TRUST_PROFILE,
  DIRECT_TRUST_PROFILE,
  MCP_HOST_TRUST_PROFILE,
  type AdapterEntry,
} from './adapter-registry.js';

export { OpenClawAdapter, OPENCLAW_SKILLS } from './openclaw-adapter.js';
export type { OpenClawCredentialRequirement, OnCredentialNeeded } from './openclaw-adapter.js';

export { applyAdapterRiskModifier } from './risk-modifier.js';

export { logSkillGap } from './skill-gap-logger.js';

export { discoverAdapters } from './adapter-discovery.js';
export { validateManifest } from './adapter-manifest.js';
export type { AdapterManifest } from './adapter-manifest.js';
