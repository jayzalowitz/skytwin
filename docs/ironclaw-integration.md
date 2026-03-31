# SkyTwin IronClaw Integration

## What IronClaw Is

IronClaw is the downstream execution and runtime layer. SkyTwin decides what should happen; IronClaw makes it happen.

Think of the relationship like this: SkyTwin is the judgment call ("reschedule the standup and send a note to the organizer"), and IronClaw is the hands ("here's the Google Calendar API call and the Slack message").

IronClaw handles:
- Direct API interactions with external services (Google Calendar, Gmail, Stripe, etc.)
- Task orchestration (multi-step execution plans)
- Execution monitoring and status reporting
- Rollback execution where supported by the downstream service

SkyTwin handles:
- Deciding *whether* to act
- Deciding *what* to do
- Assessing *risk* and *confidence*
- Enforcing *policy* and *trust constraints*
- *Explaining* what happened and why

The boundary is clean: SkyTwin never calls external service APIs directly. IronClaw never makes judgment calls about whether an action should happen.

## Integration Boundary

```
SkyTwin                          IronClaw
--------                         ---------
Decision Engine                  Execution Runtime
  |                                  |
  v                                  v
Policy Engine                    Service Connectors
  |                              (Gmail, Calendar, Stripe, etc.)
  v                                  |
IronClaw Adapter ──────────────> API  |
  |        <──────────────────── Webhooks/Results
  v                                  |
Explanation Layer                Status Monitoring
```

The `@skytwin/ironclaw-adapter` package is the only code in SkyTwin that communicates with IronClaw. No other package imports IronClaw types or calls IronClaw APIs. This isolation is enforced by the monorepo dependency graph.

## Adapter Pattern

The adapter uses a TypeScript interface to define the contract. Both a mock implementation (for development and testing) and a real implementation (`RealIronClawAdapter` with `ActionHandlerRegistry`) are provided. The real adapter dispatches to domain-specific handlers: `EmailActionHandler`, `CalendarActionHandler`, and `GenericActionHandler`.

### Interface Definition

```typescript
interface IronClawExecutor {
  /**
   * Submit an execution plan for processing.
   */
  execute(plan: ExecutionPlan): Promise<ExecutionResult>;

  /**
   * Get the current status of an execution plan.
   */
  getStatus(planId: string): Promise<ExecutionStatus>;

  /**
   * Attempt to roll back a previously executed plan.
   */
  rollback(planId: string): Promise<RollbackResult>;

  /**
   * Check if the IronClaw service is healthy.
   */
  healthCheck(): Promise<boolean>;
}
```

### Why an Adapter

1. **IronClaw's API is not yet stable.** We don't want SkyTwin's decision logic coupled to an API that's still evolving. The adapter absorbs API changes without affecting the rest of the system.

2. **Testability.** Every test of the decision pipeline can use the mock adapter. No external service calls during unit or integration tests.

3. **Error normalization.** IronClaw may return errors in various formats. The adapter normalizes them into SkyTwin error types.

4. **Retry encapsulation.** The adapter handles transient failure retries internally. The decision engine doesn't need to know about HTTP timeouts or rate limits.

5. **Future flexibility.** If IronClaw is replaced or supplemented by another execution layer, only the adapter changes.

## Expected Capabilities

Based on the workflows SkyTwin needs to support, the IronClaw integration should eventually handle:

### Email Operations
- Send email (plain text, HTML)
- Draft email (save without sending)
- Archive email
- Label/categorize email
- Forward email

### Calendar Operations
- Create event
- Reschedule event (modify time)
- Cancel/decline event
- Accept event
- Send calendar notification to attendees

### Subscription Management
- Renew subscription
- Cancel subscription
- Modify subscription (upgrade/downgrade)

### Purchase Operations
- Place order (from template/previous order)
- Modify order (before fulfillment)
- Cancel order (before fulfillment)

### Travel Operations
- Book flight/hotel
- Select seat preference
- Cancel booking (within cancellation window)

### Generic Operations
- HTTP request to arbitrary endpoint (with authentication)
- Webhook notification
- Status check on previous execution

Not all of these are implemented in IronClaw today. The adapter interface is designed to support them, with graceful failure for unsupported operations.

## Task Handoff Contract

When SkyTwin decides to execute an action, it converts the `CandidateAction` into an `ExecutionPlan` and hands it to IronClaw.

### ExecutionPlan Format

```typescript
interface ExecutionPlan {
  id: string;
  decisionId: string;
  action: CandidateAction;
  steps: ExecutionStep[];
  rollbackSteps: ExecutionStep[];
  createdAt: Date;
}

interface ExecutionStep {
  id: string;
  order: number;
  type: string;
  description: string;
  parameters: Record<string, unknown>;
  timeout: number;
}
```

