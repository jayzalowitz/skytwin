# SkyTwin Architecture Philosophy

> Three ports, four layers, one twin.

SkyTwin commits to **no proprietary protocol, no proprietary judgment, no proprietary memory**. Every load-bearing dependency is a swappable port. The system is positioned to *receive* improvements from the open ecosystem rather than chase them.

## The three ports

| Port | What it abstracts | Default impl | Future swaps |
|---|---|---|---|
| **MCP** | Capabilities (tools, signal sources) | `@modelcontextprotocol/server-*` community servers | Any MCP-compatible server, including ones the user authors |
| **Prompts** | Judgment (ranking, classification, dialogue, copy) | `@skytwin/policy-prompts` versioned prompts | User overrides, A/B variants, community PRs, future prompt formats |
| **Memory** | Knowledge of the user | `@skytwin/memory-mempalace` wrapping `@skytwin/mempalace` | gbrain (interim), next-generation memory engines as they land, anything that implements the port |

Each port corresponds to a piece of SkyTwin that the open ecosystem will rebuild faster than we can. Owning any of them is a liability on a six-month timeline.

## The four layers

```
┌────────────────────────────────────────────────┐
│ HARD RAILS — deterministic for SAFETY          │
│ FS denylist, resource caps, spend ceilings,    │
│ audit integrity, MCP protocol, auth, schema    │
└────────────────────────────────────────────────┘
┌────────────────────────────────────────────────┐
│ BORING DETERMINISTIC — deterministic for       │
│ QUALITY (LLM would do worse)                   │
│ DB queries, JSON parsing, arithmetic, schema   │
│ validation, version comparison, file format    │
│ extraction, capability lookup by name          │
└────────────────────────────────────────────────┘
┌────────────────────────────────────────────────┐
│ ADAPTIVE — prompt-driven, scales with models   │
│ Service detection, ranking, dialogue, copy,    │
│ judgment, classification, recipe selection,    │
│ OAuth recovery, dormancy detection,            │
│ promotion judgment                             │
└────────────────────────────────────────────────┘
┌────────────────────────────────────────────────┐
│ MEMORY (backend-defined via memory port)       │
└────────────────────────────────────────────────┘
```

## The rule

> **LLM for judgment, code for facts, ports for everything else.**

A wrong judgment hurts user experience (recoverable). A wrong fact corrupts state (sometimes irreversible). A wrong abstraction hurts maintenance for years (compounds). Each layer is sized for its failure mode.

## Why this matters for OSS launch

The agent ecosystem in 2026 is moving fast. Three things are mutating monthly:

1. **Tool ecosystems** — MCP servers, A2A protocols, agent frameworks
2. **Models** — every provider ships a better model every quarter; the small-local space is moving even faster
3. **Memory architectures** — MemPalace, gbrain, vector stores, graph stores, hybrid systems, and the next-generation engines landing in 2026

A digital twin built without ports against any of these will need a rewrite when its choice ages. SkyTwin's architecture means *every* mutation in the ecosystem is additive — a new MCP server, a new model, a new memory backend, all arrive as configuration, not deploys.

## Risk profile

The user states their risk tolerance in **free-form natural language**, e.g.:

```
"I'm a developer. Skip the explainers. Spend up to $50 without
asking. Send emails on my behalf when you're confident in tone —
I'll fix anything weird later. Touch nothing financial without
me approving each move."
```

The risk profile is read by every adaptive-layer prompt as context, alongside MemPalace facts. It evolves with the user (when life circumstances change, the twin notices and asks if the profile should update).

**Hard rails are never subject to the risk profile.** Even on maximum boldness, FS denylist applies, resource caps apply, user's absolute spend ceiling applies, irreversible-and-large still escalates. The dial moves behavior *within* the safety envelope, not the envelope itself.

## Quality discipline

The adaptive layer has cost and latency. To prevent LLM-everything drift:

