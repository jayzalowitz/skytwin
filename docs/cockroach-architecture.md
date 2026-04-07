# SkyTwin CockroachDB Architecture

## Why CockroachDB

SkyTwin needs a database that is:
- **Durable:** Twin profiles, decision history, and audit records must survive crashes, restarts, and infrastructure changes. This is operational memory, not a cache.
- **Transactional:** Decision pipelines involve read-modify-write sequences (check spend limit → approve → record spend). These must be atomic.
- **SQL-compatible:** The data is relational. Users have preferences. Preferences have evidence. Decisions have outcomes. This is table-and-join territory, not document-store territory.
- **Distributed (eventually):** A single Postgres instance works for development but is a single point of failure in production. SkyTwin's value proposition depends on reliability.
- **Inspectable:** Users should be able to query what the system knows about them. SQL is the lingua franca of data inspection.

CockroachDB meets all of these. It speaks PostgreSQL wire protocol (so the `pg` client library works), supports serializable transactions, replicates automatically across nodes, and scales horizontally without application changes.

### Why Not Just Postgres?

Postgres would work. For a single-node development setup, CockroachDB and Postgres are nearly identical from the application's perspective. The reasons to choose CockroachDB from day one:

1. **No migration tax later.** Starting with CockroachDB means the application is tested against CockroachDB's SQL dialect and transaction behavior from the start. Migrating from Postgres to CockroachDB later introduces compatibility risk.

2. **Serializable by default.** CockroachDB's default isolation level is serializable. Postgres defaults to read committed. SkyTwin relies on serializable transactions for spend limit enforcement and twin profile versioning. Starting with serializable-by-default avoids a class of bugs.

3. **Built-in resilience.** In production, CockroachDB replicates across nodes automatically. Postgres requires additional tooling (Patroni, pgpool, etc.) for high availability.

4. **Horizontal scaling.** CockroachDB scales by adding nodes. Postgres scales vertically (bigger machine) or requires manual sharding.

The tradeoff: CockroachDB has some SQL incompatibilities with Postgres (no advisory locks, no LISTEN/NOTIFY, some index behavior differences). For SkyTwin's workload, these are not blockers.

## Schema Design Overview

### Entity Relationship Summary

```
users
  |-- 1:1 --→ twin_profiles (current twin state)
  |-- 1:N --→ twin_profile_versions (historical snapshots)
  |-- 1:N --→ preferences
  |-- 1:N --→ connected_accounts
  |-- 1:N --→ decisions
  |-- 1:N --→ action_policies
  |-- 1:N --→ feedback_events

decisions
  |-- 1:N --→ candidate_actions
  |-- 1:1 --→ decision_outcomes
  |-- 1:N --→ execution_plans
  |-- 1:1 --→ explanation_records
  |-- 0:1 --→ approval_requests

execution_plans
  |-- 1:1 --→ execution_results

users (Memory Palace)
  |-- 1:N --→ memory_wings
  |-- 1:N --→ memory_tunnels
  |-- 1:N --→ knowledge_entities
  |-- 1:N --→ knowledge_triples
  |-- 1:N --→ episodic_memories
  |-- 1:N --→ entity_codes

memory_wings
  |-- 1:N --→ memory_rooms
  |-- 1:N --→ memory_drawers
  |-- 1:N --→ memory_closets

memory_rooms
  |-- 1:N --→ memory_drawers
  |-- 1:N --→ memory_closets
```

### Table Descriptions

