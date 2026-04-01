# SkyTwin IronClaw Integration

## What IronClaw Is

[IronClaw](https://github.com/nearai/ironclaw/) is a Rust-based autonomous agent server developed by NEAR AI. It runs as a standalone process and exposes an HTTP webhook API for receiving execution requests. SkyTwin decides what should happen; IronClaw makes it happen.

IronClaw provides:
- **Sandboxed tool execution** via WASM containers with capability-based permissions
- **Credential management** with endpoint allowlisting and leak detection
- **Multi-provider LLM support** for tool orchestration
- **Built-in safety** with prompt injection defense and content sanitization
- **Persistent memory** and workspace filesystem
- **Routines engine** for cron schedules and event triggers

SkyTwin handles:
- Deciding *whether* to act
- Deciding *what* to do
- Assessing *risk* and *confidence*
- Enforcing *policy* and *trust constraints*
- *Explaining* what happened and why

The boundary is clean: SkyTwin never calls external service APIs directly in production. IronClaw never makes judgment calls about whether an action should happen.

## Architecture

```
SkyTwin                              IronClaw Server (Rust)
--------                             --------------------
Decision Engine                      HTTP Webhook (POST /webhook)
  |                                    |
  v                                    v
Policy Engine                        Agent Loop + LLM Reasoning
  |                                    |
  v                                    v
IronClaw Adapter ──── HMAC-SHA256 ──> Tool Dispatch
  |  (HTTP POST)                       |
  |                                    v
  |                                  WASM Sandbox / Docker
  |                                    |
  |  <─── JSON Response ─────────────  v
  v                                  External APIs
Explanation Layer                    (Gmail, Calendar, Stripe, etc.)
```

The `@skytwin/ironclaw-adapter` package is the only code in SkyTwin that communicates with IronClaw. No other package imports IronClaw types or calls IronClaw APIs. This isolation is enforced by the monorepo dependency graph.

## Adapter Implementations

### RealIronClawAdapter (Production)

Communicates with an IronClaw server via its HTTP webhook API:
- Sends structured execution requests to `POST /webhook` with HMAC-SHA256 authentication
- IronClaw uses its sandboxed tool system to execute actions
- Parses IronClaw's responses back into SkyTwin's `ExecutionResult` types
- Includes retry logic with linear backoff and circuit breaker protection
- Uses `/health` endpoint for health checks
- Correlates rollback requests via IronClaw thread IDs

### DirectExecutionAdapter (Fallback)

Dispatches actions to locally registered handler classes (`EmailActionHandler`, `CalendarActionHandler`, etc.) that call external APIs directly via `fetch()`. This bypasses IronClaw entirely — useful only when IronClaw is not running.

### MockIronClawAdapter (Development/Testing)

Simulates execution without any external calls. Configurable delays, failure probability, and logging for test scenarios.

## Authentication

IronClaw's webhook endpoint uses HMAC-SHA256 authentication:

1. SkyTwin serializes the message body as JSON
2. Computes `HMAC-SHA256(body, IRONCLAW_WEBHOOK_SECRET)`
3. Sends the signature in the `X-Signature-256` header as `sha256=<hex>`
4. IronClaw verifies the signature before processing

### Configuration

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `IRONCLAW_API_URL` | Base URL for IronClaw server (e.g., `http://localhost:4000`) | Yes |
| `IRONCLAW_WEBHOOK_SECRET` | HMAC-SHA256 secret for webhook auth | Yes (when `USE_MOCK_IRONCLAW=false`) |
| `IRONCLAW_OWNER_ID` | Owner ID for IronClaw's multi-tenant model | No (defaults to `skytwin-default`) |
| `USE_MOCK_IRONCLAW` | `true` to use mock adapter, `false` for real | No (defaults to `true`) |

## Message Format

### Execution Request

SkyTwin sends a structured message to IronClaw's webhook:

```typescript
{
  channel: "skytwin",
  user_id: "<userId>",
  owner_id: "<ownerId>",
  content: "Execute the following action as instructed by SkyTwin...",
  thread_id: "<planId>",  // Used for rollback correlation
  attachments: [],
  metadata: {
    skytwin: true,
    message_type: "execute",
    plan_id: "<planId>",
    decision_id: "<decisionId>",
    idempotency_key: "<planId>",
    action: {
      type: "archive_email",
      domain: "email",
      description: "Archive the newsletter email",
      parameters: { emailId: "msg_123" },
      reversible: true,
      estimated_cost_cents: 0,
    },
    steps: [...]
  }
}
```

**Security note:** Sensitive parameters (OAuth tokens, API keys) are sanitized before being included in the message body. Token references (`accessToken_ref: "[managed-by-ironclaw]"`) are sent instead. IronClaw manages credentials through its own credential injection system.

### Execution Response

IronClaw returns:

```typescript
{
  content: "Successfully archived email msg_123",
  thread_id: "thread_abc",
  attachments: [],
  metadata: {
    status: "completed",  // or "failed", "pending", "running"
    outputs: { messageId: "msg_123", action: "archived" },
    error: null,          // populated on failure
  }
}
```

### Rollback Request

Uses the same webhook with a rollback message type and the original thread ID:

```typescript
{
  channel: "skytwin",
  user_id: "skytwin-system",
  owner_id: "<ownerId>",
  content: "Rollback execution plan <planId>...",
  thread_id: "<originalThreadId>",
  metadata: {
    skytwin: true,
    message_type: "rollback",
    plan_id: "<planId>",
  }
}
```

## Adapter Interface

```typescript
interface IronClawAdapter {
  buildPlan(action: CandidateAction): Promise<ExecutionPlan>;
  execute(plan: ExecutionPlan): Promise<ExecutionResult>;
  rollback(planId: string): Promise<RollbackResult>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number }>;
}
```

### Why an Adapter

1. **IronClaw is a Rust binary, not a JS library.** All communication is over HTTP. The adapter normalizes this into a typed TypeScript interface.

2. **Testability.** Every test of the decision pipeline can use the mock adapter. No external service calls during unit or integration tests.

3. **Error normalization.** IronClaw may return errors in various formats. The adapter normalizes them into SkyTwin error types.

4. **Retry encapsulation.** The adapter handles transient failure retries and circuit breaker protection internally.

5. **Credential isolation.** Sensitive tokens are sanitized before being sent to IronClaw. IronClaw manages its own credential store.

## Failure Handling

### Retry Logic

The HTTP client retries transient failures with linear backoff:
- **Retryable:** 5xx server errors, 429 rate limits, network timeouts
- **Not retryable:** 4xx client errors (except 429)
- **Max retries:** 2 (configurable)
- **Backoff:** 1s, 2s, 3s (linear)

### Circuit Breaker

If IronClaw fails repeatedly (default: 5 failures in 5 minutes):
- Circuit breaker opens — new executions fail immediately
- Health checks continue at `/health`
- When health check succeeds, circuit closes and executions resume
- Half-open probes allowed after half the window elapses

### Error Classification

| Error Type | SkyTwin Response |
|-----------|-----------------|
| `completed` | Log success, generate explanation |
| `failed` (retryable) | Retry with backoff, then escalate |
| `failed` (permanent) | Notify user immediately |
| Network timeout | Treat as failure, notify user |
| Circuit breaker open | Queue or pause automated actions |

## Expected Capabilities

Based on the workflows SkyTwin needs to support, IronClaw should handle:

### Email Operations
- Send email, draft email, archive email, label/categorize, forward

### Calendar Operations
- Create/reschedule/cancel events, accept/decline invites, notify attendees

### Subscription & Purchase Management
- Renew/cancel/modify subscriptions, place/modify/cancel orders

### Travel Operations
- Book flights/hotels, select preferences, cancel within windows

### Generic Operations
- HTTP requests with authentication, webhook notifications, status checks

Not all are implemented in IronClaw today. The adapter handles unsupported operations gracefully.

## Migration Path

### Phase 1: Mock Only (Complete)
- Development and testing uses `MockIronClawAdapter`
- Decision pipeline is fully testable end-to-end

### Phase 2: IronClaw HTTP Integration (Current)
- `RealIronClawAdapter` communicates with IronClaw via HTTP webhook
- HMAC-SHA256 authentication, retries, circuit breaker
- Credential sanitization in flight
- Contract tests validate mock and real adapter produce compatible outputs
- Rollback E2E tests verify execute-then-rollback lifecycle
- `MockIronClawServer` provides a local test server with HMAC verification

### Phase 3: Production Deployment
- Connect to production IronClaw with real credentials
- Start with low-risk action types (archive email, reschedule meeting)
- Monitor execution results closely
- Gradually enable more action types as confidence builds

### Phase 4: Advanced Integration
- Leverage IronClaw's routines engine for scheduled actions
- Real-time status streaming via WebSocket/SSE
- Advanced rollback coordination through IronClaw's tool system
