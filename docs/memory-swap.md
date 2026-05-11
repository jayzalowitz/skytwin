# Memory backends — gbrain (default) + mempalace + hybrid

SkyTwin's memory layer is a swappable port. The `MemoryPort` contract
([`packages/memory-port/src/port.ts`](../packages/memory-port/src/port.ts))
defines the operations that consumers (`apps/api`, `apps/worker`,
`@skytwin/decision-engine`, `@skytwin/assistant`) depend on. Concrete
implementations register against that port; the system reads
`MEMORY_BACKEND` (or per-user `brain_settings.backend`) to pick one at
runtime.

This document is a developer-facing runbook. Read
[`docs/architecture-philosophy.md`](./architecture-philosophy.md) for the
"why" of memory-as-port.

## TL;DR

- **Default backend:** `gbrain` (in-process, CockroachDB-backed). Vector +
  tsvector + Reciprocal Rank Fusion, stored entirely in the brain_* tables
  the SkyTwin DB stack already manages.
- **Optional:** `hybrid` mode composes gbrain (primary) with a secondary
  backend — typically a mempalace adapter — to get the union of capabilities
  (semantic + spatial + AAAK compression).
- **Legacy / single-engine:** `mempalace`. Selectable for users who prefer
  the original spatial system; declares no semantic_search capability so
  most retrieval falls back to keyword search.

## Backends at a glance

| backend     | semantic_search | code_aware_search | episodic | graph_walk | temporal_triples | spatial_wings | aaak_compression |
|-------------|:---------------:|:-----------------:|:--------:|:----------:|:----------------:|:-------------:|:----------------:|
| `gbrain`    |        ✓        |         ✓         |    ✓     |     ✓      |        ✓         |               |                  |
| `hybrid`    |        ✓        |         ✓         |    ✓     |     ✓      |        ✓         |       ✓       |        ✓         |
| `mempalace` |       ILIKE     |                   |    ✓     |     ✓      |        ✓         |       ✓       |        ✓         |

Hybrid is the union; gbrain on its own covers the operations most consumers
care about.

`mempalace` declares `semantic_search` capability but its underlying search
is keyword `ILIKE` over drawer content — useful for exact-token queries,
not for paraphrase-tolerant retrieval. Use `gbrain` or `hybrid` for the
production retrieval experience; `mempalace`-only is for users who
explicitly want the legacy stack.

## Selecting a backend

### Per-installation default

Set the `MEMORY_BACKEND` env var on the API (and worker, when applicable):

```bash
MEMORY_BACKEND=gbrain     # default — in-process embedded gbrain
MEMORY_BACKEND=hybrid     # gbrain (primary) + mempalace (secondary)
MEMORY_BACKEND=mempalace  # legacy single-engine
```

If the var is unset or invalid, `gbrain` is used.

### Per-user override

A user with `brain_settings.backend = 'hybrid'` always gets hybrid even if
the env default is `gbrain`. The user-facing path is **Settings → Memory
backend** (`/memory-settings` in the dashboard); the API endpoints are:

```
GET    /api/memory-config?userId=<uuid>            # current backend + counters
POST   /api/memory-config?userId=<uuid>            # body: { backend: '…' }
POST   /api/memory-config/dismiss-notification     # mark first-run notice seen
GET    /api/memory-config/diagnostics?userId=<uuid># hybrid mode counters
```

## How gbrain works (CockroachDB-backed)

`@skytwin/memory-gbrain` ships an `EmbeddedGbrainMemoryPort` that talks to
the `brain_*` tables defined in
[`packages/db/src/migrations/040-gbrain-memory.sql`](../packages/db/src/migrations/040-gbrain-memory.sql).
There is no separate Postgres process — gbrain runs against the SkyTwin
CRDB stack directly.

The retrieval engine is hybrid: every page gets both an embedding (FLOAT8[])
and a tsvector. A query produces a query embedding plus a `plainto_tsquery`,
two ranked lists are fetched in parallel, then folded via Reciprocal Rank
Fusion (`rrfFold`) with the standard k=60 constant.

```
                ┌─────────────┐
        query ──►   embed     ├──┐
                └─────────────┘  │
                                 │
       ┌─────────────────────────▼─────────────┐
       │     parallel CRDB queries             │
       │  ┌──────────────┐ ┌──────────────┐    │
       │  │ vectorSearch │ │  textSearch  │    │
       │  │ (FLOAT8[]    │ │ (tsvector,   │    │
       │  │  cosine)     │ │  ts_rank_cd) │    │
       │  └──────┬───────┘ └──────┬───────┘    │
       └─────────┼─────────────────┼───────────┘
                 │                 │
                 ▼                 ▼
              vector ranks    text ranks
                 │                 │
                 └──────► RRF ◄────┘
                           │
                           ▼
                     top-K SemanticHits
```

