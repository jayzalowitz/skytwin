# CLAUDE.md -- Instructions for AI Assistants

This file contains guidance for AI assistants (Claude, etc.) working on the SkyTwin codebase.

## Stack

- **Language:** TypeScript (strict mode, ES2022 target, NodeNext modules)
- **Package manager:** pnpm with workspaces
- **Monorepo tooling:** Turborepo
- **Database:** CockroachDB (PostgreSQL wire protocol)
- **Runtime:** Node.js >= 20

## How to Build, Test, and Run

```bash
# Install dependencies
pnpm install

# Build all packages (respects dependency graph via Turbo)
pnpm build

# Run all tests
pnpm test

# Start development mode (all apps with hot reload)
pnpm dev

# Run database migrations
pnpm db:migrate

# Seed development data
pnpm db:seed

# Lint all packages
pnpm lint
```

To work on a single package:

```bash
pnpm --filter @skytwin/decision-engine build
pnpm --filter @skytwin/twin-model test
```

### Build gotcha: shared-types dist can go stale after rebases

If `pnpm build` fails on `@skytwin/policy-engine` (or any other package) with `error TS2305: Module '"@skytwin/shared-types"' has no exported member '<NAME>'`, but the source clearly exports `<NAME>` in `packages/shared-types/src/index.ts`, the turbo cache is serving a stale `dist/`. Force-rebuild the package:

```bash
rm -rf packages/shared-types/dist packages/shared-types/tsconfig.tsbuildinfo \
  && pnpm --filter @skytwin/shared-types build
```

Then verify the export landed in the dist:

```bash
grep '<NAME>' packages/shared-types/dist/index.js
```

This shows up most often after rebasing across changes to `packages/shared-types/src/index.ts`. CI is unaffected (fresh installs). Only the local worktree sees it.

### Build gotcha: turbo parallel race on @skytwin/db dist

If `pnpm build` fails on `@skytwin/api` with `Property 'X' does not exist on type {...}` for a method that's clearly in `packages/db/src/repositories/*.ts`, turbo's default parallel concurrency is racing on the `@skytwin/db` dist between dependent builds. Direct `pnpm --filter @skytwin/api build` succeeds because there's no race; full `pnpm build` fails because parallel writers stomp on each other's `.d.ts` output.

Workaround:

```bash
pnpm build --concurrency=1   # serial build, ~10s slower but always correct
```

Or pre-build `@skytwin/db` to a stable state, then full build:

```bash
rm -rf packages/db/dist packages/db/tsconfig.tsbuildinfo \
  && pnpm --filter @skytwin/db build \
  && pnpm build
```

CI is unaffected (clean dist on every run).

## Package Descriptions

