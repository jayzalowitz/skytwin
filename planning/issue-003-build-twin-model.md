# Issue 003: Build the Twin Model Service

**Milestone:** [M1 -- Decision Core](./milestone-1-decision-core.md)
**Priority:** P0 (blocking decision engine)
**Estimate:** 3-4 days
**Assignee:** TBD
**Labels:** `twin-model`, `core`, `M1`
**Depends on:** [Issue 001](./issue-001-bootstrap-repo.md), [Issue 002](./issue-002-define-core-schemas.md)

## Problem

The decision engine needs to know who the user is -- their preferences, inferences, communication style, risk tolerance, and decision history. The twin model is the structured representation of this knowledge. Without it, the decision engine has no basis for personalized decisions; it can only apply generic rules.

## Why It Matters

The twin model is the core differentiator of SkyTwin. Every other delegated-action system either asks the user every time (too many interruptions) or applies one-size-fits-all rules (wrong decisions). The twin model enables personalized, confident, non-obvious decisions by maintaining a living model of what the user would do.

If the twin model is weak, the system is just a notification router. If it's strong, it's a digital twin.

## Scope

### TwinService API

The `@skytwin/twin-model` package exports a `TwinService` class with the following public API:

```typescript
interface TwinService {
  // Profile lifecycle
  createProfile(userId: string): Promise<TwinProfile>;
  getProfile(userId: string): Promise<TwinProfile | null>;
  deleteProfile(userId: string): Promise<void>;

  // Preference management
  addPreference(userId: string, preference: Omit<Preference, 'id' | 'createdAt' | 'updatedAt'>): Promise<Preference>;
  updatePreference(userId: string, preferenceId: string, changes: Partial<Preference>): Promise<Preference>;
  getPreferences(userId: string, domain?: string): Promise<Preference[]>;
  getPreferencesByKey(userId: string, key: string): Promise<Preference[]>;
  removePreference(userId: string, preferenceId: string): Promise<void>;

  // Inference engine
  addEvidence(userId: string, evidence: Omit<TwinEvidence, 'id'>): Promise<TwinEvidence>;
  deriveInferences(userId: string, domain: string): Promise<Inference[]>;
  getInferences(userId: string, domain?: string): Promise<Inference[]>;

  // Version history
  getVersionHistory(userId: string, limit?: number): Promise<TwinProfileVersion[]>;
  getProfileAtVersion(userId: string, version: number): Promise<TwinProfile | null>;
}
```

### Profile CRUD

- **Create:** Initialize a new `TwinProfile` for a user. Version starts at 1. Empty preferences and inferences. Default risk tolerance and spend norms.
- **Read:** Retrieve the current twin profile by user ID. Return null if not found. Include all preferences and inferences.
- **Update:** Any mutation to the profile (add preference, update inference, etc.) bumps the version number and creates a `TwinProfileVersion` snapshot.
- **Delete:** Soft-delete preferred (set a `deletedAt` timestamp). For M1, hard delete is acceptable.

### Preference Management

Preferences are the twin's knowledge about what the user wants. Each preference has:

- **Domain:** The category of behavior (e.g., `email`, `calendar`, `grocery`, `travel`, `finance`).
- **Key:** The specific preference within the domain (e.g., `email.newsletter_action`, `grocery.preferred_brand.yogurt`).
- **Value:** The preference value (e.g., `"archive"`, `"Chobani"`, `{ dayOfWeek: "Saturday", timeOfDay: "morning" }`).
- **Confidence:** How sure we are (`SPECULATIVE` through `CONFIRMED`).
- **Source:** How the preference was established (`explicit`, `inferred`, `default`, `corrected`).
- **Evidence IDs:** Links to the `TwinEvidence` records that support this preference.

Operations:
- Add a preference: validate domain/key uniqueness per user, set initial confidence and source.
- Update a preference: change value, adjust confidence, add evidence links. Creates version record.
- Query by domain: return all preferences in a domain, sorted by confidence (highest first).
- Query by key: return the preference for a specific key (may have multiple with different confidence levels).
- Remove a preference: mark as removed (or hard delete for M1).

### Inference Engine

The inference engine derives preferences from evidence. In M1, this is rule-based:

1. **Evidence accumulation:** Raw signals (user approved an email archive action, user rejected a grocery substitution) are stored as `TwinEvidence`.
2. **Pattern detection:** When enough evidence exists for a domain+key combination, derive an `Inference`:
   - 3+ consistent signals in the same direction -> `MODERATE` confidence inference
   - 5+ consistent signals -> `HIGH` confidence inference
   - Any contradicting signals reduce confidence by one tier
3. **Inference promotion:** When an inference reaches `HIGH` confidence, it becomes a `Preference` with `source: 'inferred'`.
4. **Conflict resolution:** When evidence contradicts an existing inference, record the contradiction and lower the inference confidence. If confidence drops to `SPECULATIVE`, flag the inference for review.

### Evidence Tracking

- Store `TwinEvidence` records in CockroachDB.
- Each evidence record is linked to the decision and feedback that generated it.
- Evidence has a domain and type for filtering (e.g., domain `email`, type `archive_approval`).
- Evidence is append-only -- never modified, never deleted.

### Version History

Every profile mutation creates a `TwinProfileVersion` record:

```typescript
interface TwinProfileVersion {
  id: string;
  profileId: string;
  version: number;
  snapshot: TwinProfile;       // Full profile state at this version
  changedFields: string[];      // Which fields changed (e.g., ["preferences", "inferences"])
  reason: string | null;        // Why the change happened (e.g., "feedback on decision abc-123")
  createdAt: Date;
}
```

This enables:
- Auditing: see exactly how the twin changed over time.
- Debugging: "why did the system think I prefer X?" -- check version history.
- Replay: reconstruct twin state at any point in time (needed for M4 evals).

