# Google OAuth Verification — Staged Rollout Plan

## The constraint we have to design around

Google's OAuth verification has three tiers, with sharply different costs:

| Scope tier | Scopes in SkyTwin | Verification cost | Time to clear |
|------------|-------------------|-------------------|---------------|
| **Non-sensitive** | `openid`, `email`, `profile` | Free (auto-approved on submission) | Same day |
| **Sensitive** | `calendar.readonly`, `calendar.events` | Free (manual app review, no third party) | Days–weeks |
| **Restricted** | `gmail.readonly`, `gmail.modify` | **CASA Tier 2 or 3 security assessment, $15k–$50k/year**, plus Google's review | 4–8 weeks for assessment + weeks for review |

The restricted-scope assessment is the killer. It's required annually, conducted by Google-empanelled third-party assessors (Bishop Fox, Leviathan, Schellman, etc.), and it audits the entire app's data-handling — even though SkyTwin keeps user data exclusively on the user's own machine.

## The elegant fix: tiered OAuth at the code level

SkyTwin ships with **two** OAuth code paths, both already implemented in `apps/api/src/routes/oauth.ts`:

### Tier 1 — Bundled client (Identity + Calendar only)

- The SkyTwin-team OAuth client `594829999930-kpjopcs1pak0rp0omimuegr5ugcv5l8h.apps.googleusercontent.com` (Desktop app, project `skytwin-492700`).
- Verified by Google for `openid`, `email`, `profile`, `calendar.readonly`, `calendar.events` — sensitive but not restricted.
- Used by default for every "Sign in with Google" click in the desktop app.
- Cost: $0. Just the (one-time) Google app review for the Calendar scope.

### Tier 2 — Bring-your-own client (Gmail)