1. **Every adaptive feature has a daily token budget per user.** Exceeded = degrade, don't keep spending.
2. **Every prompt has a latency target.** Cached responses preferred; cache by (input hash, prompt version, model version).
3. **Boring deterministic stays deterministic.** "What's the install URL for Notion?" is a DB query, not an LLM call.
4. **Hot paths never call LLM.** Adaptive layer runs on event-driven or scheduled triggers, not on user-blocking requests.
5. **Provenance for every adaptive decision.** Every prompt invocation logged with inputs and outputs in the provenance graph (see Issue #184).

## What never moves (the hard-rails inventory)

These are non-negotiable, deterministic, and only change via deploy:

- FS denylist (compile-time constant): `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `*.pem`, `*.key`, `id_rsa*`, `credentials`, `.env*`, browser cookie/session stores, password manager dirs, OS-protected paths
- Resource governor: CPU < 2% avg, memory < 64MB scan, IO < 1GB/day default, yields within 200ms of user input, pauses on battery < 20% AC-unplugged, pauses on thermal `serious`/`critical`
- User-set absolute spend ceilings (per-action, daily, monthly)
- Audit log integrity: every action recorded immutably, audit table append-only, never hidden from user
- MCP protocol conformance: stdio + http/sse transports per spec; tool call schemas validated; security model enforced
- Authentication and OAuth token storage: envelope-encrypted at rest, never logged in plaintext
- Database schema migrations: only via deploy with explicit migration file

Any future change here is a deliberate engineering decision, not a runtime option.

## What does move (the adaptive-layer inventory)

These get better automatically when the underlying model improves, or when prompt PRs land in `@skytwin/policy-prompts`:

- Service detection from user signals (which tools the user uses)
- Capability ranking and recipe recommendation
- Onboarding dialogue
- Trust tier promotion judgment (prompt-judged, not threshold-counted)
- Self-portrait generation
- User-facing copy rewriting (`humanize()` over all UX text)
- OAuth failure recovery (LLM diagnoses + proposes fix from server's published auth metadata)
- Lifebook domain extraction (emergent wings per user)
- Briefing prose
- Reverse capability flow intent classification
- Capability dormancy judgment
- Provenance lineage explanation prose
- Risk profile interpretation (parse the user's free-form text into the structured caps adaptive prompts can act on)

Adding a new judgment doesn't require code. It requires a prompt PR.

## How this composes

The three ports + four layers compose into the OSS-launch identity:

```
USER → conversational onboarding (adaptive)
     → risk profile (memory)
     → capability suggestions (adaptive over MCP discovery)
     → install flow (boring deterministic over MCP host)
     → trust-tier promotion (adaptive judgment + ceremony)
     → autonomous action (MCP execution + hard-rails enforcement + audit)
     → provenance (memory + adaptive prose explanation)
     → feedback loop (memory write + adaptive re-judgment)
```

No hand-curated catalog. No hardcoded rules. No fixed memory schema. Every layer is positioned to improve when the open ecosystem improves.

## What this is not

This isn't framework-fundamentalism. The architecture has clear hard rails because some things should never be probabilistic. It isn't LLM-maximalism either — boring deterministic code does most of the work in any given operation. The LLM is invoked only where its specific strength (judgment under context) outperforms code's specific strength (deterministic facts).

It also isn't backend-agnostic in some absolute sense. Every port has a *first* implementation that proves the contract. The first MCP host implementation is `@skytwin/mcp-host`. The first memory port implementation is `@skytwin/memory-mempalace`. The first prompts package is `@skytwin/policy-prompts`. New implementations are welcome but not required.

## Related

- Epic #195 (Capability Acquisition Loop) — the OSS-launch instantiation of these principles
- Issue #187 — `@skytwin/policy-prompts` package
- Issue #191 — `@skytwin/memory-port` interface
- `docs/safety-model.md` — extended model for hard rails specifically
- `docs/capabilities-architecture.md` — engineer-facing details on each port
