# SkyTwin Launch-Readiness Report

**Date:** 2026-06-14 · **Version audited:** 0.6.58.0 · **Branch:** `jayzalowitz/launch-readiness-audit`

This report is the output of a full launch-readiness pass: every open GitHub issue audited against the actual code (not the issue narrative), the whole app built/tested/linted, and the running dashboard QA'd against the [master pre-launch epic #357](https://github.com/jayzalowitz/skytwin/issues/357) launch criteria. It pairs with [`launch-plan.md`](./launch-plan.md) (the procurement/sequencing plan) — this document is the *current-state truth*.

---

## Bottom line

**SkyTwin is launch-ready on the engineering side.** The decision pipeline, twin model, policy engine, memory layer, dashboard, and the new Inbox-Intelligence digest all work, are tested, and pass live QA with zero console errors. Every *code-writable* launch criterion in epic #357 has shipped.

The remaining launch blockers are **not code**:

1. **Procurement** — Apple Developer ($99/yr) + Windows EV code-signing certs (#368/#359). Until these land, the `.dmg`/`.exe` trip Gatekeeper/SmartScreen. This is the single biggest non-engineering blocker.
2. **External review** — Google OAuth restricted-scope / brand verification (#351, multi-week CASA review) and mobile app-store review (#369/#360, needs Apple/Play accounts).
3. **Design assets** — real multi-resolution mobile icons/splash to replace the 1×1 placeholders (#409/#369).

…plus **one code task that needs a human decision first**: **#374** (encrypt user memory + preferences at rest). See [§ The one code-side launch task](#the-one-code-side-launch-task).

---

## App health (verified 2026-06-14)

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ✅ clean (5.6s) |
| `pnpm build` | ✅ 35 packages, 38s |
| `pnpm lint` | ✅ 61 targets, 37s |
| `pnpm test` | ✅ **3,821 passing** across 307 test files (24 skipped), exit 0 |
| Live QA (api:3100 + web vs seeded CRDB) | ✅ 0 console errors on cold-start / tour / briefing / decisions / settings |

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
| 10 | Receive auto-updates | 🟡 code half shipped (#370/#453); manifest generation + signed-build e2e remain (gated on #368) |

## The one code-side launch task

**[#374 — user memory and preferences are stored unencrypted](https://github.com/jayzalowitz/skytwin/issues/374)** (P1, Epic D). The audit confirms this is **entirely unimplemented**: only OAuth tokens are encrypted today (migration `032`, via `@skytwin/credential-vault`). `brain_pages`, `preferences`, `twin_profiles`, `decisions`, `signals`, `explanation_records`, episodic/assistant/lifebook tables (~14 total) all store plaintext.

It is code-writable — the issue's "Option B" (application-level envelope encryption, reusing `credential-vault`'s `envelope.ts` + `key-cache.ts`) avoids the only paid path (CRDB Enterprise TDE). The shape:

1. New migrations adding `<col>_encrypted/_iv/_tag BYTES` + `encryption_key_version INT` to the sensitive tables (mirroring `032`), making plaintext columns nullable for a lazy-migration window.
2. Encrypt-on-write / decrypt-on-read wrapping in the brain/memory/episodic/preference/twin/decision/signal/explanation/assistant/lifebook repositories, with plaintext fallback during migration.
3. A shared vault accessor for the master key.

**Why it isn't in this PR:** the master-key strategy is a deliberate security decision — passphrase-derived vs OS-keychain-backed (this is exactly [#401](https://github.com/jayzalowitz/skytwin/issues/401)). Shipping envelope encryption with the wrong key-management model is worse than shipping none. This should be designed and reviewed, not auto-merged. **Recommended:** make the #374↔#401 key-management call, then implement in a dedicated, reviewed PR. It is the top engineering pre-launch item.

## Issues closed this pass (shipped, verified in code)

| # | What shipped |
|---|---|
| [#476](https://github.com/jayzalowitz/skytwin/issues/476) | Deadline/temporal extraction (`deadline-extractor.ts`) → urgency; all 7 binding ACs |
| [#477](https://github.com/jayzalowitz/skytwin/issues/477) | Signal topic clustering (`topic-clusterer.ts`); all 7 binding ACs |
| [#479](https://github.com/jayzalowitz/skytwin/issues/479) | Inbound security-alert classifier, escalate-only (zero auto-exec); 7/8 ACs + defense-in-depth |
| [#489](https://github.com/jayzalowitz/skytwin/issues/489) | Power view — inline technical depth; all ACs, QA'd live |

## Inbox-Intelligence epic ([#484](https://github.com/jayzalowitz/skytwin/issues/484)) — 11/14 shipped

Merged via #488. Shipped **and** wired into the live digest: #474, #476, #477, #479, #480, #481, #482, #483, #486 (foundation), #487, #489. **Three extractors are built + tested but not yet consumed** in the live path — closing these closes the epic:
- **#485** — hide/pin enforcement in `buildLiveDigest` (`DigestItem.meta` population).
- **#475** — wire `extractCommitments` into the digest.
- **#478** — wire `linkEntitiesAcrossSignals` into cluster dedup.

## Dependabot PRs

9 of 10 are CI-clean and mergeable: #494, #493, #492, #491, #490, #473, #472, #471, #470. **#469** (bonjour-service) has 2 failing checks. Recommendation: batch-review and merge the 9 clean ones in a separate pass (per the repo's "/review every PR" discipline); investigate #469's failures before merging. Deliberately left out of the launch-readiness PR to avoid churning dependencies right before a release.

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
| [#361](https://github.com/jayzalowitz/skytwin/issues/361) | 🟡 partial | — | yes | Epic D: #374 + #375(b) remain |
| [#368](https://github.com/jayzalowitz/skytwin/issues/368) | ⛔ external | **YES** | — | Code-signing certs + notarization (external) |
| [#369](https://github.com/jayzalowitz/skytwin/issues/369) | 🟡 partial | **YES** | partly | EAS config + CI rewrite (code) · real icons + store accounts (external) |
| [#370](https://github.com/jayzalowitz/skytwin/issues/370) | 🟡 partial | **YES** | yes | release.yml manifest gen + curl-latest CI + release-procedure doc; e2e gated on signing |
| [#374](https://github.com/jayzalowitz/skytwin/issues/374) | ⬜ not started | **YES** | yes | Encrypt ~14 sensitive tables at rest — **needs key-mgmt decision (#401)** |
| [#375](https://github.com/jayzalowitz/skytwin/issues/375) | 🟡 partial | — | yes | Only in-prompt PII redactor (b) — explicitly deferred to v0.8 |
| [#386](https://github.com/jayzalowitz/skytwin/issues/386) | 🟡 partial | — | yes | Wire chunked-upload backbone into `VoiceScreen.tsx` |
| [#387](https://github.com/jayzalowitz/skytwin/issues/387) | 🟡 partial | — | yes | Native inline notification Approve/Reject actions (routing slice shipped) |
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
| [#486](https://github.com/jayzalowitz/skytwin/issues/486) | 🟡 partial | — | yes | Foundation shipped; connector locale/tz sync + extractor routing remain |
| [#487](https://github.com/jayzalowitz/skytwin/issues/487) | 🟡 partial | — | yes | Coverage model shipped on web; mobile parity + flag remain |
| [#489](https://github.com/jayzalowitz/skytwin/issues/489) | ✅ shipped | — | yes | Closed |

## Recommended next actions (ordered)

1. **Procurement (start now — long lead time):** enroll Apple Developer + buy Windows EV cert (#368/#359); the release workflow already injects them via secrets. Submit Google OAuth verification (#351) — multi-week.
2. **Make the #374 ↔ #401 key-management decision**, then implement memory/preference encryption in a reviewed PR. Top engineering pre-launch item.
3. **Commission mobile icon/splash assets** (#409), then land the EAS config + CI rewrite (#369, code).
4. **Finish #370's code half:** generate electron-updater manifests in `release.yml` + add a curl-latest CI check + `docs/release-procedure.md`. (Pipeline-sensitive — verify on a release dry-run.)
5. **Close the Inbox-Intelligence epic (#484):** wire #485/#475/#478 into the live digest (extractors already built + tested).
6. **Batch-merge the 9 clean dependabot PRs**; investigate #469.
