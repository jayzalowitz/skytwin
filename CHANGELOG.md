All notable changes to SkyTwin will be documented in this file.

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