| Package | Purpose |
|---------|---------|
| `@skytwin/shared-types` | All TypeScript interfaces and type definitions. The dependency root. |
| `@skytwin/config` | Environment variable loading, validation, and typed config objects. |
| `@skytwin/core` | Shared utilities, error types, logging helpers. Includes retry with exponential backoff (`withRetry`) and circuit breaker (`CircuitBreaker`). |
| `@skytwin/db` | CockroachDB client, migrations, query builders, and repository layer. |
| `@skytwin/twin-model` | Twin profile CRUD, preference learning, confidence scoring. |
| `@skytwin/decision-engine` | Event interpretation, candidate action generation, action selection. Pluggable strategy pattern: LLM strategies wrap `@skytwin/llm-client`, rule-based strategies are the fallback. |
| `@skytwin/policy-engine` | Policy evaluation, trust tier enforcement, spend limit checks. |
| `@skytwin/ironclaw-adapter` | HTTP adapter for the [IronClaw](https://github.com/nearai/ironclaw/) execution server. HMAC-SHA256 auth, retries, circuit breaker. Includes DirectExecutionAdapter fallback and mock for testing. |
| `@skytwin/execution-router` | Adapter selection between IronClaw, OpenClaw, and Direct execution with trust-ranked fallback chains, risk modifiers, skill gap detection, and dynamic adapter discovery from plugin directories. |
| `@skytwin/llm-client` | Unified LLM client with provider chain (Anthropic, OpenAI, Google, Ollama, embedded). Per-provider circuit breakers, SSRF-safe URL validation, prompt builder, response parser, and `estimateLlmCostCents()` helper (embedded/Ollama always return 0). No SDK dependencies. |
| `@skytwin/embedded-llm` | Local-first LLM runtime: `llama.cpp` text backend, `whisper.cpp` STT backend (`/api/voice/transcribe`), and Piper TTS backend (`/api/voice/synthesize`). Spawn-based — each backend probes for its binary + model and falls back to a `Null*Port` when either is missing. Used by `llm-client` as the `embedded` provider and by `/api/voice/*` for the voice loop. |
| `@skytwin/explanations` | Generates human-readable explanations for decisions and actions. |
| `@skytwin/connectors` | Gmail, Google Calendar, and mock signal connectors with OAuth token management (DbTokenStore). Stamps every signal with an `AuthoringTier` (six tiers from `user_sent_originated` to `inbox_automated`) so retrieval can weight self-authored content above broadcast noise (#251 Layer 1). |
| `@skytwin/mempalace` | Legacy memory system: spatial memory organization (wings/rooms/drawers), 4-layer retrieval stack, knowledge graph with temporal triples, episodic memory, AAAK compression. Selectable as a backend via `MEMORY_BACKEND=mempalace`; otherwise gbrain is the default. |
| `@skytwin/memory-port` | Backend-agnostic `MemoryPort` interface + `SignalsRouter` polyfill engine + capability negotiation. The contract every memory backend implements (#196). |
| `@skytwin/memory-gbrain` | Default memory backend (#197). `EmbeddedGbrainMemoryPort` runs in-process against the brain_* CRDB tables; vector + tsvector RRF for semantic and code-aware search. CLI-shellout `GbrainMemoryPort` kept for users with an external gbrain. |
| `@skytwin/memory-gbrain-crdb-adapter` | CockroachDB-backed driver for the gbrain backend. Repository functions, embedding providers (hash-trick fallback + OpenAI-compatible HTTP), in-memory store for tests, RRF fold with tier-weighted scoring (#251 Layer 2) that ADDS per-tier bonuses to fused scores (additive, not multiplicative — the multiplicative cut had a structural leapfrog regression on real dense embedders, fixed in #260/#272). The bonus is gated by an opt-in `floorRatio` threshold (default 0.85; aligned with gbrain v0.35.6.0 `SearchOpts.floorRatio` after our PR #1091 was reworked and merged upstream as #1129) so weak-overlap candidates can't pick up the bonus and leapfrog a legitimate primary hit. Pin/hide controls (#270) and the authoring-tier backfill worker (#271) operate against the same `brain_pages.metadata.authoringTier` field. |
| `@skytwin/memory-hybrid` | Composes any two `MemoryPort` impls. Reads route per-capability; writes dual-write best-effort. Exposes diagnostics counters. |
| `@skytwin/memory-mempalace` | `MemPalaceMemoryPort` adapter — wraps the legacy `@skytwin/mempalace` classes against the `MemoryPort` contract. |
| `@skytwin/assistant` | Stateless chat service that wraps `LlmClient` for text-only conversations with optional context enrichment (twin + memory) and action-intent routing (#135). |
| `@skytwin/capability-engine` | Infers which user-facing apps the twin should learn capabilities for, from raw signals. Keyword matching in v1; LLM-verified service detection plus adaptive scoring landed in #202. |
| `@skytwin/credential-vault` | Envelope encryption for OAuth tokens and other per-user secrets (AES-256-GCM with scrypt KDF) plus an in-process key cache (#212). Sits between the connectors and `db` so the encryption boundary is one obvious place. |
| `@skytwin/idle-miner` | Filesystem scanner that runs during idle time, extracts project metadata, and emits signals that feed `capability-engine` (#201). Triggered by the desktop idle bridge (#239). |
| `@skytwin/mcp-host` | Manages MCP servers (stdio / HTTP / SSE) — spawns, tool-call routing with per-server circuit breakers, telemetry, and Docker-isolated stdio servers when `zeroTrustMode` is on (#183 AC#4). |
| `@skytwin/dxt` | Serializes / deserializes DXT artifacts — packed binary files that carry MCP server configs (with secrets redacted) so a twin can hand its tool set to another instance (#219). |
| `@skytwin/observability` | In-memory metrics collection (latency, success rate, spend) with a ring-buffered rollup that powers the capability acquisition loop dashboards (#210). |
| `@skytwin/policy-prompts` | Versioned LLM prompt templates with JSON-schema-validated outputs and deterministic fallbacks when no LLM is configured. Used by briefing prose, draft-email generation, and risk profiling (#200). |
| `@skytwin/registry-client` | Loads the curated MCP registry, knows about each entry's OAuth quirks, and looks services up by keyword. Smithery-augmented when configured. |
| `@skytwin/evals` | Evaluation framework for measuring decision quality over time. |

### Apps

| App | Purpose |
|-----|---------|
| `api` | HTTP API server exposing decision endpoints, user management, and webhooks. Includes liveness/readiness health checks and mDNS service advertisement. |
| `web` | Web dashboard for reviewing decisions, managing preferences, and configuring policies. |
| `worker` | Background job processor for async decision execution and feedback processing. Includes startup hang detection and graceful shutdown. |
| `desktop` | Electron desktop app with electron-builder. Cross-platform builds for macOS (.dmg), Windows (.exe), and Linux (.AppImage/.deb). |
| `mobile` | React Native mobile app (Expo SDK 55). QR code pairing, mDNS API discovery, SSE real-time streaming, push notifications, and voice capture (`VoiceScreen` records via `expo-audio`, base64-encodes via `expo-file-system`, and ships to the paired desktop's `/api/voice/transcribe` for on-device whisper.cpp transcription). |
| `openclaw-bridge` | Lightweight bridge server connecting SkyTwin's OpenClaw adapter to a local Ollama instance for LLM reasoning. |
| `twin-mcp-server` | MCP server exposing the twin's read-only surface (decisions, learnings, recent activity) to external MCP clients. |

## Key Patterns

### Adapter Pattern for IronClaw

All IronClaw API access goes through `@skytwin/ironclaw-adapter`. Never call the IronClaw API directly from other packages. The adapter:
- Normalizes IronClaw responses into SkyTwin types
- Handles retries, timeouts, and error mapping
- Provides a typed interface that can be mocked in tests

### Typed Decision Objects

Every decision flows through a structured pipeline:
1. `DecisionObject` -- the raw event and interpreted situation
2. `DecisionContext` -- enriched with twin profile, policies, behavioral patterns, cross-domain traits, and temporal profile
3. `CandidateAction[]` -- possible actions with risk assessments, scored with pattern boosts and trait adjustments
4. `DecisionOutcome` -- the selected action and whether it auto-executes or requires approval

All of these types live in `@skytwin/shared-types`. Use them. Do not create ad-hoc objects for decision data.

### CockroachDB as Source of Truth

- All twin profiles, preferences, decision history, and policy state live in CockroachDB.
- Use the repository layer in `@skytwin/db` for all database access.
- CockroachDB supports serializable transactions -- use them for multi-step operations.
- Twin profile updates are versioned. Every mutation creates a `TwinProfileVersion` record.

### Explanation-First Design

Every automated action must produce an `ExplanationRecord` that answers:
- What happened?
- What evidence was used?
- What preferences were invoked?
- Why this action over alternatives?
- How can the user correct this if it's wrong?

### Frontend Event Handling

**No inline `onclick=`, `onkeydown=`, or any other inline event-handler attribute** in rendered HTML. The web dashboard renders a lot of HTML via template literals, and `escapeHtml` is HTML-context safe but the values often land in JS-string-literal context inside `onclick="handleX('${escapeHtml(value)}')"` — XSS-unsafe by construction even when current values (UUIDs, enums) happen to be safe today. Use `data-action="…"` attributes plus a delegated event listener.

**Singleton delegators must be gated by `window.location.hash`, not by DOM containment.** The SPA in `apps/web/public/js/app.js` reuses one `#page-content` container element across all routes — only the `innerHTML` swaps. That means `container.contains(target)` returns true for clicks on every page, and `container.addEventListener` inside a `renderX(container, …)` function stacks one new listener per render. Fix:

1. Hoist the delegator to a module-level function with a `_pageListenerWired` guard.
2. Attach once on `document`.
3. First check inside the handler: `if (window.location.hash.split('?')[0] !== '#/<route>') return;`

Same-page rerenders (after a save, after an SSE event) won't accumulate listeners. Cross-page navigation won't fire the wrong page's handlers. See `apps/web/public/js/pages/{approvals,settings,decisions,dashboard-view}.js` for the pattern.

**Read `getCurrentUserId()` inside the handler when it depends on the current user.** Closing over a `userId` argument from the render function leaves stale-userId listeners firing under the next user (relevant after the dev "Switch user" button changes localStorage).

## Safety Invariants

These are non-negotiable rules. Do not write code that violates them.

1. **Never auto-execute without a policy check.** Every action must pass through the policy engine before execution. No exceptions, no shortcuts, no "just this once."

2. **Always log explanations.** Every decision that results in an action (or a deliberate non-action) must produce an `ExplanationRecord`. If you can't explain it, don't do it.

3. **Respect trust tiers.** A user's `TrustTier` determines what can be auto-executed. New users start at `'observer'` and must earn higher tiers through consistent feedback. Never bypass tier checks.

4. **Spend limits are hard limits.** If an action's estimated cost exceeds the user's per-action or daily spend limit, it must be escalated. Do not approximate. Do not round down.

5. **Reversibility matters.** Mark actions as `reversible: true` or `reversible: false` accurately. The system treats irreversible actions with higher scrutiny. Lying about reversibility is a bug.

6. **Feedback flows back.** User approvals, rejections, edits, and undos must update the twin model. If feedback isn't being recorded, the system is broken.

7. **Risk assessment is mandatory.** Every `CandidateAction` must include a `RiskAssessment` with reasoning. Skipping risk assessment is not a valid optimization.

8. **Untrusted-origin actions never auto-execute destructive work.** Content the user did not author — inbound email, idle-crawl files, web pages, third-party calendar invites — is the documentary-poisoning attack surface. Every action carries an `ActionProvenance`; the injection guard (`evaluateInjectionGuard` in `packages/shared-types/src/action-safety.ts`, applied by `PolicyEvaluator.checkInjectionGuard` and backstopped by `ExecutionRouter`) escalates destructive-shaped or untrusted-origin actions to human confirmation — single-click, or two-click for extreme shapes (shell, filesystem, DB, account destruction). Provenance is the security boundary; never weaken it to a "default if absent" — absent provenance must fail safe to `untrusted_external`. The candidate generator does not get to set its own provenance.

## Zero-trust mode runtime constraint

When `McpServerConfig.zeroTrustMode` is `true`, the MCP server process is spawned inside `docker run --network=none` so it has no network access. This applies **only to stdio transport** — HTTP/SSE servers are remote processes and `--network=none` would sever the connection entirely. Requires Docker to be running on the host; if Docker is unavailable the server starts without isolation and `McpServerHandle.failedToIsolate` is set to `true`. MCP server packages must be pre-installed on the host via `npm install -g <package>` so the host global `node_modules` mount (resolved via `npm root -g`) makes them visible inside the container. See `packages/mcp-host/src/docker-spawn.ts` for implementation details.

## Review Discipline

### PR merge gate — non-negotiable

Every PR MUST clear a three-step gate **before merge**. Skipping any step is grounds to revert the merge. Adapted from the gate Robot-Robot-and-Human (RRH) uses, which closed a class of "Copilot left dozens of unaddressed inline comments" misses that this codebase has accumulated.

**NEVER push to main directly.** All changes — including doc-only typo fixes — go through a Pull Request. Feature branches only. If a commit lands on main by mistake, immediately revert and move the change to a feature branch.

**Add Copilot as a reviewer on every PR.** Right after `gh pr create`, run `gh pr edit <PR> --add-reviewer @copilot`. This is the cheapest second pair of eyes available and it is the reviewer that catches the most things on this codebase. The pre-merge gate depends on Copilot having actually reviewed.

**Pre-merge — all three required, in order:**

1. **Run `/review`** against the PR diff. The skill catches SQL safety issues, LLM trust-boundary violations, conditional side effects, and structural problems that Copilot's automated review misses (and vice versa — they catch different classes of issue, which is why we run both). Treat its findings the same as Copilot's: address valid concerns, dismiss non-applicable ones with a one-line explanation in the PR comment thread.

2. **Wait for Copilot review and address every comment.** After `gh pr edit <PR> --add-reviewer @copilot`, wait for the review to land. `gh pr view <PR> --json reviews` shows review summaries (state + author); for the actual inline comments use `gh api repos/:owner/:repo/pulls/<PR>/comments` (PR review comments) and `gh api repos/:owner/:repo/issues/<PR>/comments` (top-level conversation comments). For each: either push a fix (preferred — same reviewer often catches additional issues on the second pass) or dismiss with a one-line reason in a reply. **Do NOT merge until every comment is resolved or explicitly dismissed.** This is the gate the May 2026 epic week skipped, which led to ~70 REAL unresolved Copilot findings across 15 PRs and the multi-batch sweep PR (#226 → #232) to clean them up.

3. **Run `/document-release`** against the PR diff. The skill cross-references the diff against `README.md`, `ARCHITECTURE.md` (if present), `CONTRIBUTING.md`, this `CLAUDE.md`, and `CHANGELOG.md`, updates them where they've drifted from what shipped, polishes CHANGELOG voice, and cleans up TODOs the PR superseded. Running this **pre-merge** keeps code + docs atomic — reviewers see proposed doc updates alongside the code, no drift window between merge and the doc-update commit, no follow-up "docs: sync with X" commits cluttering main. If review feedback in step 2 changes the code, re-run `/document-release` (it's idempotent).

The order is non-negotiable: `/review` first (catches structural issues), Copilot second (catches what `/review` missed plus inline nits), `/document-release` third (docs reflect the final pre-merge state). Don't merge before step 3; the diff that ships includes the doc updates.

### Habits that prevent "PR ships a regression of the bug it claims to fix"

These have already prevented several bugs from landing on this codebase. Don't skip them — the merge gate above is necessary but not sufficient.

- **`/review` and CI catch different things.** CI verifies code compiles and tests pass; it does not verify that the PR's stated intent landed correctly. Two of the highest-impact bugs caught on this codebase were "the loop walks the wrong direction" and "the verification curl produces no output" — both compiled, both passed tests, both would have shipped a regression of the original bug.
- **When migrating event-handler patterns, trace re-render paths first.** Before adding any `addEventListener` inside a render function, write down what triggers a re-render of that container (route changes? SSE events? post-save mutations?). If anything other than a one-time mount triggers re-render, use a singleton wired via `_listenerWired` guard. See "Frontend Event Handling" above.
- **Verify shared-types `dist/` has the export you're importing before declaring the build clean.** After changes to `packages/shared-types/src/index.ts`, run `grep <EXPORT> packages/shared-types/dist/index.js`. Catches the turbo-cache regression in two seconds.
- **Write the unit test alongside any parse / validation / regex hardening.** "Falls back to safe default on garbage input" without a test is one rebase away from silently regressing. Five test cases for input validation are faster to write than to argue about whether you need them.
- **Post-`/review` and post-Copilot fixes get their own commits inside the PR.** Don't squash them into the original change locally before pushing — separate commits give reviewers a clear "what was the first cut, what did review catch" diff. CHANGELOG can carry a `### Fixed (post-/review)` subsection for the same reason.
- **Documentation that describes engine behavior must cite the source-of-truth file.** The trust-tier promotion criteria, spend-limit thresholds, and policy gates all live in code (`packages/shared-types/src/policy.ts`, `packages/policy-engine/`). When docs describe these, link to the file so future drift is visible. `docs/safety-model.md` does this; new docs should follow.

## Code Style

- Use named exports, not default exports.
- Prefer `interface` over `type` for object shapes.
- Use `unknown` instead of `any`. If you write `any`, justify it with a comment.
- Error handling: use typed result objects (`{ success: true, data } | { success: false, error }`) rather than thrown exceptions for expected failure modes.
- Tests go in `__tests__/` directories adjacent to source, or in files named `*.test.ts`.
- Use vitest for all tests.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review

## Deploy Configuration (configured by /setup-deploy)
- Platform: None (pre-deployment)
- Production URL: Not configured
- Deploy workflow: None
- Deploy status command: None
- Merge method: squash
- Project type: Monorepo (API + web dashboard + worker), not yet deployed
- Post-deploy health check: None

### Custom deploy hooks
- Pre-merge: none
- Deploy trigger: none (merge to main only)
- Deploy status: none
- Health check: none

## Design System
Always read `DESIGN.md` before making any visual or UI decision. Font choices,
color tokens (iris `#7C72E8` is the single accent and means "needs you / act"),
spacing, the action-vs-awareness hierarchy, and the per-element state catalog all
live there. Do not deviate without explicit user approval. In `/qa` and
`/design-review`, flag any UI that doesn't match `DESIGN.md` — especially the
"every state" rule (cold-start, scope-blocked, loading, error, prose-fallback must
all be designed, not happy-path only).
