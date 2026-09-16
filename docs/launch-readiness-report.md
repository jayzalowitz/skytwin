# SkyTwin Launch-Readiness Report

**Date:** 2026-06-14 (updated 2026-06-23) · **Version audited:** 0.6.61.0 · **Branch:** `jayzalowitz/pre-launch-dev-audit-toolchain`

This report is the output of a full launch-readiness pass: every open GitHub issue audited against the actual code (not the issue narrative), the whole app built/tested/linted, and the running dashboard QA'd against the [master pre-launch epic #357](https://github.com/jayzalowitz/skytwin/issues/357) launch criteria. It pairs with [`launch-plan.md`](./launch-plan.md) (the procurement/sequencing plan). Its checkmarks record the development/source revision named above; they are not certification of a later packaged artifact or the current published release.

## 2026-09-13 packaged-sample release boundary

Current source adds a guarded account-free packaged demo: a short-lived credential bound to one reserved fictional identity and an explicit read allowlist. Its database-backed product surface is deliberately read-only. Approve, reject, correct, reset, and learn interactions run only in a separate loopback-only simulation with bounded in-memory state. The simulation uses the real policy and explanation logic but cannot open settings, mutate the database, invoke connectors or providers, access credentials, or reach execution adapters. Browser authority is scoped to one tab. The service worker applies case-insensitive API route semantics, bypasses all `/api/v1/demo` traffic, and also bypasses normal product routes carrying the sample bearer credential or EventSource query token. It discards stored writes that fail the current replay policy. Source of truth: `apps/api/src/services/sample-simulation.ts`, `apps/web/public/js/sample-session.js`, `apps/web/public/js/pwa/sw-policy.js`, and `apps/web/public/sw.js`.

The currently published installers predate this packaged sample path. The
account-free desktop launch still requires fresh verified artifacts, signing,
production key management, packaged sample/model evidence, release evals, and
the invited-tester bake recorded in the claim ledger. Google OAuth review and
mobile/store distribution are deferred post-launch; they do not block this
account-free candidate.

The older Gmail-connect criteria, OAuth blocker classification, and submission
advice retained in the dated audit below are superseded by this boundary. They
remain visible only as history and must not be used as current launch actions.

---

## 2026-06-23 code-audit addendum

The v0.6.59.0 pre-launch code audit fixed the remaining runtime/QA issues found in the release candidate:

- The web dashboard's MCP token form now follows the delegated event-listener pattern and no longer renders inline `onsubmit`; the page was rechecked on mobile widths.
- `/api/users/:userId` routes now resolve UUID-or-email identifiers safely while preserving ownership checks and avoiding email-existence enumeration.
- Cockroach `INT8` policy priorities are normalized back to JavaScript numbers in both repository paths before the policy engine consumes them.
- The local e2e runner can reuse the existing Cockroach container name and scopes `SKYTWIN_DEV_AUTH_BYPASS=true` to its API subprocess only.
- Production dependency audit is clean after root `pnpm.overrides` pin patched transitive versions.

Verification for the addendum: `pnpm audit --prod`, `pnpm lint --force`, `pnpm exec turbo run test --force`, `pnpm build --concurrency=1 --force`, `pnpm test:e2e`, `git diff --check origin/main...HEAD`, and live web/API smoke against seeded Cockroach all passed.

After v0.6.59.0 merged, the required rerun against `origin/main` found two post-merge browser QA regressions and v0.6.60.0 fixes both:

- `#/memory-settings` now uses the shared storage-key constants instead of obsolete dotted localStorage names, so its `memory-config` calls include the current user id and return 200 instead of 400.
- Mobile dashboard pages no longer gain horizontal scroll from the global pause mount or long MCP setup snippets; the 390px token-page check now reports `scrollWidth === clientWidth === 390`.

Verification for the v0.6.60.0 follow-up: `pnpm audit --prod`, `git diff --check`, inline-handler scan, focused web regression tests, `pnpm --filter @skytwin/web lint`, `pnpm --filter @skytwin/web build`, `pnpm lint --force`, `pnpm exec turbo run test --force`, `pnpm build --concurrency=1 --force`, `pnpm test:e2e`, and live browser QA against built API/web with seeded Cockroach all passed. The browser sweep covered 17 dashboard routes with no console errors, no 4xx/5xx requests, no route overflow, `memory-config` 200 responses with the seeded user id, MCP token creation (`POST /api/external-agents/tokens` 201), and the 390px token layout.