### Embedding providers

`EmbeddedGbrainMemoryPort` reads embeddings from any class that implements
`EmbeddingProvider`. Two providers ship in `@skytwin/memory-gbrain`:

- **`HashEmbeddingProvider`** — deterministic, dependency-free, hash-trick
  embedding (`hash-fnv1a-v1`, default 384-dim). Quality is modest but the
  system always boots with no config. Used by tests and by zero-config dev.
- **`OpenAiEmbeddingProvider`** — POSTs to any OpenAI-compatible
  `/v1/embeddings` endpoint. Configurable via env:
  - `OPENAI_EMBEDDING_API_KEY` (or fall through to `OPENAI_API_KEY`)
  - `OPENAI_EMBEDDING_BASE_URL` (e.g. for Ollama or llamafile)
  - `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`)

The `apps/api` factory (`apps/api/src/memory-setup.ts:getEmbeddingProvider`)
picks OpenAI if a key is present, otherwise hash. Custom providers can be
plugged in by importing the port directly.

#### Recipe: 100% local embeddings via Ollama

Ollama exposes an OpenAI-compatible `/v1/embeddings` endpoint, so you can
run real embeddings without any cloud round-trip or API key:

```bash
# 1. Install Ollama (https://ollama.com) and pull an embedding model.
#    nomic-embed-text is 768-dim, 274 MB, fast, and good enough for
#    personal-twin-scale corpora.
ollama pull nomic-embed-text

# 2. Confirm the embeddings endpoint works.
curl -s http://localhost:11434/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"nomic-embed-text","input":"hello world"}' | jq '.data[0].embedding | length'
# → 768

# 3. Configure SkyTwin to use it.
export OPENAI_EMBEDDING_API_KEY=ollama        # any non-empty string — Ollama ignores it
export OPENAI_EMBEDDING_BASE_URL=http://localhost:11434/v1
export OPENAI_EMBEDDING_MODEL=nomic-embed-text
```

The `EmbeddingProvider`'s `dim` defaults to 1536 (OpenAI's
`text-embedding-3-small`) — for Ollama models you may want to pin it via
the constructor if you're building a custom provider. The
`@skytwin/memory-gbrain-crdb-adapter`'s `vectorSearch` skips rows whose
embedding length doesn't match the query, so model swaps degrade
gracefully (mixed-dim corpus → only same-dim rows contribute to vector
RRF) rather than crashing.

Other Ollama embedding models that work the same way: `mxbai-embed-large`
(1024-dim, ~334 MB), `snowflake-arctic-embed` (1024-dim, ~669 MB),
`all-minilm` (384-dim, ~46 MB, smallest).

For llamafile, vLLM, LocalAI, or any other OpenAI-compatible server —
same `OPENAI_EMBEDDING_BASE_URL` knob, point it at the server's port.

### Embedding job queue

`recordSignal` / `recordEntity` / `recordEpisode` synchronously embed in
the request path when a provider is fast (hash); when an external provider
is configured, embedding is allowed to fail at write time and gets retried
asynchronously. The `brain_embedding_jobs` table is a CRDB-native job queue
with `SELECT FOR UPDATE SKIP LOCKED` lease semantics — workers that drain
it can scale horizontally.

## How hybrid mode works

`@skytwin/memory-hybrid` composes any two `MemoryPort` impls.

- **Reads route per-capability.** Each method has a default routing rule
  (see `defaultRoutingRules()` in `apps/api/src/memory-setup.ts`); when the
  rule says "primary" but the primary lacks the relevant capability, the
  composer falls through to the secondary instead of returning empty.
- **Writes go to BOTH backends.** The primary write must succeed; the
  secondary is best-effort (failures logged, never propagated). Counters in
  `HybridMemoryPort.getDiagnostics()` track ok/fail per side.
- **`exportAll`/`importAll` route to the secondary** so migrations
  preserve the full mempalace surface.

The default routing in SkyTwin is:

```ts
{
  searchSemantic:    'primary',   // gbrain — vector + tsvector RRF
  code_aware_search: 'primary',   // gbrain — boost on source='code'
  walkGraph:         'primary',   // gbrain — BFS over brain_triples
  getEpisodes:       'primary',   // gbrain — brain_episodes
  getTriples:        'primary',   // gbrain — brain_triples
  summarize:         'secondary', // mempalace — AAAK compression
  compress:          'secondary', // mempalace — AAAK compression
}
```

## Migrating data between backends

`MemoryPort.exportAll()` produces a stream of `MemoryRecord` values
(signals, entities, triples, episodes); `importAll()` consumes the stream.
Both methods are idempotent — duplicates are counted and skipped, not
errored. To re-ingest mempalace data into gbrain:

