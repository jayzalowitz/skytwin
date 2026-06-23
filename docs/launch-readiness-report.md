# SkyTwin Launch-Readiness Report

**Date:** 2026-06-14 (updated 2026-06-23) · **Version audited:** 0.6.61.0 · **Branch:** `jayzalowitz/pre-launch-dev-audit-toolchain`

This report is the output of a full launch-readiness pass: every open GitHub issue audited against the actual code (not the issue narrative), the whole app built/tested/linted, and the running dashboard QA'd against the [master pre-launch epic #357](https://github.com/jayzalowitz/skytwin/issues/357) launch criteria. It pairs with [`launch-plan.md`](./launch-plan.md) (the procurement/sequencing plan) — this document is the *current-state truth*.

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

The v0.6.61.0 toolchain audit extended the dependency gate from production-only to the full dev/build graph. It upgraded Vitest across the workspace to 3.2.6, pinned patched `esbuild` and `tar` versions through pnpm overrides, and adjusted three tests for Vitest 3's stricter mock-call typing. Verification for the toolchain follow-up: `pnpm audit --prod`, `pnpm audit`, `git diff --check`, `pnpm lint --force`, `pnpm exec turbo run test --force`, `pnpm build --concurrency=1 --force`, and `pnpm test:e2e` all passed.

The issue inventory below remains the 2026-06-16 launch-readiness classification; this addendum covers the final code and QA pass through v0.6.61.0.

---

## Bottom line

**SkyTwin is launch-ready on the engineering side.** The decision pipeline, twin model, policy engine, memory layer, dashboard, and the new Inbox-Intelligence digest all work, are tested, and pass live QA with zero console errors. Every *code-writable* launch criterion in epic #357 has shipped.

The remaining launch blockers are **not code**:

