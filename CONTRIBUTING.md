# Contributing to SkyTwin

Thanks for your interest in contributing to SkyTwin. This document covers everything you need to get started.

## Getting Started

1. Fork and clone the repo
2. Install dependencies: `pnpm install`
3. Start CockroachDB: `docker-compose up -d cockroachdb`
4. Copy env config: `cp .env.example .env`
5. Run migrations: `pnpm db:migrate`
6. Build: `pnpm build`
7. Run tests: `pnpm test`

## Development Workflow

```bash
pnpm dev          # Start all apps with hot reload
pnpm test         # Run all tests
pnpm lint         # Lint all packages
```

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
