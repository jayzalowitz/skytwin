# SkyTwin TODOs

Generated from CEO review on 2026-04-01. Updated through M2/M3/M4 completion.

## Open — found in /review on 2026-04-28 (PR #126 non-tech UX branch)

Ship-blocker fixes were applied in commit landing this branch. Items below
were judged too risky or too large for this PR; they should land on
follow-up branches with their own reviews.

- [ ] **P1**: Stop the dashboard's 13-endpoint Promise.allSettled fan-out on every render. Cache slow-changing data (oauth status, creds status, skill gaps, learned, unmet creds) in a module-level Map with ~30s TTL. Or build a single `/api/v1/dashboard` aggregate endpoint. Currently bursts ~150 reqs/min during first-scan window. **Files:** apps/web/public/js/pages/dashboard.js:5
- [ ] **P1**: Migrate inline `onclick="...handleX('${escapeHtml(value)}')"` patterns across dashboard.js / approvals.js / settings.js / decisions.js / setup.js to `addEventListener` bindings. `escapeHtml` defends against HTML context but values land in JS-string-literal context — UUIDs are safe today, the pattern isn't. **Files:** apps/web/public/js/pages/{dashboard,approvals,settings,decisions,setup}.js
- [ ] **P1**: Add tests for `apps/api/src/routes/demo.ts`. Cover 400 (missing/oversize situation), 404 (no seed), 429 (per-IP + global limit), 503 (kill switch), 200 happy path. Export `checkPreviewRate` and `checkGlobalRate` for unit testability. **Files:** apps/api/src/routes/demo.ts, apps/api/src/__tests__/demo-routes.test.ts (new)
- [ ] **P2**: Split `renderDashboard` (~290 lines now) into `computeDashboardModel`, `renderDashboardView`, `applyDashboardEffects`. The current function mixes data fetching, state derivation, HTML composition, and post-render side effects — hard to test, hard to refactor. **Files:** apps/web/public/js/pages/dashboard.js
- [ ] **P2**: Extract magic numbers to a named-constants block at top of dashboard.js (BRIEFING_FRESH_MS, FIRST_SCAN_POLL_MS, etc.). Pull TIER_THRESHOLDS / TIER_NEXT from `@skytwin/shared-types` so the UI can't drift from the server's tier-promotion rules. **Files:** apps/web/public/js/pages/dashboard.js
- [ ] **P2**: Consolidate the five module-level `if (typeof window !== 'undefined') { window.X = ... }` blocks in dashboard.js into one `initDashboardGlobals()` called by app.js bootstrap. Same for the document-level click delegator on `.ask-twin-example`. **Files:** apps/web/public/js/pages/dashboard.js
- [ ] **P2**: Centralize localStorage keys in a `storageKeys.js` module. Currently constructed inline (`skytwin_tour_mode`, `skytwin_first_decision_seen_${userId}`, etc.) — easy to typo, impossible to audit centrally. **Files:** apps/web/public/js/
- [ ] **P2**: Add OpenAPI/typed-interface coverage for `DemoInfoResponse` and `DemoPreviewResponse` (currently a spread + extra field). Document the public `/api/demo/*` surface. **Files:** apps/api/src/routes/demo.ts, packages/shared-types
- [ ] **P2**: Add `app.set('trust proxy', N)` configuration for production deployments. The new global cap (DEMO_PREVIEW_GLOBAL_LIMIT_PER_HOUR) is the backstop, but the per-IP limit only works correctly with trust-proxy configured. **Files:** apps/api/src/index.ts, deploy docs
- [ ] **P2**: OAuth callback redirect contract change (#/settings → #/) — verify any out-of-tree docs (Electron deep links, README links) and consider one-release backwards compat. **Files:** apps/api/src/routes/oauth.ts:466
- [ ] **P3**: Move `/api/demo/*` to `/api/v1/demo/*` for consistency with `/api/v1/twin/*` and `/api/v1/briefings/*`. Or document the unversioned namespace explicitly. **Files:** apps/api/src/index.ts
- [ ] **P3**: Move inline `<style>@keyframes pulse {...}</style>` from dashboard.js into the global stylesheet. Re-emitted on every render of the celebration card today. **Files:** apps/web/public/js/pages/dashboard.js, apps/web/public/css/styles.css
- [ ] **P3**: Real production tour mode — short-lived demo session token, or `/api/v1/demo/dashboard` aggregate read-only endpoint. Currently tour mode auto-disables in production (auth bypass not active), which is honest but cuts off the marquee feature for non-localhost deploys. **Files:** apps/api/src/routes/demo.ts, apps/api/src/middleware/session-auth.ts

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
