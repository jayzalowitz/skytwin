# Issue 007: Build the IronClaw Adapter

**Milestone:** [M3 -- Real Workflows](./milestone-3-real-workflows.md)
**Priority:** P1
**Estimate:** 4-5 days
**Assignee:** TBD
**Labels:** `ironclaw-adapter`, `integration`, `M3`
**Depends on:** [Issue 001](./issue-001-bootstrap-repo.md), [Issue 002](./issue-002-define-core-schemas.md), M2 completion

## Problem

SkyTwin decides what to do. IronClaw does it. The adapter is the bridge between them. Without it, SkyTwin's decisions are plans that never execute. The adapter must handle the messy realities of external API communication: retries, timeouts, partial failures, rollback, and error classification -- while presenting a clean, typed interface to the rest of the system.

## Why It Matters

The IronClaw adapter is the only package that touches the outside world (via IronClaw's API). Everything else in SkyTwin is internal reasoning. This makes the adapter both the most important integration boundary and the most likely source of production issues. A flaky adapter means SkyTwin is unreliable. A leaky adapter means IronClaw concerns infect the entire codebase.

The adapter pattern is a CLAUDE.md mandate: "All IronClaw API access goes through `@skytwin/ironclaw-adapter`. Never call the IronClaw API directly from other packages."

## Scope

### IronClawAdapter Interface

```typescript
interface IronClawAdapter {
  /**
   * Execute an action via IronClaw.
   * Translates a SkyTwin CandidateAction into an IronClaw execution request,
   * sends it, and returns the result in SkyTwin types.
   */
  execute(action: CandidateAction): Promise<ExecutionResult>;

  /**
   * Check the status of a previously submitted execution.
   * Used for long-running actions that don't complete synchronously.
   */
  getStatus(executionId: string): Promise<ExecutionStatus>;

  /**
   * Request rollback of a previously executed action.
   * Only works for actions marked as reversible.
   */
  rollback(executionId: string): Promise<RollbackResult>;

  /**
   * Check if IronClaw is reachable and healthy.
   */
  healthCheck(): Promise<HealthCheckResult>;
}

interface ExecutionStatus {
  executionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';
  progress?: number;       // 0.0 to 1.0 for long-running actions
  result?: ExecutionResult;
  updatedAt: Date;
}

interface RollbackResult {
  executionId: string;
  success: boolean;
  partialRollback: boolean;   // True if some steps rolled back but not all
  error?: string;
  rolledBackAt: Date;
}

interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number;
  version?: string;
  degradedServices?: string[];
}
```

### Mock Implementation (M0, already exists as stub)

The mock implementation returns canned responses for testing:

```typescript
class MockIronClawAdapter implements IronClawAdapter {
  private executions: Map<string, ExecutionStatus>;
  private failureRate: number;  // Configurable for testing failure scenarios

  async execute(action: CandidateAction): Promise<ExecutionResult> {
    // Simulate execution delay
    // Return success or failure based on failureRate
    // Store execution for status queries
  }
}
```

The mock is used by all M1 and M2 tests. It supports:
- Configurable latency (simulate slow actions)
- Configurable failure rate (test error handling)
- Configurable partial failures (some steps succeed, some fail)
- Execution history (query past executions)

### Production Implementation (M3)

#### HTTP Client

Built on a standard HTTP client (e.g., `undici` or `node:fetch`) with:

- **Base URL configuration:** From `@skytwin/config` (`IRONCLAW_BASE_URL`)
- **Authentication:** API key in header (`IRONCLAW_API_KEY`)
- **Request timeout:** Configurable (default 30 seconds for execute, 5 seconds for status/health)
- **Request/response logging:** Log request method, URL (redact sensitive params), response status, latency

#### Retry Logic

Exponential backoff with jitter:

```typescript
interface RetryConfig {
  maxRetries: number;        // Default: 3
  baseDelayMs: number;       // Default: 1000
  maxDelayMs: number;        // Default: 30000
  jitterFactor: number;      // Default: 0.1 (10% jitter)
  retryableStatuses: number[];  // Default: [429, 500, 502, 503, 504]
}
```

Retry behavior:
- **Retryable errors:** 429 (rate limit), 500 (internal error), 502/503/504 (infrastructure). Retry with backoff.
- **Non-retryable errors:** 400 (bad request), 401 (auth), 403 (forbidden), 404 (not found), 409 (conflict). Fail immediately.
- **Idempotency:** Execute requests include an idempotency key (the `CandidateAction.id`) to prevent duplicate execution on retry.

#### Circuit Breaker

```typescript
interface CircuitBreakerConfig {
  failureThreshold: number;     // Default: 5 failures to open
  successThreshold: number;     // Default: 3 successes to close
  halfOpenTimeout: number;      // Default: 30000ms (30 seconds)
}
```

States:
- **Closed:** Normal operation. Requests pass through. Track failure count.
- **Open:** All requests fail immediately with `CircuitOpenError`. No HTTP calls made.
- **Half-open:** After `halfOpenTimeout`, allow one request through. If it succeeds, close the circuit. If it fails, reopen.

The circuit breaker protects against cascading failures when IronClaw is down. Rather than queuing up retries and timing out, the system fails fast and can escalate to the user.

#### Request/Response Translation

The adapter translates between SkyTwin types and IronClaw's API format:

```typescript
// SkyTwin → IronClaw
function toIronClawRequest(action: CandidateAction): IronClawExecutionRequest {
  return {
    action_type: action.actionType,
    domain: action.domain,
    parameters: action.parameters,
    idempotency_key: action.id,
    callback_url: null,  // M3: polling, not callbacks
  };
}

// IronClaw → SkyTwin
function fromIronClawResponse(response: IronClawExecutionResponse): ExecutionResult {
  return {
    planId: response.execution_id,
    success: response.status === 'completed',
    outputs: response.outputs ?? {},
    error: response.error_message ?? null,
    completedAt: new Date(response.completed_at),
    rollbackAvailable: response.rollback_supported,
  };
}
```

These translation functions are the only place where IronClaw-specific types exist. They're private to the adapter package.

#### Error Classification

```typescript
enum IronClawErrorType {
  TRANSIENT = 'transient',         // Retry is appropriate
  PERMANENT = 'permanent',         // Action cannot succeed, don't retry
  PARTIAL = 'partial',             // Some steps succeeded, some failed
  RATE_LIMITED = 'rate_limited',   // Slow down and retry
  AUTH = 'auth',                   // API key issue
  NOT_FOUND = 'not_found',        // Resource doesn't exist
  CONFLICT = 'conflict',          // Action conflicts with current state
}

function classifyError(status: number, body: unknown): IronClawErrorType;
```

Error classification determines the adapter's behavior:
- `TRANSIENT`: Retry with backoff
- `PERMANENT`: Return failure immediately, include error details
- `PARTIAL`: Return failure with partial results, enable rollback of completed steps
- `RATE_LIMITED`: Retry with extended backoff (honor `Retry-After` header)
- `AUTH`: Return failure, log alert (API key may be expired)
- `NOT_FOUND`: Return failure (the target resource doesn't exist in IronClaw)
- `CONFLICT`: Return failure (action conflicts with current state, e.g., email already sent)

### Execution Flow

```
DecisionOutcome (autoExecute: true)
  │
  ▼
IronClawAdapter.execute(selectedAction)
  │
  ├── Build IronClaw request (translate types)
  ├── Send HTTP request (with retry + circuit breaker)
  ├── Receive response (or timeout/error)
  ├── Translate response to ExecutionResult
  └── Return result
  │
  ▼
ExecutionResult { success, outputs, error, rollbackAvailable }
  │
  ▼
Persist to execution_results table
```

For long-running actions:
```
execute() → ExecutionResult { success: false, status: 'pending' }
  │
  ▼
Poll getStatus() every N seconds
  │
  ▼
Eventually: status: 'completed' or 'failed'
  │
  ▼
Persist final result
```

### Rollback Flow

```
User requests undo
  │
  ▼
Check: rollbackAvailable === true?
  ├── No → Return error "action cannot be rolled back"
  └── Yes ↓
  │
  ▼
IronClawAdapter.rollback(executionId)
  │
  ├── Send rollback request
  ├── Handle response (success, partial, failure)
  └── Return RollbackResult
  │
  ▼
Update execution_results: status = 'rolled_back'
Persist RollbackResult
```

## Implementation Notes

### Configuration

All IronClaw configuration comes from `@skytwin/config`:

```typescript
interface IronClawConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retry: RetryConfig;
  circuitBreaker: CircuitBreakerConfig;
}
```

Environment variables:
- `IRONCLAW_BASE_URL`: Required. The IronClaw API base URL.
- `IRONCLAW_API_KEY`: Required. The API key for authentication.
- `IRONCLAW_TIMEOUT_MS`: Optional. Default 30000.
- `IRONCLAW_MAX_RETRIES`: Optional. Default 3.

### No IronClaw Types in Public API

The adapter's public API uses only SkyTwin types (`CandidateAction`, `ExecutionResult`, etc.). IronClaw-specific types (request/response formats, error codes) are private to the adapter package.

This means:
- `packages/ironclaw-adapter/src/types/ironclaw.ts` defines IronClaw API types (private, not exported)
- `packages/ironclaw-adapter/src/translators.ts` converts between SkyTwin and IronClaw types
- `packages/ironclaw-adapter/src/index.ts` exports only the `IronClawAdapter` interface and factory function

### Testing Strategy

1. **Unit tests with HTTP mocks:** Mock the HTTP layer (e.g., `msw` or `nock`) to test retry logic, circuit breaker, error classification.
2. **Contract tests:** Define the expected IronClaw API contract as test fixtures. Verify the adapter handles all response shapes correctly.
3. **Mock adapter tests:** Verify the mock implementation behaves consistently for all integration tests.
4. **Circuit breaker state machine tests:** Test all state transitions (closed -> open, open -> half-open, half-open -> closed/open).
5. **Retry exhaustion test:** Verify that after max retries, the adapter returns a clear failure.
6. **Rollback tests:** Test successful rollback, partial rollback, and failed rollback scenarios.
7. **Timeout tests:** Verify that requests timeout after the configured duration and are classified as transient errors.

### Dependencies

The adapter should have minimal dependencies:
- `@skytwin/shared-types`: For SkyTwin type definitions
- `@skytwin/core`: For error types and logging
- `@skytwin/config`: For configuration loading
- No other `@skytwin/*` packages

## Acceptance Criteria

- [ ] `IronClawAdapter` interface is implemented with `execute`, `getStatus`, `rollback`, and `healthCheck`.
- [ ] Mock implementation exists and is configurable (latency, failure rate, partial failures).
- [ ] Production implementation uses HTTP client with configurable base URL and API key.
- [ ] Retry logic retries on 429, 500, 502, 503, 504 with exponential backoff and jitter.
- [ ] Retry logic does not retry on 400, 401, 403, 404, 409.
- [ ] Circuit breaker opens after 5 consecutive failures and closes after 3 consecutive successes in half-open state.
- [ ] Requests include idempotency key to prevent duplicate execution on retry.
- [ ] Request/response translation correctly maps between SkyTwin and IronClaw types.
- [ ] Error classification correctly categorizes all HTTP status codes.
- [ ] No IronClaw-specific types are exported from the package.
- [ ] `healthCheck()` returns latency and health status.
- [ ] Rollback works for reversible actions and returns clear error for irreversible ones.
- [ ] Long-running actions can be polled via `getStatus()`.
- [ ] All tests pass: `pnpm --filter @skytwin/ironclaw-adapter test`.

## Non-Goals

- **IronClaw API design:** We build against IronClaw's existing API. We don't influence its design.
- **Webhook/callback support:** M3 uses polling for long-running actions. Webhooks are future work.
- **Multi-region IronClaw routing:** Single IronClaw endpoint. Multi-region is infrastructure, not application concern.
- **Request batching:** One action = one IronClaw API call. Batching is future optimization.
- **IronClaw authentication flows:** M3 uses a static API key. OAuth, token refresh, etc. are future work.

## Dependencies

- [Issue 001](./issue-001-bootstrap-repo.md): Workspace structure.
- [Issue 002](./issue-002-define-core-schemas.md): `CandidateAction`, `ExecutionResult`, `ExecutionPlan`, `ExecutionStep` types.
- M2 completion: The policy engine must be working so that only approved actions reach the adapter.

## Risks and Open Questions

| Item | Type | Notes |
|------|------|-------|
| IronClaw API documentation may be incomplete | Risk | Build against the interface, not the docs. Use contract tests to verify assumptions. When the real API differs from expectations, fix the adapter, not the rest of the system. |
| Circuit breaker and retry logic interact in complex ways | Risk | The circuit breaker wraps the retry loop. If a retryable request fails all retries, it counts as one circuit breaker failure. Test the interaction explicitly. |
| Idempotency keys may not be supported by all IronClaw endpoints | Risk | Document which endpoints support idempotency. For those that don't, use at-most-once semantics (don't retry). |
| Long-running action polling creates load | Risk | Use exponential backoff for polling intervals (1s, 2s, 4s, 8s, max 60s). Set a maximum polling duration (15 minutes) after which the action is considered failed. |
| Should the adapter manage its own execution persistence? | Open question | Decision: No. The adapter returns `ExecutionResult` and the calling code (decision engine or worker) persists it. The adapter is stateless (except for circuit breaker state and the mock's in-memory store). |
| Which HTTP client library to use? | Open question | Decision: Use `undici` (Node.js built-in as of v18). It's fast, supports HTTP/2, and has good timeout handling. No external dependency needed. |
