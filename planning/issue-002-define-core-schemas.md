# Issue 002: Define Core Schemas and Shared Types

**Milestone:** [M0 -- Foundations](./milestone-0-foundations.md)
**Priority:** P0 (blocking M1 work)
**Estimate:** 2-3 days
**Assignee:** TBD
**Labels:** `schema`, `types`, `database`, `M0`
**Depends on:** [Issue 001](./issue-001-bootstrap-repo.md)

## Problem

The system needs a coherent, well-defined data model that spans TypeScript interfaces (for compile-time safety) and CockroachDB tables (for persistence). These must be aligned: every interface should map cleanly to a database table, and the schema should support versioning, auditing, and the decision pipeline's data flow.

## Why It Matters

The data model is the contract between every package in the system. If it's wrong or incomplete, every downstream service has to work around the gaps. If the TypeScript types and database schema diverge, bugs hide at the boundary between application code and persistence. Getting this right early means every M1 service can build against stable contracts.

## Scope

### TypeScript Interfaces (`@skytwin/shared-types`)

All types are defined in `packages/shared-types/src/` and re-exported from `src/index.ts`.

#### Enums (`enums.ts`)

```typescript
enum TrustTier {
  OBSERVER = 'observer',
  SUGGEST = 'suggest',
  LOW_AUTONOMY = 'low_autonomy',
  MODERATE_AUTONOMY = 'moderate_autonomy',
  HIGH_AUTONOMY = 'high_autonomy',
}

enum RiskTier {
  NEGLIGIBLE = 'negligible',
  LOW = 'low',
  MODERATE = 'moderate',
  HIGH = 'high',
  CRITICAL = 'critical',
}

enum ConfidenceLevel {
  SPECULATIVE = 'speculative',
  LOW = 'low',
  MODERATE = 'moderate',
  HIGH = 'high',
  CONFIRMED = 'confirmed',
}

enum SituationType {
  EMAIL_TRIAGE = 'email_triage',
  CALENDAR_CONFLICT = 'calendar_conflict',
  SUBSCRIPTION_RENEWAL = 'subscription_renewal',
  GROCERY_REORDER = 'grocery_reorder',
  TRAVEL_DECISION = 'travel_decision',
  GENERIC = 'generic',
}

enum RiskDimension {
  REVERSIBILITY = 'reversibility',
  FINANCIAL_IMPACT = 'financial_impact',
  LEGAL_SENSITIVITY = 'legal_sensitivity',
  PRIVACY_SENSITIVITY = 'privacy_sensitivity',
  RELATIONSHIP_SENSITIVITY = 'relationship_sensitivity',
  OPERATIONAL_RISK = 'operational_risk',
}
```

#### User types (`user.ts`)

- `User`: id, email, displayName, trustTier, autonomySettings, createdAt, updatedAt
- `AutonomySettings`: maxSpendPerActionCents, maxDailySpendCents, allowedDomains, blockedDomains, requireApprovalForIrreversible, quietHoursStart, quietHoursEnd

#### Twin types (`twin.ts`)

- `TwinProfile`: id, userId, version, preferences, inferences, createdAt, updatedAt
- `Preference`: id, domain, key, value, confidence, source, evidenceIds, createdAt, updatedAt
- `PreferenceSource`: 'explicit' | 'inferred' | 'default' | 'corrected'
- `Inference`: id, domain, key, value, confidence, supportingEvidenceIds, contradictingEvidenceIds, reasoning, createdAt, updatedAt
- `TwinEvidence`: id, userId, source, type, data, domain, timestamp
- `FeedbackEvent`: id, userId, decisionId, feedbackType, correctedAction, correctedValue, reason, timestamp

#### Decision types (`decision.ts`)

- `DecisionObject`: id, situationType, domain, urgency, summary, rawData, interpretedAt
- `DecisionContext`: userId, decision, trustTier, relevantPreferences, timestamp
- `CandidateAction`: id, decisionId, actionType, description, domain, parameters, estimatedCostCents, reversible, confidence, reasoning
- `RiskAssessment`: actionId, overallTier, dimensions (Record<RiskDimension, DimensionAssessment>), reasoning, assessedAt
- `DimensionAssessment`: tier, score, reasoning
- `DecisionOutcome`: id, decisionId, selectedAction, allCandidates, riskAssessment, autoExecute, requiresApproval, reasoning, decidedAt

