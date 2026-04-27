All notable changes to SkyTwin will be documented in this file.

## [Unreleased]

### Added

- **Per-candidate policy verdicts on decision outcomes**: `DecisionOutcome.policyVerdicts` now records the policy result for every scored candidate (`'allowed' | 'requires-approval' | 'denied'`), populated by `evaluate()` and not persisted. Lets downstream consumers distinguish blocked candidates from un-evaluated ones (#82)
- **`decision:blocked-by-policy` SSE event**: When the decision pipeline blocks every candidate, the API now emits an SSE event so the user can see why nothing happened. Previously the event ingest was silent and the policy result was invisible (#78)
- **`InvariantViolationError` runtime guard on `ExecutionRouter`**: Both `executeWithRouting` and `executeWithRoutingStreaming` now throw if called without a `RiskAssessment` or with a mismatched `actionId`. Pins Safety Invariants #1 and #7 at the boundary so a future caller that bypasses the decision pipeline cannot silently auto-execute (#78)
- **Approvals page pagination**: Renders the first 10 pending cards by default with a "Show N more (M remaining)" button. Eliminates the ~29,210-pixel scroll area that buried the "Recent decisions" section when many approvals were pending (#84)
- **E2E coverage for the safety kernel**: New `Policy safety kernel` describe block in the e2e suite gated behind `E2E=true`. Two tests prove (1) policy denial blocks execution end-to-end and (2) the approval gate blocks execution until the user approves (#83)
- **Adapter manifest `defaultConfig`**: Plugin manifests can now declare bootstrap settings (api URL, channel id, etc.) that the discovery loader passes to the factory. Falls back to `{}` when absent — existing plugins keep working (#91)
- **`SignalDeduper` extracted to its own module** (`apps/worker/src/signal-dedupe.ts`): Pure module with constructor-injected TTL, capacity, and clock. Adds `pruneUsers(activeUserIds)` so the worker can release dedupe memory when a user is no longer tracked (#93)

### Fixed

- **`whatWouldIDo` no longer leaks blocked candidates as alternatives**: Filters `alternativeActions` using the new per-candidate verdicts. Previously the prediction surfaced policy-denied actions as options the user could take. Conservative fallback drops alternatives entirely when verdicts are unavailable (#82)
- **Blocked-by-policy decisions now persist `escalationRationale`**: Previously the audit log silently dropped the policy-block reason for no-action outcomes, violating Safety Invariant #2. `formatForUser` uses a context-aware label ("Why no action was taken" vs "Why approval was needed") (#82)
- **"How well I know you" stat counted only inferences**: Users with explicit preferences saw 0% even when the twin had real knowledge. Now combines preferences and inferences, weighting explicit/corrected preferences as `'confirmed'` (#86)
- **Generic preference description read like a config dump**: Was "Travel: find_travel_deals = i love travel deals". String values now surface as the preference itself: "Travel: i love travel deals" (#86)
- **Spending guardrails forced cents input**: Inputs now show "$" prefix and decimal step, pre-fill as dollars, save by rounding dollars*100 back to cents to avoid float drift. Domain-policy badge also shows "max $X/action" (#86)
- **Decisions table showed raw enum names and stripped dates**: "What happened" column now maps `email_triage` → "Email triage", `generic` → "General", etc. Timestamps now use relative time for recent rows ("2h ago") and "Apr 7, 9:44 PM" format for older — identical-second seed data no longer blurs together (#85)
- **Twin badges said "1 things" / "1 prefs" / "1 inferences"**: Now singularizes when count is 1 (#79)
- **Decisions table Undo button was indistinguishable from a label**: `.btn-ghost` (transparent border, muted text) → `.btn-outline` for visible affordance (#79)
- **URL validation hardened against zone IDs, trailing dots, CGNAT**: Centralized hostname normalization (`normalizeHostname`) catches `localhost.`, `[fe80::1%eth0]`, and uppercase variants. Added blocks for IPv6 unspecified `[::]` / `[0:0:0:0:0:0:0:0]` and the CGNAT range `100.64.0.0/10` (RFC 6598) (#90)
- **Adapter discovery validates plugin shape post-construction**: After calling `factory()`, the loader now verifies the returned object has the four required `IronClawAdapter` methods. Plugins returning malformed objects fail at load time instead of bubbling up as `NoAdapterError` under load. Also wraps the factory call in `try/catch` so a throwing constructor doesn't kill discovery for unrelated plugins (#91)
- **Worker dedupe cap is now a hard ceiling**: Eviction now triggers on `size >= maxPerUser` (was strict `>`). Previous logic allowed +1 overshoot. Eviction drops expired entries first, then falls back to oldest-first removal until `size < maxPerUser` (#93)

### Tests

- **Explanation generator has full branch coverage**: 33 tests covering `generate`, `formatForUser`, `formatForAudit`, and every branch of the six private helpers. Pins user-facing copy across renames and refactors. Also catches the `formatForAudit` `autoExecuted = !escalationRationale` derivation (#77, #82)
- **Decision-engine `whatWouldIDo` partial-block coverage**: New tests verify mixed verdicts filter correctly, all-blocked returns no recommendation and no alternatives, and outcomes without `policyVerdicts` fall back conservatively (#82)
- **Decision-engine policy-denial blocking is locked in**: Verifies every candidate verdict is recorded on `outcome.policyVerdicts` and that selection logic still picks the highest-scored allowed candidate (#82)
- **`ExecutionRouter` boundary guards**: New tests cover null/undefined `RiskAssessment`, mismatched `actionId`, and null `CandidateAction` for both `executeWithRouting` and `executeWithRoutingStreaming` (#78, #81)
- **Events-routes test for blocked-by-policy SSE emission**: Asserts the handler emits the new event and does not call `executeWithRoutingStreaming` when no candidate was selected (#78)
- **Test fixture isolation in `@skytwin/explanations`**: Seven describe blocks now use per-test `beforeEach` instead of module-level `const` for the in-memory repo, so saved records no longer accumulate between `it()` calls (#81)
- **`@skytwin/config` test coverage** (was 0): 18 tests covering `loadConfig` defaults, env reads, `GATEWAY_AUTH_TOKEN` and `IRONCLAW_CHANNEL` legacy aliases, `validate()` per-field rejection, and `loadValidatedConfig` aggregated error message (#88)
- **`@skytwin/core` top-level helpers covered**: 20 tests for `generateId` (UUID shape + uniqueness), `compareRiskTiers`/`riskExceeds`/`trustMeetsOrExceeds` semantics, tier ordering tables, and `createLogger` level routing + format + meta JSON serialization (#88)
- **`@skytwin/connectors` Gmail + Calendar pure-logic coverage**: 35 new tests for `inferEmailType` (9 categories), `messageToSignal` (case-insensitive headers, `requiresResponse` derivation, internalDate parsing), `eventToSignal` (needsAction handling, all-day events, conflict flag), `detectConflicts` (overlap, back-to-back boundary, three-way overlap, all-day exclusion). Connectors went 8 → 43 tests (#89)
- **URL validation hardening tests** (+10): trailing-dot bypasses, IPv6 zone IDs, IPv6 unspecified `[::]`, CGNAT boundaries, uppercase normalization (#90)
- **Adapter manifest + shape validation tests** (+8): `defaultConfig` parsing and drop-on-non-object, `isAdapterShape` enumerating required methods, null/undefined/primitive rejection (#91)
- **`PreferenceArchaeologist` extended coverage** (+8): action-key fallback chain (`data.action` → `data.preference_key` → `data.behavior` → skip), multi-group analysis, sub-threshold drop, `supportingEvidence` cap at 10, `expiresAt` 30-day window, non-explicit existing preferences do NOT block re-proposal (#92)
- **`@skytwin/worker` test coverage** (was 0): 11 tests for the new `SignalDeduper` — per-user isolation, source-namespacing, TTL boundary, `mark()` idempotency, `reset()` per-user, expired-first eviction, oldest-insertion-order eviction, eviction inert at-or-below cap with no insert (#93)

## [0.4.0.0] - 2026-04-08

### Added

- **LLM-powered decisions**: Your twin can now use Claude, GPT, Gemini, or a local Ollama model to interpret events and generate candidate actions, instead of relying solely on keyword matching and hardcoded rules
- **Provider chain with automatic fallback**: Configure multiple AI providers in priority order. If Anthropic is down, the system tries OpenAI, then Ollama, then falls back to built-in rules. Per-provider circuit breakers prevent repeated timeouts
- **AI brain settings UI**: New drag-and-drop card in Settings to add, reorder, test, enable/disable, and remove AI providers. One-click connection test shows latency and model info
- **`@skytwin/llm-client` package**: Unified LLM client with provider chain, circuit breakers, prompt builder, and response parser. Supports Anthropic, OpenAI, Google, and Ollama via raw fetch (no SDK dependencies)
- **Strategy pattern in decision-engine**: `SituationInterpreter` and `DecisionMaker` now accept pluggable strategies. LLM strategies wrap the client; rule-based strategies preserve all existing logic as fallback
- **Dynamic adapter discovery**: Execution router can scan a plugin directory for adapter manifests, dynamically importing and registering third-party execution adapters with enforced minimum trust scores
- **Desktop OAuth via system browser**: Electron app opens Google OAuth in the system browser instead of an embedded window (which froze on passkey verification). Polls for completion with 5-minute timeout, shows close-tab confirmation page on success

### Fixed

- **API keys silently erased on save**: Saving your AI provider settings no longer wipes your API keys. The server preserves existing keys when the UI sends masked previews back
- **Per-request circuit breaker defeat**: A downed AI provider is now remembered across requests. Previously, the system forgot failures between events and kept retrying a broken provider on every single decision
- **SSRF via user-controlled baseUrl**: All LLM providers now validate baseUrl against private IP ranges (RFC 1918, link-local, cloud metadata, 0.0.0.0, octal/hex encodings, IPv6-mapped IPv4). Ollama is exempted for loopback addresses only. DNS rebinding protection resolves all A/AAAA records at save time, blocking hostnames like `127.0.0.1.nip.io` that resolve to private IPs
- **Google API key leaked in URL**: Moved from query parameter (`?key=`) to `x-goog-api-key` header
- **Path traversal in adapter plugins**: Entry point paths are resolved via realpathSync (following symlinks) and checked with trailing separator to prevent both symlink escape and directory prefix confusion
- **Plugin name collision**: Discovered adapters cannot use reserved names (ironclaw, direct, openclaw), preventing overwrites of built-in adapters
- **Race condition in execution router init**: Singleton now stores the initialization promise (not the result) to prevent duplicate router creation under concurrent requests, with error recovery on rejection
- **LLM-controlled safety fields**: The LLM can no longer set its own cost estimates or reversibility flags on candidate actions. These safety-critical values are overridden with conservative defaults, and the deterministic scoring and policy layers handle the real values
- **XSS in settings page**: userId now escaped in all onclick handlers to prevent injection via mobile pairing URL
- **NaN/Infinity in adapter manifest**: riskModifier validated with Number.isFinite before use
- **N+1 on decisions page**: batch-fetches decision outcomes in a single query instead of one per row
- **XSS in dashboard activity**: domain and situationType now escaped with escapeHtml in recent activity feed
- **Null crash in audit trail**: optional chaining on `entry.detail?.decisionId` prevents TypeError on malformed entries
- **escapeHtml null guard**: `escapeHtml(null)` no longer throws, returns empty string
- **0% accuracy on empty data**: dashboard shows "--" instead of "0%" when no decisions exist
- **Decisions limit injection**: limit/offset parameters clamped to [1, 200] with NaN fallback

### Changed

- **Decision status badges**: decisions page now shows Auto / You OK'd / Pending based on three-way outcome state (auto-executed true, false, or missing)
- **Stat card tooltips**: all four dashboard stat cards have title attributes explaining what each metric means

## [0.3.3.1] - 2026-04-08

### Added

- **Twin insight editing**: Edit button on each insight card opens a styled modal to update what the twin knows
- **Correction modal**: "That's not right" now opens a proper modal (replaces browser prompt) with save, remove, cancel, and keyboard shortcuts (Cmd+Enter, Escape)
- **DELETE /api/twin/:userId/insights endpoint**: atomic insight correction and removal with input validation and length limits

### Fixed

- **Twin feedback was broken**: feedback buttons on the My Learnings page called invalid API endpoints (null decisionId, wrong type). Replaced with dedicated insight management endpoint
- **XSS in insight rendering**: `escapeHtml()` now escapes quotes for HTML attribute safety, `item.reasoning` is escaped before innerHTML injection
- **Double-submit prevention**: correction modal guards against concurrent API calls from click + keyboard
- **Redundant DB queries**: correction path reduced from 4 sequential CockroachDB calls to 2 (one read, one atomic write)
- **Predictable IDs**: preference IDs use `crypto.randomUUID()` instead of `Math.random()`

### Changed

- **btn-ghost CSS class**: added missing button variant used by Edit buttons, with hover state and focus-visible keyboard indicator

## [0.3.3.0] - 2026-04-08

### Added

- **Approvals history overlay**: full decision history with search, detail expansion, infinite scroll, and per-item collapsible execution details showing what happened (or would have happened) for each decision
- **Signal context in approval cards**: pending approvals now show the original email body, sender, source, and subject so you have enough information to decide without leaving the page
- **Alternative actions for escalations**: when the twin escalates, you now see the other options it considered (with parameters, cost, reversibility) so you can pick one directly
- **Skill gaps endpoint**: new `GET /api/v1/skill-gaps/:userId` to retrieve per-user skill gap history
- **Batch repository methods**: `findByIds()` and `getCandidateActionsForDecisions()` on decision repository for efficient bulk lookups

### Changed

- **N+1 query elimination**: pending approvals endpoint reduced from 2N+1 database queries to exactly 3 fixed queries via batch `WHERE id = ANY($1)` and in-memory Map joins
- **Soft-delete for escalation cleanup**: stale escalations are now marked `status = 'cleaned'` instead of hard-deleted, preserving audit trail for pattern analysis
- **OAuth redirect**: callback now uses `WEB_BASE_URL` env var instead of hardcoded localhost, supporting deployed environments
- **PostgreSQL error codes**: duplicate candidate action detection uses error code `23505` instead of fragile string matching
- **Worker error isolation**: expiry and escalation cleanup run in separate try/catch blocks with per-user error handling so one failure doesn't block others

### Fixed

- **XSS hardening**: all user-controlled data in `describeExecutionStep()`, `describeAction()`, `explainReason()`, suggestion buttons, and domain labels now goes through `escapeHtml()` before HTML interpolation
- **History limit**: clamped to max 500 (was unbounded, could dump entire table)
- **Sensitive key filtering**: `accessToken`, `oauthToken`, `refreshToken`, and `credentials` are stripped from alternative action parameters before sending to the frontend
- **Ownership check**: cleanup-escalations endpoint rejects cross-user requests with 403

## [0.3.2.1] - 2026-04-07

### Added

- **Launch-ready README**: Complete rewrite with value proposition, ASCII architecture diagram, concrete scenario examples, trust tier documentation, version badges, and 6 dashboard screenshots
- **Apache 2.0 License**: Open-source licensing replaces proprietary notice
- **Community files**: CONTRIBUTING.md (dev workflow, safety invariants), SECURITY.md (vulnerability reporting, threat scope), CODE_OF_CONDUCT.md (Contributor Covenant)
- **GitHub templates**: Bug report and feature request issue templates, PR template with safety checklist
- **Dependabot**: Weekly automated dependency updates for npm and GitHub Actions
- **Dashboard screenshots**: Onboarding, dashboard, approvals, decision history, setup/credentials, and settings pages captured and embedded in README

### Changed

- Package.json enriched with description, repository URL, homepage, author, license, and keyword metadata

## [0.3.2.0] - 2026-04-07

### Added

- **Memory Palace** (`@skytwin/mempalace`): Your twin now remembers. A spatial memory system inspired by [mempalace](https://github.com/milla-jovovich/mempalace), ported from Python to native TypeScript and backed by CockroachDB instead of ChromaDB/SQLite. Organizes memories into wings (domains), rooms (topics), and drawers (individual memories), with cross-wing tunnels that connect related topics across domains.
- **4-Layer Memory Stack**: Decisions now load context from a tiered retrieval system. L0 (identity, ~100 tokens) and L1 (essential story, ~500 tokens) are always loaded. L2 recalls on-demand per wing/topic. L3 runs full search across all drawers and episodes.
- **Episodic Memory**: Every decision outcome is recorded as an episode linking the situation, action taken, and user feedback. When a new decision arrives, the engine retrieves similar past episodes to inform scoring. Approved episodes boost similar actions (+20 cap), rejected/undone episodes penalize them (-15 cap).
- **Knowledge Graph with Temporal Triples**: Track facts about people, places, and projects with validity windows. "Alice works at Acme" valid from 2025-03 to present. Point-in-time queries answer "what was true on date X?"
- **AAAK Compression**: Compact memory encoding using 3-letter entity codes, hall prefixes, and significance flags (CORE, PIVOT, GENESIS, DECISION). Produces token-efficient closets from multiple drawers.
- **Memory Miner**: Automatically extracts memories from signals, decisions, and feedback. Signals become drawers filed in the right wing/room. Decisions become episodic memories. Corrections and undos become discovery drawers. Entity names and email domains are extracted into the knowledge graph.
- **Memory Palace API**: 12 new endpoints at `/api/mempalace/:userId/` for palace status, wings, rooms, drawers (CRUD + search), tunnels, episodic memories (list + search), and knowledge graph entities and triples.
- **Decision Pipeline Integration**: `DecisionContext` now carries `episodicMemories` and `wakeUpContext`. The `scoreCandidate()` method includes a new `calculateEpisodicBoost()` that uses past episode outcomes to adjust candidate action scores.
- 9 new CockroachDB tables (migration 012): `memory_wings`, `memory_rooms`, `memory_drawers`, `memory_closets`, `memory_tunnels`, `knowledge_entities`, `knowledge_triples`, `episodic_memories`, `entity_codes`
- 19 new shared types for the memory palace data model
- 43 new tests across 6 test files covering palace structure, episode lifecycle, knowledge graph, AAAK compression, memory mining, and decision context enrichment (589 total, up from 546)

## [0.3.1.1] - 2026-04-07

### Added

- **mDNS Service Advertisement**: SkyTwin API now advertises itself on the local network via Bonjour/mDNS (`_skytwin._tcp`), enabling automatic discovery by mobile and desktop clients
- **Database Repository Tests**: 76 unit tests covering user, approval, decision, and policy repositories with full mock isolation
- **E2E Test Infrastructure**: Real CockroachDB integration tests (15 DB tests + 22 API tests) behind `E2E=true` gate, with `bin/skytwin-e2e-test` orchestration script for Docker-based runs
- **Circuit Breaker Probe Latch Tests**: Verifies only one probe is allowed in half-open state, preventing thundering herd
- **Retry TypeError Distinction Tests**: Verifies network TypeErrors are retried while programming TypeErrors are not

### Changed (Breaking)

- **Approval respond returns 409**: POST `/api/approvals/:requestId/respond` now returns HTTP 409 (Conflict) instead of 404 when an approval has already been responded to. Clients should handle both 404 (not found) and 409 (already handled).

### Fixed

- **Process supervision PID orphan**: `bin/skytwin-dev` now properly tracks child process PIDs and forwards SIGTERM/SIGINT, preventing orphaned node processes on `--stop`
- **Circuit breaker thundering herd**: Half-open state now uses a probe-in-flight latch so only one request probes recovery at a time
- **Retry false positive on TypeError**: `isNetworkError()` no longer classifies programming TypeErrors (e.g., null dereference) as retryable network errors
- **Approval double-execution race condition**: `approval_requests` UPDATE now includes `AND status = 'pending'` for atomic check-and-set, with ownership verified before mutation and 409 returned for already-responded requests
- **Worker circuit breaker memory leak**: Circuit breakers for removed users are now pruned during connector rediscovery
- **API graceful shutdown**: Server now handles SIGTERM/SIGINT with mDNS cleanup and HTTP connection draining

## [0.3.0.0] - 2026-04-01

### Added

- **Trust Tier Progression Engine** (`TrustTierEngine`): Users now auto-promote from OBSERVER through MODERATE_AUTONOMY based on approval history (10/20/50/100 thresholds). HIGH_AUTONOMY requires explicit opt-in, never auto-promoted. Rolling-window regression checks demote users after rejection spikes. All tier changes produce audit records in the new `trust_tier_audit` table.
- **Approval Routing with Expiry** (`ApprovalRouter`): Approval requests now expire based on urgency (immediate=15min, normal=24h, low=72h). Worker cron sweeps expired requests. Batch respond endpoint at POST /api/approvals/batch-respond for bulk approve/reject.
- **Daily Spend Tracking** (`SpendTracker`): Rolling 24-hour spend window enforced per user. Per-action AND daily aggregate limits are now hard-gated in the policy evaluator. Reconciliation updates actual costs when they differ from estimates, freeing up budget.
- **Domain-Specific Autonomy** (`DomainAutonomyManager`): Per-domain trust tier overrides. The system uses the more restrictive of global and domain tier, so HIGH_AUTONOMY globally + LOW_AUTONOMY for finance means finance actions still require approval.
- **Escalation Triggers** (`EscalationTriggerEngine`): Configurable triggers fire on amount thresholds, consecutive rejections, novel situations, and time-of-day rules. Returns structured escalation reasons with evidence.
- **Safety Invariant Integration Tests**: 7 test groups covering every safety invariant from CLAUDE.md, plus 3 regression scenarios for daily spend, domain autonomy, and tier progression.
- **Workflow Registry** (`WorkflowHandlerRegistry`): Maps SituationType to handler functions. Four new workflow handlers: calendar-conflict, subscription-renewal, grocery-reorder, travel-decision, each with E2E tests.
- **IronClaw Contract Tests**: 15 tests validating that MockIronClawAdapter and RealIronClawAdapter produce compatible outputs. MockIronClawServer with HMAC-SHA256 verification for local testing.
- **Rollback E2E Tests**: 6 tests verifying the full execute-then-rollback lifecycle, irreversible rejection, unknown plan handling, and independent multi-plan rollback.
- **Settings API and Page**: GET/PUT endpoints for autonomy settings, domain overrides, and escalation triggers at /api/settings/:userId. Settings page shows current trust tier, autonomy controls, and domain-specific policies.
- **Escalation Correctness Metric** (`EscalationCorrectnessTracker`): Measures under-escalation and over-escalation rates from feedback data.
- **Calibration Error Metric** (`CalibrationErrorTracker`): Computes Expected Calibration Error (ECE) by bucketing decisions by confidence and comparing predicted vs actual accuracy.
- **Decision Latency Metric** (`DecisionLatencyTracker`): Tracks P50, P90, and P99 latency across the decision pipeline.
- **39 New Eval Scenarios**: 8 each for calendar, subscription, grocery, and travel domains, plus 7 cross-domain correlation scenarios. Total scenario count: 50+.
- **Preference Evolution Tracking** (`PreferenceEvolutionTracker`): Records every preference change with attribution (which feedback or evidence caused it). New `preference_history` table with point-in-time reconstruction.
- **Temporal Replay Engine** (`TemporalReplayEngine`): Reconstructs twin state at any point in time using twin_profile_versions + preference_history. Supports diffing between two timestamps and timeline generation.
- **CI Workflow** (`.github/workflows/evals.yml`): Runs the eval suite on push to main and on PRs. Fails on safety regression.
- 5 new DB migrations (006-010): trust_tier_audit, approval enhancements (expires_at, batch_id), spend_records, domain_autonomy_policies + escalation_triggers, preference_history
- 172 new tests (432 total, up from 260)

### Changed

- OpenClaw adapter upgraded from mock-only to real HTTP client with `/execute` and `/rollback` endpoints, Bearer auth, and dry-run fallback when no server is configured
- `ContinuousEvalRunner` now stores per-scenario pass/fail results on `EvalRun.scenarioResults` for regression comparison across runs
- Event ingestion route now uses `WorkflowHandlerRegistry` instead of direct email-triage imports

### Fixed

- `/ask` endpoint now looks up trust tier from DB via `userRepository.findById()` instead of hardcoding `TrustTier.OBSERVER`
- `/briefings` endpoint now queries `proactiveScanRepository.getLatestBriefing()` instead of returning stub data
- `/skill-gaps` endpoint now queries `skillGapRepository` instead of returning an empty array
- `/proposals` endpoint now validates ownership and status via `proposalRepository`, and accepted proposals update the twin model via `twinService.updatePreference()`

## [0.2.0.0] - 2026-04-01

### Added

- **Execution Router** (`@skytwin/execution-router`): Adapter selection between IronClaw, OpenClaw, and Direct execution with trust-ranked fallback chains, risk modifiers for irreversible actions, and skill gap detection that logs unhandled action types
- **Twin Query API**: `whatWouldIDo()` endpoint at POST /ask/:userId that predicts what the twin would do in a hypothetical situation without persisting state, using a no-op decision repository to prevent synthetic query records in the DB
- **Twin Export**: Export your full twin profile as JSON or Markdown at GET /export/:userId, including preferences, inferences, behavioral patterns, cross-domain traits, and temporal profile
- **Proactive Mode**: ProactiveEvaluator scans incoming signals, partitions into auto-executable actions (HIGH confidence only) and approval-needed items, and generates urgency-sorted morning briefings
- **Preference Archaeology**: PreferenceArchaeologist analyzes accumulated evidence to detect implicit behavioral patterns and surfaces them as preference proposals for user confirmation (5+ consistent signals required, confidence scales with count)
- **Undo-with-Learning**: Extended feedback system accepts structured undo reasoning (whatWentWrong, severity, whichStep, preferredAlternative) and applies 2x weight correction to the twin model, with severe undos triggering extra confidence reduction
- **Cross-Domain Correlation**: Four correlation rules detect relationships across domains: calendar-email links, same-sender threading within 24h, calendar time conflicts, and subscription-financial connections
- **Phase 1 DB Migrations**: Six new tables (signals, preference_proposals, twin_exports, skill_gap_log, proactive_scans, briefings) and four column additions using CockroachDB-safe 3-step pattern (ADD nullable, UPDATE, SET NOT NULL)
- Token-scoped rate limiting on /ask endpoint, tiered by trust level (60-600 requests/hour)
- Briefing schedule configuration via PUT /briefings/:userId/preferences
- API routes for proposals (GET + POST accept/reject) and skill gaps (GET)
- OpenClaw adapter with mock-first implementation and declared skill set
- 96 new tests covering inference engine, decision maker branches, rate limiting, and feedback validation (260 total, up from 164)
- 8 planning documents for the scope expansion milestone

### Changed

- ExecutionRouter fallback logic now only retries on thrown errors (safe to retry); non-completed status returns immediately to prevent double-execution of partially-completed actions
- OpenClaw trust profile corrected: reversibilityGuarantee changed from 'partial' to 'none' (rollback always fails)
- RoutingDecision now includes modifiedRiskAssessment so callers can see the post-modifier risk tier

### Fixed

- Trust tier in /ask endpoint is now server-determined (defaults to OBSERVER per Safety Invariant #3) instead of accepting client-supplied values
- Ask endpoint uses real DB-backed TwinService and PolicyEvaluator instead of mocks, with a no-op DecisionRepository to prevent synthetic records polluting decision history
- Twin export route (/export/:userId) moved before the wildcard (/:userId) to prevent Express matching "export" as a userId
- Undo feedback validation relaxed from mandatory to optional for API backwards compatibility
- Migration safety: NOT NULL DEFAULT on existing CockroachDB tables split into 3-step pattern to avoid table-level locks
- Added missing foreign key indexes on skill_gap_log, twin_exports, and briefings tables

## [0.1.0.0] - 2026-03-31

### Added

- Monorepo scaffolding with pnpm workspaces, Turborepo, and TypeScript strict mode
- Full shared type system: User, TwinProfile, DecisionObject, CandidateAction, RiskAssessment, ActionPolicy, ExplanationRecord, and 20+ supporting types
- CockroachDB schema with 14 tables covering users, twin profiles, decisions, policies, executions, explanations, and feedback
- Repository layer with parameterized queries for all tables
- Twin model service with preference management, inference engine, and version history
- Decision engine with situation interpreter (6 situation types), risk assessor (6 dimensions), and candidate action generation
- Policy engine with 5 built-in safety policies: spend limits, irreversibility checks, legal review gates, privacy protection, and trust tier gating
- Explanation generator producing human-readable and structured audit records for every decision
- IronClaw adapter with HTTP client (HMAC-SHA256 auth, retries, circuit breaker) for the [IronClaw](https://github.com/nearai/ironclaw/) execution server, DirectExecutionAdapter fallback, and mock adapter for development
- Real Gmail and Google Calendar signal connectors with OAuth token auto-refresh, plus mock connectors for testing
- Evaluation harness with scenario framework, email triage scenarios, and safety regression suite
- Express API server with routes for event ingestion, twin management, decisions, approvals (full CRUD with pending/history/respond), feedback, evals (accuracy/learning/confidence), OAuth flow, and user management
- Multi-user worker service that discovers users with active OAuth tokens from CockroachDB, creates per-user real connectors, and re-discovers every 10 poll cycles
- Google OAuth2 flow with authorization, token exchange, DB-persisted tokens, and auto-refresh via DbTokenStore adapter
- Approval pipeline: events create approval requests when confidence is low, users review in the web dashboard, responses feed back into the twin model
- Behavioral pattern and cross-domain trait persistence via PatternRepositoryPort backed by CockroachDB
- Pattern-aware decision scoring: DecisionMaker uses pattern boosts and trait adjustments (5 cross-domain traits) when evaluating candidate actions
- Web dashboard SPA with hash-based routing: dashboard (confidence bars, accuracy, patterns), approval cards with human-readable descriptions, twin profile grouped by domain, settings with tier selector and Google connection, onboarding wizard
- Evals API endpoints calculating real accuracy from feedback data, learning progress aggregation, and per-domain confidence scoring
- DB migrations for OAuth tokens, behavioral patterns, cross-domain traits, and eval history
- End-to-end email triage workflow wiring all modules together
- 119 tests across decision engine, policy engine, twin model, IronClaw adapter (HTTP client, circuit breaker, direct execution, handler registry), evals, and connectors
- Docker Compose setup with CockroachDB single-node for local development
- 7 documentation files covering product spec, technical spec, safety model, decision engine, IronClaw integration, CockroachDB architecture, and evals
- 15 planning artifacts: 5 milestone docs and 10 issue specs

### Fixed

- IronClaw adapter now actually communicates with the [IronClaw](https://github.com/nearai/ironclaw/) server via HTTP webhook (POST /webhook with HMAC-SHA256 auth) instead of dispatching to local handler classes that called Gmail/Calendar APIs directly
- Sensitive credentials (OAuth tokens, API keys) are sanitized before being sent to IronClaw, replaced with managed references
- Config now validates that `IRONCLAW_WEBHOOK_SECRET` is set when mock mode is off
- Mobile nav menu now has a backdrop overlay and closes when tapping outside
- Error banners on settings page now clear previous errors before showing new ones
- HTML in error messages is now escaped to prevent XSS
- Connection status indicator now visible on mobile when nav menu is open
- Trust tier default changed from invalid `'new'` to `'observer'` (matching TrustTier enum)
- Policy evaluator now denies unrecognized trust tiers instead of silently permitting them
- Trust tier in event ingestion now read from DB user record instead of caller-supplied request body
- `justConnected` URL parameter in settings page escaped to prevent reflected XSS
- Twin profile update query now validates column names against an allowlist