| Table | Purpose | Write Pattern | Read Pattern |
|-------|---------|---------------|-------------|
| `users` | User identity and autonomy settings | Low frequency (settings changes) | Per-decision (load user context) |
| `connected_accounts` | OAuth tokens, service connections | Low frequency | On signal ingestion |
| `twin_profiles` | Current twin state | On every feedback event | Per-decision |
| `twin_profile_versions` | Historical twin snapshots | On every twin mutation | Audit, replay, debugging |
| `preferences` | Individual preferences with evidence | On feedback and learning | Per-decision (domain-filtered) |
| `decisions` | Decision objects (interpreted events) | Per-event | History queries, replay |
| `candidate_actions` | Generated candidate actions per decision | Per-event (batch insert) | Explanation generation, audit |
| `decision_outcomes` | Selected action and execution determination | Per-event | Audit, replay, evals |
| `action_policies` | User-configured policy rules | Low frequency | Per-decision (policy evaluation) |
| `approval_requests` | Pending and completed approval requests | On escalation | User review queue |
| `execution_plans` | Plans sent to IronClaw | On auto-execute | Status tracking |
| `execution_results` | Results from IronClaw | On execution completion | Audit, failure analysis |
| `explanation_records` | Human-readable explanations | Per-decision | User review, audit |
| `feedback_events` | User responses (approve/reject/edit/undo) | On user interaction | Twin model updates, evals |
| `memory_wings` | Top-level memory palace groupings by domain | On new domain encountered | Palace status, memory retrieval |
| `memory_rooms` | Topics within a wing | On new topic encountered | Memory filing, tunnel detection |
| `memory_drawers` | Individual memory chunks (atomic unit) | Per-signal, per-decision | Search, L2/L3 retrieval |
| `memory_closets` | Compressed summaries (AAAK dialect) | Periodic compression | L1/L2 context loading |
| `memory_tunnels` | Cross-wing connections via shared topics | On tunnel detection | Cross-domain memory recall |
| `knowledge_entities` | People, places, projects, concepts | On entity extraction | Knowledge graph queries |
| `knowledge_triples` | Temporal fact triples (subject-predicate-object) | On fact extraction | Point-in-time queries, timelines |
| `episodic_memories` | Full decision episodes (situation→action→outcome) | Per-decision | Similar episode retrieval for decisions |
| `entity_codes` | 3-letter AAAK compression codes | On compression | AAAK encoding/decoding |

### Primary Keys

All primary keys use UUIDs (`gen_random_uuid()`). CockroachDB handles UUID distribution well across nodes, and UUIDs avoid the hot-spot problems that sequential IDs create in distributed systems.

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email STRING NOT NULL UNIQUE,
  name STRING NOT NULL,
  trust_tier STRING NOT NULL DEFAULT 'observer',
  autonomy_settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### JSONB for Flexible Structures

Some fields use JSONB for structured data that varies per domain:
- `autonomy_settings` -- key-value structure that may grow
- `raw_event` in decisions -- varies by event source
- `parameters` in candidate actions -- varies by action type
- `result_data` in execution results -- varies by action type
- `communication_style`, `routines`, `domain_heuristics` in twin profiles

JSONB gives flexibility without schema migrations for every new field, while remaining queryable via CockroachDB's JSON operators.

### Timestamps

All tables include `created_at TIMESTAMPTZ`. Mutable tables also include `updated_at TIMESTAMPTZ`. Timestamps use `TIMESTAMPTZ` (timezone-aware) to avoid timezone ambiguity.

## Role as Durable Operational Memory

CockroachDB is not just "the database." It is the **durable operational memory backbone** of SkyTwin. This framing matters because:

1. **Twin profiles are memory.** The system's ability to predict user preferences depends entirely on the quality and completeness of stored twin data. If the database loses data, the system loses its understanding of the user.

2. **Decision history is memory.** Past decisions inform future ones. The system uses history for pattern detection, confidence calibration, and feedback analysis.

3. **Feedback events are memory.** Every user correction teaches the system something. Losing feedback events means losing learning.

4. **Explanation records are institutional memory.** They document why the system made every decision. Without them, the system can't be audited, debugged, or trusted.

This is why CockroachDB's durability guarantees matter. Data is replicated across nodes (in production). Transactions are serializable. Write-ahead logging ensures crash consistency. The system treats data loss as a catastrophic failure, not a recoverable inconvenience.

## Data Patterns

### Current Twin Profile Lookup

The most frequent read query. Executed on every decision.

```sql
SELECT *
FROM twin_profiles
WHERE user_id = $1;
```

