# SkyTwin Technical Specification

## Architecture Overview

SkyTwin is a TypeScript monorepo managed by pnpm workspaces and built with Turborepo. The system follows a pipeline architecture: events flow in, get interpreted, pass through decision and policy engines, and either auto-execute via IronClaw or escalate to the user.

### Repository Structure

```
skytwin/
  apps/
    api/             # HTTP API server (Express)
    web/             # Web dashboard (vanilla SPA with hash-based routing)
    worker/          # Background job processor

  packages/
    shared-types/    # TypeScript interfaces and type definitions
    config/          # Environment variable loading and validation
    core/            # Shared utilities, error types, logging
    db/              # CockroachDB client, migrations, repositories
    twin-model/      # Twin profile management and preference learning
    decision-engine/ # Event interpretation and action selection
    policy-engine/   # Safety constraints, trust tiers, spend limits
    ironclaw-adapter/# IronClaw HTTP adapter (HMAC-SHA256 auth, retries, circuit breaker)
    execution-router/# Adapter selection, fallback chains, risk modifiers, skill gap detection
    explanations/    # Human-readable explanation generation
    connectors/      # External service integrations (email, calendar, etc.)
    evals/           # Evaluation harness for decision quality
    mempalace/       # Memory Palace: episodic memory, knowledge graph, 4-layer retrieval

  docs/              # Architecture and design documentation
  planning/          # Milestone and issue tracking documents
```

### Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | TypeScript 5.4+, strict mode | Type safety across the entire pipeline |
| Runtime | Node.js >= 20 | LTS, native ESM, good async performance |
| Package manager | pnpm 9 | Fast, disk-efficient, excellent workspace support |
| Monorepo tooling | Turborepo 2 | Dependency-aware build orchestration, caching |
| Database | CockroachDB 23.2 | Distributed SQL, serializable transactions, resilient |
| Module system | NodeNext (ESM) | Forward-compatible, native in Node 20+ |
| Testing | Vitest | Fast, TypeScript-native, compatible with Jest API |
| Containerization | Docker Compose | Local CockroachDB, optional API container |
| API framework | Express | Mature, widely supported, simple middleware model |
| Web dashboard | Vanilla SPA | Hash-based routing, no build step, plain JS + CSS |

## Data Flow

The primary data flow is a pipeline with feedback loops:

```
External Event (email, calendar, webhook, etc.)
    |
    v
[Connector] -- normalize to internal event format
    |
    v
[Signal Ingestion] -- persist raw event, deduplicate, enrich
    |
    v
[Situation Interpreter] -- classify event as DecisionObject
    |                       (email_triage, calendar_conflict, etc.)
    v
[Decision Engine]
    |-- query TwinProfile from @skytwin/twin-model
    |-- generate CandidateAction[] with RiskAssessments
    |-- select best action based on twin + confidence
    |
    v
[Policy Engine] -- evaluate against ActionPolicy[], DomainPolicy
    |-- check spend limits (per-action, daily)
    |-- check trust tier authorization
    |-- check reversibility requirements
    |-- check domain allow/block lists
    |
    v
  /              \
PASS              FAIL/REQUIRES_APPROVAL
  |                  |
  v                  v
[IronClaw Adapter]  [Approval Request]
  |-- convert to     |-- persist to CockroachDB
  |   ExecutionPlan   |-- notify user via preferred channel
  |-- execute         |-- await response
  |-- receive result  |-- on approval: re-enter pipeline at IronClaw
  |                   |-- on rejection: record feedback
  v                   v
[Explanation Layer]   [Explanation Layer]
  |-- generate ExplanationRecord
  |-- persist to CockroachDB
  |
  v
[Feedback Learning]
  |-- on user approval/rejection/edit/undo
  |-- update TwinProfile (create new TwinProfileVersion)
  |-- adjust confidence scores
  |-- record FeedbackEvent
```

### Event Lifecycle

