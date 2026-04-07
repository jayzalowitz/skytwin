<p align="center">
  <h1 align="center">SkyTwin</h1>
  <p align="center">
    <strong>A digital twin that learns what you'd want — and does it.</strong>
  </p>
  <p align="center">
    <a href="https://github.com/jayzalowitz/skytwin/actions/workflows/build.yml"><img src="https://github.com/jayzalowitz/skytwin/actions/workflows/build.yml/badge.svg" alt="Build"></a>
    <a href="https://github.com/jayzalowitz/skytwin/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
    <img src="https://img.shields.io/badge/version-0.3.2-green.svg" alt="Version">
    <img src="https://img.shields.io/badge/tests-589%20passing-brightgreen.svg" alt="Tests">
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20iOS%20%7C%20Android-lightgrey.svg" alt="Platform">
  </p>
</p>

---

Every personal assistant today has amnesia. You tell it you prefer aisle seats three times. It asks again. You archive the same newsletter every morning. It keeps notifying you. Every interaction starts from scratch.

SkyTwin is different. It builds a structured model of your preferences, risk tolerances, and decision patterns — a **digital twin** — then uses that model to act on your behalf. When it's confident, it just handles things. When it's not, it asks the right question instead of the wrong one.

**The core principle: ask the twin before asking the user.**

## How It Works

```
  Gmail, Calendar, etc.
         │
         ▼
  ┌──────────────┐
  │   Connectors  │  Ingest signals from your accounts
  └──────┬───────┘
         ▼
  ┌──────────────┐
  │   Decision    │  "What's happening? What would
  │   Engine      │   the user want here?"
  └──────┬───────┘
         ▼
  ┌──────────────┐
  │  Twin Model   │  Your preferences, patterns,
  │  + MemPalace  │  and episodic memory
  └──────┬───────┘
         ▼
  ┌──────────────┐
  │   Policy      │  Spend limits, trust tiers,
  │   Engine      │  safety constraints
  └──────┬───────┘
         ▼
    ┌────┴────┐
    ▼         ▼
 Auto-     Escalate
 execute   with context
    │         │
    ▼         ▼
 Explain   You decide
    │         │
    └────┬────┘
         ▼
  ┌──────────────┐
  │  Feedback     │  Your response trains the twin
  │  Loop         │  to be better next time
  └──────────────┘
```

Every path produces an explanation. Every outcome feeds back into the twin. The system gets better at predicting what you want over time.

## Concrete Examples

| Scenario | What SkyTwin Does |
|----------|-------------------|
| **Newsletter arrives** | Your twin knows you archive these without reading. Auto-archived. Explanation logged. You never see it. |
| **Calendar conflict** | You always prioritize skip-level 1:1s over standups. Standup rescheduled with a note to the organizer. |
| **Subscription renewal** | $15.99/mo streaming service, used 3x this month, 18 months of renewals. Auto-renewed within your spend norms. |
| **Grocery reorder** | Repeats your last order with your substitution rules. Flags the one item that jumped 15% in price. |
| **Flight booking** | Finds the United aisle seat, morning departure, direct, $380. At high trust: books it. At low trust: presents top 3 options. |
| **Unknown sender email** | Low confidence. Escalates with a one-line summary so you can decide in 5 seconds instead of 5 minutes. |

## What Makes This Different

**It's not a chatbot.** SkyTwin is operational, not conversational. It doesn't wait for you to type a prompt — it watches your connected accounts and acts when opportunities arise.

**It earns trust incrementally.** New users start at `observer` — the system only suggests. As you approve and correct, it earns autonomy domain by domain. Trust in email triage doesn't mean trust with your calendar.

**Safety constraints are the product.** Every action passes through a policy engine with hard spend limits, trust tier gating, reversibility checks, and sensitivity classification. The system can be inspected, overridden, narrowed, and shut off at any time. [Read the full safety model →](./docs/safety-model.md)

**Every action is explainable.** No black boxes. Every automated decision produces an explanation record: what happened, what evidence was used, what preferences were invoked, why this action over alternatives, and how to correct it.

