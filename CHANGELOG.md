All notable changes to SkyTwin will be documented in this file.

## [unreleased] — Capabilities: filter the registry by Lifebook (#193 follow-up)

### Fixed (post-Copilot review)

- Lifebook visibility filter now uses the correct API field
  (`hidden: boolean`) instead of the nonexistent `hiddenAt`. The
  previous filter was a no-op AND would have fail-opened if the
  endpoint ever returned hidden rows. The server-side `listVisible`
  call still does the real filtering; the client-side guard is
  defense in depth.
- Removed `data-action` from the category and Lifebook `<select>`
  elements. Each had an explicit `change` listener too, so the
  global click delegator double-fired `renderRegistryResults` on
  every dropdown-open. The change listener is now the sole entry
  point. Dead switch cases (`registry-filter-change`,
  `registry-category-change`) deleted.
- `applyLifebookFilter()` is now actually pure — lifebooks is the
  third argument with a default that pulls from cache only at the
  call site. The docstring's "pure function" claim no longer
  requires monkeypatching `_cachedLifebooks` to be true.

### Original change

Closes the "capability filter by domain on Capabilities page" item that
PR #242 (#193 Child 1) explicitly deferred. The Capabilities page now
carries a Lifebook dropdown alongside the existing category dropdown;
selecting a Lifebook intersects the registry results with that
Lifebook's `suggestedCapabilities: registryId[]` set so users browsing
for a specific life domain see only the capabilities the domain
extractor actually proposed for it.