### CockroachDB Persistence

All data is stored via the `@skytwin/db` repository layer:

- `TwinProfileRepository`: CRUD for `twin_profiles` table, version creation for `twin_profile_versions` table.
- `PreferenceRepository`: CRUD for `preferences` table (normalized storage).
- `EvidenceRepository`: Append-only storage for `twin_evidence` (may need this table added to schema).
- All mutations use CockroachDB serializable transactions to maintain consistency.

## Implementation Notes

### Transaction Boundaries

Profile updates that involve multiple tables (e.g., add preference + create version + update profile timestamp) must be wrapped in a single CockroachDB transaction:

```typescript
async addPreference(userId: string, pref: ...): Promise<Preference> {
  return this.db.transaction(async (tx) => {
    const preference = await this.preferenceRepo.create(tx, pref);
    const profile = await this.profileRepo.findByUserId(tx, userId);
    const newVersion = profile.version + 1;
    await this.profileRepo.updateVersion(tx, profile.id, newVersion);
    await this.versionRepo.create(tx, {
      profileId: profile.id,
      version: newVersion,
      snapshot: { ...profile, preferences: [...profile.preferences, preference] },
      changedFields: ['preferences'],
      reason: `Added preference: ${pref.key}`,
    });
    return preference;
  });
}
```

### Inference Engine Architecture

The inference engine is a pipeline of steps:

1. **Collect evidence:** Gather all evidence for a user+domain.
2. **Group by key:** Cluster evidence by inferred preference key.
3. **Count signals:** For each key, count supporting and contradicting signals.
4. **Compute confidence:** Apply threshold rules (3+ supporting = MODERATE, 5+ = HIGH).
5. **Generate inferences:** Create or update `Inference` records.
6. **Promote to preferences:** If an inference reaches HIGH confidence, create a `Preference`.

This pipeline runs synchronously in M1. In M4, it may become asynchronous (triggered by feedback events).

### Preference Key Conventions

Use dot-separated hierarchical keys:
- `email.newsletter.action` -> what to do with newsletters (archive, label, delete)
- `email.sender.vip_list` -> list of VIP senders
- `calendar.conflict.resolution_strategy` -> how to handle double-bookings
- `grocery.brand.yogurt` -> preferred yogurt brand
- `travel.seat.preference` -> aisle, window, or middle

### Testing Strategy

1. **Unit tests for TwinService:** Mock the repository layer. Test preference CRUD, inference logic, version creation.
2. **Integration tests with CockroachDB:** Use a test database. Test transaction boundaries, concurrent updates, version ordering.
3. **Inference engine tests:** Given specific evidence patterns, verify the correct inferences are derived.
4. **Edge cases:** Empty profiles, duplicate preferences, conflicting evidence, maximum version number.

## Acceptance Criteria

- [ ] `TwinService.createProfile(userId)` creates a profile with version 1 and empty preferences/inferences.
- [ ] `TwinService.getProfile(userId)` returns the current profile with all preferences and inferences.
- [ ] `TwinService.addPreference(...)` adds a preference, bumps profile version, and creates a version record.
- [ ] `TwinService.updatePreference(...)` modifies the preference and records the change in version history.
- [ ] `TwinService.getPreferences(userId, domain)` returns only preferences in the specified domain.
- [ ] `TwinService.addEvidence(...)` stores evidence and links it to the appropriate domain.
- [ ] `TwinService.deriveInferences(userId, domain)` produces inferences from accumulated evidence with correct confidence levels.
- [ ] After 5 consistent evidence signals, an inference is promoted to a preference with `source: 'inferred'`.
- [ ] Contradicting evidence reduces inference confidence.
- [ ] Version history is append-only: 3 updates produce 3 version records (versions 2, 3, 4).
- [ ] `TwinService.getProfileAtVersion(userId, 2)` returns the profile as it was at version 2.
- [ ] All mutations are transactional: a failure mid-update leaves no partial state.
- [ ] All tests pass: `pnpm --filter @skytwin/twin-model test`.

## Non-Goals

- **ML-based inference:** M1 uses rule-based thresholds. ML is future work (M4+).
- **Real-time preference updates:** Preferences update synchronously during feedback processing, not via streaming.
- **Preference conflict resolution UI:** When preferences conflict, the system lowers confidence. User-facing resolution is future work.
- **Multi-tenant profiles:** One user, one twin. Shared/family profiles are out of scope.
- **Preference export/import:** No mechanism to export or import preference data in M1.

## Dependencies

- [Issue 001](./issue-001-bootstrap-repo.md): Workspace structure and build tooling.
- [Issue 002](./issue-002-define-core-schemas.md): TypeScript interfaces and CockroachDB schema.

## Risks and Open Questions

| Item | Type | Notes |
|------|------|-------|
| Version history grows unboundedly | Risk | For M1, accept unbounded growth. Add retention policy (keep last N versions, archive older) in M4. |
| Inference thresholds (3 for MODERATE, 5 for HIGH) are arbitrary | Risk | They're a starting point. M4 evals will calibrate them based on real feedback data. Document that these are tunable constants. |
| JSONB preferences in twin_profiles vs normalized preferences table causes dual-write complexity | Risk | Accept the complexity. The twin_profiles JSONB is the "fast read" path; the preferences table is the "query" path. Keep them in sync within the same transaction. |
| Evidence storage needs a new table not in the current schema | Risk | May need to add a `twin_evidence` table to schema.sql. Or store evidence as rows in `feedback_events` with a broader type column. Resolve during implementation. |
| Concurrent profile updates from multiple feedback events | Risk | CockroachDB serializable transactions handle this. If two updates conflict, one retries. The repository layer should handle retry logic. |