#### Policy types (`policy.ts`)

- `PolicyRule`: condition, effect ('allow' | 'deny' | 'require_approval'), spendLimit, riskCeiling, description
- `ActionPolicy`: id, name, domain, rules, priority, isActive, createdAt
- `DomainPolicy`: domain, enabled, autonomyLevel, spendLimit, blockedActions, requireApprovalFor
- `ApprovalRequest`: id, userId, decisionId, candidateAction, reason, urgency, status, requestedAt, respondedAt, response

#### Execution types (`execution.ts`)

- `ExecutionPlan`: id, decisionId, actionId, steps, status, createdAt
- `ExecutionStep`: id, planId, action, parameters, order, status, result
- `ExecutionResult`: planId, success, outputs, error, completedAt, rollbackAvailable
- `ExplanationRecord`: id, decisionId, whatHappened, evidenceUsed, preferencesInvoked, confidenceReasoning, actionRationale, escalationRationale, correctionGuidance, createdAt
- `FeedbackEvent` (execution variant): id, userId, decisionId, type, data, timestamp

### CockroachDB Schema (`@skytwin/db`)

#### Tables

The schema is defined in `packages/db/src/schemas/schema.sql` and covers:

1. **`users`** -- User accounts with trust tier and autonomy settings (JSONB)
2. **`connected_accounts`** -- OAuth connections to external services
3. **`twin_profiles`** -- Digital twin state (preferences, inferences as JSONB), one per user
4. **`twin_profile_versions`** -- Append-only version history with snapshots
5. **`preferences`** -- Normalized preference storage with domain indexing
6. **`decisions`** -- Decision records with raw event and interpreted situation
7. **`candidate_actions`** -- Generated candidate actions for each decision
8. **`decision_outcomes`** -- Selected action and execution determination
9. **`action_policies`** -- Per-user policy rules
10. **`approval_requests`** -- Pending/resolved approval requests
11. **`execution_plans`** -- Multi-step execution plans
12. **`execution_results`** -- Execution outcomes with rollback status
13. **`explanation_records`** -- Audit trail for every decision
14. **`feedback_events`** -- User feedback on decisions

#### Key Design Decisions

- **UUIDs everywhere:** All primary keys are `UUID DEFAULT gen_random_uuid()`. No auto-incrementing integers. UUIDs are safe for distributed CockroachDB.
- **JSONB for flexible fields:** Preferences, inferences, risk assessments, and autonomy settings use JSONB. This allows schema evolution without migrations for nested structures.
- **Timestamps are TIMESTAMPTZ:** All timestamps include timezone information. Application code should always use UTC.
- **Indexes on access patterns:** Decisions indexed by `(user_id, created_at DESC)` and `(user_id, domain, created_at DESC)`. Preferences indexed by `(user_id, domain)`. Feedback indexed by `(user_id, created_at DESC)` and `(decision_id)`.
- **Foreign keys are enforced:** All references use `REFERENCES` constraints. CockroachDB enforces these at the transaction level.

### Migration Infrastructure

- Migration runner in `@skytwin/db` that applies SQL files in order.
- Migration files named `NNNN_description.sql` (e.g., `0001_initial_schema.sql`).
- Migration state tracked in a `schema_migrations` table.
- `pnpm db:migrate` applies pending migrations.
- `pnpm db:seed` inserts development data (test users, sample preferences, example decisions).

### Type-Schema Alignment Validation

- A test that verifies every TypeScript interface field maps to a column in the corresponding CockroachDB table.
- This doesn't need to be automated initially, but the mapping should be documented.
- Fields that exist in TypeScript but not in the database (computed fields, joined data) should be clearly documented.

## Implementation Notes

### JSONB vs Normalized Tables

Some fields are stored as JSONB in CockroachDB but as typed objects in TypeScript:

