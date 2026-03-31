# Issue 001: Bootstrap the SkyTwin Monorepo

**Milestone:** [M0 -- Foundations](./milestone-0-foundations.md)
**Priority:** P0 (blocking everything else)
**Estimate:** 2-3 days
**Assignee:** TBD
**Labels:** `infrastructure`, `setup`, `M0`

## Problem

There is no working repository yet. We need a TypeScript monorepo that compiles, tests, lints, and runs locally with CockroachDB. Every subsequent issue assumes this foundation exists.

## Why It Matters

Every engineer on the team needs to be able to clone the repo and start working within minutes. If the foundation is shaky -- if build times are bad, if imports don't resolve, if the database won't start -- every future milestone is slowed by infrastructure friction. Getting M0 right once saves hundreds of hours downstream.

## Scope

### 1. pnpm Workspace Configuration

- `pnpm-workspace.yaml` defining `packages/*` and `apps/*` as workspace roots.
- Root `package.json` with scripts: `build`, `dev`, `test`, `lint`, `db:migrate`, `db:seed`.
- `packageManager` field set to `pnpm@9.1.0`.
- `engines` field requiring Node.js >= 20.

### 2. Turborepo Pipeline

- `turbo.json` with pipeline stages:
  - `build`: depends on `^build`, outputs `dist/**`
  - `dev`: no cache, persistent
  - `test`: depends on `build`, outputs `coverage/**`
  - `lint`: depends on `^build`
- Global dependencies on `.env.*local` files.

### 3. TypeScript Configuration

- Root `tsconfig.json`:
  - `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`
  - `strict: true`, `noUncheckedIndexedAccess: true`, `noUnusedLocals: true`, `noUnusedParameters: true`
  - `declaration: true`, `declarationMap: true`, `sourceMap: true`
  - Path aliases for all workspace packages (`@skytwin/*`)
- Per-package `tsconfig.json` that extends the root config and sets `rootDir` and `outDir`.

### 4. Package Stubs

Create directory structure and `package.json` for each package:

| Package | Name | Initial content |
|---------|------|-----------------|
| `packages/shared-types` | `@skytwin/shared-types` | Type definitions only, no runtime deps |
| `packages/config` | `@skytwin/config` | `.env` loader stub |
| `packages/core` | `@skytwin/core` | Error types, logger stub |
| `packages/db` | `@skytwin/db` | Connection stub, schema.sql |
| `packages/twin-model` | `@skytwin/twin-model` | Empty src/index.ts |
| `packages/decision-engine` | `@skytwin/decision-engine` | Empty src/index.ts |
| `packages/policy-engine` | `@skytwin/policy-engine` | Empty src/index.ts |
| `packages/ironclaw-adapter` | `@skytwin/ironclaw-adapter` | Interface + mock stub |
| `packages/explanations` | `@skytwin/explanations` | Empty src/index.ts |
| `packages/connectors` | `@skytwin/connectors` | Empty src/index.ts |
| `packages/evals` | `@skytwin/evals` | Empty src/index.ts |

App stubs:

| App | Name | Initial content |
|-----|------|-----------------|
| `apps/api` | `@skytwin/api` | Express/Fastify stub with health endpoint |
| `apps/web` | `@skytwin/web` | Placeholder |
| `apps/worker` | `@skytwin/worker` | Placeholder |

### 5. Docker Compose

- CockroachDB single-node cluster (`cockroachdb/cockroach:latest-v23.2`):
  - Ports: 26257 (SQL), 8080 (Admin UI)
  - Volume: `cockroach-data` for persistence
  - Health check: HTTP to admin UI `/health` endpoint
  - Environment: `COCKROACH_DATABASE=skytwin`
- API service (optional profile `with-api`):
  - Depends on CockroachDB health check
  - `DATABASE_URL` environment variable

### 6. Development Environment

- `.env.example` with all required environment variables documented.
- `.gitignore` covering: `node_modules`, `dist`, `coverage`, `.env`, `.env.local`, `.turbo`, `cockroach-data`.
- `CLAUDE.md` with build/test/run instructions and code style guidance.

### 7. Basic CI

