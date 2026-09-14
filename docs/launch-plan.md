# SkyTwin Launch Plan

This document tracks the path from the current `main` baseline to "grandma can download and use the app." It is updated as items close. Where a task has a hard external dependency (Apple Developer enrollment, Google verification review, etc.), that's called out so the dependency can be unblocked in parallel with the surrounding engineering work.

The plan is intentionally specific about **what's done**, **what blocks launch**, **what improves launch**, and **what is explicitly NOT in scope for launch**. Don't accept tasks that creep into Tier 3 before Tier 1 ships.

---

## Tier 0 — Current baseline on `main`

These capabilities are present on `main`. Release support remains governed by the claim ledger and the Tier 1 gates below; code presence is not evidence that a public binary has cleared them.

- **Native CRDB single-binary install** — drops the Docker Desktop dependency for the entire `install.sh` path. Hash-verified binary download for darwin-arm64, darwin-amd64, linux-amd64, linux-arm64, win32-amd64.
- **Docker validation harness** — `bin/validate-installs` and a CI matrix that drives `install.sh` end-to-end against fresh Ubuntu 22.04 / Debian 12 / Fedora 40 containers.
- **Electron desktop bundles CockroachDB + API + worker + web** — `pnpm deploy` produces self-contained app bundles; CockroachManager spawns the right per-platform binary from `<resourcesPath>/cockroach/<platform>/cockroach`. In-process migrations run via `apps/desktop/src/service-manager.ts`'s native ESM dynamic import (no child-process spawn, no asar visibility hairball).
- **DATABASE_URL parsing fix** — every previous migration was silently landing on the wrong CRDB; `packages/db/src/connection.ts` now parses `DATABASE_URL` first.
- **Migration cascade fixes** — 023 split into 023 (column add) + 057 (FK-chain dedupe + unique index); 046 stops using `crdb_internal.force_error()` which the bundled CRDB v23.2 blocks.
- **Google OAuth PKCE primitives** — `@skytwin/connectors` supports both confidential and PKCE/public-client flows; bundled `BUNDLED_GOOGLE_CLIENT_ID` from the "SkyTwin Desktop" client registered in `skytwin-492700`.
- **Tiered OAuth scope policy** — Calendar + identity through the bundled client (cheap verification path); Gmail through user-supplied credentials (no SkyTwin-side CASA assessment cost). `resolveRequestedScopes()` enforces the gate; 412 response from `/authorize?include=gmail` carries `help: '#/connect-gmail'` + `docs: 'https://jayzalowitz.github.io/skytwin/connect-gmail.html'`.
- **In-app Gmail-setup wizard** at route `/#/connect-gmail` — five-step progress-bar wizard that opens GCP Console URLs in the user's existing browser, ends with paste-and-connect form.
- **Dashboard Gmail follow-up CTA** — after Google OAuth completes, if scopes don't include Gmail, the dashboard renders a "Calendar connected — now hook up Gmail" card linking to the wizard.
- **Public-web documentation** — `https://jayzalowitz.github.io/skytwin/{index,privacy,terms,connect-gmail,demo,deck}.html`. github.io is auto-verified for Google's brand-verification checks.
- **OAuth consent screen branding configured** in GCP (`skytwin-492700`) — app name "SkyTwin", homepage/privacy/ToS URLs, `jayzalowitz.github.io` authorized domain, Save accepted. Publishing status switched from Testing to Production.
- **Tracking issue [#351](https://github.com/jayzalowitz/skytwin/issues/351)** for the eventual Gmail restricted-scope CASA assessment.

---

## Tier 1 — Launch blockers (must ship before public download links go anywhere)

### 1.1 Finish the evidence-gated release train
**Dependency:** reviewed release consumer plus current-run evidence producers.

The release consumer must remain fail-closed while the remaining producer work lands. The native claim/platform matrix and exclusive evidence aggregator are scaffolded. The canonical packaged-sample verifier covers its three native matrix entries, and the artifact-verification lane now stages the exact nine desktop release subjects, generates checksums, a subject-complete SPDX 2.3 document, canonical verification instructions, and source-bound GitHub attestations, then independently verifies those materials before producing its machine report. The remaining scope is six verifier sources (eight matrix reports), the `release-claims-ci` artifact producer, and signing/notarization proof. Each machine report must bind the exact successful native producer job, reviewed verifier source digest and command, release artifact, tag run, and structured observations. Source availability is not artifact certification: `sample.packaged-account-free` and `release.artifact-verification` remain limited until a tagged run produces and the publisher validates their reports and material. See [`sample-release-evidence.md`](./sample-release-evidence.md). The authoritative completion state is `docs/beta-claim-ledger.json`; none of its stop-ship conditions may be waived informally.

### 1.2 Submit brand verification + Calendar sensitive-scope review
**Dependency:** public policy pages reachable from `main`. **Owner:** SkyTwin team. **Time:** ~1–3 weeks of Google review.

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

**Pipeline note:** `.github/workflows/build.yml` is the sole permitted publisher. Its tag job is designed to verify release evidence, reject an existing release for the tag, create an unpublished prerelease draft with the canonical desktop assets and evidence manifest, verify that draft's exact asset digests, and publish it from the same job. Protected-environment approval, non-canceling per-tag serialization, and exclusive publisher credentials are the concurrency boundary; the post-publication check detects and attempts to recover from changes but is not an atomic transaction against other credentials. **Signing is not currently wired into any workflow**, so the claim ledger remains blocked and prevents this publication path from running. Acquiring certificates is necessary but not sufficient: the secrets and signing/notarization steps must be wired into the package jobs and produce the required machine evidence. Tracked under #368/#359.

Acceptance test: download the resulting .dmg from GitHub Releases on a fresh Mac the user has never seen SkyTwin on; double-click; verify it opens with no warnings.

### 1.4 Record the demo video
**Dependency:** §1.3 (so the .dmg launches cleanly without OS warnings that would block a clean recording). **Owner:** SkyTwin team. **Time:** ~1 hour.

Script lives in `docs/google-verification.md` § Demo video plan. Roughly 2–3 minutes covering install → sign in → consent screen (with all scopes named) → first signal in the Approvals queue → an action taken from the dashboard → the resulting effect visible in Gmail or Calendar's own UI.

Upload as **unlisted YouTube**. Paste the URL into the Google verification submission form.

### 1.5 Tag the first public release
**Dependency:** §1.3 (so the artifacts that build are usable). **Owner:** SkyTwin team. **Time:** 5 minutes + ~15 minutes for the workflow to build all three platforms.

Follow [`release-procedure.md`](./release-procedure.md) only after `VERSION`, the package metadata, and the ledger all authorize the same `v0.7.0-beta` release. The workflow rejects a tag whose commit is not already merged into the current `main` branch.

The `release` job in `.github/workflows/build.yml` takes over after the three desktop package jobs. It can publish only after the ledger is ready and current-run CI, machine, signing, model, checksum, provenance, and exact artifact-set evidence pass. It creates an unpublished draft, verifies every attached name and digest against the evidence manifest, and immediately publishes from the same controlled job. Do not publish a draft manually. Today the open stop-ship conditions intentionally prevent this path from reaching draft creation.

The full, step-by-step runbook (including these gaps and the clean-machine verification) lives in [`release-procedure.md`](./release-procedure.md).

### 1.6 README download surface: promote only verified artifacts
**Dependency:** §1.5. **Owner:** SkyTwin team. **Time:** 30 minutes.

The README already exposes technical-preview download links. After §1.5, replace preview caveats only with the exact filenames and support language authorized by the verified release manifest:

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

### 2.1 Auto-update channel — **code half done (Unreleased)**
The electron-updater client plumbing is wired (`apps/desktop/src/auto-update.ts`, dead `.local` feed-URL removed under #370 in PR #453), and the **`latest*.yml` update manifests now ship with every GitHub Release** (the remaining code half of #370). electron-builder writes `latest-mac.yml` / `latest.yml` / `latest-linux.yml` into `dist-electron/` during packaging even under `--publish never` (that flag only suppresses the upload, not the manifest generation); `build.yml`'s three desktop jobs now collect those manifests as artifacts and the softprops `release` job attaches them alongside the installers. The `release` job also verifies the GitHub Releases endpoint is reachable (`curl -f`, fails on non-2xx) before publishing. `--publish never` on the package steps is unchanged. Remaining before this is end-to-end live: code signing (#368/#359) — electron-updater refuses an unsigned update payload, so the self-update path can't complete on a fresh box until signed binaries ship. Acceptance test (after signing): install one release on a fresh box, leave it sit, tag the next, confirm the installed app self-updates within ~6 hours (the `auto-update.ts` `DEFAULT_CHECK_INTERVAL_MS` default check interval).

### 2.2 PKCE verifier store in DB — **done (Unreleased)**
Shipped: migration `058-oauth-pkce-pending.sql` + `packages/db/src/repositories/oauth-pkce-pending-repository.ts`. `apps/api/src/routes/oauth.ts` now uses the DB-backed store; a desktop restart between `/authorize` and `/callback` no longer drops the verifier. `consume()` is a single `DELETE...RETURNING` so the replay-protection property survives the move off the in-memory Map. 5 new tests.

### 2.3 Onboarding flow auto-routes through `/#/connect-gmail` — **done (Unreleased)**
Shipped: `apps/api/src/routes/oauth.ts` accepts a whitelisted `?next=connect-gmail` parameter; the value is encoded into the HMAC-signed state and used to compose the post-OAuth redirect URL. `apps/web/public/js/pages/onboarding.js`'s "Continue with Google" button passes `next: 'connect-gmail'`. `apps/web/public/js/pages/connect-gmail.js` shows a "Calendar connected — now let's hook up Gmail" banner above the wizard when the user arrives via this deep-link. 5 new tests on the whitelist + HMAC coverage of the new tag.

### 2.4 Better error story when bundled client_id is unset — **done (Unreleased)**
Shipped: `apps/api/src/routes/oauth.ts` tags its no-client_id 503 with `code: 'NO_GOOGLE_CLIENT_CONFIGURED'` + `help: '#/connect-gmail'`. `apps/web/public/js/api-client.js` plumbs structured `code`/`help`/`docs` fields through `ApiError`; 503s with a code use a new `kind: 'config-missing'`. The onboarding wizard detects the code and routes the user into the connect-gmail wizard (same five-step flow handles both BYO Gmail and "this fork has no bundled client"). The connect-gmail wizard's final OAuth call now uses `?newUser=true` when no userId is in localStorage, so brand-new onboarding users finish the flow without needing a pre-existing account.

### 2.5 Telemetry-free crash reporting
Automatic error reporting would expand SkyTwin's network and data-handling boundary, but **fully silent failures** are at odds with shipping a desktop app. The middle ground: an opt-in "send anonymized crash report" prompt that uploads a JSON payload with the exception, stack, and SkyTwin version (no user data) to a developer-controlled endpoint. Default off; if you opt in the prompt explains exactly what's sent.

### 2.6 Demo / sample-profile mode polish — **interactive local sample complete in source; artifact verification pending (Unreleased)**
Welcome-screen CTA is now a real `btn-outline btn-lg` card with an "or" divider above it instead of a tiny gray footer link (`apps/web/public/js/pages/onboarding.js` renderWelcome) — the alternative-path framing is explicit and discoverable. Packaged desktop provisions a minimal fictional **Sample User** only on its attested bundled CockroachDB child and opens it through a four-hour credential fixed to the reserved `is_demo` identity; this is separate from the richer Alex Thompson development seed. The explicit read allowlist supports dashboard, decision, and explanation browsing while excluding mutations, credentials, settings, search, SSE, paid inference, and execution; the development authentication bypass remains disabled. API readiness and worker writes are fenced to the exact packaged generation; normal pause stops the worker, and concurrent pause/resume or recovery cannot retain a partial generation. Connector cursors commit only after the API accepts every staged signal, while embedding completion is separately fenced to the exact active database lease token. Fictional packaged signals populate the browsing surfaces without relabeling an unrelated account at the reserved identity.

Approve, reject, correct, reset, and learn interactions now run through a separate loopback-only simulation with a closed command catalog. The simulation evaluates the real policy and explanation logic, but keeps bounded state in memory and cannot call connectors, providers, credentials, execution adapters, or database mutation paths. Browser authority is tab-scoped in `sessionStorage`; real sign-in wins, exit/renewal races are generation-fenced, and the service worker applies the API's case-insensitive route semantics before bypassing all `/api/v1/demo` traffic. Requests to normal product routes also bypass offline persistence when they carry the sample bearer credential or EventSource query token. The worker reapplies current policy before sending any stored write, deleting entries that are no longer eligible. Source of truth: `apps/api/src/services/sample-simulation.ts`, `apps/web/public/js/sample-session.js`, `apps/web/public/js/pwa/sw-policy.js`, and `apps/web/public/sw.js`.

Still open under [#630](https://github.com/jayzalowitz/skytwin/issues/630): fresh packaged-artifact verification and final presentation polish. The in-dashboard tour banner is functional but generic ("Click around freely, then start your own when you're ready"), and there is no "first 30 seconds" pointer steering users to the most interesting proposal. The exit flow is intentionally single-click because the state is fictional and disposable.

---

## Tier 3 — Post-launch / strategic (don't start before Tier 1 + 2 land)

### 3.1 Gmail restricted-scope verification
Tracked in [#351](https://github.com/jayzalowitz/skytwin/issues/351). Google review plus any assigned CASA assessment; obtain the current assurance-level assignment, lab quote, and schedule before budgeting. Don't start until:
- BYO Gmail friction is measurably hurting funnel conversion (instrument the wizard step-completion drop-off rate first).
- SkyTwin has revenue that comfortably absorbs the recurring fee.

### 3.2 Mobile app stores
The mobile app exists (Expo, React Native) and the pairing flow works locally over mDNS. App Store + Play Store submissions are separate review processes with their own friction. Defer until desktop hits product-market fit signals.

### 3.3 Hosted SkyTwin
The packaged default is local-first, while users can already opt into disclosed hosted reasoning, embedding, remote execution, and federation paths. A fully hosted SkyTwin deployment would be a separate product with a broader threat model and must not inherit claims that apply only to the packaged local default.

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
- CASA assessment: **current authorized-lab quote required; annual revalidation applies**

Total recurring annual cost to start: **$500–$1000** including domain.

---

## How this plan was put together

Each Tier 1 item was selected by asking: *"If we shipped without this, what would break for the user?"* If the answer is "the .dmg won't open at all" (§1.3), "the download link doesn't exist yet" (§1.5), or "Google blocks the OAuth flow" (§1.2), it's Tier 1. If the answer is "the experience is rougher than it could be" (§2.x), it's Tier 2. If the answer is "we'll know we needed this from telemetry once we have users" (§3.x), it's Tier 3 and shouldn't drain attention before we have those users.

The most common failure mode for plans like this is letting Tier 3 items (interesting strategic things) crowd out Tier 1 items (necessary boring things). The release pipeline (the `release` job in `.github/workflows/build.yml`) doesn't count as "release pipeline shipped" until §1.5 actually fires it on a tag. The OAuth wizard existing at `/#/connect-gmail` doesn't count as "Gmail working for users" until §1.2 clears the brand verification that makes Google's consent screen show the SkyTwin name. Build all the way to the user, then up.