| TypeScript Type | DB Storage | Reason |
|-----------------|------------|--------|
| `AutonomySettings` | `users.autonomy_settings JSONB` | Settings are always read/written as a unit; no need to join |
| `Preference[]` | `twin_profiles.preferences JSONB` + `preferences` table | Dual storage: JSONB for fast reads, normalized table for queries |
| `RiskAssessment` | `candidate_actions.risk_assessment JSONB` | Assessment is always read with the action; no independent queries |
| `ExecutionStep[]` | `execution_plans.steps JSONB` | Steps are always read/written with the plan |

### Repository Layer Pattern

The `@skytwin/db` package should export repository classes, not raw SQL:

```typescript
interface TwinProfileRepository {
  findByUserId(userId: string): Promise<TwinProfile | null>;
  create(profile: Omit<TwinProfile, 'id' | 'createdAt' | 'updatedAt'>): Promise<TwinProfile>;
  update(id: string, changes: Partial<TwinProfile>): Promise<TwinProfile>;
  getVersionHistory(profileId: string, limit?: number): Promise<TwinProfileVersion[]>;
}
```

This pattern keeps SQL out of business logic and makes testing easier (mock the repository, not the database).

### Seed Data

Development seed data should include:
- 3 test users at different trust tiers (OBSERVER, LOW_AUTONOMY, HIGH_AUTONOMY)
- Twin profiles with varied preferences across domains
- 10 sample decisions with outcomes and explanations
- A mix of approval states (pending, approved, rejected, expired)

## Acceptance Criteria

- [ ] All TypeScript interfaces compile without errors.
- [ ] Every interface is exported from `@skytwin/shared-types` main entry point.
- [ ] `schema.sql` applies cleanly to a fresh CockroachDB instance.
- [ ] `pnpm db:migrate` runs successfully against a running CockroachDB.
- [ ] `pnpm db:seed` populates the database with test data.
- [ ] Every CockroachDB table has a corresponding TypeScript interface (documented mapping).
- [ ] All JSONB fields have TypeScript types that describe their expected structure.
- [ ] Indexes exist for the primary query patterns (user lookup, decision history, feedback history).
- [ ] Foreign key constraints prevent orphaned records (tested with a constraint violation test).
- [ ] The migration runner tracks applied migrations and does not re-apply them.
- [ ] Seed data includes users at multiple trust tiers with varied preference sets.

## Non-Goals

- **ORM:** We use raw SQL via a thin repository layer, not an ORM like Prisma or TypeORM. ORMs hide CockroachDB-specific features we want to use (serializable transactions, JSONB operators).
- **GraphQL schema:** Types are TypeScript-only. No GraphQL schema generation.
- **Schema versioning tooling:** Migration files are manually created SQL. No auto-generated migrations from type changes.
- **Performance tuning:** Indexes are reasonable but not optimized for production load. Performance tuning is future work.

## Dependencies

- [Issue 001](./issue-001-bootstrap-repo.md): Workspace structure and CockroachDB docker-compose must exist before schemas can be tested.

## Risks and Open Questions

| Item | Type | Notes |
|------|------|-------|
| Dual storage of preferences (JSONB + normalized table) adds complexity | Risk | Accept the complexity. JSONB is for fast twin reads; normalized table is for cross-user queries and analytics. Keep them in sync via the repository layer. |
| JSONB fields are hard to validate at the database level | Risk | Validate at the application layer (TypeScript types + runtime validation). CockroachDB JSONB has no schema enforcement. |
| Schema changes during M1 will require migrations | Risk | This is expected. The migration runner exists for this reason. Keep migrations additive (add columns, not rename/remove). |
| Should `FeedbackEvent` be defined once or twice? | Open question | It's currently defined in both `twin.ts` and `execution.ts` with slightly different shapes. Decision: unify into a single type in `execution.ts` with all feedback types (`approve`, `reject`, `edit`, `undo`, `restate_preference`, `reward`, `punish`). Remove the duplicate from `twin.ts`. |
| Should we use CockroachDB's `ENUM` type for trust tiers and risk tiers? | Open question | Decision: No. Use `STRING` columns with application-level validation. CockroachDB enum changes require schema migrations; string values are more flexible. |
| What's the maximum JSONB document size we should plan for? | Open question | CockroachDB handles up to 64MB per value. In practice, twin profiles should stay under 1MB. Add a size check in the repository layer if profiles grow unexpectedly. |