**No DB migration required.** The filter is purely client-side: the
intersection set already lives on `lifebooks.suggested_capabilities`
(populated by the domain-extraction worker that landed in #242). The
capabilities page now fetches `/api/lifebooks/:userId` alongside its
existing data and runs the intersect in `applyLifebookFilter()` — a
pure helper that's trivial to lift to a vitest harness if/when one
lands in `apps/web`.

UX details:

- Dropdown shows visible (non-hidden) Lifebooks only. Hidden Lifebooks
  stay in memory but disappear from this dropdown, matching the
  "hidden surfaces stay queryable in memory; surface visibility is the
  user's call" contract Lifebooks already follow.
- When the user has zero Lifebooks (domain extractor hasn't run, or
  everything is hidden), the dropdown is omitted entirely — an empty
  selector with no options would just confuse.
- Empty-result state when a Lifebook filter narrows everything away
  surfaces the active Lifebook name in the empty-state copy ("No
  results found for the 'Health' Lifebook.") so the user can
  immediately tell *why* nothing's showing.
- A Lifebook with an empty `suggestedCapabilities: []` array means the
  extractor proposed nothing yet — the filter shows everything rather
  than collapsing to zero results, on the principle that "extractor
  hasn't decided" should not look the same as "extractor decided
  nothing matches."

Internal cleanup that fell out of the change:

- Three `renderRegistryResults(userId, q, category)` call sites
  collapsed to `renderRegistryResults(userId, readRegistryFilterState())`
  via a new pure `readRegistryFilterState()` helper. Adding the
  Lifebook filter without this would have meant editing five separate
  call sites. The next filter that lands gets to add itself in two
  places: the dropdown markup and the state reader.

Test plan: smoke-tested in Chrome with mocked Lifebook + registry data
— filter toggles correctly across three scenarios (all-Lifebooks, one
specific Lifebook, switch back to all). `node --check` clean.

## [unreleased] — Smart / Smarter mode toggle + zero-cost helper (#187 AC#6 + AC#8)

### Fixed (post-Copilot review)

- Cost rate table was off by 100× — the original draft stored
  `{ input: 8, output: 40 }` for Anthropic and called it "deci-cents
  per 1M" when the conversion is actually `$0.80 → 80¢ → 800
  deci-cents`. The table now stores `{ input: 800, output: 4000 }`
  for Anthropic and the corresponding corrected values for OpenAI and
  Google. The unit tests now pin the expected dollar-equivalent
  outputs ($4.80 for 1M+1M Anthropic, $0.60 for 1M output OpenAI,
  $0.30 for 1M output Google) so the unit conversion can't silently
  regress again. Embedded + Ollama still return 0¢ at any volume.
- `PUT /api/settings/:userId/ai` now accepts `embedded` as a valid
  provider. The Smart mode toggle inserts an `embedded` entry; the
  pre-existing validation set only allowed `anthropic` / `openai`
  / `google` / `ollama`, so clicking "Use Smart mode" round-tripped
  through `applySmartMode` and then 400'd at the API.
- `switchAIBrainMode` rolls back the optimistic UI state on save
  failure. Previously the pill + provider chain stayed in the
  reordered state with only an error banner — visually implying the
  switch succeeded when the server actually rejected it.
- "Smarter" pill copy now says "paid API or Ollama" — the
  `SMARTER_PROVIDERS` set includes Ollama (local, free) and the
  earlier copy would have confused users running Ollama into thinking
  the option didn't apply to them.

### Original change

Two pieces close out the user-visible side of the embedded LLM story:

- **AC#6 — Smart / Smarter mode toggle in the AI brain card.** A two-pill
  row at the top of Settings → AI brain shows the user which mode is
  active (computed from their provider chain: top-priority enabled =
  `embedded` → Smart; hosted / Ollama → Smarter; nothing enabled →
  none). Clicking the inactive pill reorders priorities and auto-saves
  through the existing `PUT /api/settings/:userId/ai` round-trip.
  Switching to Smart adds an `embedded` entry with `model: 'auto'` if
  the chain doesn't have one yet — first-time-Smart users get a working
  configuration in one click. Switching to Smarter when no paid
  provider exists routes to a `switch-to-smarter-blocked` action that
  focuses the "+ Add a provider…" dropdown so the user's eye is drawn
  to the next step instead of failing silently.

  Pure helpers (`detectAIMode`, `applySmartMode`, `applySmarterMode`)
  factored out at the top of `apps/web/public/js/pages/settings.js`
  with module exports so the mode pill, the action handler, and any
  future audit route all agree on one definition. 16 cases smoke-tested
  via Node ESM import; toggle visually verified in Chrome across three
  scenarios (Smart-active, Smarter-active, no-paid-provider).

- **AC#8 — `estimateLlmCostCents()` helper in `@skytwin/llm-client`.**
  Provider-keyed rate table (Anthropic / OpenAI / Google list-price
  cheapest model) plus an absolute zero for `embedded` and `ollama`.
  Rounds up to the nearest cent everywhere so spend-cap enforcement
  stays conservative — the failure direction is "approval required,"
  never "silently exceeded the cap." Exposed as
  `estimateLlmCostCents(provider, tokensIn, tokensOut)` and
  `isZeroCostProvider(provider)`. 10 unit tests; the load-bearing one
  asserts `embedded` and `ollama` return 0 regardless of token volume.
  The future spend-recording call site can compute
  `costCents = estimateLlmCostCents(response.provider, tokensIn,
  tokensOut)` and trust that local-runtime calls record zero — no
  embedded-special-case branch needed at the recording site.

## [unreleased] — Memory bootstrap: stamp every signal with an authoring tier (#251 Layer 1)

### Fixed (post-Copilot review)

- `listMessageIds()` no longer swallows all errors. Non-transient
  failures (persistent auth, 4xx other than 404, malformed account
  state) propagate so the worker surfaces "your Google connection has
  a problem" rather than silently bootstrapping zero signals forever.
  Only `RetryableHttpError` (rate-limit / 5xx after retries) still
  degrades to `[]` so one transient list failure doesn't take out the
  other batch.
- `AUTOMATED_DOMAIN_PATTERNS` doc comment now accurately describes
  the deliberate asymmetry: most entries are end-anchored at the
  apex domain (`$`), but `noreply\.` is intentionally NOT end-
  anchored so the `noreply.<vendor>.com` long tail is caught.

### Original change

The first slice of #251. Layer 1 only labels the data — no retrieval-side
weighting yet (that's Layer 2, gated on `realistic-retrieval.test.ts`
improving) — so this PR is reversible and observable on its own.

- **New: `AuthoringTier` enum + classifier in `@skytwin/connectors`.**
  Six tiers (`user_sent_originated`, `user_sent_reply`, `inbox_personal`,
  `inbox_broadcast`, `inbox_newsletter`, `inbox_automated`) capturing the
  asymmetry between mail the user authored vs. merely received. The field
  name is channel-agnostic on purpose (`authoringTier`, not
  `gmailLabel`/`senderTier`); Slack/Notion connectors can extend the enum
  later without rebuilding the memory schema.

- **Gmail connector fetches the headers needed to classify.** Added
  `To`, `Cc`, `In-Reply-To`, `List-Unsubscribe` to the
  `metadataHeaders=` URL on `messages/<id>?format=metadata`. One extra
  HTTP-header byte per message; the rest of the payload is unchanged.
  Every emitted `RawSignal` carries `data.authoringTier`.

- **Embedded gbrain port projects `authoringTier` onto
  `brain_pages.metadata`.** When a connector stamps the field, the page
  metadata gets `{ signalSource, signalType, authoringTier }`; when the
  field is missing or non-string the page metadata falls back to the
  previous two-key shape. No schema migration — `metadata` is JSONB.

- **Layer 3 minimal: sent-first bootstrap ordering.** The first poll
  for a new user now lists `in:sent newer_than:7d` BEFORE
  `is:unread newer_than:1d` and deduplicates by message id. The user's
  first brain pages lead with things they wrote, not the inbox noise that
  happens to be unread. Failure on either list query degrades gracefully
  to the other; both empty falls back to `/users/me/profile` for the
  cursor exactly as before.

Tests: 18 new unit tests for the classifier (`authoring-tier.test.ts`),
6 new tests for the Gmail signal pipeline (tier stamping for each of the
six tiers), 1 new test for sent-first bootstrap ordering, and 3 new tests
for the embedded-port metadata projection. Full workspace test run:
70 tasks, all green.

What this doesn't ship (deliberate, deferred to follow-ups):

- **Layer 2 retrieval weighting.** The RRF fold and `DecisionMaker`
  pattern boost still read `brain_pages` uniformly. Wiring those to the
  new tier requires re-running `realistic-retrieval.test.ts` with
  candidate weight schedules and accepting whichever schedule moves R@5
  up (or holds it constant) on the labeled corpus. That gate is the
  whole point of Layer 2 being a separate PR.
- **Migration backfilling tier on existing pages.** Tier is only stamped
  on signals written after this lands. A backfill migration is cheap to
  write (re-read the Gmail label + From header for stored signal rows)
  but is a separate concern from the live ingest path.


## [unreleased] — Embedded LLM downloader: round-3 review fixes (#187 AC#2 follow-up)

Copilot's third-round review of PR #247 landed after merge — four
substantive findings, addressed in a follow-up PR:

- **Multi-user partial-file collision**: two users on the same API
  host downloading the same model both wrote to
  `<modelDir>/<modelId>.gguf.partial`, so concurrent streams could
  corrupt each other and one user's cancel could delete the other's
  partial. The final GGUF is content-addressable (SHA-256 verified
  before rename), so we keep that shared at `<modelDir>/<modelId>.gguf`,
  but partials now namespace by download row id:
  `<modelDir>/<modelId>.gguf.<download.id>.partial`.

- **Pause-on-pending was a no-op**: `pauseDownload()` would set DB to
  `paused`, but the already-scheduled `runDownload()` invocation
  would start anyway and immediately overwrite back to `downloading`
  via `setStatus`. Same bug for pending→cancelled. Fixed by
  re-fetching the row at the top of `runDownload()` and bailing
  early if status changed to `paused`/`cancelled`/`complete`/`failed`
  between `startDownload()` returning and the runner picking up.

- **Polling continued after navigating away**: the 1s poll callback
  in `embedded-llm-card.js` had no termination condition tied to
  page navigation. A user who started a download and then went to
  Approvals would keep hitting `/api/embedded-llm/downloads/:id`
  every second and hold a reference to a detached
  `#embedded-llm-card-target` node. Now the poll callback checks
  `window.location.hash !== '#/settings'` and
  `document.getElementById(CARD_TARGET_ID) !== container` at the
  top and stops itself when either is true.

## [unreleased] — First-run dashboard "needs a brain" prompt (#187 follow-up)

A tiny but launch-critical UX gap: a brand-new user lands on the dashboard
with no AI provider configured and an empty state that offers no path
forward. They're left to discover Settings → AI brain on their own.

Closes the gap with a banner that surfaces only when (a) the dashboard
fetch promises resolved successfully (no false-positive on transient API
errors), (b) zero decisions exist yet, AND (c) zero AI providers are
enabled. The provider check matches the Settings UI's truthiness rule
(`p.enabled !== false`), so existing rows without an explicit `enabled`
field aren't misread as off.

Two CTAs: "Set up the local brain" (routes to Settings → Local AI brain
card from #187 AC#2) and "Or bring your own API key". Privacy framing
is per-option (not global): the local-first claim is scoped to the
local brain row; the API-key row clearly notes "each message goes to
that provider." Skipped in tour mode (seeded demo user has providers
pre-configured), so the demo experience stays clean.

Settings is fetched conditionally — only when the cheap prerequisites
(`!tourMode && recentDecisions.length === 0`) already point at first-run.
Once the user has any activity, no extra `/api/settings` round-trip per
SSE-driven dashboard re-render.

Implementation lives in `apps/web/public/js/pages/dashboard.js`. Reuses
the existing `GET /api/settings/:userId` endpoint via `fetchSettings` —
no new API. One new card, no other UI changes.

## [unreleased] — gbrain memory backend + CRDB adapter + hybrid composer (#197)

Closes the major remaining work on #197 by promoting `@skytwin/memory-gbrain`
from a CLI-shell-out skeleton (PR #215) to a real, in-process, CockroachDB-backed
memory layer. The default `MemoryPort` for new installs is now gbrain — vector
embeddings + tsvector full-text search, fused via Reciprocal Rank Fusion. No
separate Postgres process, no external CLI install — gbrain runs against the
SkyTwin DB stack directly.

### Why this matters

The mempalace search story today is `ILIKE %term%` over `memory_drawers.content`.
Works for hundreds of drawers per user; doesn't work at the size we want twins
to operate at. Gbrain's hybrid retrieval engine is what mempalace was a sketch
of: indexed semantic + keyword fusion that scales to tens of thousands of pages
per user with sub-100ms search latency on the in-process backend.

User direction was explicit: gbrain is the **default**, mempalace is the
**second option**, and everything must work against CRDB where possible. Done.

### Ships

- **`040-gbrain-memory.sql`** — new tables: `brain_pages` (FLOAT8[] embedding
  + TSVECTOR + INVERTED INDEX), `brain_entities`, `brain_triples`,
  `brain_episodes`, `brain_signals`, `brain_settings`, `brain_embedding_jobs`
  (durable queue with `SELECT FOR UPDATE SKIP LOCKED` lease semantics).
- **`@skytwin/memory-gbrain-crdb-adapter`** (NEW) — driver-level layer:
  - `repository.ts` — CRDB-backed CRUD + `hybridSearch` (parallel text + vector
    queries, application-side RRF fold).
  - `in-memory-repository.ts` — same surface, in-process; used by tests and
    hermetic boots.
  - `embedding.ts` — `EmbeddingProvider` interface + two impls:
    `HashEmbeddingProvider` (deterministic, hash-trick, zero-config) and
    `OpenAiEmbeddingProvider` (any OpenAI-compatible /v1/embeddings endpoint —
    works with Ollama, llamafile, vLLM).
  - `rrf.ts` — Reciprocal Rank Fusion fold (k=60 standard).
- **`@skytwin/memory-gbrain`** — promoted from skeleton:
  - `EmbeddedGbrainMemoryPort` — full `MemoryPort` impl. Capabilities:
    `semantic_search`, `code_aware_search`, `temporal_triples`, `episodic`,
    `graph_walk`. Synchronous embedding when fast (hash); async via the
    embedding job queue when an external provider is configured.
  - `searchCodeAware` — boosts pages with `source = 'code'` 1.25×.
  - `hasExternalGbrainConfig()` — detects existing `~/.config/gbrain/` so the
    dashboard can surface the hybrid-mode opt-in prompt.
- **`@skytwin/memory-hybrid`** — diagnostics-aware composer:
  - `HybridDiagnostics` counters expose routing + write outcomes.
  - `resolveReadPort` falls through to the secondary when the primary lacks the
    relevant capability (instead of silently returning empty).
- **`apps/api/src/memory-setup.ts`** — per-user backend factory:
  - Default `gbrain`; `MEMORY_BACKEND` env override; per-user `brain_settings`
    override beats env.
  - Embedding provider selection: OpenAI when key present, hash fallback.
- **`apps/api/src/routes/memory-config.ts`** — new REST surface:
  `GET / POST /api/memory-config`, `POST /dismiss-notification`,
  `GET /diagnostics`. Mounted under `sessionAuth + requireOwnership`.
- **`apps/web/public/js/pages/memory-settings.js`** — settings page
  (`#/memory-settings`): backend switcher, capability list, page index counts,
  hybrid diagnostics, "Your twin just got smarter" first-run notice with
  dismiss action. Singleton click delegator gated on `window.location.hash`
  per CLAUDE.md frontend event-handling discipline.
- **`docs/memory-swap.md`** — backends-at-a-glance, env knobs, migration
  recipe, rollback path.

### Tests

- `@skytwin/memory-gbrain-crdb-adapter`: 49 unit (embedding 25, rrf 6, in-memory
  repo 18) + 6 DB-gated integration (skipped unless `RUN_DB_TESTS=1`).
- `@skytwin/memory-gbrain`: 50 (cli-detector 10, gbrain-port 20,
  embedded-port 20, integration 5) + 1 always-on quality benchmark + 1
  opt-in perf benchmark gated on `GBRAIN_PERF=1`.
- `@skytwin/memory-hybrid`: 19 (10 existing + 9 new diagnostics).
- `@skytwin/api`: +21 (13 memory-setup unit + 8 memory-config-routes E2E).
- Total: 145+ new tests; full suite: 70/70 turbo tasks pass.

### Operational notes

- Set `MEMORY_BACKEND=gbrain` (default) or `hybrid` or `mempalace` to switch the
  per-installation default; per-user override via the dashboard.
- Set `OPENAI_EMBEDDING_API_KEY` (or `OPENAI_API_KEY`) to switch from the
  hash-trick fallback to real embeddings. `OPENAI_EMBEDDING_BASE_URL` lets you
  point at any OpenAI-compatible endpoint (Ollama, llamafile, vLLM, …).
- Rollback: `MEMORY_BACKEND=mempalace`. The legacy `/api/mempalace` REST surface
  still works regardless — it queries `memory_*` tables directly, not via
  `MemoryPort`.

## [unreleased] — Embedded LLM model downloader (#187 AC#2)

Closes AC#2 of #187. The single piece between "developer tool" and
"consumer app": a fresh install can now fetch its own model with no
config, no API keys, no per-message cost. The registry shipped in #246
told us *which* model to download; this PR makes it actually happen,
with pause / resume / cancel and persistence across API restarts.

### Why this is the launch-gating piece

A non-technical user opening SkyTwin previously hit a wall: the twin
needed an LLM, but configuring one meant either installing llama.cpp
manually + downloading a GGUF + setting `SKYTWIN_LLAMA_MODELS`, or
buying API keys from Anthropic/OpenAI. Now: open Settings → "Local AI
brain" card detects the user's RAM bracket via `navigator.deviceMemory`,
recommends the highest-quality model that fits, click Download → 3-15
minutes later the twin works fully offline.

### Ships

- `039-model-downloads.sql`: `model_downloads` table tracking each
  download — model_id, target_path, total_bytes, bytes_downloaded,
  sha256_expected, status (pending → downloading → verifying →
  installing → complete; or paused / failed / cancelled), started_at,
  paused_at, completed_at.
- `modelDownloadRepository`: create, findById, listForUser, findActive
  (idempotency on user+model), updateProgress (chunk-tick), setStatus
  (with paused_at / completed_at side effects), `recoverOrphanedDownloads`
  (boot-time recovery — orphaned `downloading` rows flip to `paused`).
- `apps/api/src/embedded-llm/downloader.ts`: the download engine.
  - Streams `fetch()` body to `<target_path>.partial`, atomic rename
    on success.
  - Resume via HTTP `Range` header — server that ignores Range falls
    back to full re-download (rare; logged).
  - Progress flushed to DB every ~1MB to keep transactions cheap.
  - SHA-256 verification post-download (skipped when registry hash is
    placeholder all-zeros — v1 hashes are stubs pending real artifact
    measurement).
  - In-flight `AbortController` map for pause/cancel.
  - Default model dir: `~/.skytwin/models/llama` if `SKYTWIN_LLAMA_MODELS`
    unset (matches the runtime detector's read path).
- `apps/api/src/routes/embedded-llm.ts`: extended with downloader
  endpoints (start, get, list-for-user, pause, resume, cancel,
  model-dir). Idempotent on `(userId, modelId)` so spam-clicking
  Download doesn't spawn duplicate transfers.
- Boot-time recovery wired into `apps/api/src/index.ts` —
  `recoverOnBoot()` runs alongside execution-router init.
- `apps/web/public/js/components/embedded-llm-card.js`: Settings card.
  Detects RAM bracket, recommends a default, shows a select for
  override, renders the download in progress with progress bar (reuses
  existing `.confidence-bar` styles), pause/resume/cancel buttons,
  error surface. Polls `/downloads/:id` every 1s while a download is
  active; stops polling on terminal status.
- 25 unit tests for the route layer in
  `apps/api/src/__tests__/embedded-llm-downloads-routes.test.ts`:
  start happy + missing-userId/modelId + 404 unknown-model, get +
  404, percent capping at 100% for over-fetch, percent=0 for pending,
  list-for-user, pause ok/false, pause-404, resume + 404, cancel,
  cancel-404, plus 7 cross-user-403 tests covering every mutating
  endpoint plus the dev-bypass-allowed case. Mocks `@skytwin/db` +
  the downloader module — no real HTTP / filesystem.

API total: 486 passing (24 skipped). All 34 packages build clean.

### Fixed (post-/review)

Copilot review on PR #247 surfaced 12 substantive findings; all
addressed before merge:

- **IDOR on `POST /downloads/start`**: applied `requireOwnership`
  middleware so the request body's `userId` must match the
  authenticated user.
- **IDOR on `GET /downloads/:id` and the pause/resume/cancel routes**:
  introduced a `loadOwnedDownload(req, res, id)` helper that fetches
  the row and rejects with 403 if `req.authenticatedUserId` doesn't
  match `row.user_id`. Dev bypass (no `authenticatedUserId`) keeps
  current behavior.
- **OOM on multi-GB SHA-256 verify**: replaced `readFile(path)` with a
  streaming `createReadStream → hash.update(chunk)` loop in a new
  `computeSha256(path)` helper. A 4GB GGUF no longer needs 4GB of
  Node heap to verify.
- **DB-level idempotency**: schema changed from a non-unique partial
  index to a `UNIQUE` partial index on `(user_id, model_id)` for
  non-terminal statuses, so two concurrent `/downloads/start` calls
  can't both win past `findActive()`. `startDownload()` now also
  catches the `23505` unique-violation that the loser's `INSERT`
  raises and re-fetches the surviving row.
- **In-memory race**: `startDownload()` now bails if the row is
  already in `inFlight`, preventing two concurrent runners writing
  the same `.partial`.
- **Stale progress on Range-ignored**: when the server returns 200 to
  a Range request, we now `updateProgress(id, 0)` immediately so the
  poll UI doesn't display stale `bytes_downloaded` until the next
  1MB flush.
- **`total_bytes` never persisted**: added
  `modelDownloadRepository.updateTotalBytes(id, n)` and call it when
  Content-Length disagrees with the registry by >1MB. The progress
  bar denominator now matches reality.
- **DOM update broke action buttons**: the polling tick was finding
  `labelLine.firstElementChild` and replacing it, which clobbered
  the size/percent span on first run and the action-button span on
  subsequent runs. Switched to stable `data-role` selectors
  (`embedded-llm-progress-text`, `embedded-llm-status`) so updates
  are scoped.
- **Singleton listener stale closure**: `ensureListener()` no longer
  closes over `container` or `userId` from the first mount. The
  delegator now re-derives both at click time:
  `document.getElementById('embedded-llm-card-target')` for the
  container, `localStorage.getItem(KEY_USER_ID)` for the userId.
  Same pattern as the other singleton delegators in this codebase.
- **Test auth pattern**: switched from injecting `req.user.id` to
  `req.authenticatedUserId` to match production. Added 7 new tests
  covering cross-user 403 on every mutating endpoint plus the
  dev-bypass-allowed path.

### Why this fits the theme

This is "boring deterministic" infrastructure — `fetch()` with `Range`,
SHA-256 verify, atomic rename. No LLM in the cryptography or the
download path. Every byte is accounted for; every state transition is
reflected in the row; every user-facing button has a deterministic
back-end consequence. The adaptive layer (the prompts that consume the
model once installed) doesn't change at all.

### Out of scope

- **Real SHA-256 hashes in the registry**: the v1 registry ships with
  all-zero placeholder hashes. The downloader detects this and skips
  verification. Filling in real hashes is a one-line change per model
  once an artifact has been measured (download once, `shasum -a 256`,
  paste). Tracking as a follow-up.
- **First-run onboarding integration**: the card lives in Settings
  today. The natural follow-up is to surface it as the first card on
  the dashboard when no model is installed AND no LLM provider is
  configured — making "your twin is downloading its brain" the
  explicit first-run state. Small change to `dashboard.js`.
- **Resume after API restart with a UI prompt**: orphaned downloads
  flip to `paused` on boot; the user sees a "Paused" download with a
  Resume button on next Settings visit, which is the desired UX. A
  toast / banner alerting them proactively is a small follow-up.


## [unreleased] — Accessibility: high-contrast + text-scale + voice STT route (#194 Child 4)

Closes the a11y commitments of #194 Child 4. Detailed entry in PR #244.

## [unreleased] — Crisis modes: recovery codes + vacation mode (#194 Child 3 partial)

Closes 2 of 4 sub-features in #194 Child 3: recovery codes + vacation mode. Detailed entry in PR #245.

## [unreleased] — Federation pairing protocol + delta sync (#194 Child 1)

Closes Child 1 of #194: real federation between a single user's instances
(desktop ↔ phone ↔ home server). NaCl-box pairing handshake, hourly
delta-sync worker, Settings UI for the pair / unpair / list flow. End-
to-end encrypted between paired peers; OAuth tokens excluded from sync.

Detailed entry preserved separately on the federation branch — kept terse
here to resolve the rebase against #193 cleanly.

## [unreleased] — Emergent Lifebooks Child 1: domain extractor + dynamic wings + dashboard surface (#193)

The OSS-launch headline made executable. Closes Child 1 of #193 in two
slices delivered as one PR.

The naive approach to "life management" hardcodes a fixed taxonomy
(Health, Money, Relationships, …) with curated capability bundles per
vertical. Wrong: it assumes every user's life decomposes the same way.
What about Kayaking? Aging Parents? Caregiving? Job Search?

The right approach: emergent verticals. The twin reads the user's
MemPalace, names the life domains *that user actually operates in*,
creates a wing per domain, and surfaces them on the dashboard. No
hardcoded list. Adding a new "kind" of Lifebook doesn't need a code
deploy — just a better domain-extraction prompt.

### Ships

#### Slice 1 — domain extractor worker (#193 Child 1, AC#1-#3)

- `packages/db/src/migrations/036-lifebooks.sql` — `lifebooks` table
  with `(user_id, domain_name)` unique key, importance enum (core /
  secondary / emerging), JSONB sample_signals + suggested_capabilities,
  optional wing_id pointer, soft-hide via `hidden_at`. Two indices:
  visible-only (for dashboard) and all (for management UX).
- `packages/db/src/repositories/lifebook-repository.ts` — `upsert`
  (idempotent on `(user_id, domain_name)`, never resurrects hidden rows
  on re-extraction), `listVisible`, `listAll`, `findByDomain`, `hide`,
  `unhide`. SQL-direct, parameterized, no ORM.
- `apps/worker/src/jobs/domain-extraction.ts` — `runDomainExtractionJob`
  walks active users (anyone with installed servers OR populated wings),
  builds a memory_summary from `knowledge_entities` + `knowledge_triples`
  (top 40 of each), runs `runPrompt('domain-extraction')`, validates the
  array output, and per-domain calls `mempalaceRepository.getWingByName`
  → `createWing` (with idempotent get-or-create) → `lifebookRepository.upsert`.
  Wired into `apps/worker/src/index.ts` poll loop on a 7-day cadence.
  Per-domain persist failures don't abort the user-loop; per-user errors
  don't abort the job. No-ops if no LlmClient is available — extraction
  is LLM-dependent.
- `apps/worker/src/__tests__/domain-extraction.test.ts` — 12 unit tests:
  empty-memory short-circuit, missing-LLM short-circuit, persist-each-
  domain happy path, reuse-existing-wing, invalid-entry filtering, non-
  array output handling, domain-cap-at-10, per-domain failure resilience,
  job-level user-loop, no-active-users skip. Mocks all of `@skytwin/db`,
  `@skytwin/policy-prompts` so tests never spawn DB or LLM.

#### Slice 2 — dashboard surface + per-Lifebook UX (#193 Child 1, AC#4-#7)

- `apps/api/src/routes/lifebooks.ts` — `GET /api/lifebooks/:userId`,
  `GET /api/lifebooks/:userId/all`, `GET /api/lifebooks/:userId/:domainName`
  (returns lifebook + wing room/drawer counts), `POST .../:domainName/hide`,
  `POST .../:domainName/unhide`. Mounted under `requireOwnership` so
  cross-user reads are blocked at the middleware layer. Worker is the
  only writer of *content*; this router only adjusts visibility.
- `apps/web/public/js/api-client.js` — `fetchLifebooks`, `fetchLifebook`,
  `hideLifebook`, `unhideLifebook` helpers.
- `apps/web/public/js/pages/dashboard.js` — "Your Lifebooks" card.
  Shows top 5 detected domains with importance badges, each linking to
  `#/lifebook/<domain>`. Renders nothing when no lifebooks exist (silent
  rather than a confusing "no domains detected" placeholder for users
  who haven't yet had the worker run).
- `apps/web/public/js/pages/lifebook.js` — per-Lifebook page at
  `#/lifebook/<domain>`: importance badge, sample signals, suggested
  capabilities, wing summary, and "Hide from dashboard" button. Singleton
  delegator gated by hash route — same pattern the rest of the SPA uses.
- `apps/web/public/js/app.js` — registers the dynamic
  `/lifebook/<domain>` route with title decoded from the path segment.

### Why this fits the theme

This slice is the architectural philosophy made executable:

- **Hard rails preserved**: lifebook visibility is the only user-driven
  write; domains *cannot* be added by hand. They emerge from memory.
- **Boring deterministic**: wings, rooms, drawers — same `KnowledgeEntity`
  + wing/room/drawer schema MemPalace already provides. No new
  vertical-specific tables. The lifebooks table is a thin index pointing
  at existing memory.
- **Adaptive**: domain naming, importance scoring, capability suggestions
  all flow through `@skytwin/policy-prompts` (`domain-extraction` v1).
  Adding a new "kind" of Lifebook is a prompt edit, not a code deploy.
- **Memory port**: the worker's read path is the existing MemPalace
  query; the write path goes through `Palace.ensureWing` (idempotent).
  Future MemoryPort backends (gbrain in #197) will plug in without
  touching this worker.

### Out of scope (explicitly deferred)

- Per-Lifebook briefing prose (#193 Child 1 AC#4 second half) — the
  briefing-generator (#177) is unchanged. Per-domain briefings are a
  natural follow-up but require schema changes to `twin_briefings`
  that aren't worth bundling here.
- Capability filtering "by domain" on the existing Capabilities page —
  the suggested categories are stored on the lifebook row but the
  Capabilities page itself is unchanged. Cross-link is a follow-up.
- Provenance graph filtering by wing (deep-link from Lifebook page).
  The href is wired but the graph page doesn't yet read the `wing`
  query param. Tracking as a separate small UX issue.

### Why NaCl box, not just HMAC (federation context)

Federation deltas include trust-tier, risk-profile, and recent decision
metadata. Confidentiality matters for a peer on a coffee-shop LAN — HMAC
alone (integrity, no confidentiality) wouldn't be enough. NaCl box
(Curve25519 + XSalsa20 + Poly1305) gives us asymmetric encrypt-and-
authenticate in one primitive with a 32-byte key per side. Implemented
via `tweetnacl` (audited pure-JS port, ~50KB unzipped, no native deps).

### Ships

- `037-federation-peers.sql` — `federation_peers` (+ soft-delete via
  `unpaired_at`) and `federation_pairing_codes` (10-min TTL slots).
- `federation-peer-repository.ts` — typed CRUD + `markSyncResult`.
  `create` is upsert-by-(user_id, peer_public_key) so re-pairing same
  peer updates rather than duplicates.
- `apps/api/src/federation/crypto.ts` — `generateKeyPair`,
  `generatePairingCode` (CSPRNG-backed via `node:crypto.randomInt`),
  validators, `sealMessage`/`openMessage`. Pure JS, no native deps.
- `apps/api/src/routes/federation.ts` — `/pair/start` (initiator),
  `/pair/complete` (joiner; cross-user code redemption returns 403
  for distinct audit trail), `GET /peers/:userId`, `POST .../unpair`.
- `apps/worker/src/jobs/federation-sync.ts` — hourly job that walks
  active peers with `endpoint_url`, builds a `DeltaPayload` (active
  MCP servers + last 100 capability_provenance edges; **excludes**
  OAuth tokens, vault secrets, encryption keys), seals via `nacl.box`,
  POSTs to `<endpoint>/api/federation/inbox`. Per-peer failures don't
  abort the loop.
- `apps/web/public/js/pages/settings.js` — "Linked devices" card with
  pair / "I have a code" / unpair UX. `apps/web/public/js/api-client.js`
  exports the four federation helpers.

### Tests

- `federation-crypto.test.ts` (13): keypair shape + freshness, code
  format, key validation, seal/open round-trip, wrong-sender, tampered
  ciphertext, wrong nonce.
- `federation-routes.test.ts` (11): start success + missing-userId,
  complete happy + 5 reject cases (malformed code/key/label, expired,
  cross-user 403, malformed endpoint), list (shape + secret-key never
  leaked), unpair true/false.
- `federation-sync.test.ts` (9): payload filtering (active-only,
  null registry_id skip, edges included), seal round-trip, push
  success, non-2xx failure, network error per-peer continuation,
  passive peer skip, trailing-slash endpoint normalization.

API total: 439 passing. Worker: 59 passing.

### Out of scope

- `/api/federation/inbox` receive route. Worker pushes today; receivers
  accept-and-merge in the next PR. Two paired devices are aware of each
  other but deltas land at 404 — the worker records the failed status
  with `last_sync_error: "peer responded 404"` so diagnostics still
  work before the receiver lands.
- AC#5 cross-backend `MemoryPort` exportAll/importAll wiring. Substrate
  is in place; integration into federation-sync is mechanical follow-up.
- AC#6 manual-resolve UI for installed-server conflicts.

### Why server-mediated pairing, not P2P over LAN

Direct LAN pairing needs mDNS + NAT-traversal — substantial complexity
v1 doesn't need. MVP pairs through the central API: instance A generates
code, the API holds the ephemeral keypair, instance B redeems on the
same API, both sides commit a peer row. After pairing, each instance's
worker pushes deltas via `endpoint_url`. Users with a single
internet-facing instance keep "passive peers" (no endpoint_url) that
benefit from inbound deltas without needing to be reachable.

## [unreleased] — Embedded LLM as a first-class llm-client provider (#187 AC#7)

Closes AC#7 of #187: "Same `@skytwin/policy-prompts` prompts work
against embedded model AND hosted models." Adds `'embedded'` as a
fifth `AIProviderName` alongside the existing four (anthropic, openai,
google, ollama). Callers of `LlmClient.generate()` now get embedded
inference transparently when `embedded` is in their provider chain —
no separate code path, no separate prompt format. Same circuit
breaker, same fallback chain, same streaming wrapper. Local
inference becomes one entry in the user's chain instead of a parallel
universe the rest of the codebase has to know about.

### Ships

- `packages/shared-types/src/ai-provider.ts` — `AIProviderName` extended
  with `'embedded'`. `PROVIDER_MODELS.embedded` lists `'auto'` (the
  factory's default model resolution). `PROVIDER_INFO.embedded` carries
  user-facing label/description plus `requiresApiKey: false`,
  `requiresBaseUrl: false`.
- `packages/llm-client/src/providers/embedded.ts` — provider function
  that wraps `createEmbeddedTextPort()`. Renders `ChatMessage[]` to the
  `role: content` block format `llama-cli -p` consumes (`system: ...`
  → `user: ...` → `assistant:` trailing prompt). Inline `system`
  messages take precedence over `options.systemPrompt`, matching the
  OpenAI / Ollama providers. Caches the port instance per
  resolved-model-key so detection runs once per model. Exports
  `_clearEmbeddedPortCache()` for test isolation.
- `packages/llm-client/src/llm-client.ts` — `embedded` registered in
  `PROVIDER_FNS` and `PROVIDER_STREAM_FNS` (via `makeFallbackStream`,
  the same path Ollama uses today). No structural changes to the
  client; the new provider just slots into the existing chain.
- `packages/llm-client/package.json` — declares
  `@skytwin/embedded-llm: workspace:*`.
- `apps/web/public/js/pages/settings.js` — adds `embedded` to the
  `Settings → AI brain` provider picker dropdown plus its
  `PROVIDER_MODELS` and `PROVIDER_LABELS` maps.
- `packages/llm-client/src/__tests__/embedded-provider.test.ts` —
  11 unit tests: trims output, passes maxTokens/temperature,
  renders multi-turn ChatMessage[] with assistant trailer, inline
  vs options system precedence, explicit modelPath vs auto, port
  caching across calls, separate cache entries per model, error
  propagation, ignored apiKey/baseUrl. Mocks `@skytwin/embedded-llm`
  via `vi.mock` so tests never touch the real subprocess. Total
  package now: 126 tests passing.

### How callers use it

```ts
import { LlmClient } from '@skytwin/llm-client';

const client = new LlmClient(userId, [
  { provider: 'anthropic', apiKey: '...', model: 'claude-...' },
  { provider: 'embedded', apiKey: '', model: 'auto' },        // local fallback
]);

// Identical call site whether the chain runs hosted or embedded.
const { content } = await client.generate(prompt, { maxTokens: 256 });
```

### Out of scope

- Streaming with token-level granularity from llama-cli — wrapped via
  `makeFallbackStream` for now (single chunk on completion).
- Cost dashboard zero-cost rendering for `embedded` provider — small
  UI tweak in the cost panel; tracked as follow-up under #187 AC#8.

## [unreleased] — Auto-launch toggle UI + DXT drag-drop entry point (#191 + #180)

Closes the auto-launch UX for #191 and the DXT drag-drop entry point for
#180. The IPC handlers `get-launch-at-login` / `set-launch-at-login`
landed in #218 with no UI; this PR puts a real toggle in Settings → Desktop
and wires the `app.setLoginItemSettings` round-trip end-to-end.

For #180, the existing DXT import flow (#219 export, #224 install confirm)
had no entry point — users could only POST a `.dxt` file via curl. This
PR adds two real entry points: body-wide drag-drop in the renderer and an
OS file-association handler in the main process.

### Ships

- `apps/web/public/js/pages/settings.js` — new "Desktop" card visible
  only when `window.skytwinDesktop?.isDesktop`. Toggle switch wired to
  `setLaunchAtLogin(boolean)`; hydrates from `getLaunchAtLogin()` on
  render. Toast on save success / failure; on failure the toggle reverts
  to its previous state.
- `apps/desktop/src/main.ts` — `read-dxt-file` IPC handler (`.dxt` or
  `.json` path → `{ name, base64 }`); `app.on('open-file', ...)` handler
  that buffers the path and forwards it to the renderer once the
  webContents finish loading. Pending-path drain on `did-finish-load`
  covers the case where the user double-clicks a `.dxt` before the window
  is ready.
- `apps/desktop/src/preload.ts` — exposes `readDxtFile(filePath)` and
  `onDxtFileOpened(listener)` (returns unsubscribe fn).
- `apps/web/public/js/app.js` — `wireDxtDropAndOpen()` runs once on
  `DOMContentLoaded`. Document-level `dragover`/`drop` handlers filter
  for `.dxt`/`.json` files (via `DataTransfer.types.includes('Files')`
  + filename check), read via `FileReader.readAsDataURL`, POST to
  `/api/dxt/import` with the base64 blob, and navigate to `#/dxt/imports`
  on success. Subscribes to `skytwinDesktop.onDxtFileOpened` for the
  Finder/Explorer double-click path — same import flow, file is read via
  the IPC handler instead of FileReader. Toast feedback on every code
  path. Multi-file drops produce a "drop one at a time" toast rather than
  silently picking the first.

### Why drag-drop runs in the renderer, not the main process

Browser file drops carry the `File` object directly — we already have the
bytes without touching disk. The OS-passed path from `app.on('open-file')`
is the only case where the renderer doesn't have bytes; that's why the
`readDxtFile` IPC exists as a narrow allowlist (`.dxt`/`.json` only,
explicit filePath argument). Keeping the body-wide drag-drop in the
renderer also means it works in the pure-web build of the dashboard where
no `skytwinDesktop` exists.

### Out of scope

- File-association registration in `electron-builder` config (the OS won't
  fire `open-file` for `.dxt` until macOS Info.plist `CFBundleDocumentTypes`
  / Windows registry associations are declared at install time — that's a
  packaging concern, not a runtime one).

## [unreleased] — Desktop idle bridge via Electron powerMonitor (#180 partial)

Closes one of the four "desktop integration" sub-asks of #180: a real
OS-level idle bridge in the Electron main process. Wires Electron's
`powerMonitor` (lock-screen, unlock-screen, suspend, resume + a polled
`getSystemIdleTime()` check) into a single `onStateChange(state, reason)`
callback that the renderer subscribes to via the `skytwinDesktop` preload
API. This gives the web dashboard a real signal it can use to fire a
proactive scan when the user steps away — not a `setInterval` heartbeat
that fires whether the user is at the keyboard or not.

### Ships

- `apps/desktop/src/idle-bridge.ts` — `IdleBridge` class. Listens to
  `powerMonitor.on('lock-screen' | 'unlock-screen' | 'suspend' | 'resume')`
  and runs a polled `getSystemIdleTime()` check at a configurable interval
  (default 30s) against a configurable threshold (default 300s = 5min).
  Internal state machine debounces transitions so the callback fires
  exactly once per idle ↔ active flip — no flapping at the threshold.
  Handler exceptions are isolated so a renderer crash can't tear down
  the bridge.
- `apps/desktop/src/main.ts` — constructs `IdleBridge` after services
  start, wires it to `mainWindow.webContents.send('idle-state-changed', ...)`,
  and stops it on `before-quit`.
- `apps/desktop/src/preload.ts` — exposes `skytwinDesktop.onIdleStateChanged(listener)`
  via contextBridge. Returns an unsubscribe function.
- `apps/desktop/src/__tests__/idle-bridge.test.ts` — 13 unit tests
  covering threshold transitions, debouncing, lock/unlock, suspend/resume,
  same-state no-op, handler isolation, idempotent start/stop, listener
  cleanup on stop, and the no-op fallback when powerMonitor is absent.
  Injectable `PowerMonitorLike` fake — tests never touch real Electron.

### Why this is distinct from `@skytwin/idle-miner.ElectronIdleDetector`

The existing detector lives inside the worker package and powers
filesystem mining at idle. The desktop "idle bridge" is the renderer-facing
integration — it surfaces the same OS signal to the web dashboard via
IPC so consumers can fire proactive scans, pause expensive work when
the screen locks, etc. Both read `powerMonitor` independently with
their own debouncing and thresholds tuned to their use cases.

## [unreleased] — Real llama.cpp + whisper.cpp backends for embedded LLM (#187 partial)

Replaces the `Null*Port` stubs in `@skytwin/embedded-llm` with real subprocess
backends. PR #221 shipped the port interfaces and runtime detector; this PR
ships the actual implementations that spawn the binaries and parse output.

Validated end-to-end against `/opt/homebrew/bin/llama-cli` (Homebrew llama.cpp)
and `/opt/homebrew/bin/whisper-cli` (Homebrew whisper.cpp) — confirmed real
binary spawn, arg construction, exit-code handling, and stderr-tail
propagation. With a bogus model path, the backend correctly surfaces
`llama_model_load: error loading model` from the binary's stderr.

### Ships

- `packages/embedded-llm/src/llama-cpp-backend.ts` — `LlamaCppTextBackend`
  implements `EmbeddedTextPort`, spawns `llama-cli` with
  `-m <model> -p <prompt> -n <maxTokens> --temp <temp> --no-display-prompt
  --no-warmup -no-cnv` (no-cnv suppresses the interactive REPL banner so
  stdout contains only generated tokens). Strips `[end of text]`, `<|im_end|>`,
  `<|endoftext|>`, `</s>` markers from output. Configurable `timeoutMs`
  (default 120s) and `threads`. Exit code ≠ 0 → rejects with last 5 stderr
  lines as the error message tail.
- `packages/embedded-llm/src/whisper-cpp-backend.ts` — `WhisperCppSttBackend`
  implements `EmbeddedSttPort`, writes audio buffer to a `mkdtemp`'d temp
  directory, spawns `whisper-cli` with `-m <model> -f <audio> -oj -of <basename>
  -np -nt`, reads `<basename>.json` and joins `transcription[].text` with
  spaces. Cleans up the temp dir in a `finally` block (even on whisper-cli
  failure). Optional `-l <lang>` and `-t <threads>`. `parseWhisperJson`
  exported separately for test isolation.
- `packages/embedded-llm/src/factory.ts` — `createEmbeddedTextPort()` and
  `createEmbeddedSttPort()` pick real vs Null based on
  `detectEmbeddedRuntimes()`. Model resolution order: explicit override →
  `SKYTWIN_LLAMA_MODEL`/`SKYTWIN_WHISPER_MODEL` env var → first matching
  file in detected `modelDir` (`*.gguf` for llama, `ggml-*.bin` for whisper)
  → fall back to Null port.
- `findFirstGgufModel()` and `findFirstWhisperModel()` — directory scan helpers
  with safe error handling (returns null if dir missing, readdir throws, or
  statSync fails on individual entries).
- 36 new unit tests across `llama-cpp-backend.test.ts`,
  `whisper-cpp-backend.test.ts`, and `factory.test.ts`. Mocks `node:child_process`
  and `node:fs` so tests never spawn real binaries. Total package now: 58 tests.

### Closes for #187

- AC#1 runtime: real llama.cpp text generation (the binary spawn + parse layer).
  Bundling the model file is a separate distribution concern.
- AC#3 runtime: real whisper.cpp transcription. Voice integration in mobile/desktop
  consumes this via `createEmbeddedSttPort()`.

### Still open for #187

- AC#1 bundling: shipping a default GGUF in installer payload (separate distribution
  concern; runtime accepts any GGUF via env var or model dir).
- AC#2: background download with pause/resume UI (model downloader app work).
- AC#4: Piper TTS — `piper` binary not installed locally; `NullEmbeddedTtsPort`
  remains the production fallback until `brew install piper` (or equivalent)
  lands. Real `PiperTtsBackend` will mirror the spawn pattern of these two.
- AC#5: auto-upgrade model registry (model registry / version-check work).
- AC#6/7/8: UI mode switch + prompt-eval parity + cost dashboard zero-cost
  display.

### How to use

```ts
import { createEmbeddedTextPort } from '@skytwin/embedded-llm';

const port = await createEmbeddedTextPort();
if (port.capabilities.available) {
  const text = await port.generate('Summarize this email: ...', {
    maxTokens: 256,
    temperature: 0.3,
  });
}
// Else: fall back to API-keyed providers via @skytwin/llm-client.
```

Set `SKYTWIN_LLAMACPP_BIN=/path/to/llama-cli` and `SKYTWIN_LLAMA_MODEL=/path/to/model.gguf`
(or `SKYTWIN_LLAMA_MODELS=/dir/with/models/`) to pin a specific binary/model.

## [unreleased] — GitHub Releases auto-update channel + workflow (#188 follow-up)

Closes the real auto-update channel for #188. #223 shipped the scaffold with
`NoopUpdateBackend` and a `provider: generic` placeholder that was removed
because env-interpolation (`${env.SKYTWIN_UPDATE_URL}`) failed CI. This PR
switches to GitHub Releases (`provider: github`), which embeds a static
owner/repo pair in the build config and reads `GH_TOKEN` from the environment
only at publish time — no env vars needed for CI to build cleanly.

### Ships

- `apps/desktop/package.json` — `build.publish` block set to `provider: github`,
  `owner: jayzalowitz`, `repo: skytwin`, `releaseType: release`. `electron-updater
  ^6.6.0` added to `dependencies`.
- `apps/desktop/src/auto-update.ts` — `ElectronUpdaterBackend` class: wraps
  `autoUpdater` from electron-updater, sets `autoDownload = true` and
  `autoInstallOnAppQuit = true` (silent install on next quit), maps result to
  `UpdateCheckResult`. Uses a dynamic `require` so the import is deferred to
  runtime inside a real Electron process and never resolved in tests or headless.
  `defaultBackend(opts?)` factory: returns `ElectronUpdaterBackend` when
  `process.versions.electron` is set, `NoopUpdateBackend` otherwise. `AutoUpdateController`
  constructor now accepts an optional backend and falls back to `defaultBackend()`.
- `apps/desktop/src/main.ts` — On `app.whenReady()` + `app.isPackaged`, constructs
  `AutoUpdateController` and calls `schedulePeriodicChecks()`. On `before-quit`,
  calls `cancelScheduledChecks()`. Skipped in dev mode (unpackaged runs).
- `.github/workflows/release.yml` — Matrix build (macOS/Windows/Linux) triggered on
  `v*.*.*` tags or `workflow_dispatch`. Publishes via `--publish always`. Secret names
  documented in the file header comment block. Until secrets are added, produces
  unsigned artifacts (same posture as before).
- `apps/desktop/src/__tests__/auto-update.test.ts` — 6 new tests (total 23):
  `defaultBackend()` returns Noop in test env, returns `ElectronUpdaterBackend` when
  `process.versions.electron` is set (mocked inline), handles `channel: beta`, and
  two constructor-level regression guards.

### How to cut a release

```
git tag v0.x.y && git push origin v0.x.y
```

The workflow fires automatically. Binaries appear in GitHub Releases once the
matrix jobs complete (typically 15-30 min). Clients running the previous version
will pick up the update on their next 6-hour check cycle (or on next launch).

### Code-signing status

Signing is conditional on secrets being present in the GitHub repo:
`MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (macOS);
`WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD` (Windows).
Without these secrets the workflow publishes unsigned artifacts. Unsigned builds
auto-update correctly but trigger OS security warnings on first launch.
Certificate procurement is tracked separately.

### Out of scope

- In-app update notification UI (deferred to v1.1 polish)
- Beta channel automation (stable channel only for v1)
- Delta/patch deployment (electron-updater handles this automatically once the
  channel has at least two releases)

---

## [unreleased] — PR merge gate codified in CLAUDE.md

Adds a three-step pre-merge gate to `CLAUDE.md` (`/review` → Copilot
review resolved → `/document-release`), plus two non-negotiable rules:
NEVER push to main directly, ALWAYS add Copilot as reviewer. Adapted
from the gate `Robot-Robot-and-Human/RRH` uses; closes the gap that
allowed ~70 unaddressed Copilot comments to accumulate across this
week's 15 epic PRs (cleaned up by the #226 → #232 stack).

The existing six "habits" bullets (re-render path tracing, shared-types
dist verification, unit tests for hardening, separate post-/review
commits, source-of-truth doc citations) are kept as supporting guidance
under a renamed sub-section.

## [unreleased] — Zero-trust Docker runtime (#183 AC#4 closes)

Completes AC#4 of issue #183. PR #222 shipped the policy + UI half (riskModifier
+1, force-approve, toggle endpoints, capability-detail card). This PR adds the
runtime enforcement: stdio MCP servers with `zeroTrustMode=true` are now spawned
inside a Docker container with `--network=none` so the server process has no
network access.

### Ships

- `packages/mcp-host/src/docker-spawn.ts` — `isDockerAvailable()`,
  `spawnInDockerNoNetworkAsync()` (async, resolves `npm root -g`),
  `spawnInDockerNoNetwork()` (sync, uses fallback path), and `buildDockerArgs()`
  (exported for testing). Resource caps: `--memory=512m --cpus=1` by default.
  Container flags: `--network=none --rm --init --read-only --cap-drop=ALL
  --security-opt=no-new-privileges --user=uid:gid`.
- `packages/mcp-host/src/docker-stdio-transport.ts` — `DockerStdioTransport`
  implements `Transport` using pre-spawned Docker stdin/stdout. Wires container
  exit to `onclose` so the McpHost CircuitBreaker is notified.
- `McpServerConfig.zeroTrustMode?: boolean` and
  `McpServerHandle.failedToIsolate?: boolean` added to
  `packages/mcp-host/src/types.ts`.
- `McpHost.installServer` wired: stdio + `zeroTrustMode=true` + Docker available
  → `DockerStdioTransport`; Docker unavailable → warning logged,
  `failedToIsolate=true`, regular spawn (graceful fallback).
- 18 unit tests + 1 integration test in
  `packages/mcp-host/src/__tests__/docker-spawn.test.ts`. Integration test runs
  when Docker is available and verifies `--network=none` blocks outbound fetch
  from the container (exits 0 = blocked).

### Constraints (document clearly)

- **stdio transport only.** HTTP/SSE servers are remote processes; applying
  `--network=none` would sever the connection entirely. `zeroTrustMode` is
  silently ignored for `transport: 'http'` and `transport: 'sse'`.
- **User must pre-install MCP packages on the host** via `npm install -g
  <package>`. The host's global `node_modules` directory (resolved via `npm root
  -g`) is mounted read-only into the container so `npx` can find packages without
  internet access during startup. See code comments in `docker-spawn.ts` for the
  rationale.
- **Resource cap defaults:** 512 MB memory, 1 CPU. Configurable via
  `McpServerConfig.resourceLimits.memoryMb`.
- **Graceful fallback:** if Docker is not running, the server starts without
  isolation and `McpServerHandle.failedToIsolate` is set to `true`. The UI can
  surface "isolation requested but Docker not available" (deferred).

### Out of scope

- HTTP/SSE transport zero-trust — network required by design. Documented.
- Per-server OAuth domain allowlist — needs sidecar HTTP proxy or iptables. Defer.
- Pre-built containers per MCP server — too invasive for v1. Defer.
- Auto-install MCP packages inside container — needs network. Defer.
- "Isolation requested but Docker not available" UI banner — `failedToIsolate`
  field is set; UI reads it in a follow-up.

### Closes

- #183 AC#4

## [unreleased] — Turnkey distribution config (#188 partial)

Scaffolds the electron-builder signing configuration, build orchestration
scripts, and auto-update wiring needed for a signed installer release. All
credentials are env-var-driven — no certificate material appears in the
codebase. Unsigned builds continue to work exactly as before; signing
activates only when `SKYTWIN_SIGN_RELEASE=true` and the required env vars
are present.

### Ships

- electron-builder config: minimal mac/win/linux targets. No env-interpolation
  in build config (those failed CI schema validation when env vars were unset).
- `apps/desktop/scripts/sign-and-notarize.ts` — orchestration helper validating
  required env vars when `SKYTWIN_SIGN_RELEASE='true'`.
- `apps/desktop/src/auto-update.ts` — `AutoUpdateController` with injectable
  `UpdateBackend`. `NoopUpdateBackend` default; real `ElectronUpdaterBackend`
  lands when E2E confirms.
- `apps/desktop/scripts/build-single-binary.sh` — bundles api+worker+web into
  `apps/desktop/dist/embedded/`.
- 17 unit tests for `AutoUpdateController`.

### Out of scope (deferred)

- Real signing certificates — env-var only; certs flow via CI secret storage
- Real CDN URL — env-var only
- Real `ElectronUpdaterBackend` implementation — needs E2E
- SQLite-vec embed — v1.1 per #197
- Auto-update CI workflow — separate ops PR

## [unreleased] — Mobile Capabilities + Briefing screens (#179 partial)

Read-only mobile UX for Capabilities + Briefing. Voice STT/TTS, push
notifications, deep-linking, and full offline support all need real
device testing — those are deferred.

### Ships

- `apps/mobile/src/screens/CapabilitiesScreen.tsx` — installed capabilities
  list with name, status badge, last-active timestamp, zero-trust indicator,
  pull-to-refresh. Pending suggestions at top with Snooze / Dismiss
  (Install redirects to web). Tap row → detail.
- `apps/mobile/src/screens/CapabilityDetailScreen.tsx` — skills, monthly
  spend meter, zero-trust badge, "View provenance" link via `Linking`.
  Read-only — no inline edit forms.
- `apps/mobile/src/screens/BriefingScreen.tsx` — today's headline, key
  signals, pending-approvals count, pull-to-refresh.
- `apps/mobile/src/services/api-client.ts` — `fetchCapabilities`,
  `fetchCapabilityDetail`, `fetchTwinBriefing` + 7 new types.
- `apps/mobile/src/App.tsx` — Briefing + Capabilities tabs added to the
  bottom tab bar (now 5 tabs). Capability detail is a sub-page inside the
  Capabilities tab (state-driven, resets on tab switch — avoids nested
  navigators).
- 36 new unit tests in `capabilities-briefing.test.ts`.

### Defers (out of scope this session)

- Voice STT/TTS — needs device microphone + speakers
- Push notifications — needs APNs/FCM credentials
- Deep-linking web → mobile — needs URL scheme registration
- Full offline support — needs sync engine work
- Install / activate from mobile — management stays on web

## [unreleased] — DXT install confirm flow (#180 follow-up)

Closes the backend half of the DXT import flow. `POST /api/dxt/import` now
persists a `dxt_imports` row (`status='pending'`) so the user can confirm or
reject in a dedicated step. A second call to the confirm endpoint installs
the capability by inserting into `mcp_servers`, writing a provenance node, and
returning the new server ID.

### Ships

- **Migration `035-dxt-imports.sql`** — `dxt_imports` table with
  `pending | installed | rejected | failed` status lifecycle; composite index on
  `(user_id, status, imported_at DESC)`. Also extends `cpn_node_type_check`
  to include `'manual_install'`.
- **`dxtImportRepository`** (`packages/db/src/repositories/dxt-import-repository.ts`)
  — `create`, `findById`, `listForUser`, `markRejected`, `markInstalled`,
  `markFailed`. Exported from `@skytwin/db`.
- **`POST /api/dxt/import`** updated — now persists a pending row and returns
  `importId` alongside the preview. The old `note` field is removed.
- **`POST /api/dxt/imports/:id/confirm`** — ownership-checked, pending-only,
  re-verifies SHA-256 on stored blob, inserts into `mcp_servers`, writes
  `manual_install` provenance node, returns `{ status, serverId, registryId }`.
- **`POST /api/dxt/imports/:id/reject`** — ownership-checked, pending-only,
  returns 204. Audit trail.
- **`GET /api/dxt/imports`** — lists all imports for the user, newest first.
  No blob bytes in response. Supports `?status=` filter.
- **Web page `apps/web/public/js/pages/dxt-imports.js`** — route `#/dxt/imports`,
  singleton delegator, pending review list with expand-to-review + Install /
  Reject buttons, history with status badges. Wired into `app.js`.
- **14 new tests** — 9 in `dxt-import-confirm-flow.test.ts` (API layer) +
  5 in `dxt-import-repository.test.ts` (db layer).

### Defers

- Drag-drop UI on the desktop (Electron file-picker integration) — needs
  real Electron testing environment.
- Bulk import — one artifact at a time by design.
- Cross-instance federation (push) — DXT is one-way file transfer.

## [unreleased] — Copilot review sweep, batch 1 (security + correctness)

Audited Copilot comments across this week's epic PRs (#198, #206-#215,
#218, #219, #221, #222) and fixed the security-critical and obviously-
broken items in one pass. Lower-severity items (frontend nits, doc drift,
adaptive-prompt input mismatches, observability rollup architecture, vault
rotation polish) are scoped into themed follow-up PRs.

### Security

- **Shell injection — `@skytwin/memory-gbrain`.** `searchSemantic` was
  building a shell command string with the user query interpolated through
  `JSON.stringify`. Replaced with `execFileSync` (no shell), so query
  metacharacters (`$()`, backticks, `;`, `&&`, …) are passed as a single
  argv element and cannot inject. Added regression test using a malicious
  query.
- **PII leak via array payloads — `redactPII` and `redactPayload`.** Both
  helpers in `apps/twin-mcp-server/src/audit/provenance-writer.ts` and
  `apps/api/src/routes/capabilities.ts` skipped arrays, so PII in
  array-of-object payloads (e.g. `recipients: [{email: ...}]`) was
  written to provenance and returned in API responses unredacted. Both
  now recurse through arrays.
- **PII leak — `GET /api/capabilities/suggestions`.** The response
  spread `...row` over the suggestion, returning the raw
  `evidence_sources` JSONB (the unredacted source signals) alongside the
  redacted `evidence` preview. Switched to an explicit field projection
  so only the safe preview leaves the API.
- **Broken email-redaction regex — `[A-Z|a-z]{2,}`.** Inside a character
  class `|` is literal, so the regex was matching `|` as a TLD char and
  failing to match valid TLDs. Fixed to `[A-Za-z]{2,}` in both subject
  and body redactions.

### Correctness

- **Credential vault never engaged in production.** `DbTokenStore` exposes
  `setKeyCache()` for at-rest encryption + lazy migration, but only the
  worker creates `DbTokenStore` and never called `setKeyCache`. The
  encryption feature was dead weight: lazy migration never fired, so
  existing plaintext tokens stayed plaintext forever. Added a
  worker-local `KeyCache` and wired it. The cache is empty until
  cross-process unlock IPC lands (#212 follow-up), but the seam now
  exists and a comment documents the limitation.
- **DXT routes broken under real auth.** `getUserId(req)` read
  `req.user?.id`, but production session-auth middleware sets
  `req.authenticatedUserId`. All DXT endpoints returned 400 unless
  callers passed `?userId=` explicitly. Switched to read
  `authenticatedUserId` first; tests updated to mirror production
  middleware.
- **Twin MCP provenance only on success.** Per safety invariant, every
  external-agent tool call must produce an audit row. The previous
  pattern only awaited `writeExternalAgentProvenance` after the tool
  succeeded — failed calls were invisible. Wrapped each handler in
  try/finally so the audit fires for both success and failure; a
  separate try/catch ensures provenance failures never mask the original
  tool result/error.
- **Migration 027 inline partial-index syntax.** CockroachDB does not
  support `INDEX (col) WHERE ...` inside `CREATE TABLE`. Pulled the two
  affected partial indexes out as standalone `CREATE INDEX IF NOT EXISTS`
  statements (matching the pattern in 011-sessions.sql). Idempotent if
  the migration already applied; safe if it hadn't.
- **Onboarding always recorded `first_run_choice = 'about-me'`.** Three
  call sites (skip-recipe, install-recipe, complete) hard-coded the
  string regardless of which entry path the user took. Added
  `_wizardState.firstRunChoice` set on the welcome-screen choices and
  read everywhere downstream — email and computer users now record their
  real path.
- **Briefing generator dropped users past 500.** `getActiveUserIds`
  ran a single `LIMIT 500` query and silently dropped the rest. Switched
  to a 500-row paged scan over `mcp_servers` ordered by `user_id`.
- **Zero-trust mode is helpers-only.** The `applyZeroTrustOverride` and
  `getEffectiveRiskModifier` helpers exist and are unit-tested, but no
  production caller invokes them — toggling the UI badge does not
  change runtime behavior. Updated CHANGELOG and capability-detail
  copy to be honest about that, with a #222 follow-up tracked for the
  decision-pipeline wiring.

### Tests

- Added shell-injection regression test for `GbrainMemoryPort`.
- Added array-of-object PII redaction tests for `redactPII` and
  `redactPayload` (one of which previously asserted the bug as
  expected behavior — corrected).
- Added "capabilities() returns empty when not installed" test for
  `GbrainMemoryPort`.

### Fixed (post-/review)

- **Migration 027 idempotency.** Added defensive
  `DROP INDEX IF EXISTS` for the auto-named partial indexes CockroachDB
  would have created had an earlier run accepted the inline form. A
  re-apply now yields exactly one partial index per predicate, not two.
- **Briefing-generator pagination scales linearly.** Switched from
  `LIMIT/OFFSET` to keyset pagination (`AND user_id > $last`) so
  per-page cost stays flat as the user table grows, instead of paying
  to scan + skip earlier rows on every page.
- **gbrain test mock variable rename.** `mockExecSync` →
  `mockExecFileSync` so the variable name matches the API under test.
- **DXT-route docstring honesty.** Removed the misleading "other route
  modules use the same order" claim — they don't.

## [unreleased] — Zero-trust mode policy + UI (#183 AC#4 partial)

Closes the policy + UI half of #183 AC#4. The container runtime hooks
themselves (the actual `--network=none` spawn) live in the desktop app
and are deferred to #180's environmental work.

### Added — Backend policy logic (helpers; not yet wired into pipeline)

- `getEffectiveRiskModifier(server)` returns `1 + (zero_trust_mode ? 1 : 0)`,
  stacking on the existing `MCP_HOST_TRUST_PROFILE.riskModifier` of 1.
- `applyZeroTrustOverride()` returns a `PolicyDecision` that forces approval
  for every action when `zero_trust_mode` is true.
- Both helpers are exported from `@skytwin/policy-engine` and unit-tested,
  but **no production caller invokes them yet** — the decision pipeline
  wiring is a #222 follow-up. Until that lands, enabling zero-trust mode
  records a provenance event and changes the UI badge but does not change
  runtime behavior.

### Added — `mcp-server-repository.setZeroTrustMode(id, enabled)`

Toggles the existing `mcp_servers.zero_trust_mode` column.

### Added — Migration `034-zero-trust-provenance.sql`

Extends `capability_provenance_nodes.node_type` CHECK constraint to
include `'zero_trust_change'` for toggle audit.

### Added — API routes

- `POST /api/capabilities/:id/zero-trust/enable`
- `POST /api/capabilities/:id/zero-trust/disable`

Both ownership-checked, both write a `capability_provenance_nodes` row
with `payload: { from, to }`.

### Added — Web UX

New "Zero-trust mode" card on `apps/web/public/js/pages/capability-detail.js`
with state badge, toggle button, and explanation text.

### Tests

18 new (6 policy-engine + 4 db + 8 api).

### Out of scope (deferred)

- Container runtime hooks — needs Docker / Electron testing, lives in #180
- Per-server allowlist of OAuth-provider domains — lives in #180
- E2E verifying the container has no internet — needs Docker

## [unreleased] — Embedded LLM port scaffold (#187 partial)

Scaffolds the runtime detection + port interfaces so the rest of the
codebase can call into a future embedded-LLM implementation through a
stable contract. Real llama.cpp / Whisper / Piper integrations are
explicitly deferred — they require binary distribution and integration
testing on real models.

### Added — `@skytwin/embedded-llm`

- `detectEmbeddedRuntimes()` — checks `which`/`where` for `llama-cli`,
  `whisper-cli`, `piper`. Honors env vars (`SKYTWIN_LLAMACPP_BIN`,
  `SKYTWIN_WHISPER_BIN`, `SKYTWIN_PIPER_BIN`) for explicit overrides.
  Never spawns the binaries — existence-check only.
- `EmbeddedTextPort` / `EmbeddedSttPort` / `EmbeddedTtsPort` interfaces
  with `Null*` fallback impls. Calling `generate` / `transcribe` /
  `synthesize` on a Null impl throws `NotAvailableError` with a typed
  `runtime` field.
- 22 tests across runtime-detector and null-ports.

### Explicitly deferred

- Real llama.cpp / Whisper / Piper integration — needs binaries
- Model auto-download / auto-upgrade — needs CDN + cryptographic
  verification of model artifacts
- Speaker diarization, voice cloning, fine-tuning — out of scope for v1
- Web UI for model management — needs the real backend first

### Known interface gaps for the real-implementation PR

- `generate()` returns `Promise<string>` (full completion) — no token
  streaming. llama.cpp typically streams; the real PR may add an
  overload or a separate `generateStream()` method.
- `transcribe()` takes a raw `Buffer` — audio format implicit. Whisper
  needs a known format; the real PR may add `opts.format`.
- `synthesize()` returns a raw `Buffer` — audio mime type unspecified.
  The real PR may return `{ audio: Buffer; mimeType: string }`.
- No `init`/`dispose` lifecycle — model loading happens internally.
  The real PR may add a `create(opts)` factory.

## [unreleased] — DXT export/import scaffold (#180 partial)

The capability-transfer pipeline that `docs/dxt-transfer.md` (shipped in #211)
described — implemented end-to-end except for the desktop drag-drop UI and
the actual confirmed-install flow.

### Added — `@skytwin/dxt`

New package implementing the binary artifact format:

- 4-byte magic `DXT1` + 4-byte version + 32-byte SHA-256 + 8-byte length + JSON payload
- `serialize(input)` packs an `mcp_servers` row + skills into the binary form
- `deserialize(blob)` returns a typed `DxtResult<T>` (no thrown exceptions
  on user input — boundary contract)
- `redactCommand(args)` masks any `--token=*` / `--api-key=*` / `--secret=*`
  CLI argument before it reaches the artifact

15 unit tests (round-trip, magic mismatch, version mismatch, length mismatch,
SHA-256 tamper detection, redaction).

### Added — `dxtExportRepository` (`@skytwin/db`)

`create(input)`, `findById(id)`, `listForUser(userId)` against the
existing `dxt_exports` table from migration 027.

### Added — `apps/api/src/routes/dxt.ts`

Four routes wired under `sessionAuth + requireOwnership`:

- `POST /api/dxt/export/:serverId` — serialize + persist + return base64 blob
- `GET  /api/dxt/exports` — metadata-only listing
- `GET  /api/dxt/exports/:id/blob` — download `application/octet-stream`
- `POST /api/dxt/import` — preview-only deserialization with detection of
  whether the capability is already installed

9 API integration tests (UUID validation, ownership checks, round-trip
export → import, magic-mismatch on garbage, missing-blob 400).

### Out of scope (deferred to environmental work)

- Drag-drop UI on the desktop app — needs Electron testing
- The actual install-from-DXT flow (preview only — explicit-confirm + install
  step deferred)
- Idle bridge from #180
- Zero-trust container hooks from #180 / #183 AC#4

## [unreleased] — Always-on service: headless daemon scaffold (#191 partial)

Code-bound subset of #191. Ships:

- **Headless daemon entry point** (`apps/desktop/src/headless.ts`) — runs the
  API + worker without spawning Electron windows. Listens on
  `SKYTWIN_API_PORT` (default 4000), exposes `/health`, handles SIGTERM →
  graceful shutdown.
- **Tray menu data definitions** (`apps/desktop/src/tray.ts`) — pure-data
  `buildTrayMenuItems(state)` returning `{ label, action, enabled }[]` for
  the four states (idle / scanning / acting / paused). Testable without
  Electron. Wrapper `applyTrayMenu()` exists but is not unit-tested.
- **Service install scripts** — `install-launchd.plist` (macOS),
  `install-systemd.service` (Linux), `install-windows-service.ps1`
  (Windows). Static config files. Reference `~/.skytwin/logs/` and
  `/usr/local/bin/skytwin` as documented placeholders pending #188's
  signed-binary install path.

### Out of scope (deferred to environmental work)

- The actual Electron tray (icon registration, click handling) — needs UI testing
- Auto-launch on system startup (Settings toggle) — needs UI work
- E2E tests on real macOS / Linux / Windows (#191 AC#7)

8 unit tests for headless + tray data layer.

## [unreleased] — Credential vault passphrase rotation (#183 vault follow-up)

Implements the key-rotation flow for the per-user credential vault.

### Added — `POST /api/credential-vault/rotate`

New endpoint for passphrase rotation. Accepts `{ currentPassphrase, newPassphrase }`.
Verifies the current passphrase (rate-limited 5/min/user), derives a new key from a
new random salt, re-encrypts every `oauth_tokens` row for the user inside a single
serialisable CockroachDB transaction, bumps `current_key_version` and updates
`passphrase_salt` + `passphrase_hash` in `user_credential_vault_meta`, then refreshes
the in-memory `KeyCache`. Returns `{ status: 'rotated', tokensReencrypted: N, keyVersion: N }`.
On any transaction failure the ROLLBACK leaves the original passphrase intact.

### Added — `oauthRepository.listEncryptedForUser(userId, client?)`

SELECT all `oauth_tokens` rows with `encrypted_access_token IS NOT NULL` for the given
user. Accepts an optional `PoolClient` so the rotation transaction's serialisable
isolation actually covers the read.

### Added — `oauthRepository.rotateEncrypted(id, input, client?)`

UPDATE encrypted columns for a single row without touching plaintext columns (which
are already NULL for fully-migrated rows). Accepts an optional `PoolClient`.

### Added — `credentialVaultMetaRepository.rotatePassphrase(userId, input, client?)`

UPDATE `user_credential_vault_meta`: new salt, new passphrase hash, `current_key_version + 1`,
`rotated_at = now()`. Accepts an optional `PoolClient`.

### Added — `apps/web/public/js/pages/credential-vault.js`

New web page at hash route `#/credential-vault`. Shows vault status (initialized/unlocked,
key version, last rotated), init form, unlock form, rotate form, and lock button. Uses
the singleton-delegator pattern (`_credentialVaultListenerWired` guard, hash-route gated).
Wired into `app.js` routes and `index.html` nav.

## [unreleased] — Lazy credential-vault migration: observability hook (#183 follow-up)

The fire-and-forget `_lazyMigrate` path in `DbTokenStore.getToken` previously
swallowed migration errors silently — a flaky DB could leave a user un-migrated
indefinitely with no visible signal.

### Changed — `packages/connectors/src/oauth/db-token-store.ts`

The `.catch()` arm of the lazy-migration `Promise` now:

- Increments `lazyMigrationFailureCounter.count` (exported counter that
  downstream observability tooling can poll).
- Logs a `warn` line with `userId`, `provider`, `rowId`, and the error message.
  Plaintext tokens / passphrases / keys are NEVER logged.

The caller still receives the plaintext value (backward compat), so a single
failure does not block the user; but persistent failures are now visible.

1 new regression test asserts the counter increments and the
`lazyMigrationFailureCounter` export works.

## [unreleased] — memory-gbrain + memory-hybrid scaffolding (#197 partial scaffold for v1.0.5)

SKELETON only. No live gbrain integration is included in this entry.

### Added — `@skytwin/memory-gbrain`

New package at `packages/memory-gbrain/`. Implements `MemoryPort` from
`@skytwin/memory-port` with best-effort gbrain CLI integration:

- `src/cli-detector.ts` — detects whether `gbrain` is in PATH via `which`/`where`; returns false on any error so callers fall back cleanly.
- `src/gbrain-port.ts` — `GbrainMemoryPort` implements `MemoryPort`. Declares capabilities `{ semantic_search, code_aware_search }` only. `searchSemantic` shells out to `gbrain search --json --query=... --limit=N` with a 5 s hard timeout; returns `[]` (not an error) when gbrain is absent, exits non-zero, or times out. All write methods and `walkGraph`/`getEpisodes`/`getTriples`/`summarize`/`compress` throw `NotImplementedError` — the `HybridMemoryPort` routes these to MemPalace.
- No PII in logs: only operation names and result counts are logged, never query text.

### Added — `@skytwin/memory-hybrid`

New package at `packages/memory-hybrid/`. `HybridMemoryPort` composes any two `MemoryPort` implementations:

- Constructor: `new HybridMemoryPort({ primary, secondary, routing? })`.
- Writes go to BOTH backends. Primary write must succeed; secondary write is best-effort (failures logged, never propagated).
- Reads route per-capability: `searchSemantic` and `code_aware_search` go to primary if it declares the capability; `walkGraph`, `getEpisodes`, `getTriples`, `summarize`, `compress` go to secondary by default. Overrideable via `RoutingRules`.
- `capabilities()` returns the union of primary + secondary capabilities.
- `exportAll`/`importAll` route to secondary only.
- Verified type-compatible with `MemPalaceMemoryPort` as secondary (compile-time assertion in tests).

### Explicitly deferred to v1.0.5

- CRDB driver shim (`@skytwin/memory-gbrain-crdb-adapter`) — not included.
- Full gbrain MCP integration — not included.
- Embedding pipeline wiring — not included.
- `federated_sources` capability (gbrain v1.1+) — not included.
- Web UI for memory backend selection — not included.

## [unreleased] — Capability changelog flow + new-skill opt-in (#184 follow-up)

Implements #184 AC#2 deferred from the previous PR: `changelog://` resource
fetching, new-destructive-skill opt-in prompts, hard-rail execution block, and
weekly worker sweep.

### Added — Migration `033-mcp-server-changelogs.sql`

Two new tables:
- `mcp_server_changelogs` — one row per installed server; tracks
  `current_version`, `raw_text`, `fetched_at`, `last_seen_skills`, and
  `last_known_destructive_skills`. Updated on install, on `list_tools`
  refresh, and on the weekly worker sweep.
- `pending_skill_opt_ins` — pending opt-in prompts for newly added
  destructive skills. Unique on `(server_id, skill_name)`. Partial index
  on unresolved rows.

### Added — `mcpServerChangelogRepository` (`@skytwin/db`)

Methods: `upsert`, `getForServer`, `addPendingOptIn` (idempotent),
`listPendingOptInsForUser`, `acceptOptIn`, `rejectOptIn`,
`hasPendingOptIn`.

### Added — `McpHost.fetchChangelog` + `isDestructiveSkill` (`@skytwin/mcp-host`)

`fetchChangelog(serverId)` uses `client.listResources()` to locate a
`changelog://` resource and reads its text content. Version extraction
uses a `## vX.Y.Z` / `# X.Y.Z` heuristic (first match wins). Returns
null on any error — best-effort.

`isDestructiveSkill(skillName)` heuristic gating for opt-in prompts.
Matches create/delete/update/write/send/post/commit/push/merge/mutate/set/remove.

`onChangelogFetch` hook added to `McpHostOptions` — mirrors `onToolCall`
pattern. Wired in `execution-setup.ts` to persist changelog snapshots.

Hard rail: `checkPendingOptIn` injected from `execution-setup.ts` blocks
execution of any destructive skill that has an unaccepted `pending_skill_opt_ins`
row. Fail-safe: if the check itself throws, execution is blocked.

### Added — Worker job `changelog-poll.ts` (7-day cadence)

`runChangelogPollJob` iterates all active MCP servers, rate-limits per server
to 12 hours, diffs new destructive skills against `last_known_destructive_skills`,
and writes opt-in prompts for new ones. Wired in `apps/worker/src/index.ts`
alongside the existing metrics-rollup pattern.

### Added — API routes (in `createCapabilitiesRouter`)

- `GET  /api/capabilities/:id/changelog` — ownership-checked changelog read
- `GET  /api/capabilities/pending-opt-ins` — pending opt-in feed for user
- `POST /api/capabilities/pending-opt-ins/:id/accept` — accept with ownership check
- `POST /api/capabilities/pending-opt-ins/:id/reject` — reject with ownership check

### Added — Web UI extensions

`apps/web/public/js/pages/capability-detail.js` — Changelog card (version badge
+ collapsible raw_text). Singleton delegator unchanged.

`apps/web/public/js/pages/capabilities.js` — "New skills awaiting opt-in" section
at top of page with Accept/Reject buttons. Uses existing `_capabilitiesListenerWired`
singleton guard and adds `accept-opt-in` / `reject-opt-in` to the delegator.

## [unreleased] — Credential vault envelope encryption (#183 follow-up)

Implements AC#5 from issue #183: envelope encryption of OAuth tokens in the
database. Plaintext `access_token` / `refresh_token` columns are preserved for
backward compatibility; encrypted columns are added alongside them.

### Added — `packages/db/src/migrations/032-encrypted-oauth-tokens.sql`

Adds encrypted columns to `oauth_tokens`:
`encrypted_access_token BYTEA NULL`, `encrypted_refresh_token BYTEA NULL`,
`encryption_iv BYTEA NULL`, `encryption_tag BYTEA NULL`,
`encryption_key_version INT NOT NULL DEFAULT 1`. Drops `NOT NULL` on the
plaintext columns so lazy migration can clear them to actual `NULL`.
Also creates `user_credential_vault_meta` table for per-user passphrase salt
and verification hash.

### Added — `@skytwin/credential-vault`

New package at `packages/credential-vault/`.
- `key-derivation.ts` — scrypt-based passphrase KDF (N=32768, r=8, p=1,
  keylen=32). Exports `deriveKey`, `generateSalt`, `hashDerivedKey`,
  `verifyPassphrase`, `MIN_PASSPHRASE_LENGTH`.
- `envelope.ts` — AES-256-GCM encrypt/decrypt with a fresh 96-bit IV per call.
- `key-cache.ts` — in-process TTL key cache; evicts after 1 hour by default.
  Keys are NEVER persisted.

**Crypto choice note:** The issue spec called for Argon2id. Node.js has no
built-in Argon2id; the `argon2` npm package requires native compilation and is
a deployment hazard in this monorepo. We substitute `crypto.scrypt`, which is
memory-hard (comparable security posture to Argon2id), ships with Node 20+,
and has extensive production use. Parameters: N=2^15, r=8, p=1, keylen=32.

### Added — `apps/api/src/routes/credential-vault.ts`

Four routes under `sessionAuth + requireOwnership`:
- `POST /api/credential-vault/init` — generates salt, derives key, stores hash.
  Returns 422 for passphrase < 12 chars, 400 if already initialised.
- `POST /api/credential-vault/unlock` — verifies passphrase, populates KeyCache.
  Rate-limited to 5 attempts per minute per user; returns 429 on breach.
- `POST /api/credential-vault/lock` — evicts key from KeyCache (idempotent).
- `GET /api/credential-vault/status` — returns `{ initialized, unlocked }`.

### Enhanced — lazy migration on OAuth token reads

`packages/connectors/src/oauth/db-token-store.ts`:
1. Encrypted columns present + vault unlocked → decrypt and return.
2. Plaintext present + vault unlocked → fire-and-forget encrypt (lazy migrate);
   plaintext columns cleared to NULL.
3. Plaintext present + vault locked → return plaintext (backward compat).
4. Encrypted + vault locked → throw "credentials unavailable".

Type widening: `OAuthTokenRow.{access_token,refresh_token}` are now
`string | null`. Updated all call sites (credential-provider, oauth routes).

## [unreleased] — Provenance graph + multi-modal evidence + DXT transfer doc (#184)

Implements 3 of 4 product acceptance criteria from #184. The capability
changelog flow (AC#2) is deferred to a follow-up PR — it requires
upstream MCP server coordination (`changelog://` resource fetching +
weekly worker sweep). DXT export/import operations themselves remain
in #180; this PR ships the user-facing transfer documentation only.

### Added — Provenance graph visualization

`apps/web/public/js/pages/provenance-graph.js` — vanilla SVG/JS
force-directed graph (no D3 or external charting lib). Hash route
`#/provenance`. Filter by node type and time window. Click a node →
side flyout with full payload. Singleton-delegator pattern (hash-route
gated, no inline event handlers).

### Added — `GET /api/capabilities/provenance-graph`

Returns `{ nodes, edges }` from `capability_provenance_nodes` +
`capability_provenance_edges` for the requesting user. Filter
parameters: nodeType, since (ISO timestamp), serverId, limit (default
200, max 500). Edges only included when both endpoints are in the
returned node set. PII redaction applied before serialisation.

### Added — Multi-modal evidence in AppSuggestion responses

`GET /api/capabilities/suggestions` now attaches an `evidence` array
to each suggestion. Per-signal previews built server-side via
`buildEvidencePreview(signal)`:

- **Email**: subject + max-80-char snippet, with email addresses and
  phone numbers stripped to `[email]` / `[phone]` placeholders.
- **Calendar**: event title + start time.
- **File (image, ≤512KB)**: thumbnail data URL.
- **File (other)**: name, extension, size in KB.
- **Code file**: language + first 10 imports — NEVER raw content.

The capabilities page renders the previews inline under each
suggestion card.

### Added — `docs/dxt-transfer.md`

User flow describing how to export a DXT artifact on machine A and
drop it on machine B. Privacy considerations, what the artifact does
and does not contain (no OAuth tokens — user must reconnect on the
new machine), and limitations vs live federation (deferred to v1.1).

### Consolidated PII redaction

`redactPayload()` is now the single canonical PII redaction function
in `capabilities.ts`, exported and shared across `/audit` (#183),
`/provenance-graph` (#184), and the evidence-preview path. Match is
exact (not regex) so legitimate fields like `serverName`, `skillName`,
`recipeName` stay visible. The duplicate `redactPII` from #183 has
been removed.

## [unreleased] — Observability + audit + cost ceilings (#183)

Implements three of the five acceptance criteria from issue #183.
Zero-trust container isolation (AC#4) and credential-vault Argon2id
encryption (AC#5) are deferred to a follow-up PR.

### Added — `@skytwin/observability`

New package: in-memory ring buffer (`MetricsCollector`) collects per-server
tool call outcomes (latency_ms, success, spend_cents). `MetricsRollupService`
drains the buffer and writes 1-minute rollup rows to `mcp_server_metrics`.
Threshold constants (`SUCCESS_RATE_WARN_THRESHOLD`, `LATENCY_P95_WARN_MS`,
`BUFFER_NEAR_FULL_FRACTION`) are exported so the UI adapts without a rebuild.
6 unit tests for MetricsCollector, 6 for MetricsRollupService.

### Added — `packages/db/src/repositories/mcp-server-metrics-repository.ts`

New repository: `writeBucket` (upsert with ON CONFLICT accumulation),
`getRecent`, `getSparkline`. Wired into the db package exports.

### Added — `apps/worker/src/jobs/metrics-rollup.ts`

Worker job `runMetricsRollupJob()` drains the shared `MetricsCollector`
every 60 seconds and writes to DB. Exports `sharedMetricsCollector`
singleton for mcp-host integration.

### Added — `apps/web/public/js/pages/capabilities-audit.js`

Capability audit trail page at `#/capabilities/audit`. Paginated list of
`capability_provenance_nodes` with filters: event type, date range, and
free-text keyword search. Singleton delegator pattern (hash-gated, no
stacked listeners). Wired into `app.js` routes table.

### Added — `GET /api/capabilities/audit`

Paginated provenance node endpoint with additive SQL filters (nodeType,
serverId, dateFrom, dateTo, q). PII fields (email, name, token, password,
credential) are redacted before serialisation.

### Added — `GET /api/capabilities/:id/metrics`

Returns sparkline data (latency p50/p95, success rate) and recent bucket
rows for the capability detail page.

### Enhanced — `packages/policy-engine/src/spend-tracker.ts`

Added `checkMonthlyLimit()` and `getMonthlySpendForApp()` to `SpendTracker`.
`resolveEffectiveCaps()` now returns `maxMonthlySpendCents` from the
per-app override (clamp-down semantics preserved). `SpendRepositoryPort`
gains `getMonthlyTotal()`. 8 new unit tests.

### Enhanced — `apps/web/public/js/pages/capability-detail.js`

Added "Performance" section with SVG sparklines (latency p50/p95, success
rate, no external charting library). Added "Monthly spend" meter: "$X.XX
of $Y.YY used this month" progress bar; shows "No monthly cap configured"
with settings link when none is set.

## [unreleased] — Twin-as-MCP-server (#182)

SkyTwin now exposes itself as an MCP server so external agents (Claude
Desktop, Cursor, future hosts) can read the user's memory, query
preferences, propose actions for review, and subscribe to recent
signals — under explicit, scope-limited tokens.

### Added — `@skytwin/twin-mcp-server` app

New app under `apps/twin-mcp-server/` running an HTTP MCP endpoint via
`StreamableHTTPServerTransport` (stateless mode: each request gets a
fresh `McpServer` with tools filtered to the authenticated token's
scope). Tools: `whoami`, `query_memory`, `get_preferences`,
`propose_action`, `subscribe_signals`. 34 unit tests.

### Added — External-agent token model

Migration `031-external-agent-tokens.sql` adds `external_agent_tokens`
(per-user issuance, scope, agent_name, hashed token, revoke timestamp).
Tokens are SHA-256 hashed at rest; the plaintext is returned exactly
once at issuance. New repository
`packages/db/src/repositories/external-agent-token-repository.ts` and
HTTP routes under `apps/api/src/routes/external-agents.ts` for issue /
list / revoke. 9 API integration tests.

### Hard rails (non-negotiable)

1. Tokens hashed at rest; plaintext returned once.
2. `propose_action` never auto-executes — every result is recorded with
   `autoExecuted: false` and `requiresApproval: true`.
3. Every tool call writes a `capability_provenance_nodes` row of type
   `external_agent` for full audit trail.
4. Scope strictly enforced via `scopeAllows` gating tool registration
   on the per-request `McpServer` instance.
5. Revocation is immediate (`WHERE revoked_at IS NULL`).
6. PII fields (`email`, `phone`, `password`, `token`, `secret`,
   `apiKey`, `authorization`, etc.) are recursively redacted from
   provenance payloads.

### Added — Web UX

`apps/web/public/js/pages/twin-server-tokens.js` (singleton-delegator
pattern, hash-route gated) — list active tokens, issue a new token
(shown once), revoke. Wired into the dashboard nav.

### Added — Protocol docs

`docs/twin-mcp-protocol.md` — handoff document for external-agent
integrators describing endpoint, auth, scope semantics, tool surface,
and example calls.

## [unreleased] — Capability Acquisition Loop foundation (#173)

First child of Epic #195 (Capability Acquisition Loop). Establishes the
MCP-as-capability-port and per-app autonomy primitives that the rest of
Phase 1 builds on. Companion architecture document: `docs/architecture-philosophy.md`.

### Added — `@skytwin/mcp-host`

New package implementing `IronClawAdapter` over MCP (Model Context Protocol).
Stdio + HTTP/SSE transports. Each MCP server runs under `@skytwin/core`
`CircuitBreaker`: 3 failures in 60s → status `failed`, no auto-restart loop.
Per-server resource limits (memory cap via `--max-old-space-size`, CPU/no-egress
are container-level placeholders documented for #180/#183). Best-effort rollback
via paired `*_undo` / `unsend_*` heuristics. 23 unit tests passing + 3 skipped
real-MCP-server integration tests TODO'd for follow-up commit.

### Added — `@skytwin/registry-client`

New package projecting a unified MCP server catalog. Embedded `data/curated.json`
ships 66 hand-vetted entries (15 Anthropic-verified reference servers + 51
community), distributed across 9 categories (developer, productivity, lifestyle,
data, search, media, home, finance, social). Works without internet access.
Smithery API client augments the embedded list nightly; falls back to embedded
on 5xx; rolling-1h failure window with `circuit_open` after 3 failures. 19 unit
tests passing.

`data/oauth_quirks.json` documents per-server OAuth handoff quirks for
notion, linear, slack, github, google-drive, gmail, google-calendar.

### Added — Per-app autonomy overrides

`AutonomySettings.perAppOverrides` keyed by registry id. Per-app overrides may
only narrow autonomy; the user-global cap is always the upper bound. Hard rails
(FS denylist, resource caps, audit log) are not subject to overrides.

`SpendTracker.checkDailyLimit` accepts an optional `appRegistryId`. When supplied,
the per-app cap is consulted before falling back to user-global. Rejection
messages include the per-app context for debuggability.
`resolveEffectiveCaps(settings, appRegistryId)` is exported for reuse by the
policy engine and decision pipeline. 15 new unit tests.

### Added — Migration `027-capability-acquisition.sql`

Additive only. Down-migration drops new tables in reverse FK order. New tables:
`mcp_servers`, `mcp_server_skills`, `app_suggestions`,
`capability_provenance_nodes`/`_edges`, `fs_scan_roots`, `fs_file_index`,
`capability_recipes`, `twin_briefings`, `mcp_server_metrics`, `dxt_exports`.
Per-app spend caps (`per_app_*_cents`) live on `mcp_servers` and feed the
SpendTracker per-app override path.

### Added — `MCP_HOST_TRUST_PROFILE` + boot wiring

New trust profile registered in `@skytwin/execution-router`: partial
reversibility, OAuth auth model, `riskModifier: 1`. `apps/api`'s
`createExecutionRouter()` now constructs an `McpHost` and registers it on the
`AdapterRegistry` at startup with zero servers. Servers are added via the
user-facing install flow coming in #176.

### Tests

103/103 in `@skytwin/policy-engine` (88 existing + 15 new per-app overrides).
19/19 in `@skytwin/registry-client`. 23 passing + 3 skipped in `@skytwin/mcp-host`.
Full workspace `pnpm build` green across 22 packages.

## [0.6.21.0] - 2026-05-06

Bump `electron-builder` from 24.x to 26.8.1. Supersedes Dependabot PR #65, which was held back because the version bump alone broke `electron-builder --linux/win/mac` with a config schema validation error.

### Why the dependabot bump alone failed

electron-builder v26 tightened the `linux.desktop` schema. Pre-v26, you could put any `.desktop` file key (`Name`, `Comment`, `Categories`, ...) directly under `linux.desktop`. v26 expects `linux.desktop` to be `{ desktopActions?, entry? }` — your `.desktop` file fields go under `desktop.entry`.

The CI failure surfaced as:

```
configuration.linux.desktop has an unknown property 'Name'.
configuration.linux.desktop has an unknown property 'Comment'.
configuration.linux.desktop has an unknown property 'Categories'.
```

### Fix

Move the three `.desktop` keys into `linux.desktop.entry` in `apps/desktop/package.json`:

```json
"linux": {
  "desktop": {
    "entry": {
      "Name": "SkyTwin",
      "Comment": "Your personal AI assistant",
      "Categories": "Utility;Office;"
    }
  }
}
```

Verified locally with `npx electron-builder --linux --dir` — schema validation passes, `dist-electron/linux-arm64-unpacked/` is produced cleanly.

### Tests

Backend test suite still green across 40 packages. CI's macOS/Windows/Linux desktop jobs will exercise the actual installer build.

## [0.6.20.0] - 2026-05-06

Fix three integration-live tests that fail locally when an API server is up but the web dashboard isn't — common when a sibling Conductor worktree is running its own API on `:3100` but no web server on `:3200`.

### Fixed — `apps/desktop/src/__tests__/integration-live.test.ts`

Pre-fix, every describe block was gated on a single `serverAvailable` predicate that only checked `http://localhost:3100/api/health/live`. Two blocks ("web dashboard proxy (desktop embeds this)" and "desktop service manager targets") fetched `http://localhost:3200` — so when the API was up but the web app wasn't, those blocks ran and failed instead of skipping.

Added a separate `webAvailable = isServerUp('http://localhost:3200/')` predicate. The "web dashboard proxy" block and a new "desktop service manager targets — web dashboard" block (split out of the existing service-manager block, which had one API test + one web test mixed together) gate on `webAvailable`. The pure-API "desktop service manager targets — API" block keeps `serverAvailable`.

### Fixed — `apps/mobile/src/__tests__/integration-live.test.ts`

Same shape of bug. The "web proxy (mobile browser fallback path)" describe block fetched `http://localhost:3200` but was gated on `serverAvailable` (API only). Added the same independent `webAvailable` check and gated that block on it. The `isServerUp` helper now takes a URL argument so both predicates share the implementation.

### Why CI was unaffected

CI doesn't start either server, so `serverAvailable` was false there and all describe blocks correctly skipped. The bug only surfaced on local dev machines where an API happened to be running. No CI behavior change from this PR.

### Tests

`pnpm --filter @skytwin/desktop test` and `pnpm --filter @skytwin/mobile test` both clean locally now (4 + 2 skipped, 124 + 116 passed). Backend test suite still green across 40 packages.

## [0.6.19.0] - 2026-05-06

Convert the AI provider card's nine remaining inline event handlers to data-action delegation. Pairs with v0.6.18.0 — together they close the last CLAUDE.md "no inline handlers" violations in the web SPA.

### Fixed — `.ai-provider-card` had four inline drag handlers + five inline onchange

```html
<div class="ai-provider-card" draggable="true" data-idx="${idx}"
     ondragstart="aiDragStart(event, ${idx})"
     ondragover="aiDragOver(event, ${idx})"
     ondragleave="aiDragLeave(event)"
     ondrop="aiDrop(event, ${idx})"
     ...>
  <input type="checkbox" onchange="aiToggleEnabled(${idx}, this.checked)">
  <input ... onchange="aiUpdateField(${idx}, 'model', this.value)">
  <select ... onchange="aiUpdateField(${idx}, 'model', this.value)">
  <input ... onchange="aiUpdateField(${idx}, 'baseUrl', this.value)">
  <input ... onchange="aiUpdateField(${idx}, 'apiKey', this.value)">
```

Same XSS-unsafe-by-construction concern as v0.6.18.0: `idx` is a safe integer today, but the JS-string-literal-context interpolation pattern is the wrong shape.

### Fix

Removed all nine inline handlers. Card markup now uses `data-region="ai-provider-card"` (so the delegated listeners can find the card via `closest()`) and inputs carry `data-action="ai-toggle-enabled"` / `data-action="ai-update-field"` + `data-field="model"|"baseUrl"|"apiKey"`.

Two new delegated listeners hoisted into the existing `ensureSettingsListener()` singleton:

1. `change` — resolves card via closest, dispatches `ai-toggle-enabled` / `ai-update-field` to existing `window.aiToggleEnabled` / `window.aiUpdateField`
2. `dragstart` / `dragover` / `dragleave` / `drop` — resolves card via closest, dispatches to existing `window.aiDragStart` / `aiDragOver` / `aiDragLeave` / `aiDrop`

The original drag handlers used `e.currentTarget` to set inline styles (opacity, borderColor). Under delegation `currentTarget` is `document`, so the listener shadows that property on the event with the resolved card before delegating. The `window.*` function bodies are unchanged — call shape preserved verbatim.

### Tests

Backend test suite still green across 40 packages. Drag + change behavior is browser-only.

## [0.6.18.0] - 2026-05-06

Convert the last inline event handler on the Twin/learnings page to data-action delegation. Closes a CLAUDE.md violation that's been hiding in `twin.js`.

### Fixed — `twin.js` "Tell me something about yourself" form had inline onsubmit

The "Save this preference" form rendered:

```html
<form id="add-pref-form" onsubmit="return handleAddPreference(event, '${userId}')">
```

CLAUDE.md flags this pattern as **XSS-unsafe-by-construction** even when the current values (UUIDs, enums) happen to be safe today: `escapeHtml` is HTML-context safe, but the value lands inside a JS-string-literal context inside the inline handler attribute. A future caller passing user-derived input would be smuggling code, not data.

Fix: swap to `data-action="add-preference"` + `data-user-id="${escapeHtml(userId)}"` (HTML attribute context, safe), then add a delegated `submit` listener to the existing `_twinInsightWired` singleton block. The listener checks `data-action`, reads `userId` from `data-user-id`, and calls the existing `window.handleAddPreference(event, userId)` — call shape preserved verbatim so the function body doesn't need to change.

The settings.js AI provider card still has 9 inline handlers (`ondragstart`, `ondragover`, `ondragleave`, `ondrop`, plus 5 `onchange`). That's the v0.6.19.0 follow-up.

### Tests

Backend test suite still green across 40 packages. Form behavior is browser-only.

## [0.6.17.0] - 2026-05-06

Two bugs in the Audit page caught during a sweep of less-touched surfaces.

### Fixed — broken Retry button on the Audit page

`renderAudit()` passed `retry: load` to `renderApiError({ context, retry })`. `load` was never defined — the function is called `loadAudit`. So when the API was down and the page rendered the friendly-error card, clicking Retry threw `ReferenceError: load is not defined` silently in the console and nothing reloaded. Renamed the call site to `retry: loadAudit`.

### Fixed — listener-stacking on every navigation back to /audit

The previous implementation wired `addEventListener('click', loadAudit)` on the Refresh button and `addEventListener('change', loadAudit)` on the filter inputs *inside* `renderAudit()`. Each navigation to /audit re-runs `renderAudit()`, which means after N visits each filter change fires `loadAudit()` N times in parallel — the same singleton-delegator pattern violation `CLAUDE.md` flags for approvals/settings/decisions/dashboard-view.

Fix: hoisted the listeners to a module-level `ensureAuditListener()` with a `_auditListenerWired` guard, attached on `document`, gated by `window.location.hash` (not DOM containment, since the SPA reuses one `#page-content` element across routes). Filter inputs and the Refresh button moved to `data-action` / `data-region` attributes so the delegator can identify them.

`loadAudit()` reads `_auditUserId` from module scope (set in `renderAudit()`) — same pattern as approvals.js's `_approvalsUserId`. Defends against the dev "Switch user" scenario where a closure over a render-time userId would fire under the wrong account.

### Tests

Backend test suite still green across 40 packages. Audit page is browser-only.

## [0.6.16.0] - 2026-05-06

Make the chat thread delete recoverable. Pre-fix, clicking the X next to a thread title fired the DELETE immediately with no confirm and no undo — risky for non-technical users on small screens where the X sits 8px from the thread title.

### Added — toast `action: { label, onClick }` option

`showToast(msg, { ..., action: { label: 'Undo', onClick: fn } })` renders a pill-shaped action button between the message and the close X. Clicking the action runs `onClick` then dismisses; clicking elsewhere on the toast still dismisses without firing the action. The signature matches the comment hint we left in `toast.js` v0.6.8.0 ("if we ever add action buttons to toasts in the future").

CSS is namespaced `.skytoast-action` — outline-style accent pill so it reads distinct from the close X.

### Changed — `handleDeleteThread` is now soft-delete with undo

Click X → optimistic UI removal + 6s undo toast. If the user clicks Undo, the timer is canceled and the thread restores without ever hitting the server. If 6s elapses, the real `deleteAssistantThread` API call fires.

State preserved during the undo window:
- `previousThreads` slice for full rollback
- `previousMessages` slice when the active thread itself was the one being deleted (restoring the active thread restores the full chat history mid-undo, no fetch needed)
- Pending timers tracked in `_pendingDeletes: Map<threadId, timeoutHandle>` so a misclicked X followed by another misclick on the same thread is a no-op (the second click sees a pending entry and bails)

If the active thread was the one deleted, the next-most-recent thread becomes active during the undo window and its messages are fetched async — so the chat pane shows something instead of going blank for 6 seconds.

### Tests

Backend test suite still green across 40 packages. Undo behavior is browser-only.

## [0.6.15.0] - 2026-05-06

Stop yanking the user back to the bottom of the chat while they're scrolled up reading history.

### Fixed — chunk-by-chunk streaming forced `scrollTop = scrollHeight` on every token

Prior behavior: open a long thread, scroll up to re-read an earlier assistant reply, send a new prompt → every chunk that lands snaps the scroll back to the bottom mid-token. Reading history during a streaming response was effectively impossible.

New behavior: `maybeAutoScroll(container)` only follows the stream when the messages region was already within `NEAR_BOTTOM_THRESHOLD_PX` (80px) of the bottom. If the user has scrolled up, the chunks accumulate quietly off-screen and they keep reading what they were reading.

### Added — "↓ Jump to latest" floating pill

Sits absolutely-positioned over the chat pane, above the composer. Hidden via the `hidden` attribute when the user is at the bottom; revealed when they scroll away. Click → smooth jump to the live tail. Drives off the same `isNearBottom()` predicate that gates auto-scroll, so the two behaviors always agree.

The scroll listener is delegated on `document` with capture phase (scroll events don't bubble by default, so capture is required to see them from the inner pane). The jump button uses the existing `data-action="jump-latest"` delegation pattern.

### Tests

Backend test suite still green across 40 packages. Scroll behavior is browser-only.

## [0.6.14.0] - 2026-05-06

Mobile fix for the assistant chat: composer no longer disappears behind the soft keyboard.

### Fixed — `vh` → `dvh` on `.assistant-shell` height

The chat shell sized itself with `height: calc(100vh - 12rem)`. On mobile, `vh` is fixed to the *visual* viewport height as the page first paints — it doesn't shrink when the keyboard appears. Result: tap the composer, keyboard slides up, the composer slides up with it but the parent shell still thinks it has full-viewport height, so the composer ends up rendered behind the keyboard. The user can't see what they're typing.

`dvh` (dynamic viewport height, stable in all evergreen browsers since 2022) shrinks with the keyboard so the composer stays visible. Both the desktop default and the `<= 768px` breakpoint update; the `vh` line stays above the `dvh` line as a fallback for older browsers (last-rule-wins, so `dvh` wins where supported).

### Tests

CSS-only change. Backend test suite still green across 40 packages.

## [0.6.13.0] - 2026-05-06

Bump `electron-store` from 8.x to 11.x. Supersedes Dependabot PR #71, which was held back because the bump alone broke `tsc` on `apps/desktop/src/window-state.ts`.

### Why it broke

electron-store v9 became ESM-only and started extending the (also ESM-only) `Conf` class for its `.get` / `.set` API. The desktop app's `tsconfig.json` uses `module: commonjs`, so under that resolution mode TypeScript can't follow the inheritance chain across the ESM boundary — it sees `ElectronStore<T>` as a class with no methods, even though `.get` / `.set` exist on the parent at runtime.

At runtime this is fine: Electron 41 ships Node 22.14, which supports `require()` of ESM modules natively (stable since Node 22.12).

### Fix

Narrow the constructor result to a small structural surface that matches the three call sites we actually use (`get('windowBounds')`, `set('windowBounds', …)`, `set('windowBounds.isMaximized', …)`) via `as unknown as WindowBoundsStore`. Easier to audit than a blanket `any`, and the constructor signature + runtime call sites stay unchanged so a future ESM migration of `apps/desktop/tsconfig.json` can drop the cast cleanly.

### Tests

Backend test suite still green across 40 packages. `pnpm tsc --noEmit` clean in `apps/desktop`. Pre-existing 3 failures in `integration-live.test.ts` (require localhost:3200 to be running) are unaffected.

## [0.6.12.0] - 2026-05-05

Two assistant composer polish items the dashboard "Ask your twin" widget already had — bring the chat surface up to parity.

### Added — `Enter` / `Shift+Enter` keyboard hint under the chat composer

The dashboard "Ask your twin" widget surfaces this convention with a small `<kbd>` hint underneath. The chat composer was missing it, so a non-technical user would either guess (and accidentally newline when they meant to send) or never know newlines were available. New `.assistant-composer-hint` block mirrors the dashboard pattern.

### Added — composer draft persists across navigation per thread

A user who pops to `/approvals` to look something up before finishing a prompt now keeps their half-typed text. Storage is `sessionStorage` (not localStorage) — drafts are inherently transient and shouldn't leak across browser sessions. Keying:

- One bucket per thread via `assistantDraftKey(threadId)` in `apps/web/public/js/storage-keys.js`
- Brand-new threads write to the `'new'` bucket; on first send the thread ID lands and subsequent edits flow into the new bucket
- Draft is restored in `paint()` after `innerHTML` is set, with cursor at end so a quick edit ("…and tell me why") flows
- Draft is cleared on send (after the optimistic user bubble lands)

The save is wired through a delegated `input` listener on `document` (same pattern as the click and keydown delegators on this page); each keystroke is one `sessionStorage.setItem` of <few KB, well within the budget.

### Tests

Backend test suite still green across 40 packages. Composer behavior is browser-only.

## [0.6.11.0] - 2026-05-05

Adds a Stop button to the assistant chat so users can interrupt a long generation. Pre-fix the only escape was navigating away — which left the request hanging server-side and lost any partial content the user could already see.

### Added — `Stop` button replaces `Send` while streaming

- `sendAssistantMessageStream(...)` in `apps/web/public/js/api-client.js` now accepts an optional `{ signal }` so the caller can pass an `AbortSignal`. AbortError is surfaced verbatim (not wrapped in the friendly "Unable to reach the server" fallback) so callers can branch on `err.name`. The SSE read loop also rethrows AbortError instead of the generic transport-error path.
- `apps/web/public/js/pages/assistant.js` creates a fresh `AbortController` per send, stores it on `_state.streamController`, and renders a Stop button with a square-stop glyph in place of Send while `_state.sending` is true. Click → `controller.abort()` → fetch unwinds → handleSend's catch sees `AbortError` and **keeps whatever streamed so far as a real assistant bubble** (not an error caveat). The user gets to keep what they got.
- The `_state.streamController` is cleared in the finally block, gated on identity check (`=== controller`) to defend against a hypothetical race even though `handleSend` already bails early when `_state.sending` is true.

### CSS

`.assistant-composer-stop` keeps the same dimensions as `.assistant-composer-send` so the button swap doesn't shift the composer layout. Calm bg-card background instead of the action-accent — the affordance is "interrupt", not "go." A solid square ::before glyph reads before the word "Stop" does.

### Tests

Backend test suite still green across 40 packages. Stop-button behavior is browser-only.

## [0.6.10.0] - 2026-05-05

Adds suggested-prompt chips to the assistant empty state. The chat is now SkyTwin's headline surface for non-technical users, but landing on it with no conversation history shows only a generic "Ask anything" hint — paralyzingly open for a user who doesn't yet have a model of what their twin can do.

### Added — four clickable suggestion chips on `/assistant` empty state

- "What did you handle today?"
- "What's waiting for my OK?"
- "What have you learned about me so far?"
- "Archive promotional emails from last week"

Click → fills the composer and focuses the input with cursor at end. **Does not auto-send** — the chip is a starting point, not a commitment, so the user can edit before hitting Enter. Same `data-action` delegation pattern the page already uses for `select-thread` / `delete-thread`.

The chips cover three "show me what's going on" prompts (read-only; safe first contact) plus one action-routing example so the user discovers chat can also queue actions for approval. The action-routing intent flows through the `intentRoute` pipeline that landed in v0.6.4.0 (#148 v1), so a click → edit → send already lands on the approvals page.

### CSS

`.assistant-suggestions` flex-wraps the pill-shaped chips below the empty-state copy. Restored `opacity: 1` on the container because the parent `.assistant-empty` dims its prose to 0.75 — without the override the chips would read as disabled. Hover lifts the chip 1px and tints the border to the accent color; respects `prefers-reduced-motion`.

### Tests

Backend test suite still green across 40 packages. Empty-state UI is browser-only.

## [0.6.9.0] - 2026-05-05

Toast cleanup + back-online affordance. Closes the "migrate legacy `.toast` callers" item that was deferred in v0.6.8.0 so the duplicate CSS can come out, and adds a back-online toast so the user gets explicit confirmation when the API recovers (instead of having to notice the banner disappear).

### Changed — three pages migrated from raw `.toast` DOM to `showToast()`

- `apps/web/public/js/pages/decisions.js` — the "Walked back" success toast (with quoted reason) and the "Couldn't walk that back" error toast now use `showToast(msg, { kind })`. Both use a 4s duration to give the user time to read the quoted reason.
- `apps/web/public/js/pages/twin.js` — the "Got it, I'll remember that" / "Removed" correction toast.
- `apps/web/public/js/pages/approvals.js` — removed the local 12-line `showToast(message, type)` helper (manual `requestAnimationFrame` + `.visible` toggle + nested `setTimeout`); the three call sites — escalation choice, escalation custom-text, and approve/reject — now use the shared `showToast(msg, { kind: 'success' })`.

Net: −33 lines of per-file DOM toast plumbing; toast behavior now consistent across pages (same animation, same dismiss-on-click, same hover-to-pause, same screen-reader announcement).

### Added — back-online toast on connection recovery

`updateConnectionStatus()` in `apps/web/public/js/app.js` now edge-triggers a `showToast('Back online — SkyTwin is listening again.', { kind: 'success' })` when transitioning from offline → online (either SSE reconnect or a successful health check after a failure). Skips the very first call after page load (no prior offline state to "recover" from) by initializing `_wasOffline = null` rather than `false`. Without this, the user has to notice the disconnect banner disappear — easy to miss when the banner is the only signal. The toast complements the banner by surfacing the recovery actively.

### Removed — legacy `.toast` CSS block

Deleted the `.toast`, `.toast.visible`, `.toast-success`, `.toast-error` rules at the previous line 745 of `apps/web/public/css/styles.css`. With all callers migrated, those classes are dead code. Updated the explanatory comment on the `.skytoast-*` block to note the migration completed in this version. Note: `apps/web/public/js/sse-client.js` has its own internal `showToast(title, message, type)` for SSE notifications using inline styles (not the `.toast` class), so it's unaffected.

### Tests

Backend test suite still green across 40 packages (212 passed in @skytwin/api alone, plus 104 in ironclaw-adapter). Toast component is browser-only; no new unit tests.

## [0.6.8.0] - 2026-05-05

Closes UX review #10 — adds reusable toast notifications + Settings auto-save. The toast component is the reusable infrastructure piece several deferred findings were waiting on.

### Added — `apps/web/public/js/toast.js` (new module)

`showToast(message, { kind, durationMs })` — bottom-right toast stack with four kinds (success / info / warning / danger), each color-coded via theme variables. Auto-dismiss after 3.5s (success/info) or 6s (warning/danger), but pauses on hover so the user can read longer. Click anywhere on the toast to dismiss early. `aria-live="polite"` on the stack so screen readers announce messages without stealing focus. Respects `prefers-reduced-motion` (slide-in animation no-ops). `durationMs: 0` makes a toast sticky.

Convenience wrappers: `showSavedToast()` and `showErrorToast(message)`.

CSS classes are namespaced `.skytoast-*` to avoid colliding with the legacy `.toast` rules used by approvals.js / decisions.js / twin.js for inline "Saved" indicators. Eventually those callers can migrate to `showToast()` and the legacy CSS can come out.

### Changed — Settings auto-saves the autonomy tier and spending guardrails

- **Tier auto-save** — selecting a different "How much should your twin do?" option auto-saves 800ms after the click (long enough that mis-clicks don't ping the server, short enough to feel responsive). Save button still works for users who prefer the explicit affordance.
- **Spending guardrails auto-save** — typing in the per-action / per-day caps OR toggling "Always ask before doing something that can't be undone" auto-saves 1.2s after the last edit (slightly slower debounce because the user is typing into a number field). Skips if either field is mid-edit (NaN).
- Both end with a "Saved ✓" toast. Failures show the centralized friendly error message.

### Tests

No new unit tests — toast + auto-save are browser-only. Backend test suite still green across 40 packages. Visual verification screenshots in `.context/ux-review/30-toasts-working.png` and `31-toasts-styled.png`.

### What's left from FINDINGS.md

- **Hosted OAuth deployment** (#1, infra)
- **More Advanced section consolidation** (#8 follow-up)
- **Onboarding step count audit** (#14, needs product input)
- **Migrate legacy `.toast` callers** to the new `showToast()` API so the duplicate CSS comes out (cleanup, low priority)

## [0.6.7.0] - 2026-05-05

Last batch from the browser-agent review. Closes the remaining tractable items: hosted-OAuth code support (the unblocker for "everyone can use it") and Settings cleanup. The actual hosted Google OAuth app verification is still infra work outside this repo.

### Added — hosted OAuth code path (UX review #1 P0 — code support shipped)

- **`/api/credentials/status` now returns `google.hosted: boolean`** — set true when `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` env vars are wired (the operator-supplied hosted-OAuth case). Distinguishes from `google.configured` which is true for either hosted OR user-supplied DB credentials.
- **Setup page short-circuits the GCP walkthrough when hosted is true.** Pre-fix, every install asked the user to walk through Google Cloud Console (~95% of non-technical users would not complete this). Now: when the operator ships hosted credentials via env vars, the Setup page collapses to a small "Your SkyTwin install includes Google access — no developer setup needed. Open Settings → Connected accounts and click **Connect**." card with a one-click link.
- **No application code change needed for operators** — set the env vars on the deploy and the BYO walkthrough disappears. The actual hosted SaaS deploy still needs a Google-verified OAuth app (separate infra work), but the application is now ready to receive those credentials.

### Fixed — Settings: dev-only "switch user" gated behind `?dev=1` (P1 #8)

- Pre-fix the Settings page had 5 collapsed "Advanced —" sections, signaling "this app has a lot of hidden complexity" to a non-technical user. The "Advanced — switch user (developer)" section is dev-only — used while standing up multiple test accounts on the same machine; no end user needs it.
- Now: gated behind `?dev=1` query string. Default Settings view drops to 4 disclosure sections instead of 5; the dev workflow is unchanged (`?dev=1` is sticky in the URL bar for devs who want it).

### Tests

No new unit tests — every change is in browser-only code OR the credentials route response shape (covered indirectly by the existing credentials-routes integration tests). Backend test suite still green across 40 packages.

### What's still open from FINDINGS.md

- **Hosted OAuth (P0 #1)** — code path now ships in this PR. Final step is creating the verified Google OAuth app + production hosting. Not a code change, infra/operations work.
- **Auto-save with toast (P1 #10)** — needs a toast component first.
- **More "Advanced —" consolidation** — execution routing + domain overrides + escalation triggers are advanced but legitimately user-facing; consolidating them needs a small refactor of the disclosure pattern.
- **Onboarding step count audit (P1 #14)** — see if any of the 5 onboarding steps can be optional-after-onboard. Needs product input.

## [0.6.6.0] - 2026-05-05

UX polish — second wave from the same browser-agent visual review that produced #154. Picks up the P1/P2 findings that were deferred from the hardening pass: Settings cleanup, theme switcher relocation, console-spam reduction, date input theming, onboarding modal dimmer, Chat → Settings deep-link.

### Fixed — Settings page is more honest about what's required and where things live

- **Theme switcher relocated to Settings (P1 #7).** Pre-fix the theme picker pill (`🌑 Quiet Confidence ▼`) sat on every page header next to the page title, where it looked like a breadcrumb / tag rather than a clickable control. Now lives in a dedicated **"Visual theme"** card in Settings with the description "Pick how the dashboard looks. Changes apply immediately." The header is back to just the page title + user badge.
- **"AI brain — needed for Chat (optional otherwise)" (P1 #9).** Pre-fix this section was titled "Add a smarter AI brain (optional)" — but if you visit `#/assistant` the API returns 409 "No AI provider configured." The "(optional)" was lying. Now the title surfaces the dependency, and when no providers are configured the body explicitly says "**The Chat surface needs at least one AI provider configured here** to generate replies."

### Fixed — Chat deep-links to Settings when no provider is configured (P1 #9)

- The Chat page used to render the raw "No AI provider configured" message in a bubble with no path forward. Now: when the assistant route returns a `bad-request` ApiError mentioning "provider", the chat shows "I need an AI provider configured before I can chat. Open Settings → AI brain to add one." with a deep-link footer ("Open Settings → AI brain →") that hash-routes to `#/settings`.

### Fixed — onboarding modal dimmer (P2 #15)

- Pre-fix the sidebar bled through the onboarding modal at ~25% visible (modal overlay was `rgba(0,0,0,.85)` but the sidebar has its own glass effect that survived). Drew the eye and read as "stuff I could click but can't." Bumped overlay to `rgba(0,0,0,.92)` + a `backdrop-filter: blur(4px)` so anything behind the modal is properly muted.

### Fixed — console-error spam when API is offline (P2 #20)

- Pre-fix, with the API down, the web client produced 110+ console errors per minute (every 10s badge poll, every SSE reconnect, every health check). New `isApiKnownOffline()` exported from `api-client.js`: any failed fetch with `kind: 'offline'` flips the flag; any successful fetch flips it back.
- The badge-poll loop in `app.js` now backs off from 10s → 60s when the flag is set. The connection banner already tells the user the API is offline; aggressive polling adds noise without information.

### Fixed — date input theming on Audit page (P1 #11)

- Pre-fix the audit-trail filters used raw `<input type="date">` with the OS-default styling (gray box, mm/dd/yyyy placeholder), which clashed with the dark glass aesthetic everywhere else.
- New `.themed-date` class matches the rest of the form-input styling, with `color-scheme: dark light` so the native picker icon uses light glyphs on dark themes (vs. invisible dark-on-dark). Webkit-specific `::-webkit-calendar-picker-indicator` filter gets the icon to read at high enough contrast.

### Tests

No new unit tests — every change is in browser-only code. Verified via the same browser-agent visual review (`.context/ux-review/20-23-` screenshots show the after state). Full backend test suite still green across 40 packages.

### What's still open from the UX review

- **Hosted OAuth (P0 #1)** — needs verified Google OAuth app + production hosting. Tracked separately.
- **Settings consolidate "Advanced" sections (P1 #8)** — the page now has 5 collapsed Advanced sections; consolidating them needs a small refactor of the Advanced-anything pattern.
- **Auto-save with toast (P1 #10)** — needs a toast notification component. Skipped for scope.
- **Bare connection-status footer text** vs. the new banner — they're now redundant; one of them can come out.

## [0.6.5.0] - 2026-05-05

UX hardening pass driven by a browser-agent visual review of every SPA route — focused on what would confuse a non-technical user. 7 of the 20 findings closed in this PR (the load-bearing ones); polish items deferred to a follow-up. See `.context/ux-review/FINDINGS.md` for the full list with severity grades.

### Fixed — what a first-time user sees when something goes wrong

- **Centralized friendly errors in `api-client.js` (P0 #4).** New `ApiError` class with `kind` discriminant (`offline | auth | not-found | bad-request | server | unknown`) and a `friendlyMessage` field. The web dev proxy returns `{error: 'API proxy error'}` when the upstream API is down — pre-fix, that string leaked verbatim to users on Chat / Decisions / Audit pages. Now translated to "Can't reach SkyTwin right now. We'll keep trying." `renderApiError(err, { context, retry })` and `wireApiRetry(container, retry)` give every page the same calm error card with a "Try again" button.
- **Approvals + Decisions + Audit + Chat use the centralized helper (P0 #5).** Pre-fix, Approvals showed "0 waiting / You're all caught up" when the API was down — indistinguishable from genuinely having nothing to do, so a user could miss real approvals. Now: a loaded-empty list looks different from an offline list, and Try again is one click away.
- **UUID badge → friendly fallback (P0 #2).** Header user badge and Settings footer used to show the raw UUID `11111111-2222-…` when the user record couldn't be loaded. Now shows `You (1111…)` with the first 4 chars of the userId in a tooltip for devs.

### Fixed — connection status

- **Promoted "Reconnecting…" from the bottom-left footer to a header banner (P1 #12).** Calm yellow banner with an animated dot + "Retry now" button, rendered below the page header on every page when the API is unreachable. Hidden when connected so it doesn't take vertical space on the happy path. The footer indicator stays as a secondary signal.
- Banner respects `prefers-reduced-motion`.

### Fixed — onboarding step 1 has working examples even when the API is down

- **Demo preview card static fallback (P1 #6).** Pre-fix, the "Try one — see how it thinks" card was rendered with `display: none` and only revealed by JS after a successful `/api/v1/demo/info`. With the API down, the card never appeared — the WHOLE POINT of step 1 (let me show you how it thinks before you sign up) had no interactive affordance. Now the card always renders; if the live preview is unavailable, clicks return pre-canned sample answers (recruiter / subscription / dinner) with the same visual treatment as the live engine, plus a small "Live preview offline — showing a sample answer" caveat.

### Fixed — mobile

- **Mobile bottom-nav with real icons (P0 #3).** Pre-fix had single-letter icons (H/!/D/T/S) that were mysterious to first-time users. Replaced with inline-SVG icons (home/chat-bubble/checkmark-circle/hamburger/gear).
- **Chat link added to mobile bottom-nav.** v0.6.0.0 shipped the Chat feature in the desktop sidebar but missed the mobile nav entirely — feature was unreachable on phones.
- **Bottom-nav no longer overlaps page content.** Increased `.content` `padding-bottom` from `4rem` to `5.5rem + safe-area-inset` so the last interactive element on every page (composer hint, Save button, etc.) isn't hidden under the nav.

### Fixed — voice

- **Sidebar "My learnings" → "What I've learned" (P1 #13).** Sidebar label now matches the page header. Route title in `app.js` updated.

### Tests

No new unit tests in this PR — every change is in browser-only code (`apps/web/public/js/*`, CSS, HTML). Verified with the same browser-agent visual review (`.context/ux-review/14-` through `19-` screenshots show the after state). Full backend test suite still green across 40 packages.

### What's still open from the UX review

- **Hosted OAuth (P0 #1)** — single biggest unblocker for "everyone can use it" goal. Requires a verified Google OAuth app + production hosting; can't ship from a worktree alone.
- **Settings consolidation, theme switcher relocation, "needed for Chat" hint, auto-save, date input theming, onboarding sidebar dimmer (P1 #7-#11, #15)** — queued for a follow-up "Settings + Connect polish" PR.

## [0.6.4.0] - 2026-05-05

Closes issue #148 v1 — assistant phase 2c. The chat surface now routes detected action intents through the existing decision pipeline instead of just talking about them. Saying "archive that email" or "schedule a meeting with X" in chat creates an `ApprovalRequest` and queues it on the existing `#/approvals` page. Conversational messages still go through the LLM chat path unchanged.

This is the **last phase-2 item** for the assistant epic. Phase 2 is now complete: streaming (#146), context (#147), multi-turn API (#149), action routing (#148).

### Conservative v1 design choice — read this before extending

**Chat-driven actions ALWAYS land in approvals, never auto-execute.** Even when `DecisionMaker.evaluate()` returns `autoExecute=true` (the user has high trust tier, the action is reversible, etc.), the chat router collapses that to `requiresApproval=true` for v1. Reasoning:

- Chat is a free-text channel. An unintended intent match (regex firing on a message ABOUT scheduling instead of asking to schedule) cannot trigger a real send / spend / modify. The events route has structured signals as ground truth; chat doesn't.
- The user already has the `#/approvals` UI for review and consent. Routing through it preserves the audit trail and feedback loop unchanged.
- Phase 2 of #148 lifts this restriction once we have an LLM-classifier confidence score AND an explicit per-user opt-in.

**Safety Invariants — all upheld:**
- **#1** (no auto-exec without policy check): every chat-driven action goes through `DecisionMaker.evaluate()` → `PolicyEvaluator.evaluate()`. No bypass.
- **#2** (always log explanations): `ExplanationGenerator.generate()` runs and persists for every chat-driven decision. Failure to persist logs but doesn't abort (audit-trail loss is recoverable; aborting the user's request is not).
- **#3** (respect trust tiers): trust tier comes from the user record, never from the chat input.
- **#4** (spend limits are hard): inherited from `DecisionMaker` — no special-casing for chat.
- **#5** (reversible is honest): inherited from candidate generation.
- **#7** (every action has a RiskAssessment): inherited from `DecisionMaker.evaluate()`.

### Added — rule-based intent classifier in `@skytwin/assistant`

`detectIntent(message): ActionIntent | null`. Pure regex/keyword matching for a small vocabulary:

| Intent | Pattern | Maps to |
|---|---|---|
| `archive_email` | "archive that/this/the/it" | `email_triage` |
| `label_email` | "label/tag that as X" (captures label) | `email_triage` |
| `send_reply` | "reply to / respond to / send a reply" | `email_triage` |
| `create_event` | "schedule/book/set up a meeting/call" | `calendar_invite` |
| `decline_event` | "decline/skip/cancel that meeting" | `calendar_update` |
| `create_task` | "remind me to / add a task to" | `task_management` |

- Returns `null` for messages shorter than 8 chars (avoids surprise approvals from "ok" / "thanks").
- Returns `null` for non-string input (defensive).
- Returns `null` for meta-discussion patterns ("how do you decide when to schedule things?") — false-positive guard.
- Tested with both positive matches AND false-positive guards. The latter is the load-bearing test surface.

### Added — `ActionRouter` port + `AssistantService.routeIntent`

- New `ActionRouter` interface in `@skytwin/assistant`; the route adapter satisfies it. Keeps the assistant package free of `@skytwin/decision-engine` and `@skytwin/db` deps.
- `AssistantService.routeIntent(userId, message)` runs the classifier and (if a match) calls the router. Returns `null` to fall through to the LLM chat path. Router throws are caught and downgraded to `null` — graceful degradation when the decision engine is offline.
- Three terminal outcomes (`requires-approval` / `blocked` / `no-action`); `no-action` falls back to LLM chat.

### Wiring — `apps/api/src/routes/assistant.ts`

- `buildActionRouter()` factory constructs the same TwinService + PolicyEvaluator + DecisionMaker stack `events.ts` uses. Reuses the issue #122 `LabelInferencePort` so chat-driven `label_email` candidates get the same learned-from-history confidence boost.
- Synthetic `DecisionObject` with a `chat_intent_<id>` ID; rawData includes `triggerMessage` so the approval card can show what the user said.
- Persists `ApprovalRequest` via `approvalRepository.create` — same shape as the events path. `accessToken` and `rawData` filtered from `parameters` (don't round-trip secrets through the approval payload).
- Emits `approval:new` SSE event on `sseManager` so the existing approvals badge updates immediately when a chat creates an approval.
- `POST /api/assistant/messages` branches on intent BEFORE the LLM call. If routed, persists a structured assistant message with `metadata.intentRoute` carrying the outcome kind. Both sync JSON and SSE response shapes work — SSE flushes `thread` + `user` + `done` in one shot (no chunk events because no streaming text was generated).

### Web — action footer

- `pages/assistant.js:renderMessages` checks `m.metadata.intentRoute` and renders a footer under the bubble: "Open approval →" link (hash route to `#/approvals`) for `requires-approval`; muted "Action blocked by your safety policy" notice for `blocked`.
- `assistant.css` — small accent-colored footer + link styles that respect the existing theme variables.
- Empty-state copy updated: "I can also queue actions for your approval — try 'archive that email' or 'schedule a meeting with X'."

### Tests (16 new)

- `packages/assistant/src/__tests__/intent-classifier.test.ts` (12): every intent verb + variant; label-name capture; trim + non-string defensives; **false-positive guards** (meta-discussion, action verbs as nouns); rawData source-marking; trigger-message preservation.
- `packages/assistant/src/__tests__/assistant-service.test.ts` (+4): routeIntent returns null without router; returns null when no intent matches; routes detected intents through the port; downgrades router throws to null.

### Out of scope (phase 2 of #148, future)

- **Auto-execution from chat** — when a chat-driven intent has high enough engine confidence + user trust, skip the approval step. Needs an LLM-classifier confidence score AND a per-user opt-in setting first.
- **Inline approve/reject buttons in chat** — instead of a "Open approval" link, render the approve/reject UI directly in the assistant bubble. Bigger UX surface; deferred.
- **Thumbs up/down feedback wired to twin model** (Safety Invariant #6 follow-up specific to the assistant) — events-path feedback already wires through; chat-path feedback is separate.
- **LLM-based intent classification** for ambiguous or paraphrased intents the regex doesn't match. Adds cost + latency to every chat turn; deferred until the rule-based vocabulary proves insufficient.
- **Multi-step plans** ("first do X, then Y if Z") — out of scope per the original issue body.

## [0.6.3.0] - 2026-05-05

Closes issue #149 — `LlmClient.generate` and `generateStream` now accept `string | ChatMessage[]`. Each provider translates the array to its native chat-completion format. The `User:` / `Assistant:` prompt-flattening workaround in `@skytwin/assistant` is gone — `reply()` and `replyStream()` pass the conversation history directly. Pure refactor: no new user-visible feature, but unblocks #148 (action-intent routing) and removes the comment-laden workaround that's been load-bearing since assistant phase 1.

Backward-compatible: existing string callers (decision-engine's LLM strategies, every provider integration test, anything outside this monorepo that imports `@skytwin/llm-client`) work unchanged.

### Added — `ChatMessage` type + helpers in `@skytwin/llm-client`

- `ChatMessage = { role: 'system' | 'user' | 'assistant', content: string }` re-exported from package root.
- `toMessages(input: string | ChatMessage[]): ChatMessage[]` — wraps a string as one user-role message; passes arrays through unchanged. Pure function used by every provider.
- `splitSystemAndConversation(messages, fallbackSystem?)` — peels system messages out of the array and joins them with `\n\n`. Lets providers like Anthropic and Gemini that take `system` as a top-level field separate from the conversation array do that translation in two lines instead of N. Inline system messages WIN over `options.systemPrompt` so the assistant package's context block (injected as a system turn) is never silently overridden by the route's default prompt.

### Changed — `LlmClient.generate` + `generateStream` signatures

- `prompt: string` → `prompt: string | ChatMessage[]`. String input behaves exactly as before (provider chain still emits `chunk` and `done` events for the streaming path identically; `generate` returns the same `LlmResponse` shape).

### Changed — providers translate to their native chat-completion shapes

| Provider | Before | After |
|---|---|---|
| **Anthropic** | `messages: [{role: 'user', content: <prompt>}]` + `system` top-level | Pass-through `messages` array; system-role messages hoisted to the `system` field via `splitSystemAndConversation` |
| **OpenAI** | Hardcoded system + user pair | Pass-through `messages` array; falls back to `options.systemPrompt` only when no inline system message exists |
| **Google/Gemini** | Fake `user: <prompt>` + `model: "Understood."` pair to emulate system | Native `system_instruction` field; assistant role correctly translated to `'model'` (Gemini's vocabulary). Saves tokens AND removes a drift hazard |
| **Ollama** | `/api/generate` with `systemPrompt + "\n\n" + prompt` flattened | Switched to `/api/chat` with native `messages: [{role, content}]` array. Both endpoints exist on every modern Ollama server; the chat one matches what every other provider in the chain uses. Response parsing also moved from `{response}` to `{message: {content}}` |

### Changed — `AssistantService` drops the role-flattening workaround

- `reply()` and `replyStream()` now pass the trimmed `ChatTurn[]` directly to `LlmClient.generate` / `generateStream`. `ChatTurn` and `ChatMessage` are structurally identical, so the change is just dropping the call to `formatHistoryAsPrompt`.
- New private `composeSystemPrompt(enrichment?)` helper shared between `reply()` and `replyStream()` so the two paths cannot drift on the prepend-context-block step.
- `formatHistoryAsPrompt` stays exported for back-compat (no known external callers, but the function was public; plan to remove on the next major bump if no consumers surface).

### Tests (28 new)

- `packages/llm-client/src/__tests__/messages.test.ts` (7): `toMessages` string-wrapping + array-passthrough; `splitSystemAndConversation` joining, fallback semantics, inline-wins-over-fallback, all-system input.
- `packages/llm-client/src/__tests__/provider-multiturn.test.ts` (15): per-provider request-body shape assertions for both string and `ChatMessage[]` inputs. Anthropic system-hoisting + inline-wins. OpenAI no-duplicate-system. Gemini role translation + native `system_instruction` (no fake user/model pair) + omit-when-empty. Ollama `/api/chat` endpoint switch + response shape change + empty-response defensive return.
- `packages/assistant/src/__tests__/assistant-service.test.ts` (1 updated): the history-cap test now asserts against the messages array's content fields instead of the flattened prompt string. Same intent, post-#149 wire format.

### Out of scope for this PR (last remaining phase 2 work)

- #148 action-intent routing through `@skytwin/decision-engine` — unblocked by this PR. The intent classifier can now look at structured turns instead of regexing a flattened prompt.

### Migration notes

No caller-facing changes for back-compat string passers. New callers can drop history-flattening logic; pass `ChatMessage[]` instead. Decision-engine LLM strategies (LlmCandidateGenerator, LlmSituationStrategy) were not migrated in this PR — their `PromptBuilder`-built prompts work as-is, and changing them would conflate this refactor with their own re-shaping.

## [0.6.2.0] - 2026-05-05

Closes issue #146 — assistant phase 2a. The chat UI now streams replies token-by-token instead of blocking on the full LLM response. Anthropic ships native SSE; the other providers fall back to single-chunk emission so the API contract is uniform regardless of which provider is in front. Backward-compatible: legacy JSON callers still work unchanged.

### Added — streaming through the LLM client

- **`LlmClient.generateStream(prompt, options)`** returns an `AsyncIterable<LlmStreamEvent>`. Yields `{ type: 'chunk', content }` per token, then exactly one `{ type: 'done', content, provider, model, latencyMs }` at the end.
- **Provider-chain semantics for streaming:**
  - **Pre-first-chunk failures fall through** to the next provider, just like sync `generate()`. If every provider fails before yielding any text, throws `AllProvidersFailedError` with the same `attempted` array as the sync path.
  - **Mid-stream failures do NOT fall through.** Once a provider has committed by yielding even one chunk, the caller (and the user's eyes) have already received text — silently re-trying a different provider would produce duplicate output. The error re-throws so the route can surface a partial-reply notification.
- **Native Anthropic streaming** in `packages/llm-client/src/providers/anthropic.ts:streamGenerate`. Real SSE consumption of the `/v1/messages` endpoint with `stream: true`. Buffers events across `reader.read()` boundaries (a chunk can split mid-event). Tolerates the full Anthropic event taxonomy by ignoring everything except `content_block_delta` events with `delta.type === 'text_delta'` — `message_start`, `ping`, `content_block_start`, `message_stop` are all benign.
- **Universal fallback for non-streaming providers** (`makeFallbackStream` in `llm-client.ts`) — wraps the existing sync `generate` as a single-chunk async iterable so OpenAI / Google / Ollama get the same caller contract without a real streaming implementation. Adding native streaming for those providers is just dropping a new `streamGenerate` into their provider module — no changes elsewhere.

### Added — `AssistantService.replyStream`

- Streaming variant of `reply()` returning `AsyncIterable<AssistantStreamEvent>`. Yields `chunk` events as text arrives, then exactly one terminal event:
  - `done` (success) — assembled `fullContent` + `metadata`
  - `error` (mid-stream failure with at least one chunk landed) — `partialContent` + `message`
  - Pre-first-chunk failures escape via throw (caller turns into HTTP 502 — same as sync path)
- Same `EnrichmentRequest` semantics as `reply()` — when supplied AND a `ContextBuilder` is wired, the rendered twin/memory context block is prepended to the system prompt for this request.

### Added — SSE response on `POST /api/assistant/messages`

- The route now branches on the `Accept` header. `text/event-stream` triggers the streaming path; everything else falls through to the existing sync JSON response.
- **Wire format** (each event is `event:` + `data:` + blank line):
  ```
  event: thread\ndata: {"id":"…","isNew":true}
  event: user\ndata: {…userMessage row…}
  event: chunk\ndata: {"content":"Hello"}
  event: chunk\ndata: {"content":" world"}
  event: done\ndata: {…assistantMessage row…}
  ```
- The user message persists FIRST (before the LLM call) so it survives a provider outage — same hygiene as the sync path.
- The assistant message persists AFTER the stream closes, using the accumulated full content. If the persist fails, the stream's `done` event still fires (the user got a useful reply on screen) with `persistFailed: true` so the client can warn — the audit-trail loss is recoverable, the user-facing regression isn't.
- `X-Accel-Buffering: no` header keeps nginx from buffering the stream end-to-end. Harmless when no nginx is in front.
- Mid-flight client disconnect detection: `res.writableEnded` / `res.destroyed` checked between events so the loop exits cleanly when the user navigates away — saves the provider's tokens.

### Changed — web client streams progressively

- New `sendAssistantMessageStream(userId, content, threadId, callbacks)` in `apps/web/public/js/api-client.js`. Uses `fetch` + manual SSE parsing (not `EventSource` — that only supports GET; the assistant endpoint is POST). Callbacks: `onThread`, `onUserMessage`, `onChunk`, `onDone`, `onError`.
- `apps/web/public/js/pages/assistant.js:handleSend` now streams. The user bubble lands optimistically, then thread + user events replace the optimistic IDs, then chunk events update a single bubble's text **in place** (direct DOM update via `data-streaming-id`) without re-painting the page on every token — preserves textarea focus + scroll position during the stream.
- Typing dots now fire only while sending AND before the first chunk lands. Once the streaming bubble appears, it shows the live text — no need for both indicators.
- Mid-stream errors render the partial content in one bubble + an error caveat in another, so the user sees both what landed and what went wrong.

### Tests (24 new)

- `packages/llm-client/src/__tests__/anthropic-sse.test.ts` (7): clean stream, events split across `read()` chunks, benign-event filtering (`message_start` / `ping` / `content_block_start` / `message_stop`), comment-line tolerance, malformed JSON line survival, empty stream, trailing partial-event flush.
- `packages/llm-client/src/__tests__/llm-client.test.ts` (+6): native streaming yields chunks + done, pre-first-chunk failure falls through to next provider, mid-stream failure does NOT fall through (no second-provider call), `AllProvidersFailedError` when no provider yields any chunk, universal fallback path for non-streaming providers, empty-chunk skipping.
- `packages/assistant/src/__tests__/assistant-service.test.ts` (+5): chunk-then-done events, mid-stream error event with partial content, pre-first-chunk failures escape, ContextBuilder prepended to streaming system prompt, no-enrichment skips builder.

### Out of scope for this PR (still deferred)

- Action-intent routing through `@skytwin/decision-engine` (#148).
- Native multi-turn `LlmClient` API (#149).
- Native streaming for OpenAI / Google / Ollama (drop a `streamGenerate` into the provider module + add it to `PROVIDER_STREAM_FNS` — no other changes needed).
- Provider-side cancellation when the user closes the page mid-stream (the route detects disconnect and stops emitting; the underlying provider request is closed by the AbortController on response timeout, but a long-running generation could still continue server-side until that timeout).

## [0.6.1.0] - 2026-05-05

Closes issue #147 — assistant phase 2b. The conversational assistant now reads the user's twin profile (preferences + inferences) and recent episodic memories before composing a reply, so it can answer "what did I tell you about X last month?" and "what's my preference for Y?" — the two killer use cases that distinguish a personal twin from generic ChatGPT.

### Added — `ContextBuilder` in `@skytwin/assistant`

- New `ContextBuilder` composes a compact context block (`## What I know about you` + `## Relevant past episodes`) and prepends it to the system prompt for each request.
- Two ports keep the assistant package free of `@skytwin/db` and `@skytwin/mempalace` deps: `TwinContextProvider.fetch(userId)` for profile data and `MemoryContextProvider.search(userId, query, limit)` for episodic memories. Adapters wire to real backings at composition time in `apps/api/src/routes/assistant.ts`; tests stub them directly.
- **Hard cap at `MAX_CONTEXT_BYTES = 2000`** with UTF-8-clean ellipsis truncation. A noisy profile or long memory hit list cannot dominate the model's token budget.
- **Confidence floor**: only `confirmed`, `high`, and `moderate` preferences/inferences surface. Speculative + low-confidence entries stay in the model but don't broadcast to the LLM (would make the assistant look unsure of itself and frequently wrong).
- **Confidence-ranked truncation**: when a user has more than `MAX_PREFERENCES = 12` qualifying preferences, the highest-confidence ones win the slots. Same for `MAX_INFERENCES = 6` and `MAX_MEMORIES = 5`.
- **Boolean values render as `yes`/`no`** instead of `true`/`false` — more readable for the model and the user reading the rendered prompt in debug logs.
- **Partial-context fallback**: if either provider throws, the other still renders. `console.warn` records which side failed; the request continues with whatever context was retrievable. Better than no context.
- **No-op semantics**: empty result from both providers returns `''`, which AssistantService treats as "use the default system prompt unchanged" — same behavior as phase 1, no surprises.

### Changed — `AssistantService.reply()` now takes optional enrichment

- New optional 2nd parameter `enrichment?: { userId, query }`. When supplied AND a `ContextBuilder` was injected at construction, the rendered context block is prepended to the system prompt for that request.
- Backward-compatible: omitting either the enrichment arg or the ctor builder falls back to the bare default system prompt — phase 1 callers are untouched.
- Service signature change is the 3rd ctor arg; defaults to `null` so existing 2-arg callers compile unchanged.

### Wiring

- `apps/api/src/routes/assistant.ts` constructs a `ContextBuilder` once per process and passes it into the per-request `AssistantService`. `enrichment.query` is the just-sent user message — the assistant is about to answer it, so the most-relevant memories are the ones that match it.
- `TwinContextProvider` adapter pulls `TwinService.getOrCreateProfile` (preferences + inferences) and `userRepository.findById` (trust tier) in parallel.
- `MemoryContextProvider` adapter splits the query into ≥3-char tokens and calls `mempalaceRepository.searchEpisodes` — same backing call that `MemoryStack.search` uses for L3 deep-search. Stop-words and short tokens drop so a query like "the plan for X" doesn't ILIKE-match every episode containing "the".
- Episode `outcome` JSON blobs collapse to a one-line label (`kind` / `status` / `result` field if present, else short stringification) so the rendered context stays compact.

### Tests (15 new)

- `packages/assistant/src/__tests__/context-builder.test.ts` (12): preference rendering with confidence, low-confidence noise floor, confidence-ranked truncation, inference rendering with reasoning, memory rendering with date + outcome, both-empty short-circuit, trust-tier-only suppression, JSON value rendering, byte-cap with UTF-8-clean ellipsis, twin-side throws (memory still renders), memory-side throws (twin still renders), no-memory-provider passthrough.
- `packages/assistant/src/__tests__/assistant-service.test.ts` (+4): context prepended before default system prompt when enrichment supplied, empty context falls back to bare system prompt, no-enrichment skips the builder entirely, no-builder skips even when enrichment is supplied (early-bring-up safety).

### Out of scope for this PR (still deferred)

- SSE streaming (#146).
- Action-intent routing through `@skytwin/decision-engine` (#148).
- Native multi-turn `LlmClient` API (#149).

## [0.6.0.0] - 2026-05-05

Phase 1 of issue #135 — adds a ChatGPT-style conversational assistant at `#/assistant` with the dark glass aesthetic, persisted threads, and four new API endpoints. Out of scope for this phase (deferred to phase 2+): SSE streaming, twin/memory context enrichment, action-intent routing through the decision engine, and tool use.

Minor bump on the major slot: this is the first user-visible new surface since 0.5.x and warrants the bigger jump.

### Added — `@skytwin/assistant` package

- New workspace package with `AssistantService`, `formatHistoryAsPrompt`, `DEFAULT_ASSISTANT_SYSTEM_PROMPT`, and a `MAX_HISTORY_TURNS = 20` cap. Stateless — wraps `@skytwin/llm-client.LlmClient` to turn a `ChatTurn[]` history into the next assistant reply. Persistence and HTTP concerns live elsewhere so the service unit-tests against a stubbed LLM.
- The history cap exists for three reasons: cost, latency, and provider context-window limits. Older turns are persisted (the user sees them) but not fed back to the model — so a year-long thread doesn't quietly start dropping tokens off the front when the prompt overflows.

### Added — DB schema (`assistant_threads`, `assistant_messages`)

- Migration `026-assistant-threads.sql`: parent `assistant_threads (id, user_id, title, created_at, updated_at)` and child `assistant_messages (id, thread_id, role, content, created_at, metadata)`. `ON DELETE CASCADE` so deleting a thread drops its messages atomically.
- Two indexes: `(user_id, updated_at DESC)` for the threads-list hot path and `(thread_id, created_at ASC)` for the message-replay path.
- `metadata JSONB` is reserved for phase 2 — provider/model/latency stamps so the user can see "this reply was generated by claude-opus in 1.2s" without reading the API logs.
- `assistantRepository` in `@skytwin/db` with `createThread`, `listThreads`, `getThread`, `deleteThread`, `appendMessage` (transactional — message insert + parent `updated_at` bump are atomic so a race can't demote a thread that just received a message). Plus a pure `deriveThreadTitle` helper that auto-titles from the first user message (first line, ≤80 chars, ellipsis on overflow, falls back to "New conversation" for empty input).

### Added — API routes (`/api/assistant/*`)

- `POST /api/assistant/messages` — submit a user message, get the assistant reply. Body: `{ userId, content, threadId? }`. If `threadId` is omitted a new thread is created. User message is persisted FIRST so it survives an LLM-provider outage; the reply then appends. Returns `409` when the user has no AI provider configured (dashboard surfaces "set one up in Settings"), `502` when every configured provider fails (`AllProvidersFailedError` from the chain).
- `GET /api/assistant/threads?userId=…` — list up to 50 most-recently-active threads.
- `GET /api/assistant/threads/:threadId?userId=…` — fetch one thread + all its messages chronologically.
- `DELETE /api/assistant/threads/:threadId?userId=…` — cascade-delete the thread.
- All four mounted under `sessionAuth` + `requireOwnership`. Don't-leak-existence semantics on 404: a thread the requesting user doesn't own returns the same response as a thread that doesn't exist.
- Hand-rolled validator `validators/assistant-message.ts` matching the convention in `event-ingest.ts` — UUID checks for `userId` / `threadId`, 16K byte cap on `content` (well under CRDB's row-size limit, generous for conversational input), trim+empty rejection.

### Added — `#/assistant` web route (dark glass)

- New page module `apps/web/public/js/pages/assistant.js` and stylesheet `apps/web/public/css/assistant.css`. Two-column layout: threads rail on the left (with "New" button + per-thread delete), message log + composer on the right.
- Uses the existing CSS variable theme system in `themes.css` (`--bg-card`, `--accent`, `--glass-blur`, etc.) so the chat surface tracks whichever variant + mode the user has selected. Issue spec'd `#0b0d10` background; the existing `warm-glass` dark variant ships with `#0c0a14` which is functionally identical and reuses infrastructure rather than forking a parallel theme.
- Composer: textarea + send button. Enter submits, Shift+Enter inserts a newline. Optimistic user bubble renders immediately; assistant typing dots animate during the round-trip; both replaced with persisted server messages on response.
- Singleton click + submit + keydown delegators wired once to `document`, gated by `window.location.hash` per the CLAUDE.md "Frontend Event Handling" rules. Re-renders during the page lifetime (after every send, after delete) do not stack new listeners.
- All Gmail-controlled / user-controlled strings flow through `escapeHtml` before landing in `innerHTML`. No inline `onclick` attributes.
- Respects `prefers-reduced-motion` — bubble entrance animation and typing-dot bounce both no-op when set.

### Tests (24 new)

- `packages/assistant/src/__tests__/assistant-service.test.ts` (8): happy path, custom system prompt, history cap dropping oldest turns, provider failure propagation, prompt formatting (user/assistant labels, system pass-through, empty history).
- `packages/db/src/__tests__/assistant-thread-title.test.ts` (7): short, long-truncate, multi-line, CRLF, whitespace, empty fallback, exact-boundary preservation.
- `apps/api/src/__tests__/assistant-message-validator.test.ts` (10): minimal payload, threadId continuation, content trim, non-object body rejection, UUID enforcement on both ids, empty/whitespace content, oversized content, non-string content, empty-string threadId rejection (don't silently start a new thread on a malformed continuation), null/undefined threadId acceptance.

### Out of scope for this PR (phase 2+)

- SSE streaming on `POST /messages` — the route is structured to layer this on without redesign.
- Twin profile + Memory Palace context enrichment in the system prompt.
- Action-intent routing through `@skytwin/decision-engine` — the assistant cannot send mail / modify calendar / spend money in phase 1. The default system prompt tells the user to use the rest of the dashboard for that.
- Multi-turn LLM API (today the prompt format flattens history with `User:` / `Assistant:` labels — tracked as a `LlmClient` refactor for phase 2).
- Feedback (thumbs up/down on a reply) — wired to twin model in phase 2 per Safety Invariant #6.
- Mobile chat UI tracked separately under `apps/mobile`.

## [0.5.6.0] - 2026-05-05

Two follow-ups from the v0.5.5.0 (#136) /review that were intentionally deferred to keep the original PR focused on closing #122. Both shrink production risk for the Gmail-label model.

### Changed — single source of truth for sender normalization

- **`normalizeSenderAddress` moved to `@skytwin/core`** (`packages/core/src/email-normalize.ts`). Previously implemented twice: once in `packages/connectors/src/gmail-connector.ts` (write side, used by `recordObservations`) and once in `packages/decision-engine/src/decision-maker.ts` as a private `normalizeSender` (read side, used by `topLabelsForSender` lookup). A comment said "they MUST stay in sync" — they now do by construction. The connector re-exports the symbol for back-compat with downstream imports of `@skytwin/connectors`.
- 8 unit tests in `packages/core/src/__tests__/email-normalize.test.ts` covering display-name stripping, lowercasing, `@`-poisoning guard, malformed angle brackets, non-string inputs, and idempotency.

### Added — bounded growth for `email_label_signals`

- **`emailLabelRepository.pruneStaleSignals(userId, options?)`** drops rows past a TTL (default: 180 days, count<3) then enforces a per-user hard row cap (default: 5000). Returns `{ deletedStale, deletedOverCap }` so the caller can log how aggressively each gate fires. Idempotent — second call drops ~0 rows.
- **Worker integration** (`apps/worker/src/label-signal-pruner.ts` + `apps/worker/src/index.ts`) — new `createPruneThrottle` helper gates the prune at "once per 24h per user," called opportunistically from the existing `pollUser` loop. No separate scheduler. Stamps the throttle timestamp synchronously before awaiting so concurrent polls cannot double-fire. Errors swallowed via the throttle's `onError` hook — staying tidy is best-effort, not load-bearing on signal ingestion.
- 7 unit tests in `apps/worker/src/__tests__/label-signal-pruner.test.ts`: first-call runs, throttled within interval, runs again after interval, per-user isolation, error swallowing, sync timestamp stamping (concurrency guard), 24h default.

### Why these are real risks, not over-engineering

The cardinality cap is the load-bearing one. Without it, an attacker who can email the user (or any newsletter service that rotates per-message `From:` addresses) writes one row per unique sender forever. The table grows without bound, every email decision pays the cost in `topLabelsForSender` lookups, and the lookup itself starts returning weaker results because the `LIMIT 5` fills with one-off noise rows. The 5000-row cap with the lowest-count + oldest eviction order is what the read path's `ORDER BY count DESC, last_seen_at DESC` already prefers — we just enforce the same preference at write throttle time. Drift between the read and write models was the original concern that motivated the normalize-sender extraction; same theme.

## [0.5.5.0] - 2026-05-05

Closes issue #122 — the Twin no longer suggests labels via a hardcoded subject-keyword classifier. It now learns from each user's actual Gmail history.

### Added — per-user Gmail label model

- **`email_label_signals` table** (`packages/db/src/migrations/025-email-label-signals.sql`) accumulates `(user_id, sender, label)` rows with a `count` and `last_seen_at`. Compound primary key on the tuple gives idempotent UPSERT; the `(user_id, list_id)` partial index supports the secondary List-Id lookup for mailing-list traffic where per-message `From` varies.
- **`emailLabelRepository`** (`packages/db/src/repositories/email-label-repository.ts`) — `recordObservations(userId, [{sender, label, listId}])` for the connector's write path; `topLabelsForSender(userId, sender)` and `topLabelsForListId(userId, listId)` for the decision-engine's read path.
- **`LabelObserver` port on the Gmail connector** — every fetched message now contributes one observation per labelId. Sender is normalized to the bare lowercase address before write so the decision-side lookup matches. The `recordLabelObservations` call is best-effort: a label-store outage logs a warning but does not stop signal ingestion.
- **`List-Id` header is now extracted** from each message and plumbed through to `RawSignal.data.listId`. Used as a secondary signal in `inferLabels` when the per-sender lookup is empty (mailing lists like `<rangers.lists.example.org>` whose `From` rotates per send).

### Changed — `inferLabels` consults the per-user model first

- **`packages/decision-engine/src/decision-maker.ts:inferLabels`** now takes a `senderLabelHints` array. When the sender has ≥2 prior observations of a non-system, non-`CATEGORY_` label, the decision engine suggests that label (top-2). With ≥5 observations the candidate's confidence rises to HIGH; with ≥2 it's MODERATE; pure keyword fallback drops to LOW so policy gates ask for approval. Gmail system labels (INBOX, IMPORTANT, SENT, …) and `CATEGORY_*` are recorded but filtered from suggestions — the user can't meaningfully reuse them as a categorization.
- **New `LabelInferencePort`** on `DecisionMaker` (optional ctor arg). `evaluate()` pre-fetches sender / List-Id hints before candidate generation. Falls back to keywords transparently when the port is missing, the decision isn't from email, or the lookup throws.
- **Sender normalization** lives on both sides (`gmail-connector.ts:normalizeSenderAddress` and `decision-maker.ts:normalizeSender`) and applies the exact same transformation. They MUST stay in sync — both strip `Display Name <addr@host>` to lowercase `addr@host` before the lookup.

### Wiring

- `apps/api/src/routes/events.ts` — both DecisionMaker instantiations (rule-based fallback + LLM-strategy variant) now receive a `LabelInferencePort` adapter wrapping `emailLabelRepository`.
- `apps/worker/src/index.ts` — every `GmailConnector` is constructed with a `LabelObserver` adapter wrapping `emailLabelRepository.recordObservations`.

### Tests

- `packages/decision-engine/src/__tests__/label-inference.test.ts` (10): learned-label happy path, keyword fallback when sender is unknown, system-label filtering, sub-threshold evidence is ignored, List-Id secondary signal, sender-name normalization round-trip, port-throw degrades to keywords, no-port path still works, plus 2 post-/review tests for the sub-threshold-suppresses-listId fix.
- `packages/connectors/src/__tests__/gmail-label-observer.test.ts` (15): `normalizeSenderAddress` and `parseListId` pure-function contracts, observer invocation with normalized sender + listId, skips on unparseable sender, skips on no-labels message, observer errors do not stop signal emission, listId plumbed onto signal.
- `packages/db/src/__tests__/email-label-validation.test.ts` (5): `isAcceptableLabel` accepts ordinary user labels and Gmail system labels, rejects HTML/JS injection, oversized inputs, and characters off the whitelist (semicolon, backtick, dollar, brace, bracket).

### Fixed (post-/review)

- **Sub-threshold sender hints suppressed the List-Id fallback.** Pre-fix: a single count=1 sender row would short-circuit the List-Id lookup, so for mailing-list traffic where per-message `From:` rotates, a one-off forward could mask the much richer per-list model. Now we only short-circuit when at least one sender hint clears `LABEL_HINT_MIN_COUNT`.
- **System labels filtered client-side after `LIMIT N`.** Pre-fix: a sender with 5+ `CATEGORY_*` observations crowded the user's actual labels out of the `topLabelsForSender` result entirely, so the lookup silently returned 0 usable hints despite ample evidence. Filter is now in the SQL `WHERE` clause for both `topLabelsForSender` and `topLabelsForListId`.
- **N independent `INSERT … ON CONFLICT` queries per message.** Pre-fix: 10 messages × ~5 labels per Gmail poll = 50 sequential round-trips per cycle; mid-loop failure left a partial label set written. Replaced with a single multi-row INSERT — one statement, one transaction, atomic per message.
- **Label strings written without validation.** Pre-fix: Gmail-controlled label strings flowed verbatim into approval-card text and into `parameters.labels` JSON of execution plans; only render-layer `escapeHtml` stood between hostile content and downstream sinks. Added `isAcceptableLabel` whitelist (alphanumeric + safe punctuation, length ≤100, rejects control chars + angle brackets) at the write boundary in `recordObservations`.

## [0.5.4.0] - 2026-04-29

Last of the post-/review follow-ups from PR #126. Closes the P2 item that's been bothering me since the merge: every inline `onclick=` in the dashboard / approvals / decisions / settings / setup pages.

### Changed — XSS hardening

- **40 inline `onclick="…handleX('${escapeHtml(value)}')"` sites migrated** to `data-action="…"` + delegated `addEventListener` bindings across `apps/web/public/js/pages/{approvals,settings,decisions,setup,dashboard,dashboard-view}.js`. `escapeHtml` is HTML-context safe but values land in JS-string-literal context; UUIDs / enums / constants are safe today, the pattern wasn't. Each page now installs one click delegator that reads DOM attributes — no more concatenating user-controlled strings into executable HTML.
- **`dashboard-view.js` Ask-Your-Twin** now uses a delegated `keydown` listener for Enter-to-submit instead of an inline `onkeydown` interpolating `userId` into a JS string.
- **`approvals.js`** dropped its single-purpose `escapeAttr` helper (only used for the migrated escalation suggestion `label`); no equivalent JS-string escape is needed once values flow through `data-*` attributes.

### Fixed — listener leak in the singleton delegators

- **Listener leak in approvals / decisions / settings.** The first cut wired the click delegator inside `renderX(container, ...)` via `container.addEventListener`. Settings re-renders after every save/delete, decisions re-renders on every SSE `decision:executed`, approvals re-renders on cross-page navigation — so listeners stacked, and by the third trip a single click fired duplicate POSTs (and toasts and OAuth redirects). Fix: hoist each delegator to a module-level `_pageListenerWired` guard, attach once on `document`, and gate by `window.location.hash` since the SPA reuses one `#page-content` container across routes (DOM containment can't scope it). Settings handler also reads `getCurrentUserId()` inline instead of closing over the render argument so the dev "Switch user" button can't leave a stale-userId listener firing under the next user.
- **dashboard `data-action="connect-google"` namespace collision.** Same hash-route gate added to the dashboard's document-level click + keydown delegators in `dashboard-view.js` so they don't fire on settings.js's own `connect-google` button (and vice versa).

## [0.5.3.0] - 2026-04-29

### Changed

- **Dashboard split into entry point + view layer.** `apps/web/public/js/pages/dashboard.js` was 1023 lines mixing data fetching, model derivation, HTML composition, and post-render side effects. Split presentation into `dashboard-view.js` (583 lines: pure render helpers, label maps, the global handlers their inline `onclick` attributes reference, and `initDashboardGlobals`). Entry point shrinks to 483 lines focused on lifecycle. Zero runtime behavior change. `initDashboardGlobals` is re-exported from `dashboard.js` so `app.js`'s existing import keeps working.

## [0.5.2.0] - 2026-04-29

### Added

- **`TRUST_PROXY_HOPS` deployment guidance.** README "Deployment" section now spells out the topology → hop-count table (0 direct, 1 single proxy, 2 CDN-behind-proxy, 3+ multi-hop edge) plus a verification curl that confirms `req.ip` doesn't honor a spoofed `X-Forwarded-For`. Inline comment on `apps/api/src/index.ts` expanded to call out the global blast radius — every IP-keyed check (session-auth, OAuth new-user rate limit, demo preview bucket) keys on the same setting.
- **Public demo preview env reference** in the same Deployment section: `DEMO_PREVIEW_DISABLED` kill switch, `DEMO_PREVIEW_GLOBAL_LIMIT_PER_HOUR` hard cap, per-IP bucket. Notes that the cap is process-local and multiplies by replica count.

### Fixed

- **Hardened `TRUST_PROXY_HOPS` parse.** `parseInt('abc')` is NaN; `Number.isFinite(NaN)` is false; the prior code silently fell through to "no proxy trust" without warning. Now logs a `console.warn` on invalid input (negative, NaN, non-finite) so a typo doesn't quietly mask a security-sensitive misconfiguration.

### Fixed (post-/review)

- **Verification curl in README didn't actually verify anything.** The README told operators to "check the API log for the resolved `req.ip`", but `/api/health/live` doesn't emit a request log — so an operator following the procedure would see nothing and wrongly conclude the trust setting was safe. The endpoint now echoes `clientIp` in its JSON response and the README walkthrough reads from there directly.
- **Parse hardened against `1abc`-style typos.** `parseInt('1abc', 10)` returns `1` and silently sets a 1-hop trust setting — the exact "typo quietly becomes a security hole" failure mode. Validation now requires the trimmed env value to fully match `/^\d+$/`; anything with trailing garbage warns and falls back to 0.
- **Topology table corrected for platform routers.** The CDN → reverse-proxy row claimed `2` for *every* "Cloudflare in front" deployment, but on Fly / Render / Heroku there's also a platform router (Fly's edge, Render's router, Heroku's app router) that already counts as a hop — making "Cloudflare → Fly → nginx → Node" actually `3`, not `2`. Table broken out by topology, with a note pointing to Express's array/CIDR form for setups too complex to count by hand.

## [0.5.1.0] - 2026-04-29

Fixes a tier-promotion lie. The dashboard had been firing a "You've unlocked Full autopilot" toast at 100 cumulative approvals, but `packages/policy-engine/src/trust-tier-engine.ts` has no automatic moderate→high promotion (it requires explicit user opt-in). Three places carried mismatched copies of the threshold map; now there's one.

### Fixed

- **TIER_THRESHOLDS single source of truth.** `PROMOTION_THRESHOLDS` now lives in `@skytwin/shared-types` (`packages/shared-types/src/policy.ts`). Both the policy engine and the `/api/twin/:userId/progress` route import from there. The dashboard receives the threshold from the server response — no UI-side copy to drift. **MODERATE_AUTONOMY no longer claims a 100-approval target;** the progress bar renders "Maximum trust" instead, since promotion to HIGH_AUTONOMY is explicit opt-in only.
- **Promotion uses the engine's actual gates, not cumulative count.** `/api/twin/:userId/progress` now returns `consecutiveApprovals` (resets on rejection — what the engine gates on), `approvalRatio`, `minApprovalRatio`, `nextTier`, and `nextTierThreshold` alongside the legacy `approvalCount` and `threshold` fields. The dashboard's celebration toast only fires when both gates are met. The progress bar renders an honest "you've hit the count, but I need a higher approval rate" state when only the count is met.

### Changed

- `renderTrustProgress` accepts the full `/progress` response shape; older `{ approvalCount, currentTier }` calls still work via fallback.

### Fixed (post-/review)

- **`consecutiveApprovals` was iterating in the wrong direction.** First cut had a comment claiming `findByUser` returns oldest-first and walked from `length-1 → 0`, but `feedbackRepository.findByUser` actually orders by `created_at DESC` (most-recent-first). The loop therefore counted a streak from the *oldest* event toward the newest, breaking on the first non-approval encountered there — so a user whose most recent event is a rejection but who had a long approval streak years ago would get a large `consecutiveApprovals` value. That's the exact same drift the PR was meant to fix. Loop now walks `0 → length` (freshest first), which matches what the engine does. Added 5 unit tests in `apps/api/src/__tests__/twin-progress.test.ts` covering: most-recent-rejection-with-earlier-streak, mid-history rejection, empty feedback, all-approvals, and `nextTierThreshold === null` for `moderate_autonomy`.

## [0.5.0.0] - 2026-04-28

The non-technical-user release. One shell command from zero to a working twin, no config files, no terminal needed afterward. The dashboard now makes its decisions visible in the agent's voice — every page rewritten in plain language, the agent's presence felt at the OS level (tab title pending count, favicon flips warning-yellow on pending, browser notifications when the tab is in the background), and the moment the twin "wakes up" celebrated the way it deserves.

### Added — One-command install

- **`install.sh` `curl | bash` one-liner.** Detects macOS / Linux / WSL; installs Homebrew, Node 20+, pnpm, Docker, Ollama via the existing `bin/skytwin-install`. Clones to `~/skytwin`, runs `bin/skytwin-dev`, polls the dashboard, opens the browser. Re-running pulls latest and restarts.
- **Docker daemon pre-flight in `install.sh`.** `docker info` first; on mac auto-launches Docker Desktop and waits up to 60s; on linux tries `systemctl start docker`; clear recovery on WSL. Stops the "I installed Docker but it's not responding" surprise.
- **Tailored install footer.** Hits `/api/credentials/status` and prints either "click Continue with Google" or "you'll see the 5-minute walkthrough on the dashboard" based on real state.
- **Cleanup trap in `install.sh`.** A 90s dashboard timeout (or any INT/TERM) now tears down the supervisor tree via `bin/skytwin-dev --stop` instead of orphaning processes.

### Added — Dashboard / agent voice

- **Ask Your Twin widget on the dashboard.** Type any situation and the twin returns a predicted action, plain-English reasoning, confidence level, and "I'd handle this on my own" / "I'd ask you first" badge. Backend was already there as `POST /api/v1/twin/ask/:userId` — this surfaces it. Mode-aware example chips for tour vs real users.
- **Public preview route `POST /api/v1/demo/preview`.** Lets onboarding step 1 run a live `whatWouldIDo()` call against the seeded demo user before the visitor signs in. Three layers of protection: operator kill switch (`DEMO_PREVIEW_DISABLED=1` → 503), per-IP bucket (20/5min), global hourly cap (`DEMO_PREVIEW_GLOBAL_LIMIT_PER_HOUR`, default 500). 12 unit tests covering 400 / 404 / 429 / 503 / 200 paths.
- **Tour mode** (`GET /api/v1/demo/info`). Step 2 of onboarding surfaces "Or explore with a sample profile first →" when the seed exists AND localhost dev-bypass is active. Skips the wizard, lands on the populated dashboard with a tour banner. Auto-disables in production where dev-bypass is off (would land on a 401-riddled dashboard otherwise).
- **Post-OAuth lands on the dashboard, not Settings.** Was `#/settings?connected=…`, now `#/?connected=…` so the celebration happens where the value shows up. Hash query is stripped after first read (refresh tomorrow doesn't re-show, account email doesn't persist in browser history).
- **"Your twin just woke up" celebration card** with a pulsing watching-your-inbox indicator (CSS class `.skytwin-pulse-dot` with `prefers-reduced-motion` support). Auto-refreshes every 4s during first-scan; flips to "Your twin is live" once decisions land.
- **"While you were away" banner** counts decisions newer than the user's last visit. Baseline updates only on `visibilitychange → hidden` and `beforeunload` so SSE re-renders don't clobber it.
- **Morning briefing card** pulls `GET /api/v1/briefings/:userId` (already populated by the proactive scanner). Time-of-day-aware title ("this morning" / "earlier today" / "yesterday" / weekday name); per-item rendering with action / reasoning / confidence badge; 36-hour freshness window so stale briefings hide.
- **Empty-state preview card** for brand-new users. Replaces the wall of "0%" stat cards with "What I'll handle for you" — three concrete "I noticed…" examples covering newsletter archive / calendar conflict / subscription renewal.
- **Trust-tier celebration toast** when the approval count crosses a threshold (observer→10, suggest→20, low_autonomy→50, moderate_autonomy→100).
- **First-decision celebration toast** the first time decisions transition from 0 to >0 for this browser. One-time, dismissible via localStorage.

### Added — Background-tab presence

- **Document title shows pending count.** `(3) SkyTwin — Your Personal AI Assistant` when something's waiting; reverts cleanly when the queue clears.
- **SVG favicon that flips warning-yellow** on pending approvals. Inline data URI, no asset file required, scales cleanly on retina, `prefers-reduced-motion` respected.
- **OS-level browser notifications** on `sse:approval:new` when the tab isn't visible/focused. In-app opt-in card asks first ("Want a heads-up when I need you?") instead of firing the OS prompt unannounced. Click → focus the tab and route to /approvals. Notification body sanitized (control chars stripped, capped at 140 chars).
- **Sidebar twin-presence indicator.** Connection status reads "Listening" by default, "Reconnecting…" when offline; flashes "Working on it…" / "Just handled something" / "Wants your OK" / "Learned something new" for ~4.5s on real SSE activity.

### Added — Voice rewrites of moment-of-truth pages

- **Welcome step 1** leads with the actual problem ("Most assistants have amnesia. You tell them you prefer aisle seats three times. They keep asking.") and the actual claim. Three concrete promises about the trust-tier ramp, explanations, and control. Interactive demo chips below ("Try one — see how it thinks") that hit `/api/v1/demo/preview` so the twin reasons out loud before signup.
- **Sidebar nav.** "Setup" → "Connect" (route hash unchanged so links work).
- **Connect page** leads with "Let's connect your twin to your life" + a two-line status (Google account / twin-ready). Adapter health collapses under "Advanced — how SkyTwin actually runs your actions". One-click "Save and connect now" replaces the multi-step paste-then-navigate-then-click flow.
- **Approvals.** Title flips between "I want to handle these — OK?" and "Needs your OK". Buttons soften from "Yes, go ahead" / "No, don't do this" to "Yes, do it" / "Not this time" — reject drops danger styling. Reason quoted back in the toast ("Got it — I'll remember: 'Sarah's emails are personal — never archive these'"). Trust progress bar visibly ticks up on approval. First-time tutorial card explains how the page works.
- **Decisions.** "Decision History" → "What I've been doing for you". Filter row collapses by default. Empty state shows three concrete "I noticed…" examples. Activity rows now narrate ("I handled · a newsletter in Email") instead of dev-y "Email — newsletter_archive".
- **Walk-back undo modal.** "Undo This Action" → "Walk me back". Severity options expand to plain-language framings. Reason quoted back in success toast.
- **My learnings.** "What I've learned about you" → "A portrait of how you do things". Add-preference form leads with a natural-language sentence ("e.g. Always archive newsletters from Substack — I never read them"). Edit / "That's not right" buttons migrated from inline JS-string interpolation (XSS-unsafe with free-text values) to data-attributes + delegated event listener.
- **Audit page.** "Audit Timeline" → "The full paper trail"; type labels flip to verbs ("Trust earned", "Money moved", "Learned about you"); empty state reinforces the safety promise ("Nothing happens in the dark").
- **Settings.** "Privacy & data" → "Your data, your machine"; first-person body ("I keep" / "I don't keep" / "Account access"). UUID identity card collapses under "Advanced — switch user (developer)". "Pause your twin" loses danger-red styling and only shows the button when not already on observer.

### Added — De-jargonization

- **IronClaw / OpenClaw / Direct never appear on default views.** All three move into a collapsed `<details>` titled "Advanced — how SkyTwin actually runs your actions" with role-first descriptions ("Sandboxed execution server", "Built-in handlers", "Local-AI execution"); codename in parens. Settings "IronClaw channel" card collapses under "Advanced — execution routing". "Routines" retitles to "Scheduled actions" and only renders when non-empty.
- **`/api/credentials/google` failure error** stops citing env vars and points at the in-app walkthrough.
- **Notification permission opt-in card** asks in-app first; OS-level prompt only fires after the user clicks "Yes, ping me".

### Added — Infra / quality

- **`apps/web/public/js/storage-keys.js`** — centralized localStorage key registry. Constants for fixed names, builder functions for per-user keys (`lastVisitKey`, `firstDecisionSeenKey`, `tierCelebratedKey`, `firstApprovalIntroSeenKey`), `clearKeysForSuffix` powers the tour-exit cleanup.
- **`packages/shared-types/src/demo.ts`** — `DemoInfoResponse` and `DemoPreviewResponse` typed interfaces. Public `/api/v1/demo/*` surface is now type-checked.
- **`app.set('trust proxy', N)`** configurable via `TRUST_PROXY_HOPS` env var (default 0). Required for the per-IP rate limit on `/api/v1/demo/preview` to work behind reverse proxies.
- **Slow-fetch cache** on the dashboard. Module-level Map with 30s TTL wraps oauth status, creds status, skill gaps, learned, unmet creds — eliminates the 13-fetch fan-out on every render. SSE `twin:updated` busts learned/skill-gaps; `credential:needed` busts creds-status/unmet-creds.
- **`initDashboardGlobals()`** consolidates five module-top-level `if (typeof window !== 'undefined') { window.X = ... }` blocks into one bootstrap call from `app.js`'s DOMContentLoaded.
- **Magic-numbers extracted to named constants** in dashboard.js (BRIEFING_FRESH_MS, FIRST_SCAN_POLL_MS, FIRST_SCAN_MAX_MS, SINCE_LAST_VISIT_MIN_MS, SLOW_CACHE_TTL_MS, TIER_THRESHOLDS, TIER_NEXT).
- **Inline `@keyframes pulse`** moved out of the celebration-card render into `apps/web/public/css/styles.css` as `.skytwin-pulse-dot`.
- **`/api/demo/*` versioned to `/api/v1/demo/*`** for consistency with `/api/v1/twin/*` and `/api/v1/briefings/*`.
- **README "first 60 seconds" walkthrough** under the curl one-liner so a tire-kicker scrolling the README sees the value pitch (Ask Your Twin live → tour mode → 5-min Google setup) before the architecture section.
- **TODOS.md** carries the four remaining P2/P3 items (renderDashboard split, remaining inline-onclick migration, OAuth redirect compat, real production tour mode).

### Fixed

- **install.sh stops telling Ollama to do nothing.** `bin/skytwin-install` pulls Ollama + the 9.6 GB gemma model; the previous `bin/skytwin-dev --no-ollama` flag made `skytwin-dev` skip launching the OpenClaw bridge. Users waited for a 9.6 GB download for nothing and the README's "starts the local LLM bridge" claim was silently false. Drop `--no-ollama`.
- **`/api/v1/demo/info` no longer leaks email/name.** Onboarding only reads `available` + `userId`; the response stops including the seeded user's email and name. If a future operator reuses `DEMO_USER_ID` for a real account, no PII leaks.
- **Tour mode is honest about production auth.** `/api/v1/demo/info` reports `available: false` outside localhost dev-bypass, so the onboarding tour link auto-hides in production where the dashboard's protected fetches would 401.
- **`/api/v1/demo/preview` validation runs before the rate-limit consume.** Cheap malformed POSTs no longer burn a legitimate caller's bucket. 429 responses include `Retry-After` header + `resetAt` body.
- **Demo user lookup memoized** with a 60s TTL backstop. Hot path no longer queries the DB on every preview request.
- **`sinceLastVisit` baseline no longer self-clobbers.** The IIFE used to `setItem(key, now)` on every render, then check `(now - lastVisitMs) < 5min`. Result: any second SSE-driven render in a session always failed the gap check. Now updates only on `visibilitychange → hidden` and `beforeunload`.
- **`?connected=…&account=…` stripped from the hash** after the celebration card consumes it via `history.replaceState`. Email no longer persists in browser history; refresh tomorrow no longer re-shows the celebration.
- **Briefing freshness check** validates `Date.parse(briefing.createdAt)` with `Number.isFinite`. Malformed createdAt no longer silently hides the briefing forever.
- **`_twinActivityText` switched to `textContent`.** Internal-only today; defense-in-depth for any future caller that passes user-derived text.
- **Notification body sanitized** — control chars stripped, capped at 140 chars. SSE-derived strings can no longer push wall-of-text or fake-header content into OS notification center.
- **Favicon and document.title repaints guarded** against same-state no-op churn (was repainting on every 30s poll).
- **30s approval-badge poll** stretches to 5 minutes when SSE is healthy, drops to 10 seconds when it's down. Pure overhead during normal operation eliminated.
- **`skyTwinExitTour`** now sweeps every per-user key the tour wrote (first-decision toast flag, tier celebrations, approval intro, last visit, notif flags) so a future tour starts clean.
- **OAuth callback redirect target.** `/#/settings?connected=…` → `/#/?connected=…` so the celebration card lands where the dashboard parses it.

### Security

- **Public LLM endpoint hardened.** Operator kill switch (`DEMO_PREVIEW_DISABLED=1`), per-IP rate limit (20/5min) with proper `Retry-After`, global hourly cap (`DEMO_PREVIEW_GLOBAL_LIMIT_PER_HOUR`, default 500) as a backstop against rotated-IP / spoofed-XFF abuse, 600-char input cap, validation-before-rate-consume.
- **Free-text preference values** in My learnings migrated from inline `onclick="...handleX('${escapeHtml(value)}')"` to data-attributes + delegated event listener. `escapeHtml` is HTML-context safe but values land in JS-string-literal context — UUIDs are safe today, the pattern wasn't.

## [Unreleased]

Launch-prep work since `0.4.1.0`. Two threads ran in parallel: the dev experience (`pnpm dev` actually working end-to-end) and the user-onboarding hot path (sign-in-with-Google as the front door, auto-create user from verified Google email, multi-account OAuth schema). Tail end of the run hardened the security boundary that all of that opened up — public sign-in routes, public OAuth callback, per-user data scoping. Plus closed [#102](https://github.com/jayzalowitz/skytwin/issues/102) end-to-end (worker dedupe ledger + Gmail History API + decisions uniqueness), so duplicate signals can no longer become duplicate approvals through any path.

### Security

- **SESSION_SECRET startup assertion** ([#113](https://github.com/jayzalowitz/skytwin/pull/113)). The api now refuses to start outside dev/test if `SESSION_SECRET` is unset, equals the hardcoded dev default `'skytwin-dev-secret'`, or is shorter than 32 chars. Both `session-auth.ts` and the OAuth state HMAC fall back to that literal when unset — anyone reading the open-source code knew the production HMAC key. Logic in `apps/api/src/startup-assertions.ts` so the failure paths are unit-testable without `process.exit`.
- **`GET /api/users` scoped to the requester** ([#113](https://github.com/jayzalowitz/skytwin/pull/113)). Previously any authenticated user could enumerate every other user's id and email. Now returns the full set only when the dev auth bypass is active; an authenticated session gets back just their own row.
- **Per-IP rate limit on `/api/oauth/google/authorize?newUser=true`** ([#113](https://github.com/jayzalowitz/skytwin/pull/113)). 5 requests per minute per IP, 429 with `Retry-After`. The new-user path is public so an attacker could otherwise mint authorize URLs in a loop and burn the project's Google OAuth quota.
- **HMAC-signed OAuth state with 10-minute TTL** ([#103](https://github.com/jayzalowitz/skytwin/pull/103)). The Google OAuth callback is public; without integrity-protecting `state`, an attacker could mint their own Google auth code and call back with `state=<victim-id>` to attach their account to someone else. State is now `v2.<payload>.<expiresAtMs>.<hmac>` verified in constant time; invalid/expired states return 400 before any DB write.
- **`verified_email` enforcement on auto-create** ([#103](https://github.com/jayzalowitz/skytwin/pull/103)). Google's userinfo `verified_email` is now required for sign-in-with-Google to materialize a user. Stops account-takeover by registering a Google account with someone else's address.
- **Identity scopes added to authorize URL** ([#103](https://github.com/jayzalowitz/skytwin/pull/103)). `openid email profile` are now requested alongside Gmail/Calendar — userinfo wouldn't return the email field without them, which would have silently broken the entire sign-in-with-Google flow.
- **Refresh-token revocation on disconnect** ([#103](https://github.com/jayzalowitz/skytwin/pull/103)). Per Google's revocation semantics: revoking the access token alone leaves the long-lived grant active; revoking the refresh token invalidates the entire grant. Both per-account `DELETE /api/oauth/:provider/:userId/:accountEmail` and the legacy `disconnect` now revoke the refresh token.

### Added

- **Sign-in-with-Google as the onboarding front door** ([#114](https://github.com/jayzalowitz/skytwin/pull/114)). Step 2 of the onboarding overlay leads with a single primary "Continue with Google" button. Click → `POST /api/oauth/google/authorize?newUser=true` → consent → callback → redirect back to `/?userId=…#/settings?connected=google&account=…` and the dashboard picks up the active user. The previous email-typing form is preserved as a `<details>` fallback. Friendly 503 with a clear message if Google credentials aren't configured yet.
- **Multi-account OAuth schema with auto-create user** ([#103](https://github.com/jayzalowitz/skytwin/pull/103)). `oauth_tokens` gains `account_email` and `account_provider_id` (Google `sub`); unique key is now `(user_id, provider, account_email)` so a user can connect more than one Google account. The OAuth callback fetches userinfo, keys the row on the verified email, and auto-creates a user when `state=new` (no userId yet). New routes: `GET /api/oauth/:provider/accounts/:userId` (list connected accounts) and `DELETE /api/oauth/:provider/:userId/:accountEmail` (disconnect one without nuking the rest). Per-account UI in approvals/signals views and connector multi-account routing remain explicit non-goals — the data plane is ready.
- **Auto-created users start at `'observer'`** ([#113](https://github.com/jayzalowitz/skytwin/pull/113)). Sign-in-with-Google materializes a user at the read-only tier; `'suggest'` is earned through approval feedback. The interactive `POST /api/users` form continues to use `'suggest'` since a real human filled out a form.
- **User-switcher in the dashboard header** ([#100](https://github.com/jayzalowitz/skytwin/pull/100)). The user-badge in the page header is clickable and renders a dropdown listing every user with the current one marked. New `GET /api/users` endpoint backs it, scoped per the security entry above. `?userId=<id>` URL param also switches and persists, used by the Google OAuth callback redirect.
- **Persistent dedupe ledger** ([#104](https://github.com/jayzalowitz/skytwin/pull/104)). New `forwarded_signals(user_id, signal_key, forwarded_at)` table. `SignalDeduper` gained an optional persistence hook and a `hydrate` method; the worker hydrates from `listSince(24h)` on startup and write-throughs every `mark()`. Without this, `tsx watch` reloads (or any worker restart) re-emitted every still-matching signal — the symptom that motivated [#102](https://github.com/jayzalowitz/skytwin/issues/102).
- **Gmail History API + persistent cursor** ([#116](https://github.com/jayzalowitz/skytwin/pull/116)). Replaces the `is:unread` poll with `users.history.list?startHistoryId=…`. New `connector_cursors(user_id, provider, cursor_kind, cursor_value)` table holds the cursor across worker restarts; first poll bootstraps from a recent listing and persists the highest historyId. 404 on history.list (cursor too old) re-bootstraps in place. Real Gmail API quota savings — the worker stops re-listing the inbox on every cycle.
- **Per-user uniqueness on `decisions.signal_id`** ([#115](https://github.com/jayzalowitz/skytwin/pull/115)). New `signal_id` column extracted from `raw_event->>'signalId'`; partial unique index on `(user_id, signal_id) WHERE signal_id IS NOT NULL`. `decisionRepository.create` pre-checks before insert so duplicate ingests return the existing row rather than racing the index. Defense-in-depth backstop for [#102](https://github.com/jayzalowitz/skytwin/issues/102).
- **`conductor.json` Run script** ([#100](https://github.com/jayzalowitz/skytwin/pull/100)). Conductor's Run button now brings up CockroachDB then `pnpm dev`. `runScriptMode: nonconcurrent` because dev ports are hardcoded and would collide across parallel workspaces.
- **OpenClaw bridge as a workspace package** ([#100](https://github.com/jayzalowitz/skytwin/pull/100)). New `apps/openclaw-bridge/package.json` with a `dev` script so it boots under `pnpm dev` alongside everything else, instead of only via `bin/skytwin-dev`.

### Fixed

- **`pnpm dev` runs the full local stack** ([#100](https://github.com/jayzalowitz/skytwin/pull/100)). Root `dev` script now sets `NODE_ENV=development` (the API's localhost auth bypass keys off this), points IronClaw/OpenClaw at the real local URLs with a shared dev webhook secret, and bumps Turbo concurrency past the 18 persistent dev tasks. `turbo.json` declares `globalEnv` so Turbo 2.x actually passes those env vars through to tasks instead of filtering them under strict mode (volatile values stay scoped to the `dev` task so they don't pollute build/test cache keys).
- **Desktop external-instance probe gated to dev** ([#100](https://github.com/jayzalowitz/skytwin/pull/100)). `apps/desktop/src/service-manager.ts` probes `localhost:3100/api/health` before forking the embedded API/worker; reuses the standalone instance when present so `pnpm dev` no longer crashes the desktop dev target with EADDRINUSE. Probe runs in unpackaged builds only — a packaged install must never attach to whatever stranger happens to be answering on localhost.
- **Sign-in-with-Google flow is reachable from a fresh session** ([#113](https://github.com/jayzalowitz/skytwin/pull/113)). The router-level `sessionAuth` now exempts `/google/authorize?newUser=true` (mirroring the existing `/google/callback` exemption). Without this, the new-user variant 401-ed before the user could even start consenting.
- **Legacy `oauthRepository.saveToken` no longer creates placeholder rows** ([#103](https://github.com/jayzalowitz/skytwin/pull/103)). The shim now looks up the user's primary email when no existing token row is present, so it never produces a `account_email = ''` row that could shadow the real per-account row created by the callback.

### Tests

- 8 new oauth-repository tests covering the multi-account key, the legacy shim's email passthrough, list/delete behaviour ([#103](https://github.com/jayzalowitz/skytwin/pull/103)).
- 8 new startup-assertion tests covering dev/test pass-through, prod/staging fail-loud, custom defaults, length validation ([#113](https://github.com/jayzalowitz/skytwin/pull/113)).
- 4 new oauth-rate-limit tests covering per-IP isolation and window reset ([#113](https://github.com/jayzalowitz/skytwin/pull/113)).
- 4 new SignalDeduper persistence tests (write-through, error containment, hydrate, TTL filter) and 6 new forwarded-signals-repository tests ([#104](https://github.com/jayzalowitz/skytwin/pull/104)).
- 4 new decision-repository tests covering signal_id extraction and (user_id, signal_id) pre-check ([#115](https://github.com/jayzalowitz/skytwin/pull/115)).
- 7 new GmailConnector History API tests using stubbed `globalThis.fetch` (bootstrap, empty-bootstrap via profile, history delta, no-changes cursor advance, 404 re-bootstrap, save-error containment, no-cursor-store back-compat) and 6 new connector-cursor-repository tests ([#116](https://github.com/jayzalowitz/skytwin/pull/116)).

## [0.4.1.0] - 2026-04-27

Hardening release. Closes the entire session-start audit punch list:
safety-kernel boundary guards, blocked-by-policy observability, partial-
block leak in `whatWouldIDo`, URL validation hardening, adapter shape
validation, runtime input validation, plus polish across the dashboard,
mobile getting-started tour, and dev-mode Mock IronClaw registration.
~180 new tests landed across 11 packages.

### Security

- **Runtime validation at `/api/events/ingest`** (#95): The endpoint now validates the request body shape before passing it to the interpreter. Explicitly rejects caller-supplied `trustTier` (Safety Invariant #3 — trust tier must come from the user record). Returns 400 with structured per-field errors instead of TypeError'ing downstream.
- **URL validation hardened against zone IDs, trailing dots, CGNAT** (#90): Centralized hostname normalization (`normalizeHostname`) catches `localhost.`, `[fe80::1%eth0]`, and uppercase variants. Added blocks for IPv6 unspecified `[::]` / `[0:0:0:0:0:0:0:0]` and the CGNAT range `100.64.0.0/10` (RFC 6598).
- **`InvariantViolationError` runtime guard on `ExecutionRouter`** (#78): Both `executeWithRouting` and `executeWithRoutingStreaming` now throw if called without a `RiskAssessment` or with a mismatched `actionId`. Pins Safety Invariants #1 and #7 at the boundary so a future caller that bypasses the decision pipeline cannot silently auto-execute.
- **Adapter discovery validates plugin shape post-construction** (#91): After calling `factory()`, the loader verifies the returned object has the four required `IronClawAdapter` methods. Plugins returning malformed objects fail at load time instead of bubbling up as `NoAdapterError` under load. Also wraps the factory call in `try/catch` so a throwing constructor doesn't kill discovery for unrelated plugins.

### Added

- **Per-candidate policy verdicts on decision outcomes**: `DecisionOutcome.policyVerdicts` now records the policy result for every scored candidate (`'allowed' | 'requires-approval' | 'denied'`), populated by `evaluate()` and not persisted. Lets downstream consumers distinguish blocked candidates from un-evaluated ones (#82)
- **`decision:blocked-by-policy` SSE event**: When the decision pipeline blocks every candidate, the API now emits an SSE event so the user can see why nothing happened. Previously the event ingest was silent and the policy result was invisible (#78)
- **`InvariantViolationError` runtime guard on `ExecutionRouter`**: Both `executeWithRouting` and `executeWithRoutingStreaming` now throw if called without a `RiskAssessment` or with a mismatched `actionId`. Pins Safety Invariants #1 and #7 at the boundary so a future caller that bypasses the decision pipeline cannot silently auto-execute (#78)
- **Approvals page pagination**: Renders the first 10 pending cards by default with a "Show N more (M remaining)" button. Eliminates the ~29,210-pixel scroll area that buried the "Recent decisions" section when many approvals were pending (#84)
- **E2E coverage for the safety kernel**: New `Policy safety kernel` describe block in the e2e suite gated behind `E2E=true`. Two tests prove (1) policy denial blocks execution end-to-end and (2) the approval gate blocks execution until the user approves (#83)
- **Adapter manifest `defaultConfig`**: Plugin manifests can now declare bootstrap settings (api URL, channel id, etc.) that the discovery loader passes to the factory. Falls back to `{}` when absent — existing plugins keep working (#91)
- **`SignalDeduper` extracted to its own module** (`apps/worker/src/signal-dedupe.ts`): Pure module with constructor-injected TTL, capacity, and clock. Adds `pruneUsers(activeUserIds)` so the worker can release dedupe memory when a user is no longer tracked (#93)
- **`validateEventIngest` boundary validator at the API**: New `apps/api/src/validators/event-ingest.ts` guards `POST /api/events/ingest` with a discriminated `{ ok, event, userId } | { ok, errors }` result. Aggregates errors so callers get every failing field at once, not one at a time. See Security above for the `trustTier` injection rejection (#95)
- **Mobile getting-started tour**: After first successful pairing the app now shows a 3-step Welcome screen explaining (1) approve → twin learns, (2) push notifications for new approvals, (3) trust tier controls in Settings. Persists "seen" flag in `SecureStore` so it shows once per device (#97)
- **Mock IronClaw adapter registers in dev**: When `USE_MOCK_IRONCLAW=true` (default in `bin/skytwin-dev` when no real IronClaw URL/secret are present), the execution router registers `MockIronClawAdapter` as the primary adapter. Setup page now shows IronClaw "Running" out of the box instead of silently dropping the engine (#99)

### Fixed

- **`whatWouldIDo` no longer leaks blocked candidates as alternatives**: Filters `alternativeActions` using the new per-candidate verdicts. Previously the prediction surfaced policy-denied actions as options the user could take. Conservative fallback drops alternatives entirely when verdicts are unavailable (#82)
- **Blocked-by-policy decisions now persist `escalationRationale`**: Previously the audit log silently dropped the policy-block reason for no-action outcomes, violating Safety Invariant #2. `formatForUser` uses a context-aware label ("Why no action was taken" vs "Why approval was needed") (#82)
- **"How well I know you" stat counted only inferences**: Users with explicit preferences saw 0% even when the twin had real knowledge. Now combines preferences and inferences, weighting explicit/corrected preferences as `'confirmed'` (#86)
- **Generic preference description read like a config dump**: Was "Travel: find_travel_deals = i love travel deals". String values now surface as the preference itself: "Travel: i love travel deals" (#86)
- **Spending guardrails forced cents input**: Inputs now show "$" prefix and decimal step, pre-fill as dollars, save by rounding dollars*100 back to cents to avoid float drift. Domain-policy badge also shows "max $X/action" (#86)
- **Decisions table showed raw enum names and stripped dates**: "What happened" column now maps `email_triage` → "Email triage", `generic` → "General", etc. Timestamps now use relative time for recent rows ("2h ago") and "Apr 7, 9:44 PM" format for older — identical-second seed data no longer blurs together (#85)
- **Twin badges said "1 things" / "1 prefs" / "1 inferences"**: Now singularizes when count is 1 (#79)
- **Decisions table Undo button was indistinguishable from a label**: `.btn-ghost` (transparent border, muted text) → `.btn-outline` for visible affordance (#79)
- **URL validation hardened against zone IDs, trailing dots, CGNAT**: Centralized hostname normalization (`normalizeHostname`) catches `localhost.`, `[fe80::1%eth0]`, and uppercase variants. Added blocks for IPv6 unspecified `[::]` / `[0:0:0:0:0:0:0:0]` and the CGNAT range `100.64.0.0/10` (RFC 6598) (#90)
- **Adapter discovery validates plugin shape post-construction**: After calling `factory()`, the loader now verifies the returned object has the four required `IronClawAdapter` methods. Plugins returning malformed objects fail at load time instead of bubbling up as `NoAdapterError` under load. Also wraps the factory call in `try/catch` so a throwing constructor doesn't kill discovery for unrelated plugins (#91)
- **Worker dedupe cap is now a hard ceiling**: Eviction now triggers on `size >= maxPerUser` (was strict `>`). Previous logic allowed +1 overshoot. Eviction drops expired entries first, then falls back to oldest-first removal until `size < maxPerUser` (#93)
- **`/api/events/ingest` returned 500 on non-UUID `userId`**: The validator from #95 only checked "non-empty string", so `userId="501"` (or any malformed token) fell through to the DB layer and crashed pg-pool with `could not parse "501" as type uuid`. Now hard-rejects with 400 + structured `{field:"userId", message:"userId must be a valid UUID"}` at the boundary (#99)

### Tests

- **Explanation generator has full branch coverage**: 33 tests covering `generate`, `formatForUser`, `formatForAudit`, and every branch of the six private helpers. Pins user-facing copy across renames and refactors. Also catches the `formatForAudit` `autoExecuted = !escalationRationale` derivation (#77, #82)
- **Decision-engine `whatWouldIDo` partial-block coverage**: New tests verify mixed verdicts filter correctly, all-blocked returns no recommendation and no alternatives, and outcomes without `policyVerdicts` fall back conservatively (#82)
- **Decision-engine policy-denial blocking is locked in**: Verifies every candidate verdict is recorded on `outcome.policyVerdicts` and that selection logic still picks the highest-scored allowed candidate (#82)
- **`ExecutionRouter` boundary guards**: New tests cover null/undefined `RiskAssessment`, mismatched `actionId`, and null `CandidateAction` for both `executeWithRouting` and `executeWithRoutingStreaming` (#78, #81)
- **Events-routes test for blocked-by-policy SSE emission**: Asserts the handler emits the new event and does not call `executeWithRoutingStreaming` when no candidate was selected (#78)
- **Test fixture isolation in `@skytwin/explanations`**: Seven describe blocks now use per-test `beforeEach` instead of module-level `const` for the in-memory repo, so saved records no longer accumulate between `it()` calls (#81)
- **`@skytwin/config` test coverage** (was 0): 18 tests covering `loadConfig` defaults, env reads, `GATEWAY_AUTH_TOKEN` and `IRONCLAW_CHANNEL` legacy aliases, `validate()` per-field rejection, and `loadValidatedConfig` aggregated error message (#88)
- **`@skytwin/core` top-level helpers covered**: 20 tests for `generateId` (UUID shape + uniqueness), `compareRiskTiers`/`riskExceeds`/`trustMeetsOrExceeds` semantics, tier ordering tables, and `createLogger` level routing + format + meta JSON serialization (#88)
- **`@skytwin/connectors` Gmail + Calendar pure-logic coverage**: 35 new tests for `inferEmailType` (9 categories), `messageToSignal` (case-insensitive headers, `requiresResponse` derivation, internalDate parsing), `eventToSignal` (needsAction handling, all-day events, conflict flag), `detectConflicts` (overlap, back-to-back boundary, three-way overlap, all-day exclusion). Connectors went 8 → 43 tests (#89)
- **URL validation hardening tests** (+10): trailing-dot bypasses, IPv6 zone IDs, IPv6 unspecified `[::]`, CGNAT boundaries, uppercase normalization (#90)
- **Adapter manifest + shape validation tests** (+8): `defaultConfig` parsing and drop-on-non-object, `isAdapterShape` enumerating required methods, null/undefined/primitive rejection (#91)
- **`PreferenceArchaeologist` extended coverage** (+8): action-key fallback chain (`data.action` → `data.preference_key` → `data.behavior` → skip), multi-group analysis, sub-threshold drop, `supportingEvidence` cap at 10, `expiresAt` 30-day window, non-explicit existing preferences do NOT block re-proposal (#92)
- **`@skytwin/worker` test coverage** (was 0): 11 tests for the new `SignalDeduper` — per-user isolation, source-namespacing, TTL boundary, `mark()` idempotency, `reset()` per-user, expired-first eviction, oldest-insertion-order eviction, eviction inert at-or-below cap with no insert (#93)
- **Events-ingest validator coverage** (+25): Happy paths, body shape (null/array/primitive/undefined), userId presence + type + non-empty, source/type type guards, urgency enum, data shape, `trustTier` injection rejection, error aggregation across multiple bad fields. `@skytwin/api` 142 → 167 (#95)

## [0.4.0.0] - 2026-04-08

### Added

- **LLM-powered decisions**: Your twin can now use Claude, GPT, Gemini, or a local Ollama model to interpret events and generate candidate actions, instead of relying solely on keyword matching and hardcoded rules
- **Provider chain with automatic fallback**: Configure multiple AI providers in priority order. If Anthropic is down, the system tries OpenAI, then Ollama, then falls back to built-in rules. Per-provider circuit breakers prevent repeated timeouts
- **AI brain settings UI**: New drag-and-drop card in Settings to add, reorder, test, enable/disable, and remove AI providers. One-click connection test shows latency and model info
- **`@skytwin/llm-client` package**: Unified LLM client with provider chain, circuit breakers, prompt builder, and response parser. Supports Anthropic, OpenAI, Google, and Ollama via raw fetch (no SDK dependencies)
- **Strategy pattern in decision-engine**: `SituationInterpreter` and `DecisionMaker` now accept pluggable strategies. LLM strategies wrap the client; rule-based strategies preserve all existing logic as fallback
- **Dynamic adapter discovery**: Execution router can scan a plugin directory for adapter manifests, dynamically importing and registering third-party execution adapters with enforced minimum trust scores
- **Desktop OAuth via system browser**: Electron app opens Google OAuth in the system browser instead of an embedded window (which froze on passkey verification). Polls for completion with 5-minute timeout, shows close-tab confirmation page on success

### Fixed

- **API keys silently erased on save**: Saving your AI provider settings no longer wipes your API keys. The server preserves existing keys when the UI sends masked previews back
- **Per-request circuit breaker defeat**: A downed AI provider is now remembered across requests. Previously, the system forgot failures between events and kept retrying a broken provider on every single decision
- **SSRF via user-controlled baseUrl**: All LLM providers now validate baseUrl against private IP ranges (RFC 1918, link-local, cloud metadata, 0.0.0.0, octal/hex encodings, IPv6-mapped IPv4). Ollama is exempted for loopback addresses only. DNS rebinding protection resolves all A/AAAA records at save time, blocking hostnames like `127.0.0.1.nip.io` that resolve to private IPs
- **Google API key leaked in URL**: Moved from query parameter (`?key=`) to `x-goog-api-key` header
- **Path traversal in adapter plugins**: Entry point paths are resolved via realpathSync (following symlinks) and checked with trailing separator to prevent both symlink escape and directory prefix confusion
- **Plugin name collision**: Discovered adapters cannot use reserved names (ironclaw, direct, openclaw), preventing overwrites of built-in adapters
- **Race condition in execution router init**: Singleton now stores the initialization promise (not the result) to prevent duplicate router creation under concurrent requests, with error recovery on rejection
- **LLM-controlled safety fields**: The LLM can no longer set its own cost estimates or reversibility flags on candidate actions. These safety-critical values are overridden with conservative defaults, and the deterministic scoring and policy layers handle the real values
- **XSS in settings page**: userId now escaped in all onclick handlers to prevent injection via mobile pairing URL
- **NaN/Infinity in adapter manifest**: riskModifier validated with Number.isFinite before use
- **N+1 on decisions page**: batch-fetches decision outcomes in a single query instead of one per row
- **XSS in dashboard activity**: domain and situationType now escaped with escapeHtml in recent activity feed
- **Null crash in audit trail**: optional chaining on `entry.detail?.decisionId` prevents TypeError on malformed entries
- **escapeHtml null guard**: `escapeHtml(null)` no longer throws, returns empty string
- **0% accuracy on empty data**: dashboard shows "--" instead of "0%" when no decisions exist
- **Decisions limit injection**: limit/offset parameters clamped to [1, 200] with NaN fallback

### Changed

- **Decision status badges**: decisions page now shows Auto / You OK'd / Pending based on three-way outcome state (auto-executed true, false, or missing)
- **Stat card tooltips**: all four dashboard stat cards have title attributes explaining what each metric means

## [0.3.3.1] - 2026-04-08

### Added

- **Twin insight editing**: Edit button on each insight card opens a styled modal to update what the twin knows
- **Correction modal**: "That's not right" now opens a proper modal (replaces browser prompt) with save, remove, cancel, and keyboard shortcuts (Cmd+Enter, Escape)
- **DELETE /api/twin/:userId/insights endpoint**: atomic insight correction and removal with input validation and length limits

### Fixed

- **Twin feedback was broken**: feedback buttons on the My Learnings page called invalid API endpoints (null decisionId, wrong type). Replaced with dedicated insight management endpoint
- **XSS in insight rendering**: `escapeHtml()` now escapes quotes for HTML attribute safety, `item.reasoning` is escaped before innerHTML injection
- **Double-submit prevention**: correction modal guards against concurrent API calls from click + keyboard
- **Redundant DB queries**: correction path reduced from 4 sequential CockroachDB calls to 2 (one read, one atomic write)
- **Predictable IDs**: preference IDs use `crypto.randomUUID()` instead of `Math.random()`

### Changed

- **btn-ghost CSS class**: added missing button variant used by Edit buttons, with hover state and focus-visible keyboard indicator

## [0.3.3.0] - 2026-04-08

### Added

- **Approvals history overlay**: full decision history with search, detail expansion, infinite scroll, and per-item collapsible execution details showing what happened (or would have happened) for each decision
- **Signal context in approval cards**: pending approvals now show the original email body, sender, source, and subject so you have enough information to decide without leaving the page
- **Alternative actions for escalations**: when the twin escalates, you now see the other options it considered (with parameters, cost, reversibility) so you can pick one directly
- **Skill gaps endpoint**: new `GET /api/v1/skill-gaps/:userId` to retrieve per-user skill gap history
- **Batch repository methods**: `findByIds()` and `getCandidateActionsForDecisions()` on decision repository for efficient bulk lookups

### Changed

- **N+1 query elimination**: pending approvals endpoint reduced from 2N+1 database queries to exactly 3 fixed queries via batch `WHERE id = ANY($1)` and in-memory Map joins
- **Soft-delete for escalation cleanup**: stale escalations are now marked `status = 'cleaned'` instead of hard-deleted, preserving audit trail for pattern analysis
- **OAuth redirect**: callback now uses `WEB_BASE_URL` env var instead of hardcoded localhost, supporting deployed environments
- **PostgreSQL error codes**: duplicate candidate action detection uses error code `23505` instead of fragile string matching
- **Worker error isolation**: expiry and escalation cleanup run in separate try/catch blocks with per-user error handling so one failure doesn't block others

### Fixed

- **XSS hardening**: all user-controlled data in `describeExecutionStep()`, `describeAction()`, `explainReason()`, suggestion buttons, and domain labels now goes through `escapeHtml()` before HTML interpolation
- **History limit**: clamped to max 500 (was unbounded, could dump entire table)
- **Sensitive key filtering**: `accessToken`, `oauthToken`, `refreshToken`, and `credentials` are stripped from alternative action parameters before sending to the frontend
- **Ownership check**: cleanup-escalations endpoint rejects cross-user requests with 403

## [0.3.2.1] - 2026-04-07

### Added

- **Launch-ready README**: Complete rewrite with value proposition, ASCII architecture diagram, concrete scenario examples, trust tier documentation, version badges, and 6 dashboard screenshots
- **Apache 2.0 License**: Open-source licensing replaces proprietary notice
- **Community files**: CONTRIBUTING.md (dev workflow, safety invariants), SECURITY.md (vulnerability reporting, threat scope), CODE_OF_CONDUCT.md (Contributor Covenant)
- **GitHub templates**: Bug report and feature request issue templates, PR template with safety checklist
- **Dependabot**: Weekly automated dependency updates for npm and GitHub Actions
- **Dashboard screenshots**: Onboarding, dashboard, approvals, decision history, setup/credentials, and settings pages captured and embedded in README

### Changed

- Package.json enriched with description, repository URL, homepage, author, license, and keyword metadata

## [0.3.2.0] - 2026-04-07

### Added

- **Memory Palace** (`@skytwin/mempalace`): Your twin now remembers. A spatial memory system inspired by [mempalace](https://github.com/milla-jovovich/mempalace), ported from Python to native TypeScript and backed by CockroachDB instead of ChromaDB/SQLite. Organizes memories into wings (domains), rooms (topics), and drawers (individual memories), with cross-wing tunnels that connect related topics across domains.
- **4-Layer Memory Stack**: Decisions now load context from a tiered retrieval system. L0 (identity, ~100 tokens) and L1 (essential story, ~500 tokens) are always loaded. L2 recalls on-demand per wing/topic. L3 runs full search across all drawers and episodes.
- **Episodic Memory**: Every decision outcome is recorded as an episode linking the situation, action taken, and user feedback. When a new decision arrives, the engine retrieves similar past episodes to inform scoring. Approved episodes boost similar actions (+20 cap), rejected/undone episodes penalize them (-15 cap).
- **Knowledge Graph with Temporal Triples**: Track facts about people, places, and projects with validity windows. "Alice works at Acme" valid from 2025-03 to present. Point-in-time queries answer "what was true on date X?"
- **AAAK Compression**: Compact memory encoding using 3-letter entity codes, hall prefixes, and significance flags (CORE, PIVOT, GENESIS, DECISION). Produces token-efficient closets from multiple drawers.
- **Memory Miner**: Automatically extracts memories from signals, decisions, and feedback. Signals become drawers filed in the right wing/room. Decisions become episodic memories. Corrections and undos become discovery drawers. Entity names and email domains are extracted into the knowledge graph.
- **Memory Palace API**: 12 new endpoints at `/api/mempalace/:userId/` for palace status, wings, rooms, drawers (CRUD + search), tunnels, episodic memories (list + search), and knowledge graph entities and triples.
- **Decision Pipeline Integration**: `DecisionContext` now carries `episodicMemories` and `wakeUpContext`. The `scoreCandidate()` method includes a new `calculateEpisodicBoost()` that uses past episode outcomes to adjust candidate action scores.
- 9 new CockroachDB tables (migration 012): `memory_wings`, `memory_rooms`, `memory_drawers`, `memory_closets`, `memory_tunnels`, `knowledge_entities`, `knowledge_triples`, `episodic_memories`, `entity_codes`
- 19 new shared types for the memory palace data model
- 43 new tests across 6 test files covering palace structure, episode lifecycle, knowledge graph, AAAK compression, memory mining, and decision context enrichment (589 total, up from 546)

## [0.3.1.1] - 2026-04-07

### Added

- **mDNS Service Advertisement**: SkyTwin API now advertises itself on the local network via Bonjour/mDNS (`_skytwin._tcp`), enabling automatic discovery by mobile and desktop clients
- **Database Repository Tests**: 76 unit tests covering user, approval, decision, and policy repositories with full mock isolation
- **E2E Test Infrastructure**: Real CockroachDB integration tests (15 DB tests + 22 API tests) behind `E2E=true` gate, with `bin/skytwin-e2e-test` orchestration script for Docker-based runs
- **Circuit Breaker Probe Latch Tests**: Verifies only one probe is allowed in half-open state, preventing thundering herd
- **Retry TypeError Distinction Tests**: Verifies network TypeErrors are retried while programming TypeErrors are not

### Changed (Breaking)

- **Approval respond returns 409**: POST `/api/approvals/:requestId/respond` now returns HTTP 409 (Conflict) instead of 404 when an approval has already been responded to. Clients should handle both 404 (not found) and 409 (already handled).

### Fixed

- **Process supervision PID orphan**: `bin/skytwin-dev` now properly tracks child process PIDs and forwards SIGTERM/SIGINT, preventing orphaned node processes on `--stop`
- **Circuit breaker thundering herd**: Half-open state now uses a probe-in-flight latch so only one request probes recovery at a time
- **Retry false positive on TypeError**: `isNetworkError()` no longer classifies programming TypeErrors (e.g., null dereference) as retryable network errors
- **Approval double-execution race condition**: `approval_requests` UPDATE now includes `AND status = 'pending'` for atomic check-and-set, with ownership verified before mutation and 409 returned for already-responded requests
- **Worker circuit breaker memory leak**: Circuit breakers for removed users are now pruned during connector rediscovery
- **API graceful shutdown**: Server now handles SIGTERM/SIGINT with mDNS cleanup and HTTP connection draining

## [0.3.0.0] - 2026-04-01

### Added

- **Trust Tier Progression Engine** (`TrustTierEngine`): Users now auto-promote from OBSERVER through MODERATE_AUTONOMY based on approval history (10/20/50/100 thresholds). HIGH_AUTONOMY requires explicit opt-in, never auto-promoted. Rolling-window regression checks demote users after rejection spikes. All tier changes produce audit records in the new `trust_tier_audit` table.
- **Approval Routing with Expiry** (`ApprovalRouter`): Approval requests now expire based on urgency (immediate=15min, normal=24h, low=72h). Worker cron sweeps expired requests. Batch respond endpoint at POST /api/approvals/batch-respond for bulk approve/reject.
- **Daily Spend Tracking** (`SpendTracker`): Rolling 24-hour spend window enforced per user. Per-action AND daily aggregate limits are now hard-gated in the policy evaluator. Reconciliation updates actual costs when they differ from estimates, freeing up budget.
- **Domain-Specific Autonomy** (`DomainAutonomyManager`): Per-domain trust tier overrides. The system uses the more restrictive of global and domain tier, so HIGH_AUTONOMY globally + LOW_AUTONOMY for finance means finance actions still require approval.
- **Escalation Triggers** (`EscalationTriggerEngine`): Configurable triggers fire on amount thresholds, consecutive rejections, novel situations, and time-of-day rules. Returns structured escalation reasons with evidence.
- **Safety Invariant Integration Tests**: 7 test groups covering every safety invariant from CLAUDE.md, plus 3 regression scenarios for daily spend, domain autonomy, and tier progression.
- **Workflow Registry** (`WorkflowHandlerRegistry`): Maps SituationType to handler functions. Four new workflow handlers: calendar-conflict, subscription-renewal, grocery-reorder, travel-decision, each with E2E tests.
- **IronClaw Contract Tests**: 15 tests validating that MockIronClawAdapter and RealIronClawAdapter produce compatible outputs. MockIronClawServer with HMAC-SHA256 verification for local testing.
- **Rollback E2E Tests**: 6 tests verifying the full execute-then-rollback lifecycle, irreversible rejection, unknown plan handling, and independent multi-plan rollback.
- **Settings API and Page**: GET/PUT endpoints for autonomy settings, domain overrides, and escalation triggers at /api/settings/:userId. Settings page shows current trust tier, autonomy controls, and domain-specific policies.
- **Escalation Correctness Metric** (`EscalationCorrectnessTracker`): Measures under-escalation and over-escalation rates from feedback data.
- **Calibration Error Metric** (`CalibrationErrorTracker`): Computes Expected Calibration Error (ECE) by bucketing decisions by confidence and comparing predicted vs actual accuracy.
- **Decision Latency Metric** (`DecisionLatencyTracker`): Tracks P50, P90, and P99 latency across the decision pipeline.
- **39 New Eval Scenarios**: 8 each for calendar, subscription, grocery, and travel domains, plus 7 cross-domain correlation scenarios. Total scenario count: 50+.
- **Preference Evolution Tracking** (`PreferenceEvolutionTracker`): Records every preference change with attribution (which feedback or evidence caused it). New `preference_history` table with point-in-time reconstruction.
- **Temporal Replay Engine** (`TemporalReplayEngine`): Reconstructs twin state at any point in time using twin_profile_versions + preference_history. Supports diffing between two timestamps and timeline generation.
- **CI Workflow** (`.github/workflows/evals.yml`): Runs the eval suite on push to main and on PRs. Fails on safety regression.
- 5 new DB migrations (006-010): trust_tier_audit, approval enhancements (expires_at, batch_id), spend_records, domain_autonomy_policies + escalation_triggers, preference_history
- 172 new tests (432 total, up from 260)

### Changed

- OpenClaw adapter upgraded from mock-only to real HTTP client with `/execute` and `/rollback` endpoints, Bearer auth, and dry-run fallback when no server is configured
- `ContinuousEvalRunner` now stores per-scenario pass/fail results on `EvalRun.scenarioResults` for regression comparison across runs
- Event ingestion route now uses `WorkflowHandlerRegistry` instead of direct email-triage imports

### Fixed

- `/ask` endpoint now looks up trust tier from DB via `userRepository.findById()` instead of hardcoding `TrustTier.OBSERVER`
- `/briefings` endpoint now queries `proactiveScanRepository.getLatestBriefing()` instead of returning stub data
- `/skill-gaps` endpoint now queries `skillGapRepository` instead of returning an empty array
- `/proposals` endpoint now validates ownership and status via `proposalRepository`, and accepted proposals update the twin model via `twinService.updatePreference()`

## [0.2.0.0] - 2026-04-01

### Added

- **Execution Router** (`@skytwin/execution-router`): Adapter selection between IronClaw, OpenClaw, and Direct execution with trust-ranked fallback chains, risk modifiers for irreversible actions, and skill gap detection that logs unhandled action types
- **Twin Query API**: `whatWouldIDo()` endpoint at POST /ask/:userId that predicts what the twin would do in a hypothetical situation without persisting state, using a no-op decision repository to prevent synthetic query records in the DB
- **Twin Export**: Export your full twin profile as JSON or Markdown at GET /export/:userId, including preferences, inferences, behavioral patterns, cross-domain traits, and temporal profile
- **Proactive Mode**: ProactiveEvaluator scans incoming signals, partitions into auto-executable actions (HIGH confidence only) and approval-needed items, and generates urgency-sorted morning briefings
- **Preference Archaeology**: PreferenceArchaeologist analyzes accumulated evidence to detect implicit behavioral patterns and surfaces them as preference proposals for user confirmation (5+ consistent signals required, confidence scales with count)
- **Undo-with-Learning**: Extended feedback system accepts structured undo reasoning (whatWentWrong, severity, whichStep, preferredAlternative) and applies 2x weight correction to the twin model, with severe undos triggering extra confidence reduction
- **Cross-Domain Correlation**: Four correlation rules detect relationships across domains: calendar-email links, same-sender threading within 24h, calendar time conflicts, and subscription-financial connections
- **Phase 1 DB Migrations**: Six new tables (signals, preference_proposals, twin_exports, skill_gap_log, proactive_scans, briefings) and four column additions using CockroachDB-safe 3-step pattern (ADD nullable, UPDATE, SET NOT NULL)
- Token-scoped rate limiting on /ask endpoint, tiered by trust level (60-600 requests/hour)
- Briefing schedule configuration via PUT /briefings/:userId/preferences
- API routes for proposals (GET + POST accept/reject) and skill gaps (GET)
- OpenClaw adapter with mock-first implementation and declared skill set
- 96 new tests covering inference engine, decision maker branches, rate limiting, and feedback validation (260 total, up from 164)
- 8 planning documents for the scope expansion milestone

### Changed

- ExecutionRouter fallback logic now only retries on thrown errors (safe to retry); non-completed status returns immediately to prevent double-execution of partially-completed actions
- OpenClaw trust profile corrected: reversibilityGuarantee changed from 'partial' to 'none' (rollback always fails)
- RoutingDecision now includes modifiedRiskAssessment so callers can see the post-modifier risk tier

### Fixed

- Trust tier in /ask endpoint is now server-determined (defaults to OBSERVER per Safety Invariant #3) instead of accepting client-supplied values
- Ask endpoint uses real DB-backed TwinService and PolicyEvaluator instead of mocks, with a no-op DecisionRepository to prevent synthetic records polluting decision history
- Twin export route (/export/:userId) moved before the wildcard (/:userId) to prevent Express matching "export" as a userId
- Undo feedback validation relaxed from mandatory to optional for API backwards compatibility
- Migration safety: NOT NULL DEFAULT on existing CockroachDB tables split into 3-step pattern to avoid table-level locks
- Added missing foreign key indexes on skill_gap_log, twin_exports, and briefings tables

## [0.1.0.0] - 2026-03-31

### Added

- Monorepo scaffolding with pnpm workspaces, Turborepo, and TypeScript strict mode
- Full shared type system: User, TwinProfile, DecisionObject, CandidateAction, RiskAssessment, ActionPolicy, ExplanationRecord, and 20+ supporting types
- CockroachDB schema with 14 tables covering users, twin profiles, decisions, policies, executions, explanations, and feedback
- Repository layer with parameterized queries for all tables
- Twin model service with preference management, inference engine, and version history
- Decision engine with situation interpreter (6 situation types), risk assessor (6 dimensions), and candidate action generation
- Policy engine with 5 built-in safety policies: spend limits, irreversibility checks, legal review gates, privacy protection, and trust tier gating
- Explanation generator producing human-readable and structured audit records for every decision
- IronClaw adapter with HTTP client (HMAC-SHA256 auth, retries, circuit breaker) for the [IronClaw](https://github.com/nearai/ironclaw/) execution server, DirectExecutionAdapter fallback, and mock adapter for development
- Real Gmail and Google Calendar signal connectors with OAuth token auto-refresh, plus mock connectors for testing
- Evaluation harness with scenario framework, email triage scenarios, and safety regression suite
- Express API server with routes for event ingestion, twin management, decisions, approvals (full CRUD with pending/history/respond), feedback, evals (accuracy/learning/confidence), OAuth flow, and user management
- Multi-user worker service that discovers users with active OAuth tokens from CockroachDB, creates per-user real connectors, and re-discovers every 10 poll cycles
- Google OAuth2 flow with authorization, token exchange, DB-persisted tokens, and auto-refresh via DbTokenStore adapter
- Approval pipeline: events create approval requests when confidence is low, users review in the web dashboard, responses feed back into the twin model
- Behavioral pattern and cross-domain trait persistence via PatternRepositoryPort backed by CockroachDB
- Pattern-aware decision scoring: DecisionMaker uses pattern boosts and trait adjustments (5 cross-domain traits) when evaluating candidate actions
- Web dashboard SPA with hash-based routing: dashboard (confidence bars, accuracy, patterns), approval cards with human-readable descriptions, twin profile grouped by domain, settings with tier selector and Google connection, onboarding wizard
- Evals API endpoints calculating real accuracy from feedback data, learning progress aggregation, and per-domain confidence scoring
- DB migrations for OAuth tokens, behavioral patterns, cross-domain traits, and eval history
- End-to-end email triage workflow wiring all modules together
- 119 tests across decision engine, policy engine, twin model, IronClaw adapter (HTTP client, circuit breaker, direct execution, handler registry), evals, and connectors
- Docker Compose setup with CockroachDB single-node for local development
- 7 documentation files covering product spec, technical spec, safety model, decision engine, IronClaw integration, CockroachDB architecture, and evals
- 15 planning artifacts: 5 milestone docs and 10 issue specs

### Fixed

- IronClaw adapter now actually communicates with the [IronClaw](https://github.com/nearai/ironclaw/) server via HTTP webhook (POST /webhook with HMAC-SHA256 auth) instead of dispatching to local handler classes that called Gmail/Calendar APIs directly
- Sensitive credentials (OAuth tokens, API keys) are sanitized before being sent to IronClaw, replaced with managed references
- Config now validates that `IRONCLAW_WEBHOOK_SECRET` is set when mock mode is off
- Mobile nav menu now has a backdrop overlay and closes when tapping outside
- Error banners on settings page now clear previous errors before showing new ones
- HTML in error messages is now escaped to prevent XSS
- Connection status indicator now visible on mobile when nav menu is open
- Trust tier default changed from invalid `'new'` to `'observer'` (matching TrustTier enum)
- Policy evaluator now denies unrecognized trust tiers instead of silently permitting them
- Trust tier in event ingestion now read from DB user record instead of caller-supplied request body
- `justConnected` URL parameter in settings page escaped to prevent reflected XSS
- Twin profile update query now validates column names against an allowlist