### Key Design Decisions

**Idempotency keys:** Every execution plan includes an idempotency key. If IronClaw receives the same key twice, it should return the result of the first execution rather than executing again. This protects against retry-induced double-execution.

**Timeout:** SkyTwin sets a timeout based on urgency and action type. If IronClaw hasn't completed execution within the timeout, SkyTwin treats it as a failure and may escalate to the user.

**Metadata:** The plan includes metadata about the decision context. IronClaw can use this for logging, monitoring, and priority routing. It should not use it for decision-making -- that's SkyTwin's job.

**Scheduled execution:** Some actions should execute at a specific time (e.g., "send this email at 9am"). The `scheduledFor` field supports deferred execution. IronClaw is responsible for honoring the schedule.

## Execution Result Contract

After IronClaw executes (or attempts to execute) a plan, it returns an `ExecutionResult`:

```typescript
interface ExecutionResult {
  planId: string;
  status: ExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  output?: Record<string, unknown>;
}

type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed';
```

### Status Meanings

| Status | Meaning | SkyTwin Response |
|--------|---------|-----------------|
| `pending` | Execution has been submitted but not yet started | Wait for execution to begin |
| `running` | Execution is in progress | Poll for completion, respect timeout |
| `completed` | Action executed successfully | Log success, generate explanation |
| `failed` | Action could not be executed | Log failure, notify user, consider retry |

### Error Classification

Errors are returned as an optional `error` string on `ExecutionResult`. The adapter uses the `error` field and `status` to determine how to handle failures:

- **Retryable failures** (e.g., transient network issues) trigger automatic retry (up to 2 retries with linear backoff).
- **Permanent failures** (e.g., invalid parameters) are reported to the user immediately. No retry.
- **Timeouts** are treated as failures. The user is notified. The system does not assume the action completed.

## Failure Handling Strategy

### Retry Logic

```
Execute Plan
    |
    v
IronClaw returns result
    |
    ├── completed → success path
    ├── failed (retryable) → retry (max 2)
    |     |
    |     └── all retries exhausted → failure path
    ├── failed (permanent) → failure path
    ├── pending → poll with timeout
    |     |
    |     └── timeout exceeded → failure path
    └── unknown → failure path
```

### Failure Path

