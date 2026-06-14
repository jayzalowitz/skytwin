# SkyTwin Launch Plan

This document tracks the path from "code in a feature branch" to "grandma can download and use the app." It is updated as items close. Where a task has a hard external dependency (Apple Developer enrollment, Google verification review, etc.), that's called out so the dependency can be unblocked in parallel with the surrounding engineering work.

The plan is intentionally specific about **what's done**, **what blocks launch**, **what improves launch**, and **what is explicitly NOT in scope for launch**. Don't accept tasks that creep into Tier 3 before Tier 1 ships.

---

## Tier 0 — What's already shipped (in PR #350)

These are done in code and live on the `jayzalowitz/grandma-proof-install` branch. Verified locally on Darwin arm64 + by CI on Linux. Will reach users once the PR merges to `main`.

- **Native CRDB single-binary install** — drops the Docker Desktop dependency for the entire `install.sh` path. Hash-verified binary download for darwin-arm64, darwin-amd64, linux-amd64, linux-arm64, win32-amd64.
- **Docker validation harness** — `bin/validate-installs` and a CI matrix that drives `install.sh` end-to-end against fresh Ubuntu 22.04 / Debian 12 / Fedora 40 containers.
- **Electron desktop bundles CockroachDB + API + worker + web** — `pnpm deploy` produces self-contained app bundles; CockroachManager spawns the right per-platform binary from `<resourcesPath>/cockroach/<platform>/cockroach`. In-process migrations run via `apps/desktop/src/service-manager.ts`'s native ESM dynamic import (no child-process spawn, no asar visibility hairball).
- **DATABASE_URL parsing fix** — every previous migration was silently landing on the wrong CRDB; `packages/db/src/connection.ts` now parses `DATABASE_URL` first.
- **Migration cascade fixes** — 023 split into 023 (column add) + 057 (FK-chain dedupe + unique index); 046 stops using `crdb_internal.force_error()` which the bundled CRDB v23.2 blocks.
- **Google OAuth PKCE primitives** — `@skytwin/connectors` supports both confidential and PKCE/public-client flows; bundled `BUNDLED_GOOGLE_CLIENT_ID` from the "SkyTwin Desktop" client registered in `skytwin-492700`.
- **Tiered OAuth scope policy** — Calendar + identity through the bundled client (cheap verification path); Gmail through user-supplied credentials (no SkyTwin-side CASA assessment cost). `resolveRequestedScopes()` enforces the gate; 412 response from `/authorize?include=gmail` carries `help: '#/connect-gmail'` + `docs: 'https://jayzalowitz.github.io/skytwin/connect-gmail.html'`.
- **In-app Gmail-setup wizard** at route `/#/connect-gmail` — five-step progress-bar wizard that opens GCP Console URLs in the user's existing browser, ends with paste-and-connect form.
- **Dashboard Gmail follow-up CTA** — after Google OAuth completes, if scopes don't include Gmail, the dashboard renders a "Calendar connected — now hook up Gmail" card linking to the wizard.
- **Public-web documentation** — `https://jayzalowitz.github.io/skytwin/{index,privacy,terms,connect-gmail}.html`. github.io is auto-verified for Google's brand-verification checks.
- **OAuth consent screen branding configured** in GCP (`skytwin-492700`) — app name "SkyTwin", homepage/privacy/ToS URLs, `jayzalowitz.github.io` authorized domain, Save accepted. Publishing status switched from Testing to Production.
- **Tracking issue [#351](https://github.com/jayzalowitz/skytwin/issues/351)** for the eventual Gmail restricted-scope CASA assessment.

---

## Tier 1 — Launch blockers (must ship before public download links go anywhere)

### 1.1 Merge PR #350 to main
**Dependency:** review pass. PR is at https://github.com/jayzalowitz/skytwin/pull/350.

Until this merges:
- GitHub Pages doesn't serve the privacy/ToS/connect-gmail pages (Pages is pointed at `main/docs`).
- Brand verification can't be submitted (Google can't fetch the consent-screen URLs because they 404).
- The bundled CRDB + Gmail-wizard fixes can't reach users.

Nothing else in Tier 1 unblocks until this is done.

