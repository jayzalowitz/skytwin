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
| `@skytwin/llm-client` | Unified LLM client with provider chain (Anthropic, OpenAI, Google, Ollama). Per-provider circuit breakers, SSRF-safe URL validation, prompt builder, and response parser. No SDK dependencies. |
| `@skytwin/explanations` | Generates human-readable explanations for decisions and actions. |
| `@skytwin/connectors` | Gmail, Google Calendar, and mock signal connectors with OAuth token management (DbTokenStore). |
| `@skytwin/mempalace` | Memory Palace system: spatial memory organization (wings/rooms/drawers), 4-layer retrieval stack, knowledge graph with temporal triples, episodic memory, AAAK compression. Enriches DecisionContext with past episodes. |
| `@skytwin/evals` | Evaluation framework for measuring decision quality over time. |

### Apps

| App | Purpose |
|-----|---------|
| `api` | HTTP API server exposing decision endpoints, user management, and webhooks. Includes liveness/readiness health checks and mDNS service advertisement. |
| `web` | Web dashboard for reviewing decisions, managing preferences, and configuring policies. |
| `worker` | Background job processor for async decision execution and feedback processing. Includes startup hang detection and graceful shutdown. |
| `desktop` | Electron desktop app with electron-builder. Cross-platform builds for macOS (.dmg), Windows (.exe), and Linux (.AppImage/.deb). |
| `mobile` | React Native mobile app (Expo). QR code pairing, mDNS API discovery, SSE real-time streaming, push notifications. |
| `openclaw-bridge` | Lightweight bridge server connecting SkyTwin's OpenClaw adapter to a local Ollama instance for LLM reasoning. |

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

## Review Discipline

These are habits that have already prevented "PR ships a regression of the bug it claims to fix" from landing on this codebase. Don't skip them.

- **Run `/review` on every non-trivial PR before merging, even when CI is green.** CI verifies code compiles and tests pass; it does not verify that the PR's stated intent landed correctly. Two of the highest-impact bugs caught on this codebase were "the loop walks the wrong direction" and "the verification curl produces no output" — both compiled, both passed tests, both would have shipped a regression of the original bug.
- **When migrating event-handler patterns, trace re-render paths first.** Before adding any `addEventListener` inside a render function, write down what triggers a re-render of that container (route changes? SSE events? post-save mutations?). If anything other than a one-time mount triggers re-render, use a singleton wired via `_listenerWired` guard. See "Frontend Event Handling" above.
- **Verify shared-types `dist/` has the export you're importing before declaring the build clean.** After changes to `packages/shared-types/src/index.ts`, run `grep <EXPORT> packages/shared-types/dist/index.js`. Catches the turbo-cache regression in two seconds.
- **Write the unit test alongside any parse / validation / regex hardening.** "Falls back to safe default on garbage input" without a test is one rebase away from silently regressing. Five test cases for input validation are faster to write than to argue about whether you need them.
- **Post-`/review` fixes get their own commits inside the PR.** Don't squash them into the original change locally before pushing — separate commits give reviewers a clear "what was the first cut, what did review catch" diff. CHANGELOG can carry a `### Fixed (post-/review)` subsection for the same reason.
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