1. **Ingestion:** Raw event arrives, gets normalized into internal format with standard metadata (timestamp, source, domain, raw payload).
2. **Interpretation:** Situation interpreter classifies the event, produces a `DecisionObject` with situation type, urgency, and domain.
3. **Contextualization:** Decision engine loads the user's `TwinProfile`, applicable policies, trust tier, and relevant history into a `DecisionContext`.
4. **Candidacy:** Engine generates `CandidateAction[]`, each with parameters, risk assessment, reversibility flag, cost estimate, and predicted user preference.
5. **Selection:** Engine selects the best candidate and determines whether auto-execution is allowed (producing a `DecisionOutcome`).
6. **Policy gate:** Policy engine evaluates the selected action. Pass, deny, or require approval.
7. **Execution or escalation:** Either hand off to IronClaw or create an approval request.
8. **Explanation:** Generate and persist an explanation record regardless of outcome.
9. **Feedback:** When the user responds (approval, rejection, edit, undo), update the twin model and record the feedback event.

## Key Interfaces and Type System

All types live in `@skytwin/shared-types`. The package is the dependency root of the monorepo -- every other package imports from it.

### Core Type Hierarchy

```
User
  ├── AutonomySettings
  │     ├── maxSpendPerActionCents
  │     ├── maxDailySpendCents
  │     ├── allowedDomains / blockedDomains
  │     └── requireApprovalForIrreversible
  └── TrustTier (enum: observer → suggest → low_autonomy → moderate_autonomy → high_autonomy)

TwinProfile
  ├── Preference[] (domain, key, value, confidence, evidence[])
  ├── Inference[] (statement, confidence, supporting/contradicting evidence)
  ├── riskTolerance (per-domain)
  ├── spendNorms (per-domain)
  ├── communicationStyle
  ├── routines
  └── domainHeuristics

DecisionObject
  ├── situationType
  ├── rawEvent
  ├── interpretedSituation
  ├── urgency
  └── domain

DecisionContext = DecisionObject + TwinProfile + ActionPolicy[] + TrustTier + history

CandidateAction
  ├── actionType
  ├── parameters
  ├── predictedUserPreference (ConfidenceLevel)
  ├── riskAssessment (RiskAssessment)
  │     ├── overallTier (RiskTier)
  │     └── dimensions (6 risk dimensions)
  ├── reversible
  └── estimatedCost

DecisionOutcome
  ├── selectedAction
  ├── autoExecute
  ├── requiresApproval
  ├── escalationReason
  ├── explanation
  └── confidence

ExecutionPlan → sent to IronClaw
ExecutionResult → received from IronClaw

ExplanationRecord → persisted for every decision
FeedbackEvent → user response, feeds back to twin
```

### Confidence and Risk Enums

**ConfidenceLevel** (for preference predictions):
- `known_preference` -- explicitly stated by user
- `likely_preference` -- strong evidence from behavior
- `weak_inference` -- some evidence, not yet reliable
- `insufficient_evidence` -- not enough data
- `explicitly_disallowed` -- user has said "never do this"
- `requires_approval` -- must ask regardless

**TrustTier** (for autonomy gating):
- `observer` -- no autonomy, all actions require approval
- `suggest` -- can suggest but not act
- `low_autonomy` -- can auto-execute low-risk in approved domains
- `moderate_autonomy` -- can auto-execute moderate-risk in approved domains
- `high_autonomy` -- can auto-execute most actions except high-risk

**RiskTier** (for action classification):
- `negligible` -- no meaningful downside
- `low` -- minor inconvenience if wrong
- `moderate` -- real but manageable consequences
- `high` -- significant consequences, hard to reverse
- `critical` -- must never auto-execute

## Package Dependency Graph

