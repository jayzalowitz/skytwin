# SkyTwin TODOs

Generated from CEO review on 2026-04-01. Updated through M2/M3/M4 completion.

## Open — remaining from /review on 2026-04-28 (PR #126 non-tech UX branch)

Most items closed in the same branch (see Completed below). Three items
remain open as P2/P3 follow-ups.

- [ ] **P2**: Split `renderDashboard` (~340 lines now) into `computeDashboardModel`, `renderDashboardView`, `applyDashboardEffects`. The current function mixes data fetching, state derivation, HTML composition, and post-render side effects — hard to test, hard to refactor. **Files:** apps/web/public/js/pages/dashboard.js
- [ ] **P2**: Migrate the remaining inline `onclick="...handleX('${escapeHtml(value)}')"` patterns across approvals.js / settings.js / decisions.js / setup.js / dashboard.js to `addEventListener` bindings. The highest-risk site (twin.js, free-text preference value flowing through JS string literals) was migrated in this PR. The remaining ~40 inline handlers interpolate UUIDs / enum values / constants where practical risk is zero today, but the pattern is unsafe by construction. **Files:** apps/web/public/js/pages/{approvals,settings,decisions,setup,dashboard}.js
- [x] **P3**: ~~OAuth callback redirect contract change verification~~ **Completed:** 2026-04-29 — Audited `apps/desktop/`, `apps/mobile/`, README, all `*.ts/*.tsx/*.js/*.md` repo-wide. No consumers reference the old `#/settings?connected=…` shape. Desktop OAuth uses an HTML success page (no client-side route consumed). Mobile sse-client has unrelated `callback` mentions. Safe to ship the new `#/?connected=…` redirect without backwards-compat. **Verified by:** grep audit on origin/main HEAD `a72e85b`.
- [ ] **P3**: Real production tour mode — short-lived demo session token, or `/api/v1/demo/dashboard` aggregate read-only endpoint. Currently tour mode auto-disables in production (auth bypass not active), which is honest but cuts off the marquee feature for non-localhost deploys. **Files:** apps/api/src/routes/demo.ts, apps/api/src/middleware/session-auth.ts
- [x] **P1**: ~~Fix TIER_THRESHOLDS drift between client and policy-engine~~ **Completed:** v0.5.1.0 (2026-04-29) — `PROMOTION_THRESHOLDS` moved to `@skytwin/shared-types`; `/progress` returns `consecutiveApprovals` + `approvalRatio` so client uses the engine's actual metrics; `moderate_autonomy: 100` dropped (explicit opt-in only).
- [ ] **P2**: Document `TRUST_PROXY_HOPS` deployment guidance. The new `app.set('trust proxy', N)` in `apps/api/src/index.ts:88` is global — it affects every IP-keyed check (session-auth, OAuth new-user rate limit, demo preview rate limit). Setting it too high lets a client-controlled `X-Forwarded-For` become `req.ip` and bypass all of them. README/deploy docs should call out: only set `TRUST_PROXY_HOPS` to the exact hop count between the API and the actual client (1 for a single Fly/Render/nginx hop, 2 for nginx-behind-Cloudflare, etc.); when in doubt, prefer trusted-proxy subnet logic. **Files:** README.md, apps/api/src/index.ts:88
- [ ] **P3**: Multi-instance demo rate limiting. `globalPreviewTimestamps` is process-local — N API replicas multiply the global hourly cap, and a restart clears it. Acceptable for self-hosted single-process deploys, fine for the dev-bypass-only tour, but if `/api/v1/demo/preview` is ever exposed to an unauthenticated public deployment with multiple instances, move the counter to Redis or a DB row with an atomic increment. **Files:** apps/api/src/routes/demo.ts

## Completed in PR #126 (2026-04-28)

