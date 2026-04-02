# SkyTwin

**Judgment Jay: Mildly Apocalyptic Personal Automation**

SkyTwin is a delegated judgment layer that sits above [IronClaw](https://github.com/nearai/ironclaw/). It maintains a digital twin of user preferences, risk tolerances, and decision patterns, then uses that model to act on behalf of the user -- or, when it isn't sure, to ask the right question instead of the wrong one.

The core principle: **ask the twin before asking the user.**

Most personal automation fails because it either does too much (surprise charges, awkward emails) or too little (another notification to ignore). SkyTwin tries to thread the needle: build a real model of what you'd want, act on it when confidence is high, and escalate with context when it isn't.

## Architecture

SkyTwin is structured as a pipeline:

1. **Events arrive** from connected accounts (Gmail, Google Calendar, etc.) via signal connectors, with OAuth tokens auto-refreshed from the database.
2. The **decision engine** interprets each event, queries the user's twin profile (including behavioral patterns, cross-domain traits, and temporal activity), and evaluates candidate actions.
3. The **policy engine** applies safety constraints, spend limits, and trust tiers before anything executes.
4. Actions are either auto-executed via IronClaw (with an explanation logged) or escalated as an **approval request** the user can review in the web dashboard.
5. User feedback (approvals, rejections, edits, undos) flows back to update the twin model, improving future decisions.

CockroachDB is the source of truth for twin profiles, decision history, and policy state. The system is designed so that every automated action can be explained, audited, and reversed.

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker (for CockroachDB)

### Setup

```bash
# Clone and install
git clone <repo-url> && cd skytwin
pnpm install

# Start CockroachDB
docker-compose up -d cockroachdb

# Configure environment
cp .env.example .env
# Edit .env with your values

# Run migrations and seed data
pnpm db:migrate
pnpm db:seed

# Build all packages
pnpm build

# Start development
pnpm dev
```

### Running Tests

```bash
pnpm test          # 432 tests across 40+ test files
```

## Monorepo Structure

This is a pnpm workspace managed by Turborepo.

```
apps/
  api/            # HTTP API server
  web/            # Web dashboard
  worker/         # Background job processor

packages/
  shared-types/   # TypeScript type definitions shared across all packages
  config/         # Environment config loading and validation
  core/           # Core utilities and shared logic
  db/             # Database client, migrations, and queries
  twin-model/     # Twin profile management and preference learning
  decision-engine/# Event interpretation and action selection
  policy-engine/  # Safety constraints, trust tiers, spend limits
  ironclaw-adapter/ # HTTP adapter for IronClaw execution server
  execution-router/ # Adapter selection, fallback chains, and risk modifiers
  explanations/   # Human-readable explanation generation
  connectors/     # Gmail, Google Calendar, and mock connectors with OAuth token management
  evals/          # Evaluation harness for decision quality
```

Packages reference each other via `@skytwin/*` workspace imports. The `shared-types` package is the dependency root -- everything else builds on its type definitions.

## Documentation

Detailed documentation lives in [docs/](./docs/):

- [Product Specification](./docs/product-spec.md) — vision, target user, operating principles
- [Technical Specification](./docs/technical-spec.md) — architecture, data flow, API endpoints
- [Safety Model](./docs/safety-model.md) — threat model, trust tiers, defense layers
- [Decision Engine](./docs/decision-engine.md) — how situations are interpreted and actions selected
- [IronClaw Integration](./docs/ironclaw-integration.md) — execution adapter, contracts, failure handling
- [CockroachDB Architecture](./docs/cockroach-architecture.md) — schema design, query patterns, versioning
- [Evals](./docs/evals.md) — evaluation harness, scenarios, metrics

## License

Proprietary. All rights reserved.