### 1.2 Submit brand verification + Calendar sensitive-scope review
**Dependency:** §1.1. **Owner:** SkyTwin team. **Time:** ~1–3 weeks of Google review.

After Pages goes live:
1. Click **Verify branding** on https://console.cloud.google.com/auth/branding?project=skytwin-492700.
2. Upload a 120×120 PNG app logo (TODO — needs design pass; the SkyTwin star/twin glyph from the dashboard would work).
3. Submit for verification covering the four scopes the bundled client requests: `calendar.readonly`, `calendar.events`, `email`, `profile`. (`openid` doesn't require review.)
4. Paste the scope justifications from `docs/google-verification.md` § Scope justifications into the per-scope text fields.
5. Upload the demo video — see §1.4.

When this clears, the bundled flow shows the SkyTwin name + logo on the consent screen instead of the raw project-ID, and the "unverified app" warning goes away for Calendar usage.

### 1.3 Code signing + notarization
**Dependency:** purchase. **Owner:** SkyTwin team. **Time:** 1 day setup, certs renew annually.

The .dmg/.exe today are unsigned; macOS Gatekeeper and Windows SmartScreen show scary warnings on first launch. This is the single biggest grandma-blocker that isn't gated on Google.

Three purchases:
- **Apple Developer Program** — $99/year. Sign up at https://developer.apple.com/programs/enroll/. Confirms the team identity, gives access to the Developer ID Application certificate used to sign + notarize macOS apps.
- **Windows Code Signing cert** — EV (Extended Validation) is $300–600/year from DigiCert, Sectigo, or SSL.com. Required to skip Windows SmartScreen's reputation-warming period; OV (Organization Validation) is $100–200/year but builds reputation slowly (users see the warning until enough installs accrue).
- **Linux: no certificate needed** — AppImage/deb/rpm signing exists but no OS-level "unsigned app" warning gates execution.

**Pipeline note (corrected 2026-06-14):** there is no longer a separate `release.yml` — it was deleted in #356 in favour of a simpler softprops-based `release` job at the bottom of `.github/workflows/build.yml`, which runs on `v*` tag push, downloads the desktop/mobile artifacts the matrix jobs produce, and creates a **draft** GitHub Release. **Signing is not currently wired into any workflow** — the `desktop-mac`/`desktop-windows`/`desktop-linux` jobs in `build.yml` set `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` and explicitly skip signing for CI. So acquiring the certs is necessary but *not sufficient*: once the certs exist, someone must (a) add the secrets to the repo (CSC_LINK + CSC_KEY_PASSWORD for macOS/Windows; APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID for notarization) **and** (b) wire those env vars into the three `package:*` steps in `build.yml` (or restore a dedicated signing release workflow). Until (b) lands, a tag-push produces *unsigned* draft-release artifacts. Tracked under #368/#359.

Acceptance test: download the resulting .dmg from GitHub Releases on a fresh Mac the user has never seen SkyTwin on; double-click; verify it opens with no warnings.

### 1.4 Record the demo video
**Dependency:** §1.3 (so the .dmg launches cleanly without OS warnings that would block a clean recording). **Owner:** SkyTwin team. **Time:** ~1 hour.

Script lives in `docs/google-verification.md` § Demo video plan. Roughly 2–3 minutes covering install → sign in → consent screen (with all scopes named) → first signal in the Approvals queue → an action taken from the dashboard → the resulting effect visible in Gmail or Calendar's own UI.

Upload as **unlisted YouTube**. Paste the URL into the Google verification submission form.

### 1.5 Tag the first public release
**Dependency:** §1.3 (so the artifacts that build are usable). **Owner:** SkyTwin team. **Time:** 5 minutes + ~15 minutes for the workflow to build all three platforms.

```bash
git checkout main && git pull
git tag -a v0.6.57.0 -m "First public release"
git push origin v0.6.57.0
```

The `release` job in `.github/workflows/build.yml` takes over: the `desktop-mac` / `desktop-windows` / `desktop-linux` matrix jobs build in parallel, and the `release` job (softprops, tag-only) attaches the .dmg, .zip, .exe, .AppImage, .deb, .rpm, and Android .apk to a **draft** GitHub Release. Two caveats from the 2026-06-14 audit: (1) the artifacts are **unsigned** until signing is wired per §1.3; (2) the release is created as a **draft** (publish it manually) and the electron-updater `latest*.yml` auto-update manifests are **not** generated yet — that's the remaining code half of #370.

### 1.6 README rewrite: lead with download
**Dependency:** §1.5. **Owner:** SkyTwin team. **Time:** 30 minutes.

The current README leads with `curl … | bash`. After §1.5, the front door becomes:

```markdown
## Install

[Download SkyTwin for macOS (.dmg)](.../releases/latest/download/SkyTwin-mac.dmg)
[Download SkyTwin for Windows (.exe)](.../releases/latest/download/SkyTwin-Setup.exe)
[Download SkyTwin for Linux (.AppImage)](.../releases/latest/download/SkyTwin.AppImage)

Or build from source: `curl -fsSL .../install.sh | bash`
```

This is the single biggest user-experience change in the launch. From "compile this codebase" to "click."

---

## Tier 2 — First-month polish (ship after Tier 1, before broad invite)

### 2.1 Auto-update channel
The electron-updater client plumbing is wired (`apps/desktop/src/auto-update.ts`, dead `.local` feed-URL removed in #453), but the **`latest*.yml` update manifests are not generated by the release pipeline yet** — `build.yml`'s package steps run `--publish never` and the softprops `release` job uploads only the installer artifacts, not the electron-updater manifests. That's the remaining code half of #370: switch the desktop package steps to emit + upload `latest-mac.yml` / `latest.yml` / `latest-linux.yml` (e.g. an explicit electron-builder publish/manifest step) so installed apps can discover updates. Acceptance test (after that + signing): install one release on a fresh box, leave it sit, tag the next, confirm the installed app self-updates within 24 hours (default poll cadence).

### 2.2 PKCE verifier store in DB — **done (Unreleased)**
Shipped: migration `058-oauth-pkce-pending.sql` + `packages/db/src/repositories/oauth-pkce-pending-repository.ts`. `apps/api/src/routes/oauth.ts` now uses the DB-backed store; a desktop restart between `/authorize` and `/callback` no longer drops the verifier. `consume()` is a single `DELETE...RETURNING` so the replay-protection property survives the move off the in-memory Map. 5 new tests.

### 2.3 Onboarding flow auto-routes through `/#/connect-gmail` — **done (Unreleased)**
Shipped: `apps/api/src/routes/oauth.ts` accepts a whitelisted `?next=connect-gmail` parameter; the value is encoded into the HMAC-signed state and used to compose the post-OAuth redirect URL. `apps/web/public/js/pages/onboarding.js`'s "Continue with Google" button passes `next: 'connect-gmail'`. `apps/web/public/js/pages/connect-gmail.js` shows a "Calendar connected — now let's hook up Gmail" banner above the wizard when the user arrives via this deep-link. 5 new tests on the whitelist + HMAC coverage of the new tag.

### 2.4 Better error story when bundled client_id is unset — **done (Unreleased)**
Shipped: `apps/api/src/routes/oauth.ts` tags its no-client_id 503 with `code: 'NO_GOOGLE_CLIENT_CONFIGURED'` + `help: '#/connect-gmail'`. `apps/web/public/js/api-client.js` plumbs structured `code`/`help`/`docs` fields through `ApiError`; 503s with a code use a new `kind: 'config-missing'`. The onboarding wizard detects the code and routes the user into the connect-gmail wizard (same five-step flow handles both BYO Gmail and "this fork has no bundled client"). The connect-gmail wizard's final OAuth call now uses `?newUser=true` when no userId is in localStorage, so brand-new onboarding users finish the flow without needing a pre-existing account.

### 2.5 Telemetry-free crash reporting
Sentry-style error reporting is at odds with the "nothing leaves your machine" privacy story, but **fully silent failures** are at odds with shipping a desktop app. The middle ground: an opt-in "send anonymized crash report" prompt that uploads a JSON payload with the exception, stack, and SkyTwin version (no user data) to a developer-controlled endpoint. Default off; if you opt in the prompt explains exactly what's sent.

### 2.6 Demo / sample-profile mode polish — **partial (Unreleased)**
Welcome-screen CTA is now a real `btn-outline btn-lg` card with an "or" divider above it instead of a tiny gray footer link (`apps/web/public/js/pages/onboarding.js` renderWelcome) — the alternative-path framing is now explicit and discoverable. The seed payload (Alex Thompson — twin profile + preferences + ~10 decisions across multiple domains + approvals + feedback events) is already rich enough to demo every dashboard surface; no seed changes were needed in this round.

Still rough and worth a separate design pass once first-week feedback lands: the in-dashboard tour banner is functional but generic ("Click around freely, then start your own when you're ready"), there's no "first 30 seconds" pointer steering users to the most interesting card, and the exit-tour flow is a single-click hard reset with no confirmation (acceptable because the tour data is fake — listed here so a future polish round doesn't re-discover it as an open question).

---

## Tier 3 — Post-launch / strategic (don't start before Tier 1 + 2 land)

### 3.1 Gmail restricted-scope verification
Tracked in [#351](https://github.com/jayzalowitz/skytwin/issues/351). Annual ~$15k–$50k CASA assessment + Google review. Don't start until:
- BYO Gmail friction is measurably hurting funnel conversion (instrument the wizard step-completion drop-off rate first).
- SkyTwin has revenue that comfortably absorbs the recurring fee.

### 3.2 Mobile app stores
The mobile app exists (Expo, React Native) and the pairing flow works locally over mDNS. App Store + Play Store submissions are separate review processes with their own friction. Defer until desktop hits product-market fit signals.

### 3.3 Hosted SkyTwin
The privacy story is "everything runs on your machine." A hosted variant is a separate product with a separate threat model. Don't conflate.

### 3.4 Slack, Notion, bank-feed connectors
README hints at these. They each carry their own OAuth scope review (Slack workspace verification, Notion integration approval, Plaid for banks). Sequence them by feature value × verification cost. Banking via Plaid is the most expensive path; Slack and Notion are cheap. Notion next.

---

## What is explicitly NOT in launch scope

- **Federated multi-device sync.** The federation pairing exists in code (peers, sync workers) but the actual cross-device decision sync isn't designed end-to-end. Document as "experimental" if mentioned at all.
- **MCP server marketplace.** The MCP host can spawn third-party servers (#183 zero-trust mode) but discovery / install / curation is a whole separate product.
- **AI provider auto-selection.** Letting SkyTwin pick the cheapest model that meets a quality bar is a research feature, not a launch one.
- **Marketing / paid acquisition.** Launch with the GitHub README, Hacker News post, and an email to whoever the existing waitlist is. Don't burn cash on ads before product-market fit.

---

## Costs to launch

Recurring annual:
- Apple Developer Program: **$99**
- Windows EV code signing: **~$400** (EV; OV is ~$150 but slower SmartScreen reputation)
- Domain (optional, only if moving off github.io): **~$15**

One-time:
- Logo design: $0 (use existing dashboard glyph) to ~$500 (commissioned)
- Demo video editing: $0 (raw screen capture is fine for Google review) to ~$500 (professional cut for the homepage)

Deferred until §3.1 trigger:
- CASA assessment: **$15k–$50k annually**

Total recurring annual cost to start: **$500–$1000** including domain.

---

## How this plan was put together

Each Tier 1 item was selected by asking: *"If we shipped without this, what would break for the user?"* If the answer is "the .dmg won't open at all" (§1.3), "the download link doesn't exist yet" (§1.5), or "Google blocks the OAuth flow" (§1.2), it's Tier 1. If the answer is "the experience is rougher than it could be" (§2.x), it's Tier 2. If the answer is "we'll know we needed this from telemetry once we have users" (§3.x), it's Tier 3 and shouldn't drain attention before we have those users.

The most common failure mode for plans like this is letting Tier 3 items (interesting strategic things) crowd out Tier 1 items (necessary boring things). The release pipeline existing in `release.yml` doesn't count as "release pipeline shipped" until §1.5 actually fires it. The OAuth wizard existing at `/#/connect-gmail` doesn't count as "Gmail working for users" until §1.2 clears the brand verification that makes Google's consent screen show the SkyTwin name. Build all the way to the user, then up.