```
@skytwin/shared-types  (no internal dependencies -- the root)
    |
    v
@skytwin/config  (depends on: shared-types)
    |
    v
@skytwin/core  (depends on: shared-types, config)
    |
    v
@skytwin/db  (depends on: shared-types, config, core)
    |
    ├──────────────────────────────────────────────┐
    v                                              v
@skytwin/twin-model                    @skytwin/policy-engine
(depends on: shared-types, db, core)   (depends on: shared-types, db, core)
    |                                              |
    v                                              v
@skytwin/decision-engine  <────────────────────────┘
(depends on: shared-types, twin-model, policy-engine, core)
    |
    v
@skytwin/ironclaw-adapter
(depends on: shared-types, core)
    |
    v
@skytwin/execution-router
(depends on: shared-types, ironclaw-adapter, policy-engine, core)
    |
    v
@skytwin/explanations
(depends on: shared-types, core, db)
    |
    v
@skytwin/connectors
(depends on: shared-types, core)
    |
    v
@skytwin/evals
(depends on: shared-types, decision-engine, twin-model, policy-engine, db, core)

Apps:
  api    → depends on most packages
  worker → depends on decision-engine, ironclaw-adapter, db, connectors
  web    → depends on shared-types, api client
```

## API Endpoints

### Decision API

```
POST   /api/v1/events                    # Submit a new event for processing
GET    /api/v1/decisions/:id             # Get a decision and its outcome
GET    /api/v1/decisions?userId=&status= # List decisions with filters
POST   /api/v1/decisions/:id/approve     # Approve a pending decision
POST   /api/v1/decisions/:id/reject      # Reject a pending decision
POST   /api/v1/decisions/:id/edit        # Approve with modifications
POST   /api/v1/decisions/:id/undo        # Undo an executed decision
```

### User API

```
GET    /api/v1/users/:id                 # Get user profile
PUT    /api/v1/users/:id/settings        # Update autonomy settings
GET    /api/v1/users/:id/trust-tier      # Get current trust tier
```

### Twin API

```
GET    /api/v1/twin/:userId              # Get current twin profile
GET    /api/v1/twin/:userId/history      # Get twin version history
GET    /api/v1/twin/:userId/preferences  # Get preferences with evidence
PUT    /api/v1/twin/:userId/preferences  # Explicitly set a preference
DELETE /api/v1/twin/:userId/preferences/:id  # Delete a learned preference
```

### Policy API

```
GET    /api/v1/policies/:userId          # Get user's active policies
PUT    /api/v1/policies/:userId/domain/:domain  # Update domain policy
```

### Explanation API

```
GET    /api/v1/explanations/:decisionId  # Get explanation for a decision
GET    /api/v1/explanations?userId=      # List recent explanations
```

### Ask API (Twin Query)

```
POST   /api/v1/twin/:userId/ask          # Predict what the twin would do (read-only)
```

### Briefing API

```
GET    /api/v1/briefings/:userId         # Get latest morning briefing
PUT    /api/v1/briefings/:userId/preferences  # Update briefing schedule
```

### Proposal API (Preference Archaeology)

```
GET    /api/v1/preferences/:userId/proposals  # List pending proposals
POST   /api/v1/preferences/:userId/proposals/:id/respond  # Accept or reject
```

### Skill Gaps API

```
GET    /api/v1/skill-gaps                # List unhandled action types
```

### Settings API

```
GET    /api/v1/settings/:userId          # Get all user settings
PUT    /api/v1/settings/:userId/autonomy # Update autonomy settings
PUT    /api/v1/settings/:userId/domains/:domain  # Update domain-specific autonomy
POST   /api/v1/settings/:userId/escalation-triggers  # Configure escalation triggers
```

### Health and Operations

```
GET    /health                           # Health check (includes DB)
GET    /api/v1/stats/:userId             # Decision statistics
```

## Worker Architecture

The worker process handles asynchronous operations that shouldn't block the API:

### Job Types

1. **Event Processing (`process-event`):** Receives normalized events, runs them through the full decision pipeline. This is the primary job type.

2. **Execution (`execute-action`):** Takes an approved action and sends it to IronClaw. Handles retries and timeout management.

3. **Feedback Processing (`process-feedback`):** Takes feedback events (approval, rejection, edit, undo) and updates the twin model. Computes new confidence scores and creates twin profile versions.

