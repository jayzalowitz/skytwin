# Contributing to SkyTwin

Thanks for your interest in contributing to SkyTwin. This document covers everything you need to get started.

## Getting Started

1. Fork and clone the repo
2. Install dependencies: `pnpm install`
3. Fetch + start the local CockroachDB: `./bin/skytwin-db install && ./bin/skytwin-db start && ./bin/skytwin-db ensure-db`
4. Copy env config: `cp .env.example .env`
5. Run migrations: `pnpm db:migrate`
6. Seed the demo profile (so "Try with a sample profile" / tour mode works): `pnpm db:seed`
7. Build: `pnpm build`
8. Run tests: `pnpm test`

`bin/skytwin-db` fetches a hash-verified CockroachDB binary into
`~/.local/share/skytwin/bin/cockroach` and spawns it as a child process.
No Docker required.

To validate install regressions before opening a PR, run the multi-distro
harness: `./bin/validate-installs` (or one of `ubuntu`/`debian`/`fedora`).

## Development Workflow

```bash
pnpm dev          # Start all apps with hot reload
pnpm test         # Run all tests
pnpm lint         # Lint all packages
```

`pnpm dev` preflights the required local ports before Turbo starts. If another
process owns the API, web, OpenClaw bridge, or Twin MCP port, the script prints
the owning PID/command/cwd and exits before services start racing each other.
For Docker-backed CockroachDB, set `SKYTWIN_DOCKER_SQL_PORT` and
`SKYTWIN_DOCKER_ADMIN_PORT` when running multiple local workspaces.

During `pnpm dev`, the OpenClaw bridge runs under a dev-only supervisor. If the
bridge child process is killed once, including exit 137/SIGKILL, it restarts
without bringing down API/web/worker. Repeated fast exits still fail the task so
real crash loops are visible.

To work on a single package:

```bash
pnpm --filter @skytwin/decision-engine build
pnpm --filter @skytwin/twin-model test
```

## Pull Request Process

1. Create a branch from `main`
2. Make your changes
3. Ensure all tests pass (`pnpm test`)
4. Ensure linting passes (`pnpm lint`)
5. Write a clear PR description explaining **what** changed and **why**
6. Link any relevant issues

## Code Conventions

- **Named exports only** — no default exports
- **`interface` over `type`** for object shapes
- **`unknown` over `any`** — if you must use `any`, explain why in a comment
- **Result objects over exceptions** — use `{ success: true, data } | { success: false, error }` for expected failures
- **Tests live next to source** — in `__tests__/` directories or `*.test.ts` files
- **Vitest** for all tests

## Safety Invariants

These are non-negotiable. Code that violates them will not be merged.

1. Every action must pass through the policy engine before execution
2. Every decision must produce an `ExplanationRecord`
3. Trust tier checks cannot be bypassed
4. Spend limits are hard limits — no approximations, no rounding down
5. `reversible` must be marked accurately on every action
6. User feedback must flow back to update the twin model
7. Every `CandidateAction` must include a `RiskAssessment`

See [Safety Model](./docs/safety-model.md) for the full rationale.

## Types

All shared types live in `@skytwin/shared-types`. Use the existing decision pipeline types (`DecisionObject`, `DecisionContext`, `CandidateAction`, `DecisionOutcome`). Do not create ad-hoc objects for decision data.

## Reporting Issues

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) for bugs
- Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) for ideas
- Search existing issues before opening a new one

## Questions?

Open a discussion or issue. We're happy to help you find the right place to contribute.