When execution fails:
1. Record the failure in the `execution_results` table
2. Generate an explanation: "I tried to [action] but it failed because [reason]"
3. Notify the user if the action was auto-executed (they need to know it didn't work)
4. Do not automatically retry permanent failures
5. Do not assume partial failures completed the important parts
6. Record the failure as neutral feedback (don't penalize the twin for IronClaw failures)

### Circuit Breaker

If IronClaw fails repeatedly (configurable: 5 failures in 5 minutes), the adapter activates a circuit breaker:
- All new executions are queued rather than sent
- Health checks continue
- When health check succeeds, circuit closes and queued executions resume
- User is notified that automated actions are temporarily paused

## Observability Assumptions

The adapter provides observability through:

### Logging
- Every execution plan submission is logged with plan ID, action type, and user ID
- Every result is logged with status, duration, and error details (if any)
- Retries are logged with attempt number and reason

### Metrics (Planned)
- `ironclaw.execution.duration` -- histogram of execution times
- `ironclaw.execution.status` -- counter by status (completed, failed, etc.)
- `ironclaw.execution.retries` -- counter of retry attempts
- `ironclaw.circuit_breaker.state` -- gauge (open/closed)
- `ironclaw.health_check.latency` -- histogram of health check response times

### Correlation
Every execution plan includes the `decisionId` from SkyTwin. IronClaw should propagate this ID in its own logs. This enables end-to-end tracing from event ingestion through decision to execution.

## Rollback Possibilities

Rollback depends entirely on what IronClaw can do with the downstream service:

### Likely Rollbackable
- Email archive → unarchive
- Calendar event creation → delete event
- Calendar reschedule → reschedule back
- Draft email → delete draft
- Order modification → revert modification (before fulfillment)

### Possibly Rollbackable
- Subscription renewal → cancel within grace period
- Order placement → cancel before fulfillment cutoff
- Flight booking → cancel within 24-hour window

### Not Rollbackable
- Email sent → cannot unsend
- Meeting declined → can re-accept but social damage may be done
- Subscription canceled → may lose promotional pricing
- Non-refundable purchase → money is gone

SkyTwin determines rollback availability from the `ExecutionPlan`'s `rollbackSteps` and the `action.reversible` flag. When a user requests an undo, the adapter checks whether rollback steps are defined and the action is marked as reversible, then either initiates rollback or informs the user that rollback is not possible.

## What We Don't Know Yet

Honest accounting of current uncertainties:

### IronClaw API Surface
We don't know the exact API endpoints, authentication mechanism, request/response formats, or error codes. The adapter interface is based on what we *need* IronClaw to support, not what it currently provides. The mock implementation simulates expected behavior.

### Execution Latency
We don't know how long IronClaw takes to execute various action types. The mock uses a default base delay of 100ms. Real latency may be significantly different, especially for actions that involve multiple downstream API calls.

### Rollback Granularity
We don't know exactly which actions IronClaw can roll back and under what conditions. The adapter treats rollback as best-effort and always tells the user the truth about what can and can't be undone.

### Authentication Model
We don't know how SkyTwin will authenticate with IronClaw. The adapter assumes an API key or token-based authentication. The actual mechanism will be configured via environment variables when known.

### Webhook vs. Polling
We don't know whether IronClaw will push execution results via webhooks or whether SkyTwin needs to poll. The adapter interface supports both patterns. The mock implementation uses immediate responses (simulating polling).

### Rate Limits
We don't know IronClaw's rate limits. The adapter includes a placeholder for rate limit handling, but actual limits will need to be configured when known.

### Multi-Step Execution
We don't know whether IronClaw supports compound execution plans (multiple steps in one request) or whether SkyTwin needs to orchestrate steps individually. The adapter currently sends one plan per action. Multi-step orchestration is a future consideration.

## Mock Adapter Behavior

The mock adapter (`MockIronClawAdapter`) simulates IronClaw for development and testing.

### Default Behavior

```typescript
class MockIronClawAdapter implements IronClawExecutor {
  // Configurable behavior (via MockAdapterConfig)
  private executionDelayMs = 100;        // Base execution delay in milliseconds
  private failureProbability = 0.05;     // Probability of simulated failure (0-1)
  private simulateDelays = true;         // Whether to simulate execution delays

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    // Simulate execution delay
    if (this.simulateDelays) {
      await delay(this.executionDelayMs);
    }

    // Simulate step-by-step execution with possible failure
    for (const step of plan.steps) {
      if (Math.random() < this.failureProbability) {
        return {
          planId: plan.id,
          status: 'failed',
          startedAt: new Date(),
          completedAt: new Date(),
          error: `Simulated failure at step ${step.order}: ${step.description}`,
        };
      }
    }

    return {
      planId: plan.id,
      status: 'completed',
      startedAt: new Date(),
      completedAt: new Date(),
      output: {
        stepsCompleted: plan.steps.length,
        actionType: plan.action.actionType,
        description: plan.action.description,
      },
    };
  }
  // ... similar for getStatus, rollback, healthCheck
}
```

### Test Configuration

Tests can configure the mock to simulate specific scenarios:

```typescript
// Simulate IronClaw failing on every execution
const adapter = new MockIronClawAdapter({ failureProbability: 1.0 });

// Simulate slow execution
const adapter = new MockIronClawAdapter({ executionDelayMs: 5000 });

// Disable simulated delays for fast tests
const adapter = new MockIronClawAdapter({ simulateDelays: false });

// Simulate IronClaw being unhealthy
const adapter = new MockIronClawAdapter();
adapter.setHealthy(false);
```

### Idempotency in Mock

The mock adapter tracks idempotency keys. If the same key is submitted twice, it returns the original result without "re-executing." This ensures retry logic is tested correctly even in the mock environment.

### Testing Helpers

The mock adapter provides several methods for inspecting and controlling state in tests:

```typescript
// Get all operation logs (execute, status_check, rollback, health_check)
const logs = adapter.getLogs();
// Returns: readonly OperationLog[]

// Get the result for a specific plan
const result = adapter.getResult(planId);
// Returns: ExecutionResult | undefined

// Clear all logs
adapter.clearLogs();

// Reset all state (plans, logs, health status)
adapter.reset();

// Control health check responses
adapter.setHealthy(false);
```

This makes it easy to assert that the decision pipeline produced the expected execution plans without inspecting IronClaw internals.

## Migration Path

### Phase 1: Mock Only (Current)
- All development and testing uses `MockIronClawAdapter`
- No real external service calls
- Decision pipeline is fully testable end-to-end

### Phase 2: IronClaw Sandbox
- Connect to IronClaw's sandbox/staging environment
- Real API calls but against test accounts
- Validate the adapter interface against actual API behavior
- Discover and handle real error patterns

### Phase 3: Production Integration
- Connect to production IronClaw
- Start with low-risk action types (archive email, reschedule meeting)
- Monitor execution results closely
- Gradually enable more action types as confidence builds

### Phase 4: Advanced Integration
- Webhook-based result delivery (if supported)
- Compound execution plans
- Real-time status streaming
- Advanced rollback coordination
