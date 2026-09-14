# Google OAuth Verification — Staged Rollout Plan

## The constraint we have to design around

Google classifies OAuth scopes by sensitivity and assigns the verification path. Google or its assessment framework—not the app developer—determines whether an external security assessment is required and which current CASA assurance level applies.

| Scope class | Scopes in SkyTwin | Verification path |
|-------------|-------------------|-------------------|
| **Non-sensitive** | `openid`, `email`, `profile` | Consent-screen configuration; Google may still review branding or policy compliance. |
| **Sensitive** | `calendar.readonly`, `calendar.events` | Google OAuth verification before the bundled production client can present these scopes as approved. |
| **Restricted** | `gmail.readonly`, `gmail.modify` | Google OAuth verification plus any security assessment Google assigns. Assessment level, timing, and assessor price require a current assignment and quote. |

Restricted-scope review can include annual CASA revalidation by an authorized lab. It evaluates the application, deployment infrastructure, and applicable user-data storage. SkyTwin's packaged desktop defaults to a local database, but users may configure remote storage or providers, and selected prompt data can leave the machine when a hosted reasoning mode is enabled. See Google's [OAuth verification guidance](https://support.google.com/cloud/answer/9110914) and the current [CASA assurance-level model](https://appdefensealliance.dev/casa/casa-tiering).

## The elegant fix: tiered OAuth at the code level

SkyTwin ships with **two** OAuth code paths, both already implemented in `apps/api/src/routes/oauth.ts`:

### Tier 1 — Bundled client (Identity + Calendar only)

- The SkyTwin-team OAuth client `594829999930-kpjopcs1pak0rp0omimuegr5ugcv5l8h.apps.googleusercontent.com` (Desktop app, project `skytwin-492700`).
- Configured to request `openid`, `email`, `profile`, `calendar.readonly`, and `calendar.events`; brand and sensitive-scope verification are still pending.
- Used by default for every "Sign in with Google" click in the desktop app.
- External assessment cost: none currently identified for this sensitive-scope path; Google review is still required.

### Tier 2 — Bring-your-own client (Gmail)

**This is the launch Gmail experience**, not a fallback. SkyTwin's content-aware features — body summarisation, draft replies, classification by what the email *says* — all live behind Gmail's restricted scope class. Until the bundled client completes Google's assigned verification path, the launch route is for each user to plug in their own Google Cloud OAuth client. A personal-use project with fewer than 100 users may use Google's verification exception and click through the unverified-app warning, but it must still comply with the [Google API Services User Data Policy](https://support.google.com/cloud/answer/13464323).

- Documented at [`/connect-gmail.html`](https://jayzalowitz.github.io/skytwin/connect-gmail.html) — five-minute walkthrough on the public web.
- In-app wizard at `#/connect-gmail` in the SkyTwin dashboard ([apps/web/public/js/pages/connect-gmail.js](https://github.com/jayzalowitz/skytwin/blob/main/apps/web/public/js/pages/connect-gmail.js)) — same five steps, with progress dots, per-step deep links into GCP Console, and a final paste-and-connect form that PUTs to `/api/credentials/google` then redirects through `/api/oauth/google/authorize?include=gmail`.
- User creates a Google Cloud OAuth client (Web application type, `http://localhost:3100/api/oauth/google/callback` as the redirect) in their own GCP project; pastes client_id + client_secret.
- `resolveRequestedScopes()` then includes `gmail.readonly` and `gmail.modify` because `source === 'user-supplied'`. The Gmail API accepts `gmail.modify` for approved send operations, so SkyTwin does not need the separate sensitive-only `gmail.send` scope on top of its restricted BYO Gmail grant.
- Cost to the user: ~5 minutes of clicking. Cost to SkyTwin: $0.

### How the gate is enforced in code

`resolveRequestedScopes()` in `apps/api/src/routes/oauth.ts` returns:

- `bundled` source + `includeGmail=true` → Gmail scopes are silently **dropped**, and the caller receives a `skipped: [{ capability: 'gmail', reason: 'bundled-client-not-verified-for-restricted-scopes' }]` so the dashboard can render a "Connect Gmail" CTA pointing at `/connect-gmail`.
- `user-supplied` source + `includeGmail=true` → Gmail scopes included as requested.
- Any source + `includeGmail=false` → Gmail scopes never included, even if they could be — minimum-scope principle.

The `/api/oauth/google/authorize` endpoint returns HTTP 412 (Precondition Failed) with a clear error and a `help: '/docs/connect-gmail'` pointer when a caller explicitly asks for Gmail under the bundled client. 6 tests in `apps/api/src/__tests__/oauth-scope-tiers.test.ts` lock in this behaviour.

## Brand verification (lighter-weight, mandatory regardless)

Brand verification is the lighter-weight step that lets the app name + logo + homepage URL show on the consent screen instead of the generic "<project-id> wants to access your Google Account" string. Required even for the Calendar-only Tier 1 flow.

Checklist:

| Requirement | Status | Notes |
|-------------|--------|-------|
| Homepage on verified domain | **done** | `https://jayzalowitz.github.io/skytwin/`. github.io is auto-verified. |
| Privacy policy same domain | **done** | `https://jayzalowitz.github.io/skytwin/privacy.html`. |
| Terms of service same domain | **done** | `https://jayzalowitz.github.io/skytwin/terms.html`. |
| OAuth consent screen Branding URLs | **done via browser agent** | App name "SkyTwin", homepage/privacy/ToS URLs, `jayzalowitz.github.io` in Authorized domains. |
| App published (Testing → Production) | **done** (user clicked Publish) | Out of Testing-mode user cap; unverified-app warning still shows until app review clears. |
| App logo uploaded | **todo** | 120×120 PNG. Required only when we submit for verification (Testing mode skips it). |
| Submit for brand verification | **todo** | GitHub Pages is live. After the logo and review materials are ready, click "Verify branding" on `https://console.cloud.google.com/auth/branding?project=skytwin-492700`. |

## Sensitive-scope review for Calendar (cheap, manual)

After brand verification clears, submit for sensitive-scope verification covering only `calendar.readonly` + `calendar.events`. Reviewer wants:

1. **Scope justifications** — drafted in this doc (see [Scope justifications](#scope-justifications) below). Paste these into the per-scope justification fields in the GCP submission UI.
2. **Demo video** — see [Demo video plan](#demo-video-plan) below.
3. **In-app data-handling disclosure** — already present in `apps/web/public/onboarding.html` (mentions calendar access and how data is stored locally) and in the Privacy Policy.

Calendar review typically clears in 1–4 weeks. No third-party fees.

## Restricted-scope verification for Gmail (the hard gate)

Tracked in [issue #351](https://github.com/jayzalowitz/skytwin/issues/351). Until Google's assigned verification and assessment path is completed, SkyTwin uses Tier 2 (BYO Gmail) for inbox features.

## Scope justifications

(Paste into the per-scope justification fields in the GCP verification submission. Each is intentionally specific about *which feature* in SkyTwin's UI relies on *which scope* — Google's reviewers reject generic phrasing.)

### `openid` + `email` + `profile`

> Required to identify which Google account is connecting so SkyTwin can key the local twin profile on the verified email address. The profile name is shown on the user's local dashboard ("Signed in as Jane Smith") so they know which account the twin is operating on behalf of. Google processes the OAuth request, and SkyTwin stores the resulting profile and grant in the user's local application database; configured hosted-model features have separate disclosures.

### `https://www.googleapis.com/auth/calendar.readonly`

> Required for SkyTwin's calendar-context feature: reading the user's calendar to spot scheduling conflicts, surface relevant events when interpreting incoming mail (matching a meeting-reschedule email to the right calendar entry), and learn the user's scheduling habits (working hours, preferred meeting length, recurring blocks). The "Approvals" tab in the SkyTwin dashboard shows the calendar-derived signals that drive each decision.

### `https://www.googleapis.com/auth/calendar.events`

> Required for SkyTwin's calendar-management feature: with the user's approval — or automatically for events matching patterns the user has explicitly taught the twin — SkyTwin creates, modifies, or responds to calendar invites. Supported calendar paths can produce explanation records visible in the dashboard's "Recent actions" feed; release-wide coverage remains under audit. The narrower `calendar.events.owned` would not work because the invites SkyTwin must respond to are typically events the user does not own (incoming invitations from others).

### `https://www.googleapis.com/auth/gmail.readonly` (Tier 2 only)

> Required for SkyTwin's inbox-triage feature: reading incoming Gmail to classify messages by sender and content, surface high-priority threads, and learn which kinds of mail the user typically archives versus replies to. The classification result drives the "Approvals" queue in the SkyTwin dashboard. The narrower `gmail.metadata` scope is insufficient because metadata alone cannot distinguish a personal email from a calendared newsletter — body content is needed for accurate classification.

### `https://www.googleapis.com/auth/gmail.modify` (Tier 2 only)

> Required for SkyTwin's Gmail action surface: when the user has taught the twin (via approval feedback) to archive a specific category of mail — newsletters, notifications from a specific service, etc. — SkyTwin applies the relevant Gmail label and archives the thread. When the user approves a draft reply or has explicitly earned enough autonomy for routine email replies, SkyTwin can also send a Gmail reply or new message through `users.messages.send`; those outgoing emails include a default-on SkyTwin attribution footer that the user can disable in Settings. `gmail.modify` is one of the scopes Google accepts for `users.messages.send`, so a separate `gmail.send` scope is not requested. SkyTwin does not permanently delete mail. `gmail.labels` alone is insufficient because applying a label does not move a thread out of the inbox or allow approved replies.

## Demo video plan

When submitting for sensitive- or restricted-scope review, record a 2–3 minute screen capture covering:

1. Open the `.dmg` / `.exe` / `.AppImage` SkyTwin installer; double-click; let the splash + bundled CockroachDB come up.
2. Dashboard loads on `localhost:3200`. Click "Sign in with Google."
3. Browser opens to `accounts.google.com` showing the SkyTwin consent screen — language toggled to English, scopes listed. Read each scope aloud while pointing at it.
4. Click "Continue." Return to the SkyTwin desktop; show the "Connected" celebration card.
5. (For Calendar review) Show a conflict-detection card. Decline an event from the dashboard; show the resulting RSVP in Google Calendar's web UI.
6. (For Gmail review, Tier 2 BYO) Open the Connect Gmail walkthrough at `/connect-gmail.html`; show a credential paste; show a real Gmail signal coming through the Approvals queue.
7. Approve a Gmail action from the dashboard. If the action is a draft reply, point out the SkyTwin footer preview and Settings toggle before send, then show the resulting Gmail message.
8. End on the dashboard's "Recent actions" feed showing explanation details for the recorded actions exercised by the verification flow.

Upload as unlisted YouTube. Paste the link into the verification submission.

## Issue draft: restricted-scope verification

Use this when filing the GitHub issue for the eventual Gmail-tier-1 work:

> **Title:** Submit bundled OAuth client for Gmail restricted-scope verification
>
> **Body:**
>
> Today SkyTwin uses a tiered OAuth design (see `docs/google-verification.md`): the bundled SkyTwin-team OAuth client is configured for Calendar and identity scopes, with brand and sensitive-scope verification still pending. Users who want Gmail features go through the BYO walkthrough at `/connect-gmail.html` and use their own personal OAuth client.
>
> This is the launch design because it avoids waiting for bundled-client verification. It still carries Google's unverified-app warning, user cap, policy obligations, and publishing-status rules. The BYO step is friction; once usage justifies it, submit the bundled client through Google's assigned restricted-scope verification and assessment path so Gmail can work without per-user client setup.
>
> ### What needs to happen
>
> - [ ] Obtain Google's current assessment assignment, including the required CASA assurance level, then select an authorized lab.
> - [ ] Pre-assessment readiness review (internal): walk the assessor's standard checklist against `packages/credential-vault`, `apps/api`, the data-flow diagram in `docs/technical-spec.md`. Fix anything obvious.
> - [ ] Obtain current lab quotes and schedule the assessment; do not plan against an unverified fixed price or duration.
> - [ ] Submit to Google with the CASA Letter of Validation, scope justifications (already drafted in `docs/google-verification.md`), and the demo video.
> - [ ] After approval: bake the change in code by removing the `source === 'user-supplied'` gate in `resolveRequestedScopes()` for Gmail. Update `docs/connect-gmail.html` to read "this used to be required; not anymore."
>
> ### Assessment planning
>
> CASA applications are revalidated annually. The required assurance level is assigned from factors such as data sensitivity, user count, risk tolerance, and internal/external risk indicators. Record a current authorized-lab quote before budgeting; Google and CASA do not publish a single guaranteed price for this app.
>
> ### Don't do this before
>
> - User base is large enough that the friction of BYO Gmail is genuinely blocking sign-ups.
> - SkyTwin has revenue (or a sponsor) that covers the current quoted assessment cost without strain.
> - We've shipped at least one feature that genuinely needs the body of every email at sub-second latency — if BYO is fine for power users, the assessment may never be worth it.
