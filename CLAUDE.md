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

## Package Descriptions

| Package | Purpose |
|---------|---------|
| `@skytwin/shared-types` | All TypeScript interfaces and type definitions. The dependency root. |
| `@skytwin/config` | Environment variable loading, validation, and typed config objects. |
| `@skytwin/core` | Shared utilities, error types, logging helpers. |
| `@skytwin/db` | CockroachDB client, migrations, query builders, and repository layer. |
| `@skytwin/twin-model` | Twin profile CRUD, preference learning, confidence scoring. |
| `@skytwin/decision-engine` | Event interpretation, candidate action generation, action selection. |
| `@skytwin/policy-engine` | Policy evaluation, trust tier enforcement, spend limit checks. |
| `@skytwin/ironclaw-adapter` | HTTP adapter for the [IronClaw](https://github.com/nearai/ironclaw/) execution server. HMAC-SHA256 auth, retries, circuit breaker. Includes DirectExecutionAdapter fallback and mock for testing. |
| `@skytwin/explanations` | Generates human-readable explanations for decisions and actions. |
| `@skytwin/connectors` | Gmail, Google Calendar, and mock signal connectors with OAuth token management (DbTokenStore). |
| `@skytwin/evals` | Evaluation framework for measuring decision quality over time. |

### Apps

| App | Purpose |
|-----|---------|
| `api` | HTTP API server exposing decision endpoints, user management, and webhooks. |
| `web` | Web dashboard for reviewing decisions, managing preferences, and configuring policies. |
| `worker` | Background job processor for async decision execution and feedback processing. |

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

## Safety Invariants

These are non-negotiable rules. Do not write code that violates them.

1. **Never auto-execute without a policy check.** Every action must pass through the policy engine before execution. No exceptions, no shortcuts, no "just this once."

2. **Always log explanations.** Every decision that results in an action (or a deliberate non-action) must produce an `ExplanationRecord`. If you can't explain it, don't do it.

3. **Respect trust tiers.** A user's `TrustTier` determines what can be auto-executed. New users start at `'observer'` and must earn higher tiers through consistent feedback. Never bypass tier checks.

4. **Spend limits are hard limits.** If an action's estimated cost exceeds the user's per-action or daily spend limit, it must be escalated. Do not approximate. Do not round down.

5. **Reversibility matters.** Mark actions as `reversible: true` or `reversible: false` accurately. The system treats irreversible actions with higher scrutiny. Lying about reversibility is a bug.

6. **Feedback flows back.** User approvals, rejections, edits, and undos must update the twin model. If feedback isn't being recorded, the system is broken.

7. **Risk assessment is mandatory.** Every `CandidateAction` must include a `RiskAssessment` with reasoning. Skipping risk assessment is not a valid optimization.

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