**Your twin is inspectable.** It's not a vector embedding or a bag of keywords. It's a typed, versioned data structure where every preference has a confidence level, supporting evidence, and provenance. Contradictions are tracked, not hidden.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 9
- [Docker](https://www.docker.com/) (for CockroachDB)

### Setup

```bash
git clone https://github.com/jayzalowitz/skytwin.git && cd skytwin
pnpm install

# Start the database
docker-compose up -d cockroachdb

# Configure
cp .env.example .env   # edit with your values

# Migrate and seed
pnpm db:migrate
pnpm db:seed

# Build and run
pnpm build
pnpm dev
```

The API starts on `localhost:3100`, the web dashboard on `localhost:3200`.

### Running Tests

```bash
pnpm test   # 589 tests across 50+ files
```

## Architecture

SkyTwin is a TypeScript monorepo (pnpm + Turborepo) with 12 packages and 5 apps:

```
apps/
  api/              HTTP API — decisions, user management, webhooks
  web/              Dashboard — review decisions, manage preferences, configure policies
  worker/           Background jobs — async execution, feedback processing
  desktop/          Electron app — macOS (.dmg), Windows (.exe), Linux (.AppImage)
  mobile/           React Native (Expo) — QR pairing, push notifications, SSE streaming

packages/
  shared-types/     TypeScript interfaces — the dependency root for everything
  config/           Env var loading and validation
  core/             Retry logic, circuit breaker, error types, logging
  db/               CockroachDB client, migrations, repositories
  twin-model/       Twin profile CRUD, preference learning, confidence scoring
  decision-engine/  Event interpretation, candidate generation, action selection
  policy-engine/    Trust tiers, spend limits, domain policies, safety checks
  ironclaw-adapter/ Execution adapter with HMAC auth, retries, circuit breaker
  execution-router/ Adapter selection, fallback chains, risk modifiers
  explanations/     Human-readable explanation generation
  connectors/       Gmail, Calendar, and mock connectors with OAuth management
  mempalace/        Episodic memory, knowledge graph, 4-layer retrieval stack
  evals/            Decision quality evaluation and regression testing
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict, ES2022) |
| Database | CockroachDB (PostgreSQL wire protocol) |
| Runtime | Node.js >= 20 |
| Package Manager | pnpm with workspaces |
| Build | Turborepo |
| Desktop | Electron + electron-builder |
| Mobile | React Native + Expo |
| Testing | Vitest (589 tests) |
| CI/CD | GitHub Actions |
| Execution | [IronClaw](https://github.com/nearai/ironclaw/) |

## Trust Tiers

SkyTwin uses a progressive trust model. Autonomy is earned, not assumed.

| Tier | What It Means |
|------|---------------|
| `observer` | System watches and suggests. Never acts. Default for new users. |
| `suggest` | Drafts actions for your review. You approve or edit before anything happens. |
| `low_autonomy` | Auto-executes low-risk, reversible actions in trusted domains. Escalates everything else. |
| `moderate_autonomy` | Handles most routine decisions. Escalates novel situations and high-cost actions. |
| `high_autonomy` | Acts on your behalf across domains. Still respects hard limits and irreversibility checks. |

Trust is **domain-specific**. You might be at `moderate_autonomy` for email but `suggest` for calendar. A bad decision in one domain can reduce trust in that domain without affecting others.

## Documentation

| Document | What's Inside |
|----------|---------------|
| [Product Spec](./docs/product-spec.md) | Vision, target user, operating principles, example workflows |
| [Technical Spec](./docs/technical-spec.md) | Architecture, data flow, API endpoints, database schema |
| [Safety Model](./docs/safety-model.md) | Threat model, trust tiers, defense layers, safety philosophy |
| [Decision Engine](./docs/decision-engine.md) | Situation interpretation, risk assessment, confidence scoring |
| [IronClaw Integration](./docs/ironclaw-integration.md) | Execution adapter, HMAC auth, failure handling |
| [CockroachDB Architecture](./docs/cockroach-architecture.md) | Schema design (18+ tables), query patterns, versioning |
| [Evals](./docs/evals.md) | Evaluation harness, scenario simulation, calibration metrics |

## Project Status

SkyTwin is in **active development** (v0.3.2). The core decision pipeline, twin model, policy engine, and memory palace are functional. Gmail and Google Calendar connectors work with real OAuth. Desktop builds ship for all three platforms. The mobile app pairs via QR code.

**What works today:**
- Full decision pipeline: signal → interpret → decide → policy check → execute/escalate → explain → learn
- Twin model with versioned profiles, confidence scoring, and preference learning
- Policy engine with spend limits, trust tiers, and domain-specific rules
- Memory Palace with episodic memory, knowledge graph, and 4-layer retrieval
- Web dashboard for reviewing decisions, managing preferences, and auditing
- Desktop app (macOS, Windows, Linux) and mobile app (iOS, Android)
- 589 tests with CI/CD on GitHub Actions

**What's next:**
- More connectors (Slack, Notion, bank feeds)
- Hosted version with multi-tenant support
- Plugin system for custom domains
- Improved preference learning from implicit signals

## Contributing

We welcome contributions. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on getting started, running tests, and submitting pull requests.

## License

[Apache License 2.0](./LICENSE) — use it, modify it, build on it.
