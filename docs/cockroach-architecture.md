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
  |-- 0:1 --→ reasoning_mode_settings
  |-- 1:N --→ twin_profile_versions (historical snapshots)
  |-- 1:N --→ preferences
  |-- 1:N --→ connected_accounts
  |-- 1:N --→ oauth_connection_authority
  |-- 1:N --→ decisions
  |-- 1:N --→ action_policies
  |-- 1:N --→ feedback_events
  |-- 1:N --→ execution_admission_barriers
  |-- 1:N --→ credential_dispatch_leases
  |-- 1:N --→ workflows

workflows
  |-- 1:N --→ workflow_versions (immutable lineage)
  |-- 1:N --→ workflow_proposals (review + idempotency)
  |-- 1:N --→ workflow_activation_events (append-only pointer history)
  |-- 0:1 --→ watches (active compiled projection)

workflow_versions
  |-- 0:N --→ watch_runs (exact version, payload, compiler, and evidence pins)

decisions
  |-- 1:N --→ candidate_actions
  |-- 1:1 --→ decision_outcomes
  |-- 1:N --→ execution_plans
  |-- 1:1 --→ explanation_records
  |-- 0:N --→ inference_receipts
  |-- 0:1 --→ inference_receipt_completions
  |-- 0:1 --→ decision_ingest_guards
  |-- 0:N --→ execution_admission_barriers
  |-- 0:1 --→ approval_requests