- GitHub Actions workflow (`.github/workflows/ci.yml`):
  - Triggers: push to main, pull requests
  - Steps: checkout, setup Node.js 20, setup pnpm, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`, `pnpm test`
  - CockroachDB service container for integration tests (optional for M0, can start with unit tests only)

### 8. Testing Setup

- Vitest as the test runner (configured in root and per-package).
- At least one passing test per package (can be a trivial "imports work" test).
- Coverage reporting configured but not enforced in M0.

## Implementation Notes

### Package Dependency Order

Packages have a strict dependency order. Build must respect this:

```
shared-types (no deps)
  └── config (depends on shared-types)
  └── core (depends on shared-types)
       └── db (depends on shared-types, core, config)
            └── twin-model (depends on shared-types, core, db)
            └── decision-engine (depends on shared-types, core, db, twin-model, policy-engine)
            └── policy-engine (depends on shared-types, core, db)
            └── ironclaw-adapter (depends on shared-types, core)
            └── explanations (depends on shared-types, core, db)
            └── connectors (depends on shared-types, core, config)
            └── evals (depends on shared-types, core, decision-engine, twin-model, policy-engine)
```

Turborepo handles this automatically via `^build` dependencies, but the `package.json` dependency declarations must be correct.

### Path Alias Strategy

Use TypeScript path aliases (`@skytwin/foo`) that map to the source (`./packages/foo/src`), not the built output. This allows IDE navigation and development without a build step. Turborepo ensures packages are built in the correct order for runtime.

At runtime (tests, production), packages resolve through the `main` field in `package.json`, which points to `dist/index.js`.

### CockroachDB Local Development

CockroachDB runs in insecure mode for local development. The connection string is:
```
postgresql://root@localhost:26257/skytwin?sslmode=disable
```

For CI, CockroachDB runs as a GitHub Actions service container with the same configuration.

## Acceptance Criteria

- [ ] `git clone && pnpm install` completes in under 60 seconds on a fresh machine with warm npm cache.
- [ ] `pnpm build` compiles all packages with zero TypeScript errors and zero warnings.
- [ ] `pnpm test` runs at least one test per package, all passing.
- [ ] `pnpm lint` passes across all packages.
- [ ] `docker-compose up cockroachdb` starts CockroachDB and the health check passes within 30 seconds.
- [ ] Every package can import from `@skytwin/shared-types` without build errors.
- [ ] `turbo run build --graph` shows the correct dependency order.
- [ ] `.env.example` documents every environment variable with example values and descriptions.
- [ ] `CLAUDE.md` accurately describes how to build, test, and run the project.
- [ ] A developer unfamiliar with the project can set up the dev environment following only the README and CLAUDE.md.

## Non-Goals

- **Production-ready CI/CD:** M0 CI is build+test only. No deployment pipelines, no staging environments, no artifact publishing.
- **Package publishing:** Packages are consumed via workspace resolution only. No npm publishing.
- **Complete implementation:** Packages are stubs. Business logic is M1+.
- **Performance optimization:** Build speed and test speed are acceptable if they're not terrible. Optimization is future work.

## Dependencies

- **External:** Docker, Node.js 20+, pnpm 9.x, GitHub Actions (for CI)
- **Internal:** None (this is the first issue)

## Risks and Open Questions

| Item | Type | Notes |
|------|------|-------|
| pnpm 9.x has breaking changes from 8.x | Risk | Pin to 9.1.0 via `packageManager` field. Test lockfile generation. |
| Turborepo pipeline config format changed in v2 | Risk | Use v2 format from the start. Verify with `turbo --version`. |
| CockroachDB docker image is large (~1GB) | Risk | Accept the download time. Cache in CI. Consider using `cockroachdb/cockroach:latest-v23.2` not `latest` to avoid surprise upgrades. |
| Should we use ESM or CJS for output? | Open question | Decision: ESM (`"type": "module"` in package.json). NodeNext module resolution handles this. All imports must have `.js` extensions. |
| Do we need a Dockerfile for every app in M0? | Open question | Decision: No. The API Dockerfile exists for docker-compose but is not required to work in M0. Apps are stubs. |
| Should vitest config be per-package or shared? | Open question | Decision: Shared vitest config at root, per-package overrides via `vitest.config.ts` only when needed. |
