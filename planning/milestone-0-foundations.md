# Milestone 0: Foundations

**Status:** In Progress
**Target:** Week 1-2
**Owner:** Core team

## Goal

Get the SkyTwin monorepo standing with all infrastructure in place so that every subsequent milestone can build on a stable, tested foundation. After M0, any engineer should be able to clone the repo, run `pnpm install`, start CockroachDB, apply schemas, and see types compile -- all within five minutes.

## Scope

### In scope

- **Monorepo bootstrap:** pnpm workspaces, Turborepo pipeline, root-level scripts for build/test/dev/lint.
- **TypeScript configuration:** Strict mode, ES2022 target, NodeNext modules, path aliases for all workspace packages, shared tsconfig base.
- **Workspace packages (stubs):** Create the directory structure and package.json for every package (`shared-types`, `config`, `core`, `db`, `twin-model`, `decision-engine`, `policy-engine`, `ironclaw-adapter`, `explanations`, `connectors`, `evals`) and every app (`api`, `web`, `worker`).
- **CockroachDB setup:** docker-compose service with health checks, schema.sql with all tables, migration runner stub, seed data script.
- **Shared types and schemas:** All TypeScript interfaces (`DecisionObject`, `DecisionContext`, `CandidateAction`, `RiskAssessment`, `DecisionOutcome`, `TwinProfile`, `Preference`, `Inference`, `TwinEvidence`, `FeedbackEvent`, `PolicyRule`, `ActionPolicy`, `DomainPolicy`, `ApprovalRequest`, `ExecutionPlan`, `ExecutionStep`, `ExecutionResult`, `ExplanationRecord`, `User`, `AutonomySettings`) and all enums (`TrustTier`, `RiskTier`, `ConfidenceLevel`, `SituationType`, `RiskDimension`).
- **Mock IronClaw adapter:** A mock implementation of the `IronClawAdapter` interface that returns canned responses for testing.
- **Local dev environment:** .env.example, docker-compose, documented setup steps, working `pnpm dev`.
- **Basic CI:** GitHub Actions workflow that runs install, build, lint, and test on every PR.
- **Developer documentation:** CLAUDE.md with build/test/run instructions and code style guidance.

### Out of scope

- Real IronClaw API integration (M3).
- Business logic in any service package (M1+).
- Production deployment configuration.
- Web dashboard UI.

## Success Criteria

All of the following must be true for M0 to be considered complete:

1. `pnpm install` completes without errors.
2. `pnpm build` compiles all packages and apps with zero TypeScript errors.
3. `pnpm test` runs and all tests pass (even if coverage is minimal).
4. `docker-compose up cockroachdb` starts CockroachDB and the health check passes.
5. `pnpm db:migrate` applies schema.sql to the running CockroachDB instance without errors.
6. All shared types are importable from `@skytwin/shared-types` in any workspace package.
7. The mock IronClaw adapter can be instantiated and returns valid typed responses.
8. `pnpm lint` passes across all packages.
9. CI workflow runs successfully on a PR.

## Issues

| Issue | Title | Status |
|-------|-------|--------|
| [001](./issue-001-bootstrap-repo.md) | Bootstrap the SkyTwin monorepo | Not started |
| [002](./issue-002-define-core-schemas.md) | Define core schemas and shared types | Not started |

## Dependency Graph

```
issue-001 (bootstrap)
    └── issue-002 (schemas + types) depends on 001
```

Issue 001 must be completed first because the workspace structure, build tooling, and CockroachDB docker setup are prerequisites for defining and testing schemas.

## Estimated Effort

| Issue | Estimate | Notes |
|-------|----------|-------|
| 001 | 2-3 days | Mostly boilerplate but needs careful attention to Turbo config, tsconfig paths, and docker health checks |
| 002 | 2-3 days | Schema design decisions, migration infrastructure, type/schema alignment validation |
| **Total** | **4-6 days** | |

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| CockroachDB docker image version incompatibility | Medium | Low | Pin to `cockroachdb/cockroach:latest-v23.2`, test on CI |
| pnpm workspace resolution edge cases with TypeScript path aliases | Medium | Medium | Test cross-package imports early; add integration test that imports from every package |
| Schema design changes during M1 require migrations | Low | High | Accept this; keep migration runner working from the start so schema changes are cheap |
| CI flakiness from CockroachDB startup time | Medium | Medium | Use health checks with generous start_period (15s); cache docker layers |

## Dependencies

- **External:** Docker (for CockroachDB), Node.js >= 20, pnpm 9.x
- **Internal:** None (M0 is the root of the dependency tree)

## Exit Criteria

M0 is complete when:
- All success criteria above are verified
- A second developer can clone the repo and get everything running following only the documented steps
- CI is green on the main branch