system authority
  |-- 1:1 --→ execution_policy_authority
  |-- 0:N --→ oauth_account_connection_authority (short-lived account tombstones)
  |-- 0:N --→ oauth_new_user_authorizations (short-lived pre-identity grants)

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
| `reasoning_mode_settings` | Per-user reasoning-mode selection | On settings change | Before constructing a decision-event LLM client |
| `oauth_tokens` | Provider credentials and their verified account binding | On connect / token refresh | Per-poll connectors and credential dispatch |
| `oauth_connection_authority` | Per-user, per-provider generation that fences known-owner OAuth redirects | On reconnect or invalidation | OAuth callback admission |
| `oauth_account_connection_authority` | Short-lived account-key generation/tombstone for redirects whose owner is not known yet | On account resolution or invalidation | OAuth callback admission; TTL expiry |
| `oauth_new_user_authorizations` | Short-lived one-shot authority for a new-user OAuth flow before identity binding | On authorization issue and claim | OAuth callback claim; TTL expiry |
| `connected_accounts` | Opaque, owner-bound provider identity and lifecycle anchor; credentials reference it from `oauth_tokens` | On OAuth identity verification, reconnect, and disconnect | Connector/account resolution and message-evidence ownership checks |
| `twin_profiles` | Current twin state | On every feedback event | Per-decision |
| `twin_profile_versions` | Historical twin snapshots | On every twin mutation | Audit, replay, debugging |
| `preferences` | Individual preferences with evidence | On feedback and learning | Per-decision (domain-filtered) |
| `decisions` | Decision objects (interpreted events) | Per-event | History queries, replay |
| `candidate_actions` | Generated candidate actions per decision | Per-event (batch insert) | Explanation generation, audit |
| `decision_outcomes` | Selected action and execution determination | Per-event | Audit, replay, evals |
| `decision_receipts` | Owner-bound root for a joined, append-only decision evidence chain | Once per decision receipt | Audit, backup, and receipt reconstruction |
| `decision_receipt_revisions` | Digest-chained snapshots joining proposal, approval, effect, terminal, and feedback stages | Append on a validated lifecycle transition | Truthful current-state receipt and correction history |
| `action_policies` | User-configured policy rules | Low frequency | Per-decision (policy evaluation) |
| `approval_requests` | Pending and completed approval requests | On escalation | User review queue |
| `assistant_threads` | Per-user conversational thread metadata | First turn, message activity, deletion | Owner-scoped thread listing and lookup |
| `assistant_messages` | Chat turns; new writes carry owner-scoped request identity and processing metadata, with owner equality enforced against the parent thread | Once per logical turn | Thread history and completed retry replay |
| `execution_plans` | Admitted execution plans for a specific adapter path | On admitted execution preparation | Status tracking and reconciliation |
| `watches` | No-code routines (#519) — read-only signal watchers (digest/notify on a schedule) | On create / edit / pause | Per-user listing, scheduler `listDue` |
| `workflows` | Stable owner-scoped workflow identity and atomic active-version pointer | First proposal; every activation/rollback updates its pointer by serializable compare-and-swap | Authoring, version history, Watch projection |
| `workflow_versions` | Immutable provider payload, lineage, canonical hash, and sanitized inference metadata | Every accepted initial/edit/feedback/import proposal | Review, replay, compilation, rollback, exact run pins |
| `workflow_proposals` | Review boundary joining a base and proposed version, including durable request idempotency | Every proposed initial version or correction | Lost-response replay, explicit activation, audit |
| `workflow_activation_events` | Append-only activation/rollback transition with monotonic per-workflow sequence | Every explicit activation or rollback | Audit, concurrent pointer fencing, restore |
| `watch_runs` | Durable scheduled slots created before an exact-window signal read, with database-clock leases, retries, exact workflow/version/compiler/evidence pins, and any resulting summary | Every due slot, including zero-match audit slots | Worker claims; positive history projection; bounded zero-match audit retention |
| `execution_results` | Results from IronClaw | On execution completion | Audit, failure analysis |
| `explanation_records` | Human-readable explanations | Per-decision | User review, audit |
| `inference_receipts` | Signed reasoning-path records for completed decision-event model calls, ordered by durable capture completion | Atomic batch finalization before approval or execution | Owner-scoped metadata read, backup, audit |
| `inference_receipt_completions` | Content-free marker that the full zero-or-more receipt batch from one attempt is durable | Same transaction as receipt finalization | Re-ingest admission; absence on an existing decision requires recovery |
| `decision_ingest_guards` | Captured continuation snapshot and guarded effect state for one decision | Finalized with receipt authority, then advanced by guarded claims | Retry/reconciliation without replaying ambiguous effects |
| `execution_policy_authority` | Installation-wide revision fencing policy changes from stale dispatch claims | On global execution-policy invalidation | Every external-dispatch lease admission |
| `execution_admission_barriers` | One-shot, graph-bound admission snapshot for memory and approval execution | Immediately before an effect-bearing dispatch | Reconciliation and duplicate-dispatch prevention |
| `pre_effect_barriers` | One-shot reservation for an exact owner-bound external effect and its policy snapshot | Before any dedicated effect claim | Dispatch fencing, truthful failure/result evidence, and reconciliation |
| `credential_dispatch_leases` | Committed request-start authority bound to credential, vault, policy, user, and execution generations | Immediately before an external adapter request; terminal update afterward | Disconnect fencing and ambiguous-request reconciliation |
| `feedback_events` | User responses (approve/reject/edit/undo) | On user interaction | Twin model updates, evals |
| `twin_feedback_applications` | Idempotency ledger binding one feedback event to input/output profile versions | On a composed feedback projection | Replay-safe twin update audit; the Gmail archive projection is not runtime-wired yet |
| `gmail_message_refs` | Opaque app-facing reference to one owner/account-bound Gmail message and its provider IDs | On verified Gmail signal ingestion | Proposal binding and dedicated recovery/observation repositories |
| `gmail_archive_recovery_leases` | Fenced leases and finite observation state for archive recovery work | By a future dedicated recovery worker | Recovery candidate claim and provider-observation reconciliation; worker is currently unwired |
| `memory_wings` | Top-level memory palace groupings by domain | On new domain encountered | Palace status, memory retrieval |
| `memory_rooms` | Topics within a wing | On new topic encountered | Memory filing, tunnel detection |
| `memory_drawers` | Individual memory chunks (atomic unit) | Per-signal, per-decision | Search, L2/L3 retrieval |
| `memory_closets` | Compressed summaries (AAAK dialect) | Periodic compression | L1/L2 context loading |
| `memory_tunnels` | Cross-wing connections via shared topics | On tunnel detection | Cross-domain memory recall |
| `knowledge_entities` | People, places, projects, concepts | On entity extraction | Knowledge graph queries |
| `knowledge_triples` | Temporal fact triples (subject-predicate-object) | On fact extraction | Point-in-time queries, timelines |
| `episodic_memories` | Full decision episodes (situation→action→outcome) | Per-decision | Similar episode retrieval for decisions |
| `entity_codes` | 3-letter AAAK compression codes | On compression | AAAK encoding/decoding |
| `brain_pages` | Vector + tsvector pages backing the gbrain memory layer (#197) | Per-signal / per-episode | Hybrid RRF retrieval — `searchSemantic` |
| `brain_entities` | Typed entities mined for gbrain | On entity extraction | gbrain knowledge graph |
| `brain_triples` | Temporal triples for gbrain | On fact extraction | gbrain graph walks |
| `brain_episodes` | Episodes recorded via the MemoryPort surface | Per-approval feedback | Memory-feeds-decisions boost |
| `brain_signals` | Lossless RawSignal mirror (port export/import) | Per inbound signal | gbrain MemoryRecord round-trips |
| `brain_settings` | Per-user backend choice (gbrain / hybrid / mempalace) + hybrid notice dismissal | On dashboard switch | Backend factory in `apps/api/src/memory-setup.ts` |
| `brain_embedding_jobs` | Durable queue for async embedding with an exact five-minute lease token and three-attempt cap | When write-path embedding fails | `FOR UPDATE SKIP LOCKED`; expired claims are reclaimable, late completion is fenced, and page update + completion commit atomically |
| `worker_generation_authority` | Durable admission boundary for one packaged worker generation; stores only a secret hash | Packaged worker registration, revocation, and resume | Every protected write transaction locks and validates the active row; API/database containment revokes it |

### Primary Keys

Most primary keys use UUIDs (`gen_random_uuid()`). CockroachDB handles UUID distribution well across nodes, and UUIDs avoid the hot-spot problems that sequential IDs create in distributed systems.

The `brain_*` tables (#197 gbrain memory backend) use **STRING primary keys** with a UUID default (`gen_random_uuid()::STRING`). This is load-bearing: production signal IDs are connector-assigned opaque strings like `sig_gmail_abc123`, not UUIDs. Forcing UUID on `brain_signals.id` etc. would 500 every `recordSignal`. The MemoryPort contract treats record IDs as opaque strings, so the storage layer follows.

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

Time-bearing tables use `TIMESTAMPTZ` for timezone-aware instants. Many durable
records expose `created_at`, and mutable resources commonly expose `updated_at`,
but operational/link tables use purpose-specific fields such as `recorded_at`,
`scheduled_for`, or `completed_at`; the schema does not impose one timestamp
pair on every table.

## Role as Durable Operational Memory

CockroachDB is not just "the database." It is the **durable operational memory backbone** of SkyTwin. This framing matters because:

1. **Twin profiles are memory.** The system's ability to predict user preferences depends entirely on the quality and completeness of stored twin data. If the database loses data, the system loses its understanding of the user.

2. **Decision history is memory.** Past decisions inform future ones. The system uses history for pattern detection, confidence calibration, and feedback analysis.

3. **Feedback events are memory.** Every user correction teaches the system something. Losing feedback events means losing learning.

4. **Explanation records are institutional memory.** They document why supported decision paths reached recorded outcomes. Release-wide coverage remains under audit; without it, the system cannot claim a complete audit trail.

This is why CockroachDB's durability guarantees matter. SkyTwin's current
supported desktop preview runs a single local node, so it does not claim
multi-node availability. CockroachDB still provides serializable transactions
and crash-consistent storage locally; a future multi-node deployment can add
replication as an operator concern. The system treats data loss as a
catastrophic failure, not a recoverable inconvenience.

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
  COALESCE(actual_cost_cents, estimated_cost_cents)
), 0) AS daily_spend_cents
FROM spend_records
WHERE user_id = $1
  AND recorded_at >= now() - ($2::INT * INTERVAL '1 hour');

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

### Decision Receipt Finalization and External Dispatch

A successfully finalized decision-event attempt writes the decision graph and
explanation before atomically inserting zero or more `inference_receipts`, in
durable capture-completion order, plus one `inference_receipt_completions` row
and the corresponding `decision_ingest_guards` continuation snapshot. Approval
creation and execution preparation happen only after that transaction commits.
If an existing decision lacks the completion marker, re-ingestion stops before
client construction, inference, memory writes, receipt admission, approval, or
execution. Because completed-call traces are currently request-local, safe
availability recovery requires a future durable provisional trace journal or
atomic-restart design; a retry cannot declare a replacement batch complete.

An effect-bearing continuation then creates or claims an
`execution_admission_barriers` row tied by foreign keys to the exact decision,
candidate, outcome, explanation, and execution plan. Immediately before an
external adapter request, `credential_dispatch_leases` records the request-start
linearization point and snapshots the current user, policy, credential, vault,
and dispatch authority revisions. A disconnect or authority revision therefore
fences a stale claimant; an interrupted request remains ambiguous rather than
being replayed automatically.

The newer joined receipt path anchors the complete decision lifecycle in
`decision_receipts` and appends digest-chained `decision_receipt_revisions`.
Dedicated effects first reserve `pre_effect_barriers`, so proposal, consent,
dispatch, terminalization, and feedback projection cannot be confused with one
another. The Gmail archive slice currently uses this model only through
proposal and consent: its approval route returns `execution: null`, while the
caller kernel, recovery worker, and feedback projection remain unwired.

## Event Storage Design

Events (decisions) are append-only during normal operation and are removed only
by owner deletion. This supports:

- **Reconstruction:** Inspect historical twin/preference state without replaying effects
- **Audit:** Complete, unmodified record of what happened
- **Debugging:** "What did the system see at time T?"
- **Training:** Historical decisions are training data for twin model improvements

The current `TemporalReplayEngine` reconstructs twin and preference state only;
it does not rerun the decision engine. Historical effect replay is never an
automatic consequence of reading these records.

### Retention Strategy

Events are retained based on type:

| Data Type | Retention | Rationale |
|-----------|----------|-----------|
| Decisions | Until user deletion | Core audit and reconstruction data |
| Candidate actions | Until user deletion | Needed for explanation and analysis |
| Decision outcomes | Until user deletion | Core audit data |
| Execution plans/results | Until user deletion | Needed for rollback and audit |
| Explanation records | Until user deletion | User-facing audit trail |
| Feedback events | Until user deletion | Twin model provenance |
| Twin profile versions | Until user deletion | Historical reconstruction |
| Raw event payloads | Until user deletion | No automatic 90-day summarization job exists today |

### Partitioning Consideration

For high-volume deployments, the `decisions` table may benefit from range partitioning by `created_at`:

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

The checked-in schema currently includes these access paths (names are omitted
where CockroachDB derives them for inline indexes):

```sql
twin_profiles UNIQUE (user_id)
preferences (user_id, domain)
twin_profile_versions UNIQUE (profile_id, version)
decisions (user_id, created_at DESC)
decisions (user_id, domain, created_at DESC)
approval_requests (user_id, status)
approval_requests UNIQUE (decision_id)
feedback_events (user_id, created_at DESC)
feedback_events (decision_id)
feedback_events UNIQUE (approval_request_id)
action_policies (user_id, domain)
execution_results UNIQUE (plan_id)
spend_records (user_id, recorded_at DESC)
```

The authoritative definitions live in
[`packages/db/src/schemas/schema.sql`](../packages/db/src/schemas/schema.sql)
and later migrations. Check those files and the repository query shape before
adding or changing an index.

### Partial Indexes

CockroachDB supports partial indexes (indexes with `WHERE` clauses). SkyTwin
uses them only where a checked-in migration defines a stable predicate, such
as unrevoked sessions, pending approval expiry, non-null approval batches, and
pending brain-page embeddings. The base policy and approval owner/status
lookups are ordinary indexes.

Partial indexes reduce index size and improve write performance for large tables.

### Index Maintenance

Indexes should be reviewed quarterly against actual query patterns. CockroachDB's built-in SQL statistics (`SHOW STATISTICS`) can identify unused indexes and missing index opportunities.

## Local Development with Single-Node CockroachDB

### Native binary (default since v0.6.56)

The default install fetches a hash-verified CockroachDB binary into
`~/.local/share/skytwin/bin/cockroach` (or `$XDG_DATA_HOME/skytwin/bin/`)
and spawns it as a child process. No Docker required.

```bash
# Fetch + start + create the skytwin database
./bin/skytwin-db install
./bin/skytwin-db start
./bin/skytwin-db ensure-db

# Inspect status
./bin/skytwin-db status

# Verify it's accepting SQL
~/.local/share/skytwin/bin/cockroach sql --insecure --host 127.0.0.1:26257 -e "SELECT 1"

# Admin UI (note: NOT port 8080 — that collides with everything; we use 26258)
open http://127.0.0.1:26258
```

The data directory is `~/.local/share/skytwin/crdb-data/`. Stop with
`./bin/skytwin-db stop`. Wipe with `./bin/skytwin-db reset`.

### Docker Compose (legacy / opt-in)

`SKYTWIN_USE_DOCKER=true` runs the same single-node setup inside Docker
via `docker-compose.yml`:

```yaml
cockroachdb:
  image: cockroachdb/cockroach:latest-v23.2
  command: start-single-node --insecure
  ports:
    - "26257:26257"  # SQL port
    - "8080:8080"    # Admin UI (Docker path retains the upstream default)
```

```bash
SKYTWIN_USE_DOCKER=true ./install.sh
# or, for an existing checkout:
./bin/skytwin-dev --use-docker
```

Useful for CI, sandboxed environments where binaries can't be installed,
and users who already have a Docker workflow.

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

Migrations are sequential SQL files in `packages/db/src/migrations/`:

```
packages/db/src/migrations/
  001-initial.ts              # ordered runner
  002-add-api-key.sql
  ...
  094-account-signal-persistence.sql
  095-adaptive-workflow-foundation.sql
  096-watch-workflow-version-pins.sql
  097-workflow-proposal-idempotency.sql
  098-watch-full-evidence-commitments.sql
  ...
```

### Migration Rules

1. **Forward-only.** Migrations are applied in order and are never modified after application. To change a table, create a new migration.
2. **Idempotent where possible.** Use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc.
3. **No data loss.** Column drops or table drops must be preceded by a migration that preserves the data (copy to new table, rename, etc.).
4. **Tested.** Migrations are tested by running them against a fresh CockroachDB instance in CI.

### Migration Runner

[`001-initial.ts`](../packages/db/src/migrations/001-initial.ts) applies the
base schema, then reads every sibling `.sql` migration in lexical order and
executes it statement by statement. It does not use a `schema_migrations`
ledger; rerun safety depends on explicit idempotent DDL and a narrow set of
duplicate-object SQLSTATEs. Unique violations are never swallowed. The
desktop-owned path uses fixed direct connections and rechecks child-process
authority before every write.

### CockroachDB-Specific Considerations

- **No ALTER TYPE for enums.** CockroachDB doesn't support adding values to existing enums the same way Postgres does. Use STRING columns with application-level validation instead of database enums.
- **No advisory locks or migration ledger.** CockroachDB does not support
  `pg_advisory_lock`, and this runner does not pretend a nonexistent
  `schema_migrations` row can serialize it. Desktop startup owns one fixed
  migration connection and revalidates process authority before writes;
  operators must not launch competing manual migration runs. Rerun safety is
  provided by the reviewed idempotent DDL/error boundary described above.
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

Embeddings already supplement the structured twin model through the CRDB-native
gbrain-compatible backend:

- `brain_pages.embedding` stores portable `FLOAT8[]` vectors.
- `brain_pages.content_tsv` supports lexical retrieval.
- `@skytwin/memory-gbrain-crdb-adapter` fuses both ranked lists with RRF.

Current and future consumers include:

- **Semantic preference matching:** "Does the user have a preference that's *similar to* this new situation?" Vector search over preference descriptions could find approximate matches when exact key lookup fails.
- **Event similarity:** "Has the user seen an event *like* this before?" Embedding recent events and finding similar historical events could improve situation interpretation.
- **Communication style:** Embedding the user's past communications to generate stylistically consistent draft replies.

This retrieval remains additive to structured lookups and informs context or
confidence rather than replacing explicit preferences. The supported CRDB path
does not require pgvector or a second database.

The principle: **structured data for structured decisions; embeddings for fuzzy matching when structured lookup finds nothing.**

## Future Considerations

### Richer Memory Model

The current schema already includes MemPalace `episodic_memories`, gbrain-compatible
`brain_episodes`, temporal knowledge triples, and a twin `temporal_profile`.
Future extensions might include:
- **Goal modeling:** "The user is trying to reduce their subscription spending." Higher-level objectives inferred from patterns.
- **Cross-memory reconciliation:** explain and resolve conflicting episodic,
  graph, and profile facts without silently overwriting provenance.

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
