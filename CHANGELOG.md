All notable changes to SkyTwin will be documented in this file.

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

<<<<<<< HEAD
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