- Documented at [`/connect-gmail.html`](https://jayzalowitz.github.io/skytwin/connect-gmail.html) — five-minute walkthrough.
- User creates a Google Cloud OAuth client in their own GCP project; pastes client_id + client_secret into the SkyTwin Setup page.
- The same OAuth flow then includes `gmail.readonly` and `gmail.modify` because the request goes through the user's own client, which is a private installed app and therefore exempt from Google's app-verification requirements (the assessment requirement applies to public OAuth clients, not to a developer using their own client).
- Cost to the user: 5 minutes of clicking. Cost to SkyTwin: $0.

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
| Submit for brand verification | **todo** | Click "Verify branding" on `https://console.cloud.google.com/auth/branding?project=skytwin-492700`. Cannot submit until GitHub Pages goes live (PR #350 must merge for `/docs` to actually serve). |

## Sensitive-scope review for Calendar (cheap, manual)

After brand verification clears, submit for sensitive-scope verification covering only `calendar.readonly` + `calendar.events`. Reviewer wants:

1. **Scope justifications** — drafted in this doc (see [Scope justifications](#scope-justifications) below). Paste these into the per-scope justification fields in the GCP submission UI.
2. **Demo video** — see [Demo video plan](#demo-video-plan) below.
3. **In-app data-handling disclosure** — already present in `apps/web/public/onboarding.html` (mentions calendar access and how data is stored locally) and in the Privacy Policy.

Calendar review typically clears in 1–4 weeks. No third-party fees.

## Restricted-scope verification for Gmail (the hard gate)

Tracked in [Issue #TBD](https://github.com/jayzalowitz/skytwin/issues) (to be created — see [`docs/google-verification.md` § Issue draft](#issue-draft-restricted-scope-verification) below). Until this is funded and submitted, SkyTwin uses Tier 2 (BYO Gmail) for inbox features.

## Scope justifications

(Paste into the per-scope justification fields in the GCP verification submission. Each is intentionally specific about *which feature* in SkyTwin's UI relies on *which scope* — Google's reviewers reject generic phrasing.)

### `openid` + `email` + `profile`

> Required to identify which Google account is connecting so SkyTwin can key the local twin profile on the verified email address. The profile name is shown on the user's local dashboard ("Signed in as Jane Smith") so they know which account the twin is operating on behalf of. No data leaves the user's machine.

### `https://www.googleapis.com/auth/calendar.readonly`

> Required for SkyTwin's calendar-context feature: reading the user's calendar to spot scheduling conflicts, surface relevant events when interpreting incoming mail (matching a meeting-reschedule email to the right calendar entry), and learn the user's scheduling habits (working hours, preferred meeting length, recurring blocks). The "Approvals" tab in the SkyTwin dashboard shows the calendar-derived signals that drive each decision.

### `https://www.googleapis.com/auth/calendar.events`

> Required for SkyTwin's calendar-management feature: with the user's approval — or automatically for events matching patterns the user has explicitly taught the twin — SkyTwin creates, modifies, or responds to calendar invites. Each action produces an explanation record visible in the dashboard's "Recent actions" feed. The narrower `calendar.events.owned` would not work because the invites SkyTwin must respond to are typically events the user does not own (incoming invitations from others).

### `https://www.googleapis.com/auth/gmail.readonly` (Tier 2 only)

> Required for SkyTwin's inbox-triage feature: reading incoming Gmail to classify messages by sender and content, surface high-priority threads, and learn which kinds of mail the user typically archives versus replies to. The classification result drives the "Approvals" queue in the SkyTwin dashboard. The narrower `gmail.metadata` scope is insufficient because metadata alone cannot distinguish a personal email from a calendared newsletter — body content is needed for accurate classification.

### `https://www.googleapis.com/auth/gmail.modify` (Tier 2 only)

> Required for SkyTwin's auto-archive feature: when the user has taught the twin (via approval feedback) to archive a specific category of mail — newsletters, notifications from a specific service, etc. — SkyTwin applies the relevant Gmail label and archives the thread. This is the user-facing action visible in the dashboard's "Recent actions" feed. SkyTwin never sends mail (`gmail.send` is not requested) and never deletes mail. `gmail.labels` alone is insufficient because applying a label does not move a thread out of the inbox.

## Demo video plan

When submitting for sensitive- or restricted-scope review, record a 2–3 minute screen capture covering:

1. Open the `.dmg` / `.exe` / `.AppImage` SkyTwin installer; double-click; let the splash + bundled CockroachDB come up.
2. Dashboard loads on `localhost:3200`. Click "Sign in with Google."
3. Browser opens to `accounts.google.com` showing the SkyTwin consent screen — language toggled to English, scopes listed. Read each scope aloud while pointing at it.
4. Click "Continue." Return to the SkyTwin desktop; show the "Connected" celebration card.
5. (For Calendar review) Show a conflict-detection card. Decline an event from the dashboard; show the resulting RSVP in Google Calendar's web UI.
6. (For Gmail review, Tier 2 BYO) Open the Connect Gmail walkthrough at `/connect-gmail.html`; show a credential paste; show a real Gmail signal coming through the Approvals queue.
7. End on the dashboard's "Recent actions" feed showing each action with its explanation record.

Upload as unlisted YouTube. Paste the link into the verification submission.

## Issue draft: restricted-scope verification

Use this when filing the GitHub issue for the eventual Gmail-tier-1 work:

> **Title:** Submit bundled OAuth client for Gmail restricted-scope verification
>
> **Body:**
>
> Today SkyTwin uses a tiered OAuth design (see `docs/google-verification.md`): the bundled SkyTwin-team OAuth client is verified for Calendar and identity scopes only. Users who want Gmail features go through the BYO walkthrough at `/connect-gmail.html` and use their own private OAuth client.
>
> This is the right design for launch — it costs $0 and unblocks every user without waiting on Google. But the 5-minute BYO step is friction, and once SkyTwin has revenue to support it we should submit the bundled client through Google's restricted-scope CASA assessment so Gmail "just works" out of the box.
>
> ### What needs to happen
>
> - [ ] Pick a CASA Tier 2 (read-only) or Tier 3 (modify) assessor from <https://cloud.google.com/security/compliance/casa-tier-2-assessors>. Tier 3 is required for `gmail.modify`.
> - [ ] Pre-assessment readiness review (internal): walk the assessor's standard checklist against `packages/credential-vault`, `apps/api`, the data-flow diagram in `docs/technical-spec.md`. Fix anything obvious.
> - [ ] Engage the assessor; budget 4–8 weeks for the engagement and $15k–$50k for the fee.
> - [ ] Submit to Google with the CASA Letter of Validation, scope justifications (already drafted in `docs/google-verification.md`), and the demo video.
> - [ ] After approval: bake the change in code by removing the `source === 'user-supplied'` gate in `resolveRequestedScopes()` for Gmail. Update `docs/connect-gmail.html` to read "this used to be required; not anymore."
>
> ### Cost benchmark
>
> Bishop Fox, Leviathan, Schellman, NCC, and other empanelled assessors generally quote $15k–$30k for Tier 2 and $25k–$50k for Tier 3, *annually*. The CASA fee renews every year regardless of whether code changed.
>
> ### Don't do this before
>
> - User base is large enough that the friction of BYO Gmail is genuinely blocking sign-ups.
> - SkyTwin has revenue (or a sponsor) that covers an annual five-figure expense without strain.
> - We've shipped at least one feature that genuinely needs the body of every email at sub-second latency — if BYO is fine for power users, the assessment may never be worth it.