The v0.6.61.0 toolchain audit extended the dependency gate from production-only to the full dev/build graph. It upgraded Vitest across the workspace to 3.2.6, pinned patched `esbuild` and `tar` versions through pnpm overrides, adjusted Vitest-sensitive tests, made opportunistic Turbo GitHub Actions cache setup non-blocking, and replaced Unix-only package asset copy commands with portable Node scripts so Windows desktop CI can build the prompt and registry packages. Verification for the toolchain follow-up: `pnpm audit --prod`, `pnpm audit`, `git diff --check`, `pnpm lint --force`, `pnpm exec turbo run test --force`, `pnpm build --concurrency=1 --force`, `pnpm test:e2e`, the focused desktop idle-bridge test suite, and focused `@skytwin/policy-prompts` / `@skytwin/registry-client` builds all passed.

The issue inventory below remains the 2026-06-16 launch-readiness classification; this addendum covers the final code and QA pass through v0.6.61.0.

---

## Bottom line

**This report is historical and does not establish current release readiness.**
The later `v0.7.0-beta` release contract adds code and evidence gates that this
June 2026 snapshot did not evaluate. Consult
[`beta-claim-ledger.json`](./beta-claim-ledger.json) for the current support,
privacy, security, and artifact status. The audited development/source revision
passed its recorded engineering checks, but that result does not establish that
published installers contain later source work or that a fresh release artifact
has passed validation.

The dated audit recorded the blockers below. For the current account-free
desktop launch, the claim ledger is authoritative; Google OAuth and mobile/store
items in this historical inventory are explicitly non-blocking and deferred.