4. **Explanation Generation (`generate-explanation`):** Generates and persists explanation records. Can run asynchronously since explanations don't block execution.

5. **Trust Tier Evaluation (`evaluate-trust`):** Periodically evaluates whether a user's trust tier should be promoted or demoted based on recent decision history.

6. **Eval Runs (`run-eval`):** Executes evaluation scenarios against the decision pipeline.

### Job Processing

The worker uses a simple polling loop against CockroachDB:

```
1. Query for pending jobs ordered by priority and creation time
2. Claim job (UPDATE with row-level lock)
3. Execute job handler
4. On success: mark complete, record result
5. On failure: increment attempt count, schedule retry or mark failed
```

CockroachDB's serializable transactions ensure that concurrent workers won't double-process jobs. This is simpler than introducing a message broker at MVP stage, and CockroachDB handles the contention well.

### Retry Strategy

- Event processing: 3 retries with exponential backoff (1s, 5s, 25s)
- Execution: 2 retries with linear backoff (5s, 10s). IronClaw failures may not be idempotent.
- Feedback processing: 5 retries (feedback must eventually be processed)
- Explanation generation: 3 retries (non-critical path)

## CockroachDB Usage Patterns

See [cockroach-architecture.md](./cockroach-architecture.md) for full database architecture. Key patterns:

### Serializable Transactions

CockroachDB defaults to serializable isolation. We use this for:
- Twin profile updates (read-modify-write with version check)
- Decision pipeline execution (event → decision → outcome as one transaction)
- Spend limit enforcement (read current daily spend, check against limit, record new spend)

### Versioned State

Twin profiles are versioned. Every mutation creates a `twin_profile_versions` row with the full profile snapshot, changed fields, and reason. This enables:
- Historical reconstruction ("what did the twin look like when this decision was made?")
- Audit ("why did this preference change?")
- Rollback ("revert to version N")

### Event Sourcing Lite

Raw events and decisions are append-only. We don't delete decision history. This supports:
- Replay for evals
- Audit trail
- Debugging production issues
- Training data for future model improvements

## Error Handling Strategy

### Result Types Over Exceptions

For expected failure modes, use typed result objects:

```typescript
type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };
```

Exceptions are reserved for truly unexpected failures (database connection lost, OOM, etc.).

### Error Categories

1. **Validation errors:** Bad input data. Return immediately with descriptive error. No retry.
2. **Policy violations:** Action blocked by policy. Not an error -- this is normal operation. Record the policy check result and escalate.
3. **Database errors:** Retry with backoff. CockroachDB transaction retries are expected under contention.
4. **IronClaw errors:** Classify as transient (retry) or permanent (escalate to user). Record failure in execution result.
5. **Twin model errors:** Missing or corrupted twin data. Fall back to default-safe behavior (escalate everything). Log alert.
6. **System errors:** Unexpected failures. Log, alert, do not auto-execute anything. Fail safe.

### CockroachDB Transaction Retries

CockroachDB may abort transactions under contention and return a `40001` error (serialization failure). The application must retry these:

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (isCockroachRetryError(error) && attempt < maxRetries) {
        continue; // CockroachDB says: retry this transaction
      }
      throw error;
    }
  }
  throw new Error('Unreachable');
}
```

## Testing Strategy

### Unit Tests

Every package has unit tests in `__tests__/` directories or `*.test.ts` files adjacent to source. Unit tests mock all external dependencies (database, IronClaw, connectors).

Key areas:
- Decision engine: candidate generation, risk assessment, action selection
- Policy engine: rule evaluation, spend limit checks, trust tier gating
- Twin model: preference updates, confidence scoring, evidence handling
- Explanation generation: output format, evidence citation, correction guidance

### Integration Tests

Test the pipeline end-to-end with a real (local) CockroachDB instance:

- Event → decision → policy check → execution/escalation → explanation
- Feedback → twin model update → changed behavior on replay
- Concurrent worker processing (no double-execution)
- Transaction retry behavior under contention

Integration tests run against the Docker CockroachDB instance from `docker-compose.yml`.

### Eval Tests

Scenario-based tests that evaluate decision quality. See [evals.md](./evals.md). These are not pass/fail unit tests -- they produce metrics that are tracked over time:

- Interruption rate across scenario sets
- False autonomy rate
- Escalation correctness
- Confidence calibration
- Explanation quality scores

### Test Commands

```bash
# Run all tests
pnpm test