1. **Procurement** — Apple Developer ($99/yr) + Windows EV code-signing certs (#368/#359). Until these land, the `.dmg`/`.exe` trip Gatekeeper/SmartScreen. This is the single biggest non-engineering blocker.
2. **External review** — Google OAuth restricted-scope / brand verification (#351, multi-week CASA review) and mobile app-store review (#369/#360, needs Apple/Play accounts).
3. **Design assets** — real multi-resolution mobile icons/splash to replace the 1×1 placeholders (#409/#369).

…plus **one code task that needs a human decision first**: **#374** (encrypt user memory + preferences at rest). See [§ The one code-side launch task](#the-one-code-side-launch-task).

---

## App health (verified 2026-06-23)

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ✅ clean (5.6s) |
| `pnpm audit --prod` + `pnpm audit` | ✅ clean |
| `pnpm build --concurrency=1 --force` | ✅ 35 targets |
| `pnpm lint --force` | ✅ 61 targets |
| `pnpm exec turbo run test --force` | ✅ 70 targets |
| `pnpm test:e2e` | ✅ DB + API e2e smoke passed |
| Live QA (api:3100 + web vs seeded CRDB) | ✅ 17 dashboard routes, 0 console errors/4xx/5xx/overflow; memory settings + MCP token generation verified |

## Launch criteria status (epic #357)

| # | Criterion | Status |
|---|---|---|
| 1 | Download a signed `.dmg`/`.exe`/store build | ⛔ external — certs (#368/#359), store accounts (#369) |
| 2 | Install without Gatekeeper/SmartScreen warnings | ⛔ external — certs |
| 3 | Reach a meaningful state ≤60s | ✅ tour mode is instant |
| 4 | Connect Gmail **or** "Try with a sample profile" → decisions | ✅ sample-profile path loads a fully-populated dashboard |
| 5 | A real decision in the queue ≤5 min of connecting Gmail | ✅ pipeline verified; tour shows a populated queue |
| 6 | Understand *why* each decision was made | ✅ "What happened" log, click any row for full reasoning |
| 7 | Approve/reject without confusion | ✅ microcopy intact (Just watch / Ask me first / Handle small stuff / …) |
| 8 | Find a "pause everything" button | ✅ global **Pause everything** + Settings **Pause auto-execution** (#379) |
| 9 | Find a "delete my data" button | ✅ Settings → **Download** + **Delete my data** (#376) |
| 10 | Receive auto-updates | 🟡 code complete — manifests ship (#370) + the user-facing layer (in-app update banner + "Check for Updates…" menu) landed; only signed-build e2e remains (gated on #368) |

## The one code-side launch task

**[#374 — user memory and preferences are stored unencrypted](https://github.com/jayzalowitz/skytwin/issues/374)** (P1, Epic D). Re-audited 2026-06-16 (full code-state findings on the issue). The encryption **infrastructure shipped** via #520 — but it is **dormant** in production and **partial**, and the memory half has an architectural conflict that makes it a design task, not a wiring task:

- **Shipped (#520):** migration `066-encrypt-high-value-tables.sql` adds `_encrypted BYTES` columns to `preferences` / `twin_profiles` / `brain_pages`; `packages/db/src/lib/vault-helper.ts` (`encryptColumn`/`readColumn`/`resolveKey`, AES-256-GCM + scrypt); and encrypt-on-write / decrypt-on-read wiring in `twin-repository-adapter.ts` **for `preferences` only**.
- **Dormant:** `setPreferenceVaultKeyProvider(...)` is called **only in tests** — no app composition root enables it, so `vaultKeyProvider` stays `null` and even preferences are written plaintext in the running app. Enabling it is the #401 key-management call.
- **Partial:** `twin_profiles`' 7 `_encrypted` columns are unused, and `brain_pages` (user memory) is written plaintext (`insertPage()` in `packages/memory-gbrain-crdb-adapter/src/repository.ts` ignores the `_encrypted` columns).
- **The hard part:** `brain_pages` is the *searchable* store. RRF retrieval needs `content_tsv @@ plainto_tsquery` (full-text, server-side) and the row's `embedding` (vector — pulled out and scored with `cosineSimilarity` in application code, brute-force; not a CRDB `<=>` operator). Both are derived from plaintext content, and a `tsvector` stores the lexemes in the clear — so encrypting `content` while keeping `content_tsv` queryable leaks it anyway, while encrypting the index breaks search; the embedding likewise has to be read back out in the clear to score. So memory-at-rest encryption needs a design (scope to non-searched columns, index-time decrypt, or searchable encryption), not just an `encryptColumn` call.

**Why it isn't auto-fixable:** enabling the provider with a wrong/ephemeral master key is worse than shipping none (lost key → unrecoverable memory) — that's exactly the #374↔#401 decision — and the memory search-conflict needs a design call. **Recommended sequence:** decide #401 key management → enable the provider (makes the existing preference encryption live) → extend to `twin_profiles` (not searched, straightforward) → design `brain_pages` against the search conflict. Top engineering pre-launch item.

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
| [#357](https://github.com/jayzalowitz/skytwin/issues/357) | 🟡 partial | **YES** | — | Code-writable launch criteria have shipped; rest is external |
| [#359](https://github.com/jayzalowitz/skytwin/issues/359) | ⛔ external | **YES** | — | Apple Developer + Windows EV cert purchase/enroll |
| [#360](https://github.com/jayzalowitz/skytwin/issues/360) | 🟡 partial | **YES** | yes | Mobile: #369 store-readiness gate is the bulk |
| [#361](https://github.com/jayzalowitz/skytwin/issues/361) | 🟡 partial | — | yes | Epic D: #375 decision-path redactor shipped (#524). Remaining: #374 (encryption — needs #401 key-mgmt decision) + #375 follow-ups (assistant block, number/name). |
| [#368](https://github.com/jayzalowitz/skytwin/issues/368) | ⛔ external | **YES** | — | Code-signing certs + notarization (external) |
| [#369](https://github.com/jayzalowitz/skytwin/issues/369) | 🟡 partial | **YES** | partly | EAS config + CI rewrite (code) · real icons + store accounts (external) |
| [#370](https://github.com/jayzalowitz/skytwin/issues/370) | ✅ closed | done | yes | Code complete + closed: manifests + curl-latest CI + the user-facing banner + "Check for Updates…" menu all shipped (#523). Only signed-build e2e remains, tracked under #368. |
| [#374](https://github.com/jayzalowitz/skytwin/issues/374) | ⬜ not started | **YES** | yes | Encrypt ~14 sensitive tables at rest — **needs key-mgmt decision (#401)** |
| [#375](https://github.com/jayzalowitz/skytwin/issues/375) | 🟡 partial | — | yes | Decision-pipeline redactor shipped (#524): `redactPromptPii` masks email addresses in `PromptBuilder` by default, ReDoS-hardened. Remaining: assistant memory-context block (needs provider-trust gating) + number/name masking. |
| [#386](https://github.com/jayzalowitz/skytwin/issues/386) | ✅ closed | done | yes | Shipped + closed: resumable chunked voice upload end-to-end — `voice-chunker.ts` + `transcribeChunked()` (per-chunk retry, progress, cancel) + server `/upload/session`/`/chunk`/finalize + 3 test files. Only the airplane-mode manual smoke is device-only. |
| [#387](https://github.com/jayzalowitz/skytwin/issues/387) | 🟡 partial | — | yes | Deep-link routing slice shipped + wired (tap → specific approval, scrolled into view; `deep-link.ts` + `App.tsx` + `ApprovalsScreen.tsx`, tested). Remaining: native inline Approve/Reject actions (iOS NSE + Android actions + EAS dev build — gated on #360/#404). |
| [#399](https://github.com/jayzalowitz/skytwin/issues/399) | ⬜ not started | — | yes | Opt-in crash reporting (P3) |
| [#400](https://github.com/jayzalowitz/skytwin/issues/400) | ⬜ not started | — | yes | Backup/restore CLI (P3) |
| [#401](https://github.com/jayzalowitz/skytwin/issues/401) | ⬜ not started | — | yes | OS-keychain for vault passphrase (P3) — pairs with #374 |
| [#402](https://github.com/jayzalowitz/skytwin/issues/402) | 🟡 partial | — | yes | axe-core CI on web routes is code-fixable; full manual a11y is post-launch |
| [#403](https://github.com/jayzalowitz/skytwin/issues/403) | ⬜ not started | — | yes | PWA manifest + service worker (P3) |
| [#404](https://github.com/jayzalowitz/skytwin/issues/404) | ⬜ not started | — | — | EAS TestFlight/Play internal (P3, needs accounts) |
| [#405](https://github.com/jayzalowitz/skytwin/issues/405) | ⬜ not started | — | yes | Demo recipe library (P3) |
| [#406](https://github.com/jayzalowitz/skytwin/issues/406) | ⬜ not started | — | yes | Native macOS menu bar (P3) |
| [#407](https://github.com/jayzalowitz/skytwin/issues/407) | ⬜ not started | — | yes | Worker dead-letter queue (P3) |
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

## Recommended next actions (ordered)

1. **Procurement (start now — long lead time):** enroll Apple Developer + buy Windows EV cert (#368/#359). The certs alone aren't enough — `build.yml` currently skips signing (`CSC_IDENTITY_AUTO_DISCOVERY: 'false'`), so someone must also wire the cert secrets into its `package:*` steps (see launch-plan §1.3). Submit Google OAuth verification (#351) — multi-week.
2. **Make the #374 ↔ #401 key-management decision**, then implement memory/preference encryption in a reviewed PR. Top engineering pre-launch item (the encryption schema + adapter already exist via #520; what remains is the default-on key-management policy decision).
3. **Mobile cut-or-commit (#360):** decide whether mobile ships at launch. If yes: commission icon/splash assets (#409), land the EAS config + CI (#369/#404), then the native inline notification actions (#387's remaining half). If no: descope to a fast-follow.

**Done since the 2026-06-14 audit (2026-06-16 update):** auto-update code half + user-facing banner/menu (#370, #523 — closed); the 10 dependabot bumps batched + merged (#522, #469–#494 closed); decision-pipeline LLM prompt redaction (#375 decision-path, #524); resumable chunked voice upload verified shipped (#386 — closed); deep-link notification routing verified shipped (#387 routing half); and the Inbox-Intelligence read layer (#324/#474/#478/#481/#482/#485/#486/#487) verified shipped + closed.