1. **Procurement** — Apple Developer ($99/yr) + Windows EV code-signing certs (#368/#359). Until these land, the `.dmg`/`.exe` trip Gatekeeper/SmartScreen. This is the single biggest non-engineering blocker.
2. **External review (superseded for this launch)** — Google OAuth restricted-scope / brand verification (#351) and mobile app-store review (#369/#360) remain future account/mobile work, not account-free desktop launch gates.
3. **Design assets** — real multi-resolution mobile icons/splash to replace the 1×1 placeholders (#409/#369).

4. **Code and architecture** — the #401 key-management decision is now captured
   by ADR 0001 and the first locked broker/custody slice exists, but #374 remains
   incomplete: source clients, an owner-wide cascade/revoke barrier,
   source-field migration, packaged verification, and bake evidence are still
   required. See [§ Encryption and key-management detail](#encryption-and-key-management-detail).
   Other partial code-side items remain tracked under #357 and in the inventory below.
5. **Artifact verification** — build fresh installers from the intended release head and validate their exact behavior on clean supported systems. The source-tree checks below do not substitute for this gate.

---

## App health (verified 2026-06-23)

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ✅ clean |
| `pnpm audit --prod` + `pnpm audit` | ✅ clean |
| `pnpm build --concurrency=1 --force` | ✅ 35 targets |
| `pnpm lint --force` | ✅ 61 targets |
| `pnpm exec turbo run test --force` | ✅ 70 targets |
| `pnpm test:e2e` | ✅ DB + API e2e smoke passed |
| Live QA (api:3100 + web vs seeded CRDB) | ✅ v0.6.60 runtime sweep remains valid for v0.6.61.0's dev-toolchain-only change: 17 dashboard routes, 0 console errors/4xx/5xx/overflow; memory settings + MCP token generation verified |

## Launch criteria status (epic #357)

| # | Criterion | Status |
|---|---|---|
| 1 | Download a signed `.dmg`/`.exe`/store build | ⛔ external — certs (#368/#359), store accounts (#369) |
| 2 | Install without Gatekeeper/SmartScreen warnings | ⛔ external — certs |
| 3 | Reach a meaningful state ≤60s | 🟡 development tour verified; current source adds an interactive packaged sample, but published installers predate it and a fresh artifact still needs validation |
| 4 | Connect Gmail **or** "Try with a sample profile" → decisions | Superseded for the account-free launch. The isolated packaged sample is the only supported preview path; fresh artifact evidence remains required. |
| 5 | A real decision in the queue ≤5 min of connecting Gmail | Superseded for the account-free launch. Connected-account development results are not launch evidence. |
| 6 | Understand *why* each decision was made | ✅ development/connected flow verified; current packaged-sample source can inspect allowlisted decision and explanation views |
| 7 | Approve/reject without confusion | 🟡 connected/development controls and microcopy were verified; current source adds isolated packaged approve/reject/correct interactions, but a fresh artifact still needs validation |
| 8 | Find a whole-system pause control | 🟡 partial — the global **Pause everything** button stops MCP capability servers only; Settings **Pause auto-execution** routes actions to review while signal sync continues; the desktop tray stops the packaged worker and suppresses delayed replacement, containing partial generations during recovery. No single control currently stops every subsystem. |
| 9 | Find a "delete my data" button | ✅ connected/development product exposes Settings → **Download** + **Delete my data** (#376); Settings is outside packaged-sample authority |
| 10 | Receive auto-updates | 🟡 source/CI path implemented — the tagged workflow generates and is designed to attach manifests (#370), and the user-facing layer (in-app update banner + "Check for Updates…" menu) landed; no qualifying tagged release is published, and signed-build e2e remains gated on #368 |

## Encryption and key-management detail

> **Current addendum — 2026-09-14:** [ADR 0001](./adr/0001-local-source-field-encryption-boundary.md)
> resolves the #401 design question for the desktop boundary. Migration 073 now
> defines the recovery-wrapper registry and deletion intent, and Electron has a
> locked, capability-scoped source-key broker with private API/worker child IPC.
> Every production child binding starts with empty owner authority. Exact live
> human API sessions can now receive session-bound authority after independent
> API and Electron database revalidation. Token hashes are globally unique,
> lease refresh is atomic. Concurrent exact grants coalesce, and only a
> revalidated strictly later expiry for the same session/owner/token rotates
> one. Transient database loss denies the current source-key operation
> without manufacturing a revocation. Worker, demo, development-bypass,
> service, and unauthenticated paths remain unable to grant. Recovery wrappers now use
> the narrow CockroachDB registry adapter with no Electron-store or plaintext
> fallback, but no source repository consumes the broker, so it encrypts no
> production source field. Separately, the API-local OAuth vault encrypts new/reconnected
> grants when its matching generation is unlocked and can migrate complete plaintext
> grants on authorized use; without a vault, tokens remain plaintext, and the worker
> does not receive the API key. Source repository clients and migration, an
> owner-wide database-cascade/bulk-revoke barrier, an owned-service authority design, clean packaged-platform
> verification, and bake period remain blockers. See the
> [implementation status](./security/source-key-broker-implementation.md).

**[#374 — user memory and preferences are stored unencrypted](https://github.com/jayzalowitz/skytwin/issues/374)** (P1, Epic D). Re-audited 2026-06-16 (full code-state findings on the issue). The encryption **infrastructure shipped** via #520 — but it is **dormant** in production and **partial**, and the memory half has an architectural conflict that makes it a design task, not a wiring task:

- **Shipped (#520):** migration `066-encrypt-high-value-tables.sql` adds `_encrypted BYTES` columns to `preferences` / `twin_profiles` / `brain_pages`; `packages/db/src/lib/vault-helper.ts` (`encryptColumn`/`readColumn`/`resolveKey`, AES-256-GCM + scrypt); and encrypt-on-write / decrypt-on-read wiring in `twin-repository-adapter.ts` **for `preferences` only**.
- **Dormant:** `setPreferenceVaultKeyProvider(...)` is called **only in tests** — no app composition root enables it, so `vaultKeyProvider` stays `null` and even preferences are written plaintext in the running app. ADR 0001 resolves the key-custody design, but authenticated API grants have no source-field client and worker grants remain empty, keeping this path inactive. Database-only account cascades and bulk session revocation also need an owner-wide broker barrier before activation.
- **Partial:** `twin_profiles`' 7 `_encrypted` columns are unused, and `brain_pages` (user memory) is written plaintext (`insertPage()` in `packages/memory-gbrain-crdb-adapter/src/repository.ts` ignores the `_encrypted` columns).
- **The hard part:** `brain_pages` is the *searchable* store. RRF retrieval needs `content_tsv @@ plainto_tsquery` (full-text, server-side) and the row's `embedding` (vector — pulled out and scored with `cosineSimilarity` in application code, brute-force; not a CRDB `<=>` operator). Both are derived from plaintext content, and a `tsvector` stores the lexemes in the clear — so encrypting `content` while keeping `content_tsv` queryable leaks it anyway, while encrypting the index breaks search; the embedding likewise has to be read back out in the clear to score. So memory-at-rest encryption needs a design (scope to non-searched columns, index-time decrypt, or searchable encryption), not just an `encryptColumn` call.

**Why it still is not a wiring-only fix:** the custody design is accepted, but
activating it before source-specific clients,
crash-safe plaintext migration, packaged-platform
verification, and recovery testing would risk either exposing keys or losing
data. The memory search conflict also still needs a deliberate boundary.
**Recommended sequence:** compose source clients over the authenticated grants
→ migrate the narrow non-search fields with crash recovery → verify
backup/delete/rotation and packaged lock behavior → resolve the readable search
derivatives for `brain_pages` → complete the bake gate before making a claim.

## Issues closed this pass (shipped, verified in code)

| # | What shipped |
|---|---|
| [#476](https://github.com/jayzalowitz/skytwin/issues/476) | Deadline/temporal extraction (`deadline-extractor.ts`) → urgency; all 7 binding ACs |
| [#477](https://github.com/jayzalowitz/skytwin/issues/477) | Signal topic clustering (`topic-clusterer.ts`); all 7 binding ACs |
| [#479](https://github.com/jayzalowitz/skytwin/issues/479) | Inbound security-alert classifier, escalate-only (zero auto-exec); 7/8 ACs + defense-in-depth |
| [#489](https://github.com/jayzalowitz/skytwin/issues/489) | Power view — inline technical depth; all ACs, QA'd live |

## Inbox-Intelligence epic ([#484](https://github.com/jayzalowitz/skytwin/issues/484)) — read layer complete

Merged via #488 + follow-ups. As of 2026-06-16 the three extractors that were "built but not consumed" are now **wired into the live digest and their issues closed**: #485 (hide/pin enforcement in `buildLiveDigest`), #475 (`extractCommitments`), #478 (`linkEntitiesAcrossSignals` cluster dedup), alongside #474/#481/#482/#486/#487 (all verified in code + closed this pass). The epic's read layer is complete; #483 (the "grandma seed" new-user bootstrap) is the one ambiguous remainder — idempotent seeding + the demo fixture ship, but what "grandma seed" requires beyond the demo persona needs a one-line product clarification.

## Dependabot PRs

**Done (2026-06-16):** all 10 open bumps (#469–#494, incl. the bonjour-service one that had been failing) were batched into a single lockfile regeneration and merged via **#522**; the individual PRs are closed as superseded. `pnpm build` 35/35 + `pnpm lint` 61/61 + all six platform installer builds + eval + Test green on the batch.

## Full audit — every open issue

Verdict legend: ✅ shipped · 🟡 partial · ⬜ not started · ⛔ external (human/procurement, not code). "Blocker" = blocks shipping to real strangers per #357. Most ⬜ items are P3/post-launch.

| # | Verdict | Blocker | Code-fixable | What remains (1-line) |
|---|---|---|---|---|
| [#193](https://github.com/jayzalowitz/skytwin/issues/193) | 🟡 partial | — | yes | Lifebooks: manual-create route + a couple of detail-surface slices |
| [#195](https://github.com/jayzalowitz/skytwin/issues/195) | ⛔ external | — | — | No code remains for this epic |
| [#235](https://github.com/jayzalowitz/skytwin/issues/235) | ⛔ external | — | — | Procurement checklist (Apple/Win/Google), zero code |
| [#319](https://github.com/jayzalowitz/skytwin/issues/319) | 🟡 partial | — | yes | Lifebooks: inline fact-edit recorder + adaptive layout slices |
| [#321](https://github.com/jayzalowitz/skytwin/issues/321) | 🟡 partial | — | yes | Lifebooks: promote/demote importance controls + backend wiring |
| [#323](https://github.com/jayzalowitz/skytwin/issues/323) | 🟡 partial | — | — | AC3: wire `registryId` into MCP-action spend recording |
| [#324](https://github.com/jayzalowitz/skytwin/issues/324) | 🟡 partial | — | yes | Rollback wiring + decision→execution-plan join follow-ups |
| [#351](https://github.com/jayzalowitz/skytwin/issues/351) | ⛔ external | — | — | CASA assessor contract + Google review (post-launch) |
| [#357](https://github.com/jayzalowitz/skytwin/issues/357) | 🟡 partial | **YES** | partly | Source capabilities passed the dated audit; fresh artifact validation and the external launch gates remain |
| [#359](https://github.com/jayzalowitz/skytwin/issues/359) | ⛔ external | **YES** | — | Apple Developer + Windows EV cert purchase/enroll |
| [#360](https://github.com/jayzalowitz/skytwin/issues/360) | 🟡 partial | **YES** | yes | Mobile: #369 store-readiness gate is the bulk |
| [#361](https://github.com/jayzalowitz/skytwin/issues/361) | 🟡 partial | — | yes | Epic D: #375 decision-path redactor shipped (#524). Remaining: #374 (encryption — design resolved by #401/ADR 0001; production activation remains) + #375 follow-ups (assistant block, number/name). |
| [#368](https://github.com/jayzalowitz/skytwin/issues/368) | ⛔ external | **YES** | — | Code-signing certs + notarization (external) |
| [#369](https://github.com/jayzalowitz/skytwin/issues/369) | 🟡 partial | **YES** | partly | EAS config + CI rewrite (code) · real icons + store accounts (external) |
| [#370](https://github.com/jayzalowitz/skytwin/issues/370) | ✅ closed | done | yes | Source/CI implementation complete: manifest generation/attachment plumbing, curl-latest CI, user-facing banner, and "Check for Updates…" menu shipped (#523). No qualifying tagged release has proven or published those manifests; signed-build e2e remains tracked under #368. |
| [#374](https://github.com/jayzalowitz/skytwin/issues/374) | 🟡 partial | **YES** | yes | Accepted design + broker/custody/session-authority foundation shipped; source clients, owner-wide revoke barrier, migration, packaged verification, and bake remain |
| [#375](https://github.com/jayzalowitz/skytwin/issues/375) | 🟡 partial | — | yes | Decision-pipeline redactor shipped (#524): `redactPromptPii` masks email addresses in `PromptBuilder` by default, ReDoS-hardened. Remaining: assistant memory-context block (needs provider-trust gating) + number/name masking. |
| [#386](https://github.com/jayzalowitz/skytwin/issues/386) | ✅ closed | done | yes | Shipped + closed: resumable chunked voice upload end-to-end — `voice-chunker.ts` + `transcribeChunked()` (per-chunk retry, progress, cancel) + server `/upload/session`/`/chunk`/finalize + 3 test files. Only the airplane-mode manual smoke is device-only. |
| [#387](https://github.com/jayzalowitz/skytwin/issues/387) | 🟡 partial | — | yes | Deep-link routing slice shipped + wired (tap → specific approval, scrolled into view; `deep-link.ts` + `App.tsx` + `ApprovalsScreen.tsx`, tested). Remaining: native inline Approve/Reject actions (iOS NSE + Android actions + EAS dev build — gated on #360/#404). |
| [#399](https://github.com/jayzalowitz/skytwin/issues/399) | ⬜ not started | — | yes | Opt-in crash reporting (P3) |
| [#400](https://github.com/jayzalowitz/skytwin/issues/400) | ✅ closed | done | yes | Backup/restore CLI shipped with an encrypted authenticated archive and atomic fresh-user restore. |
| [#401](https://github.com/jayzalowitz/skytwin/issues/401) | ✅ design resolved | — | yes | ADR 0001 defines mandatory recovery wrapping plus opt-in reviewed OS protection; #374 runtime activation remains open |
| [#402](https://github.com/jayzalowitz/skytwin/issues/402) | 🟡 partial | — | yes | axe-core CI on web routes is code-fixable; full manual a11y is post-launch |
| [#403](https://github.com/jayzalowitz/skytwin/issues/403) | ⬜ not started | — | yes | PWA manifest + service worker (P3) |
| [#404](https://github.com/jayzalowitz/skytwin/issues/404) | ⬜ not started | — | — | EAS TestFlight/Play internal (P3, needs accounts) |
| [#405](https://github.com/jayzalowitz/skytwin/issues/405) | ⬜ not started | — | yes | Demo recipe library (P3) |
| [#406](https://github.com/jayzalowitz/skytwin/issues/406) | ⬜ not started | — | yes | Native macOS menu bar (P3) |
| [#407](https://github.com/jayzalowitz/skytwin/issues/407) | ✅ closed | done | yes | Worker dead-letter queue shipped with durable failure records, operator inspection, and replayed/discarded resolution; the normal cadence reruns eligible jobs. |
| [#408](https://github.com/jayzalowitz/skytwin/issues/408) | ⬜ not started | — | yes | AsyncLocalStorage request context (P3) |
| [#409](https://github.com/jayzalowitz/skytwin/issues/409) | ⛔ external | — | — | Designer-made mobile icon/splash set |
| [#410](https://github.com/jayzalowitz/skytwin/issues/410) | ⬜ not started | — | — | Pricing experiment (P3, business) |
| [#474](https://github.com/jayzalowitz/skytwin/issues/474) | 🟡 partial | — | yes | Web act/FYI split shipped; mobile two-section render remains |
| [#475](https://github.com/jayzalowitz/skytwin/issues/475) | 🟡 partial | — | yes | Wire `extractCommitments` into the digest |
| [#476](https://github.com/jayzalowitz/skytwin/issues/476) | ✅ shipped | — | yes | Closed |
| [#477](https://github.com/jayzalowitz/skytwin/issues/477) | ✅ shipped | — | yes | Closed |
| [#478](https://github.com/jayzalowitz/skytwin/issues/478) | 🟡 partial | — | yes | Wire entity cross-linking into dedup/presentation |
| [#479](https://github.com/jayzalowitz/skytwin/issues/479) | ✅ shipped | — | yes | Closed (1 cosmetic AC6 marker-naming follow-up) |
| [#481](https://github.com/jayzalowitz/skytwin/issues/481) | 🟡 partial | — | yes | Web two-bucket UI shipped; mobile `BriefingScreen` rebuild remains |
| [#482](https://github.com/jayzalowitz/skytwin/issues/482) | 🟡 partial | — | yes | Wire briefing-generation into demo fixture |
| [#483](https://github.com/jayzalowitz/skytwin/issues/483) | 🟡 partial | — | yes | Grandma seed shipped; tier-ladder intro card remains |
| [#484](https://github.com/jayzalowitz/skytwin/issues/484) | 🟡 partial | **YES** | yes | 11/14 shipped; wire #485/#475/#478 into live path |
| [#485](https://github.com/jayzalowitz/skytwin/issues/485) | 🟡 partial | — | yes | Hide/pin enforcement in the live digest path |
| [#486](https://github.com/jayzalowitz/skytwin/issues/486) | ✅ closed | done | yes | Connector locale/tz sync (`google-profile-sync.ts`) + locale-aware extractor routing shipped; closed. |
| [#487](https://github.com/jayzalowitz/skytwin/issues/487) | ✅ closed | done | yes | Coverage model (`source-coverage.ts`) shipped + exposed in the digest payload; closed. |
| [#489](https://github.com/jayzalowitz/skytwin/issues/489) | ✅ shipped | — | yes | Closed |

## Current recommended next actions (account-free desktop launch)

1. **Signing procurement and wiring:** enroll Apple Developer + buy the Windows signing cert (#368/#359), wire the secrets into the package jobs, and produce the required platform evidence. Google OAuth submission is not part of this launch.
2. **Finish the release-evidence train:** implement the missing CI and machine evidence producers, then validate the guarded sample, model delivery, signing, checksums, SBOM, provenance, and exact artifact set on the release SHA.
3. **Finish #374 without widening its claims:** compose authenticated broker
   grants and clients against Cockroach custody, migrate only the reviewed source
   fields, prove recovery/backup/delete/rotation in packaged builds, resolve the
   searchable-memory boundary, and complete the bake gate. ADR 0001 has already
   resolved the #401 custody decision.

Google account review (#351) and mobile store work (#360) are post-launch tracks.

**Done since the 2026-06-14 audit (2026-06-16 update):** auto-update source/CI implementation + user-facing banner/menu (#370, #523 — closed; no qualifying tagged release has yet proven or published the manifests); the 10 dependabot bumps batched + merged (#522, #469–#494 closed); decision-pipeline LLM prompt redaction (#375 decision-path, #524); resumable chunked voice upload verified shipped (#386 — closed); deep-link notification routing verified shipped (#387 routing half); and the Inbox-Intelligence read layer (#324/#474/#478/#481/#482/#485/#486/#487) verified shipped + closed.