# Run tests for a single package
pnpm --filter @skytwin/decision-engine test

# Run tests in watch mode
pnpm --filter @skytwin/twin-model test -- --watch

# Run integration tests (requires running CockroachDB)
pnpm test:integration

# Run eval suite
pnpm --filter @skytwin/evals run evals
```

## Local Development Setup

### Prerequisites

- Node.js >= 20 (recommend using `nvm` or `fnm`)
- pnpm >= 9 (`corepack enable && corepack prepare pnpm@9.1.0 --activate`)
- Docker and Docker Compose (for CockroachDB)

### Getting Started

```bash
# 1. Install dependencies
pnpm install

# 2. Start CockroachDB
docker-compose up -d cockroachdb

# 3. Wait for CockroachDB to be healthy
docker-compose exec cockroachdb cockroach sql --insecure -e "SELECT 1"

# 4. Configure environment
cp .env.example .env

# 5. Run database migrations
pnpm db:migrate

# 6. Seed development data
pnpm db:seed

# 7. Build all packages (respects dependency order via Turbo)
pnpm build

# 8. Start development mode (watch + hot reload)
pnpm dev
```

### CockroachDB Admin UI

CockroachDB's built-in admin UI is available at `http://localhost:8080` when running locally. Useful for:
- Monitoring query performance
- Viewing table schemas
- Checking cluster health
- Debugging slow queries

### Working on a Single Package

```bash
# Build just the decision engine and its dependencies
pnpm --filter @skytwin/decision-engine build

# Run decision engine tests in watch mode
pnpm --filter @skytwin/decision-engine test -- --watch

# Lint a specific package
pnpm --filter @skytwin/policy-engine lint
```

### Environment Variables

See `.env.example` for all available configuration:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://root@localhost:26257/skytwin?sslmode=disable` | CockroachDB connection string |
| `IRONCLAW_API_URL` | `http://localhost:8080` | IronClaw API endpoint |
| `API_PORT` | `3000` | API server port |
| `NODE_ENV` | `development` | Environment (development, test, production) |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |

## Deployment Considerations

### CockroachDB

For production, CockroachDB should run as a multi-node cluster (3+ nodes minimum for replication). Options:
- **CockroachDB Cloud:** Managed service, simplest path
- **Self-hosted:** On Kubernetes (using the CockroachDB operator) or bare VMs
- **CockroachDB Serverless:** For early-stage cost optimization

Connection pooling: Use `pg-pool` with a max connection count appropriate for the cluster size. CockroachDB handles connection balancing across nodes.

### Application

The API server and worker are stateless Node.js processes. Standard deployment patterns apply:
- Container-based deployment (Docker, Kubernetes)
- Horizontal scaling for API servers (behind a load balancer)
- Worker scaling: start with 1-2 workers, scale based on job queue depth
- Health check endpoint at `/health` includes database connectivity

### Secrets Management

- Database credentials via environment variables or secrets manager
- IronClaw API keys via environment variables
- No secrets in code or config files
- `.env` files are gitignored

### Observability

Planned but not yet implemented:
- Structured logging (JSON format in production)
- Metrics: decision latency, throughput, error rate, queue depth
- Distributed tracing across the decision pipeline
- Alerts: policy violation attempts, database health, worker failures, twin model staleness

### Migration Path

1. **Local development:** Single-node CockroachDB via Docker Compose
2. **Staging:** CockroachDB Cloud (free tier or dev cluster)
3. **Production:** CockroachDB Cloud (dedicated) or self-hosted cluster
4. **Scale considerations:** CockroachDB handles horizontal scaling natively; the application layer scales by adding API servers and workers