Index: Primary key on `twin_profiles` includes `user_id` (or there's a unique index on `user_id`).

With preferences:
```sql
SELECT p.*
FROM preferences p
WHERE p.user_id = $1
  AND p.domain = $2
ORDER BY p.updated_at DESC;
```

Index: `(user_id, domain, updated_at DESC)` for efficient domain-filtered preference lookups.

### Historical Twin Profile Reconstruction

Used for audit, replay, and debugging. "What did the twin look like when decision X was made?"

```sql
SELECT *
FROM twin_profile_versions
WHERE profile_id = $1
  AND created_at <= $2
ORDER BY version DESC
LIMIT 1;
```

Index: `(profile_id, created_at DESC)` for efficient point-in-time lookups.

This query finds the most recent twin version at or before a given timestamp. For decision replay, `$2` is the timestamp of the decision being replayed.

### Decision and Event Replay

Used by the eval harness and for debugging production issues.

```sql
-- All decisions for a user in a time range
SELECT d.*, do.*, er.*
FROM decisions d
JOIN decision_outcomes do ON do.decision_id = d.id
LEFT JOIN explanation_records er ON er.decision_id = d.id
WHERE d.user_id = $1
  AND d.created_at BETWEEN $2 AND $3
ORDER BY d.created_at ASC;
```

Index: `(user_id, created_at)` on `decisions`.

With full candidate analysis:
```sql
SELECT ca.*
FROM candidate_actions ca
WHERE ca.decision_id = $1
ORDER BY ca.id;
```

### Audit Record Retrieval

Comprehensive audit trail for a specific decision.

```sql
-- Full decision audit
SELECT
  d.*,
  do.*,
  er.*,
  ar.*,
  ep.*,
  exr.*
FROM decisions d
LEFT JOIN decision_outcomes do ON do.decision_id = d.id
LEFT JOIN explanation_records er ON er.decision_id = d.id
LEFT JOIN approval_requests ar ON ar.decision_id = d.id
LEFT JOIN execution_plans ep ON ep.decision_id = d.id
LEFT JOIN execution_results exr ON exr.plan_id = ep.id
WHERE d.id = $1;
```

This is an infrequent query (audit/debugging) so performance is less critical than correctness.

### Approval History

Used for the user's review queue and for trust tier evaluation.

```sql
-- Pending approvals for a user
SELECT *
FROM approval_requests
WHERE user_id = $1
  AND status = 'pending'
ORDER BY requested_at ASC;

-- Approval history (for trust tier evaluation)
SELECT status, count(*) as count
FROM approval_requests
WHERE user_id = $1
  AND requested_at > now() - INTERVAL '30 days'
GROUP BY status;
```

Index: `(user_id, status, requested_at)` on `approval_requests`.

### Feedback-Based Twin Updates

When feedback arrives, the system needs to update the twin and record the change.

```sql
-- Within a serializable transaction:

-- 1. Read current twin profile
SELECT * FROM twin_profiles WHERE user_id = $1 FOR UPDATE;

-- 2. Read relevant preference
SELECT * FROM preferences WHERE user_id = $1 AND domain = $2 AND key = $3;

-- 3. Update preference (or insert)
UPSERT INTO preferences (user_id, domain, key, value, confidence, evidence, version, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, now());

-- 4. Update twin profile version
INSERT INTO twin_profile_versions (profile_id, version, snapshot, changed_fields, reason, created_at)
VALUES ($1, $2, $3, $4, $5, now());

-- 5. Update twin profile current version
UPDATE twin_profiles SET version = $2, updated_at = now() WHERE user_id = $1;

-- 6. Record feedback event
INSERT INTO feedback_events (user_id, decision_id, type, data, created_at)
VALUES ($1, $2, $3, $4, now());
```

This entire sequence runs in a single serializable transaction.

### Per-User Policy Retrieval

```sql
SELECT *
FROM action_policies
WHERE user_id = $1
  AND is_active = true
ORDER BY priority DESC;
```

Index: `(user_id, is_active)` on `action_policies`.

### Spend Limit Tracking

Critical for safety. Must be atomic.

```sql
-- Within a serializable transaction:

-- 1. Check current daily spend
SELECT COALESCE(SUM(
  CASE WHEN ca.estimated_cost IS NOT NULL
       THEN ca.estimated_cost
       ELSE 0
  END
), 0) as daily_spend
FROM decisions d
JOIN decision_outcomes do ON do.decision_id = d.id
JOIN candidate_actions ca ON ca.id = do.selected_action_id
WHERE d.user_id = $1
  AND d.timestamp > now() - INTERVAL '24 hours'
  AND do.auto_executed = true;

-- 2. If daily_spend + proposed_cost <= daily_limit, proceed
-- 3. Record the new execution
```

Serializable isolation ensures concurrent decisions can't both pass the limit check and collectively exceed it.

### Workflow Execution Logs

```sql
-- Execution history for a user
SELECT ep.*, exr.*
FROM execution_plans ep
JOIN execution_results exr ON exr.plan_id = ep.id
JOIN decisions d ON d.id = ep.decision_id
WHERE d.user_id = $1
ORDER BY ep.created_at DESC
LIMIT 50;
```

## Transaction Patterns

### Read-Modify-Write with Version Check

Used for twin profile updates to prevent lost updates:

```sql
BEGIN;
  SELECT version FROM twin_profiles WHERE user_id = $1 FOR UPDATE;
  -- Application checks version matches expected
  UPDATE twin_profiles SET ..., version = version + 1 WHERE user_id = $1;
  INSERT INTO twin_profile_versions ...;
COMMIT;
```

CockroachDB's serializable isolation prevents the classic lost-update problem even without the explicit `FOR UPDATE`, but the version check provides an additional application-level safeguard.

### Batch Insert with Individual Risk Assessment

When generating candidate actions, all candidates for a decision are inserted together:

```sql
INSERT INTO candidate_actions (id, decision_id, action_type, description, parameters,
  predicted_user_preference, risk_assessment, reversible, estimated_cost)
VALUES
  ($1, $2, $3, $4, $5, $6, $7, $8, $9),
  ($10, $11, $12, $13, $14, $15, $16, $17, $18),
  ...;
```

Batch inserts are significantly faster than individual inserts in CockroachDB.

### Conditional Execution

The decision pipeline's final step is conditional: execute only if all safety checks pass.

```sql
BEGIN;
  -- 1. Record decision outcome
  INSERT INTO decision_outcomes ...;

  -- 2. Check spend limits (query above)
  -- 3. If over limit, ROLLBACK and escalate

  -- 4. Record execution plan
  INSERT INTO execution_plans ...;

  -- 5. Record explanation
  INSERT INTO explanation_records ...;
COMMIT;
```

If any step fails or a safety check doesn't pass, the entire transaction rolls back. No partial state.

## Event Storage Design

Events (decisions) are append-only. We do not update or delete decision records. This supports:

- **Replay:** Re-run any historical event through the current pipeline
- **Audit:** Complete, unmodified record of what happened
- **Debugging:** "What did the system see at time T?"
- **Training:** Historical decisions are training data for twin model improvements

### Retention Strategy

Events are retained based on type:

| Data Type | Retention | Rationale |
|-----------|----------|-----------|
| Decisions | Indefinite | Core audit and replay data |
| Candidate actions | Indefinite | Needed for explanation and analysis |
| Decision outcomes | Indefinite | Core audit data |
| Execution plans/results | Indefinite | Needed for rollback and audit |
| Explanation records | Indefinite | User-facing audit trail |
| Feedback events | Indefinite | Twin model provenance |
| Twin profile versions | Indefinite | Historical reconstruction |
| Raw event payloads | 90 days, then summarize | Can be large; summaries retain essential data |

### Partitioning Consideration

For high-volume deployments, the `decisions` table may benefit from range partitioning by `timestamp`:

```sql
CREATE TABLE decisions (
  ...
) PARTITION BY RANGE (created_at);
```

This is a future optimization, not required at MVP scale.

## Twin Version Storage Design

Every twin profile mutation creates a version record. This enables:

1. **Time-travel:** Reconstruct the twin at any point in history
2. **Audit:** See exactly what changed and why
3. **Rollback:** Revert to a previous version if needed
4. **Debugging:** "Why did the system think X at time T?"

### Version Table Structure

```sql
CREATE TABLE twin_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES twin_profiles(id),
  version INT NOT NULL,
  snapshot JSONB NOT NULL,          -- Full twin profile at this version
  changed_fields STRING[] NOT NULL, -- Which fields changed
  reason STRING,                     -- Why the change happened (optional)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  INDEX (profile_id, version DESC)
);
```

### Snapshot Strategy

Each version stores a **full snapshot** of the twin profile, not a delta. This makes reconstruction simple (just load the snapshot) at the cost of storage. For twin profiles in the KB range, this is acceptable.

If twin profiles grow significantly (many preferences, extensive evidence), a delta-based approach could be introduced. The current design supports this migration without changing the query interface -- the repository layer would reconstruct from deltas transparently.

### Reasons for Changes

Every version records why it was created:

- `"feedback: user approved decision dec_abc123"`
- `"feedback: user rejected auto-archive of email from boss@company.com"`
- `"feedback: user explicitly set preference 'always book aisle seats'"`
- `"learning: confidence increased for 'archive newsletters' based on 10 consistent actions"`
- `"admin: user manually reset travel preferences"`
- `"system: trust tier promoted from suggest to low_autonomy"`

## Indexing Strategy

### Primary Access Patterns and Their Indexes

```sql
-- User lookup (authentication, context loading)
-- Covered by PRIMARY KEY on users(id) and UNIQUE on users(email)

-- Twin profile by user
CREATE INDEX idx_twin_profiles_user ON twin_profiles (user_id);

-- Preferences by user and domain
CREATE INDEX idx_preferences_user_domain ON preferences (user_id, domain, updated_at DESC);

-- Twin versions for historical reconstruction
CREATE INDEX idx_twin_versions_profile_time ON twin_profile_versions (profile_id, created_at DESC);

-- Decisions by user and time (most common query pattern)
CREATE INDEX idx_decisions_user_time ON decisions (user_id, created_at DESC);

-- Decisions by situation type (for evals and analytics)
CREATE INDEX idx_decisions_situation ON decisions (situation_type, created_at DESC);

-- Approval requests by user and status
CREATE INDEX idx_approvals_user_status ON approval_requests (user_id, status, requested_at ASC);

-- Feedback events by user and time
CREATE INDEX idx_feedback_user_time ON feedback_events (user_id, created_at DESC);

-- Active policies by user
CREATE INDEX idx_policies_user_active ON action_policies (user_id) WHERE is_active = true;

-- Execution results by plan (for status checks)
-- Covered by execution_results(execution_plan_id) if it's a UNIQUE or FK index

-- Spend tracking: decisions with auto-executed outcomes in the last 24 hours
CREATE INDEX idx_decisions_user_recent ON decisions (user_id, timestamp DESC)
  WHERE timestamp > now() - INTERVAL '24 hours';
```

### Partial Indexes

CockroachDB supports partial indexes (indexes with WHERE clauses). These are used for:
- Active policies only (`WHERE is_active = true`)
- Pending approvals only (`WHERE status = 'pending'`)
- Recent decisions for spend tracking

Partial indexes reduce index size and improve write performance for large tables.

### Index Maintenance

Indexes should be reviewed quarterly against actual query patterns. CockroachDB's built-in SQL statistics (`SHOW STATISTICS`) can identify unused indexes and missing index opportunities.

## Local Development with Single-Node CockroachDB

### Docker Compose Setup

The `docker-compose.yml` runs a single-node CockroachDB instance:

```yaml
cockroachdb:
  image: cockroachdb/cockroach:latest-v23.2
  command: start-single-node --insecure
  ports:
    - "26257:26257"  # SQL port
    - "8080:8080"    # Admin UI
```

### Starting CockroachDB

```bash
# Start CockroachDB
docker-compose up -d cockroachdb

# Verify it's running
docker-compose exec cockroachdb cockroach sql --insecure -e "SELECT 1"

# Access the SQL shell
docker-compose exec cockroachdb cockroach sql --insecure -d skytwin

# Access the Admin UI
open http://localhost:8080
```

### Creating the Database

```bash
# Create the skytwin database (if not auto-created)
docker-compose exec cockroachdb cockroach sql --insecure -e "CREATE DATABASE IF NOT EXISTS skytwin"
```

### Running Migrations

```bash
# Apply all migrations
pnpm db:migrate

# Seed with development data
pnpm db:seed
```

### Resetting the Database

```bash
# Drop and recreate (development only!)
docker-compose exec cockroachdb cockroach sql --insecure -e "DROP DATABASE IF EXISTS skytwin CASCADE"
docker-compose exec cockroachdb cockroach sql --insecure -e "CREATE DATABASE skytwin"
pnpm db:migrate
pnpm db:seed
```

### Connecting from Application Code

The `@skytwin/db` package handles connection management:

```typescript
import { getPool, query, withTransaction } from '@skytwin/db';

// Simple query
const result = await query('SELECT * FROM users WHERE id = $1', [userId]);

// Transaction
const user = await withTransaction(async (client) => {
  const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
  await client.query('UPDATE users SET trust_tier = $1 WHERE id = $2', [newTier, userId]);
  return rows[0];
});
```

Connection configuration comes from environment variables. See `.env.example`.

## Migration Strategy

### Migration Files

Migrations are sequential SQL files in `packages/db/migrations/`:

```
packages/db/migrations/
  001_create_users.sql
  002_create_twin_profiles.sql
  003_create_decisions.sql
  004_create_policies.sql
  005_create_execution.sql
  006_create_feedback.sql
  ...
```

### Migration Rules

1. **Forward-only.** Migrations are applied in order and are never modified after application. To change a table, create a new migration.
2. **Idempotent where possible.** Use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc.
3. **No data loss.** Column drops or table drops must be preceded by a migration that preserves the data (copy to new table, rename, etc.).
4. **Tested.** Migrations are tested by running them against a fresh CockroachDB instance in CI.

### Migration Runner

The migration runner tracks applied migrations in a `schema_migrations` table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The runner applies each unapplied migration in order within a transaction.

### CockroachDB-Specific Considerations

- **No ALTER TYPE for enums.** CockroachDB doesn't support adding values to existing enums the same way Postgres does. Use STRING columns with application-level validation instead of database enums.
- **No advisory locks.** CockroachDB doesn't support `pg_advisory_lock`. The migration runner uses a `SELECT FOR UPDATE` on the `schema_migrations` table to prevent concurrent migration runs.
- **Index creation is online.** CockroachDB creates indexes without locking the table, so index migrations don't cause downtime.

## Why NOT Vector Storage as Primary

SkyTwin's twin model is structured, relational data. Preferences have typed keys, confidence levels, evidence chains, and version history. This is not a good fit for vector storage as the primary memory system.

Vector storage excels at:
- Semantic similarity search ("find memories similar to X")
- Unstructured text retrieval
- Embedding-based nearest neighbor queries

SkyTwin needs:
- Exact preference lookup by domain and key
- Structured evidence chains with provenance
- Version history with diffs
- Aggregate queries (spend tracking, approval rates)
- Transactional updates (read-modify-write with consistency guarantees)
- Relational joins (decision → outcome → explanation → feedback)

These are relational database workloads. Trying to force them into a vector store would be slower, less reliable, harder to query, and impossible to transact against.

### Embeddings as Supplement

That said, embeddings and vector search could supplement the structured twin model in the future:

- **Semantic preference matching:** "Does the user have a preference that's *similar to* this new situation?" Vector search over preference descriptions could find approximate matches when exact key lookup fails.
- **Event similarity:** "Has the user seen an event *like* this before?" Embedding recent events and finding similar historical events could improve situation interpretation.
- **Communication style:** Embedding the user's past communications to generate stylistically consistent draft replies.

If vector search is added, it would be implemented as:
- A separate index (possibly pgvector in CockroachDB, or an external vector store)
- Queried *in addition to* the structured twin lookup, not instead of it
- Results used to inform confidence, not to replace explicit preference data

The principle: **structured data for structured decisions; embeddings for fuzzy matching when structured lookup finds nothing.**

## Future Considerations

### Richer Memory Model

The current schema supports preferences, inferences, and evidence. Future extensions might include:
- **Episodic memory:** "The user went to Denver last March and had a bad experience at the airport hotel." Narrative memories tied to specific events.
- **Goal modeling:** "The user is trying to reduce their subscription spending." Higher-level objectives inferred from patterns.
- **Temporal patterns:** "The user is more conservative about spending at the end of the month." Time-based behavioral patterns.

The schema design accommodates these by using JSONB for extensible fields (`domain_heuristics`, `routines`) and by keeping the version history system generic enough to capture any twin state change.

### Multi-User / Household Support

The current schema is per-user. Future extensions might need:
- Shared preferences (household grocery preferences)
- Delegation chains (user A delegates travel to assistant B)
- Conflict resolution (two users disagree on a shared subscription)

The schema would need shared preference tables and delegation/permission tables. The per-user indexing strategy would need to be extended.

### Analytics and Reporting

For operational monitoring and product analytics:
- Materialized views for common aggregate queries (daily decision counts, approval rates)
- Time-series data for trend analysis (confidence calibration over time)
- CockroachDB's built-in CHANGEFEED for streaming decision events to analytics systems

### Data Export and Portability

Users should be able to export their data:
- Full twin profile export (JSON)
- Decision history export (CSV or JSON)
- Preference export with evidence
- Complete account data deletion (GDPR/CCPA compliance)

The relational schema makes export straightforward -- it's a set of queries across the known tables, serialized to the export format.