```ts
import { getMemoryPortForUser } from '@skytwin/api/memory-setup';

const fromMem = await getMemoryPortForUser(userId, /* override */ 'mempalace');
const toGbrain = await getMemoryPortForUser(userId, /* override */ 'gbrain');
const summary = await toGbrain.port.importAll(fromMem.port.exportAll());
console.log(`imported ${summary.imported}, skipped ${summary.skipped}`);
```

(The `apps/api` `getMemoryPortForUser` doesn't take an override yet —
follow-up: extract a pure factory.)

## Verifying the CRDB SQL paths

The `@skytwin/memory-gbrain-crdb-adapter` package has 6 DB-gated integration
tests covering `insertPage` + `hybridSearch`, entity/triple round-trip,
episode persistence, the embedding job queue lifecycle, settings round-trip,
and `countPages`. They're skipped by default (no live DB) and gated on
`RUN_DB_TESTS=1`.

To exercise them against a hermetic local CRDB:

```bash
# From the repo root. Requires Docker + psql client.
pnpm --filter @skytwin/memory-gbrain-crdb-adapter test:crdb
```

The script (`packages/memory-gbrain-crdb-adapter/scripts/run-crdb-integration.sh`):

1. Spins up `cockroachdb/cockroach:latest-v23.2` on a non-default port
   (26259, so it doesn't collide with a dev cluster).
2. Creates a `skytwin_test` database + a minimal `users` table for the FK.
3. Applies `040-gbrain-memory.sql`.
4. Seeds one test user.
5. Runs the integration suite with `RUN_DB_TESTS=1` and the right `DATABASE_*`
   env vars.
6. Tears the container down on exit (trap).

CI doesn't run this — it requires Docker + a clean port. Useful before merge
of any change to `repository.ts` or migration 040.

## Operational knobs

| Env var                     | Effect                                                  |
|-----------------------------|---------------------------------------------------------|
| `MEMORY_BACKEND`            | `gbrain` (default) \| `hybrid` \| `mempalace`           |
| `OPENAI_EMBEDDING_API_KEY`  | Switches embeddings to OpenAI-compatible HTTP           |
| `OPENAI_EMBEDDING_BASE_URL` | Custom URL (e.g. `http://localhost:11434/v1`)           |
| `OPENAI_EMBEDDING_MODEL`    | Override model name (default `text-embedding-3-small`)  |
| `GBRAIN_PERF`               | Set to `1` to opt into the perf benchmark in tests      |

## Rollback

If gbrain misbehaves, set `MEMORY_BACKEND=mempalace` (or per-user via the
settings page) and the system reverts to the legacy backend without any
code changes. `brain_*` tables stay intact and can be re-enabled when the
issue is resolved. The `/api/mempalace` REST surface continues to work
regardless of backend selection — it queries memory_* tables directly,
not via `MemoryPort`.

## Why not run gbrain externally?

Issue #197 originally targeted the upstream `gbrain` CLI. We ship an
in-process embedded port instead because:

1. **No second Postgres.** Upstream gbrain defaults to PGLite or Supabase.
   Running PGLite alongside CRDB means two databases per install — a
   nontrivial operational burden. The CRDB adapter (in this repo) lets
   gbrain run against the database SkyTwin already has.
2. **No second install step.** Users don't need to `brew install gbrain`
   or `npm install -g gbrain` — the backend is a pnpm dep.
3. **Same retrieval primitives.** RRF over vector + tsvector is well-defined
   without depending on upstream gbrain's specific implementation.

The CLI shell-out path is still available (`@skytwin/memory-gbrain`'s
`GbrainMemoryPort`) for users who already run gbrain externally and want to
consume their existing brain via a thin wrapper. The dashboard surfaces
"Your existing gbrain detected" prompts (via
`hasExternalGbrainConfig()`) when `~/.config/gbrain/` is present.

## References

- [#138](https://github.com/anthropics/skytwin/issues/138) — Replace
  `@skytwin/mempalace` with GBrain (epic).
- [#196](https://github.com/anthropics/skytwin/issues/196) — `@skytwin/memory-port` interface (shipped).
- [#197](https://github.com/anthropics/skytwin/issues/197) — `@skytwin/memory-gbrain` + hybrid composer + CRDB adapter (this).
- [`packages/memory-gbrain-crdb-adapter/src/repository.ts`](../packages/memory-gbrain-crdb-adapter/src/repository.ts) — RRF + vector + tsvector query layer.
- [`packages/memory-hybrid/src/hybrid-port.ts`](../packages/memory-hybrid/src/hybrid-port.ts) — composer + diagnostics.
- [`apps/api/src/memory-setup.ts`](../apps/api/src/memory-setup.ts) — backend factory, embedding provider selection.