- [x] **P1**: Cache slow-changing dashboard fetches in a module-level Map with 30s TTL — `slowFetch()` wraps oauth status, creds status, skill gaps, learned, unmet creds. SSE `twin:updated` busts learned/skill-gaps; `credential:needed` busts creds-status/unmet-creds. **Completed:** PR #126 (2026-04-28)
- [x] **P1**: Migrated highest-risk inline onclick site (twin.js — free-text preference value) to data-attributes + delegated event listener. **Completed:** PR #126 (2026-04-28)
- [x] **P1**: Added 12 tests for `apps/api/src/routes/demo.ts` covering 400 / 404 / 429 / 503 / 200 paths. Caught two real bugs in the process (PREVIEW_DISABLED was load-time, demo user cache wasn't reset between requests). **Completed:** PR #126 (2026-04-28)
- [x] **P2**: Extracted magic numbers in dashboard.js to named constants (BRIEFING_FRESH_MS, FIRST_SCAN_POLL_MS, FIRST_SCAN_MAX_MS, SINCE_LAST_VISIT_MIN_MS, SLOW_CACHE_TTL_MS, TIER_THRESHOLDS, TIER_NEXT). **Completed:** PR #126 (2026-04-28)
- [x] **P2**: Consolidated five module-level window-globals blocks in dashboard.js into one `initDashboardGlobals()` called from app.js bootstrap. **Completed:** PR #126 (2026-04-28)
- [x] **P2**: Created `apps/web/public/js/storage-keys.js` registry. All `skytwin_*` localStorage keys now flow through `KEY_*` constants and per-user builder functions. `clearKeysForSuffix()` powers the tour-exit cleanup. **Completed:** PR #126 (2026-04-28)
- [x] **P2**: Added `DemoInfoResponse` and `DemoPreviewResponse` to `@skytwin/shared-types`. demo.ts response objects now type-check against the public surface. **Completed:** PR #126 (2026-04-28)
- [x] **P2**: Added `app.set('trust proxy', N)` configuration via `TRUST_PROXY_HOPS` env var (default 0). Required for the per-IP rate limit on /api/v1/demo/preview to work behind reverse proxies. **Completed:** PR #126 (2026-04-28)
- [x] **P3**: Moved `/api/demo/*` to `/api/v1/demo/*` for consistency with `/api/v1/twin/*` and `/api/v1/briefings/*`. Client-side `fetchDemoInfo` and `previewDemoDecision` updated. **Completed:** PR #126 (2026-04-28)
- [x] **P3**: Moved inline `@keyframes pulse` from dashboard.js into `apps/web/public/css/styles.css` as `.skytwin-pulse-dot` with `prefers-reduced-motion` support. **Completed:** PR #126 (2026-04-28)

## Completed (v0.3.0.0 — M2/M3/M4)

- [x] M2 Phase 1: TrustTierEngine with auto-promotion (OBSERVER→MODERATE_AUTONOMY) and rolling-window regression **Completed:** v0.3.0.0 (2026-04-01)
- [x] M2 Phase 1: trust_tier_audit table + repository **Completed:** v0.3.0.0 (2026-04-01)
- [x] M2 Phase 2: ApprovalRouter with urgency-based expiry (15min/24h/72h) **Completed:** v0.3.0.0 (2026-04-01)
- [x] M2 Phase 2: Batch respond endpoint + worker expiry cron **Completed:** v0.3.0.0 (2026-04-01)
- [x] M2 Phase 3: SpendTracker with rolling 24h window + reconciliation **Completed:** v0.3.0.0 (2026-04-01)
- [x] M2 Phase 3: Daily spend limit enforcement in PolicyEvaluator **Completed:** v0.3.0.0 (2026-04-01)
- [x] M2 Phase 4: DomainAutonomyManager with per-domain trust tier overrides **Completed:** v0.3.0.0 (2026-04-01)
- [x] M2 Phase 4: EscalationTriggerEngine with configurable triggers **Completed:** v0.3.0.0 (2026-04-01)
- [x] M2 Phase 5: 7 safety invariant integration tests **Completed:** v0.3.0.0 (2026-04-01)
- [x] M3 Phase 6: WorkflowHandlerRegistry + 4 situation-type handlers with E2E tests **Completed:** v0.3.0.0 (2026-04-01)
- [x] M3 Phase 7: IronClaw contract tests (mock vs real adapter compatibility) **Completed:** v0.3.0.0 (2026-04-01)
- [x] M3 Phase 7: Rollback E2E tests + MockIronClawServer **Completed:** v0.3.0.0 (2026-04-01)
- [x] M3 Phase 8: Settings API (GET/PUT /api/settings/:userId) **Completed:** v0.3.0.0 (2026-04-01)
- [x] M3 Phase 8: Settings page with tier display, autonomy controls, domain overrides **Completed:** v0.3.0.0 (2026-04-01)
- [x] M4 Phase 9: 3 new metrics (escalation correctness, calibration error, decision latency) **Completed:** v0.3.0.0 (2026-04-01)
- [x] M4 Phase 9: 39 eval scenarios across 5 domains (50+ total) **Completed:** v0.3.0.0 (2026-04-01)
- [x] M4 Phase 10: PreferenceEvolutionTracker with attribution **Completed:** v0.3.0.0 (2026-04-01)
- [x] M4 Phase 10: TemporalReplayEngine for point-in-time twin reconstruction **Completed:** v0.3.0.0 (2026-04-01)
- [x] M4 Phase 10: CI workflow (.github/workflows/evals.yml) **Completed:** v0.3.0.0 (2026-04-01)
- [x] De-mock: Real DB-backed /ask, /briefings, /skill-gaps, /proposals routes **Completed:** v0.3.0.0 (2026-04-01)
- [x] De-mock: OpenClaw adapter upgraded to real HTTP client **Completed:** v0.3.0.0 (2026-04-01)

## Completed (v0.2.0.0 — M1.5)

- [x] Issue 018: Run all schema migrations (signals, preference_proposals, twin_exports, skill_gap_log, proactive_scans, briefings tables + column additions) **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 011: Create @skytwin/execution-router package **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 011: ExecutionRouter with adapter selection logic **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 011: OpenClawAdapter (mock-first) **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 011: Adapter trust characteristics + risk modifier **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 011: Fallback chains **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 011: Skill gap detection + logging **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 012: whatWouldIDo() in decision-engine **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 012: POST /api/v1/twin/:userId/ask endpoint **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 012: Token-scoped rate limiting **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 012: Prediction logging (type='prediction') **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 013: Export function in twin-model (JSON + Markdown) **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 013: GET /api/v1/twin/:userId/export endpoint **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 013: twin_exports audit logging **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 014: ProactiveEvaluator in decision-engine **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 014: Morning briefing generation **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 014: GET /api/v1/briefings/:userId endpoint **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 014: Worker cron integration **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 014: HIGH confidence requirement for proactive auto-execution **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 015: PreferenceArchaeologist analyzer **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 015: GET/POST /api/v1/preferences/:userId/proposals endpoints **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 015: Accept → create Preference, Reject → negative signal **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 016: Extended feedback with undo reasoning **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 016: Rollback trigger via ExecutionRouter **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 016: 2x weight correction to twin model **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 017: Signal persistence + retention cleanup **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 017: Cross-domain correlation rules (at least 2) **Completed:** v0.2.0.0 (2026-04-01)
- [x] Issue 011: Skill gap → IronClaw issue creation pipeline **Completed:** v0.2.0.0 (2026-04-01)
- [x] Golden path e2e integration test **Completed:** v0.2.0.0 (2026-04-01)
- [x] Rate limiting implementation **Completed:** v0.2.0.0 (2026-04-01)
- [x] Briefing schedule configuration **Completed:** v0.2.0.0 (2026-04-01)
- [x] Dashboard updates **Completed:** v0.2.0.0 (2026-04-01)
- [x] Export format refinements **Completed:** v0.2.0.0 (2026-04-01)
