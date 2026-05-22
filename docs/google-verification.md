# Google OAuth App Verification Plan

This document tracks the verification status of the bundled Google OAuth client (`SkyTwin Desktop`, client ID `594829999930-kpjopcs1pak0rp0omimuegr5ugcv5l8h.apps.googleusercontent.com`, project `skytwin-492700`).

## Why we need it

We ship a public OAuth client (PKCE flow) so end users don't have to register their own Google Cloud project. Until the consent screen is published + verified, two limits apply:

- **Testing mode (current state)** — only emails on the test-user list can complete OAuth, capped at 100 users.
- **Published, unverified** — any user can sign in, but they hit a scary "Google hasn't verified this app" warning and have to click through "Advanced → Go to SkyTwin (unsafe)".
- **Published, verified** — clean consent screen, no warning. Required for grandma-grade UX.

## Where we stand

| Requirement | Status | Notes |
|-------------|--------|-------|
| Homepage on a verified domain | **done** | `https://jayzalowitz.github.io/skytwin/` — github.io is auto-verified by Google. |
| Privacy policy on the same domain | **done** | `https://jayzalowitz.github.io/skytwin/privacy.html`, linked from the homepage. |
| Terms of service | **done** | `https://jayzalowitz.github.io/skytwin/terms.html`, linked from the homepage. |
| OAuth consent screen URLs updated | **todo** | Open `https://console.cloud.google.com/auth/branding?project=skytwin-492700` and paste the homepage + privacy URLs into the App Information section. |
| Domain verification via Search Console | **n/a** | `github.io` subdomains are pre-verified; no Search Console token needed. |
| Authorized domains list includes `github.io` | **todo** | Add `github.io` to the Authorized domains list in the consent-screen editor. |
| Publishing status: Testing → In production | **todo** | Click "Publish app" on the Audience page. Users will see the unverified-app warning until full verification completes. |
| Scope justifications | **drafted** | See [Scope justifications](#scope-justifications) below. |
| Demonstration video | **todo** | Record a screen capture of the .dmg/.exe install → OAuth grant → mail-triage workflow. Must show the OAuth consent screen with the exact scopes we request, in English. |
| Restricted-scope security assessment | **not started** | Required annually for the Gmail `readonly` and `modify` scopes (Google classifies both as restricted). Quoted by Google-empanelled assessors at roughly $15k–$50k per cycle. **Hardest gate.** |

## Scope justifications

These are the answers we'll paste into the consent-screen scope-by-scope justification fields. Each is intentionally specific about *which feature* in the SkyTwin UI relies on *which scope*, because Google's review consistently rejects "we might need this later" or generic phrasing.

### `openid` + `email` + `profile`

> Used to identify which Google account is connecting to SkyTwin so we can key the local twin profile on the verified email address. The profile name is shown on the user's local dashboard ("Signed in as Jane Smith") so they know which account the twin is operating on behalf of. No narrower scope provides the verified email address. No data is sent to skytwin.dev or any other server — the verified identity is stored only in the user's local CockroachDB instance.

### `https://www.googleapis.com/auth/gmail.readonly`

> Required for SkyTwin's core inbox-triage feature: reading incoming Gmail to classify messages by sender and content, surface high-priority threads, and learn which kinds of mail the user typically archives versus replies to. The classification result drives the "Approvals" queue in the SkyTwin dashboard (the prominent user-facing feature that requires this scope). The narrower `gmail.metadata` scope is insufficient because metadata alone cannot distinguish, for example, a personal email from a calendared newsletter — body content is needed for accurate classification.

### `https://www.googleapis.com/auth/gmail.modify`

> Required for SkyTwin's auto-archive feature: when the user has taught the twin (via approval feedback) to archive a specific kind of mail — newsletters, notifications from a specific service, etc. — SkyTwin applies the relevant Gmail label and archives the thread. This is the user-facing action visible in the dashboard's "Recent actions" feed. SkyTwin never sends mail (`gmail.send` is not requested) and never deletes mail. `gmail.labels` alone is insufficient because applying a label does not move a thread out of the inbox; the modify scope is the narrowest one that supports archive-on-our-behalf.

### `https://www.googleapis.com/auth/calendar.readonly`

> Required for SkyTwin's calendar-context feature: reading the user's calendar to spot conflicts, surface relevant events when interpreting incoming mail (e.g. matching a meeting-reschedule email to the right calendar entry), and learn the user's scheduling habits (working hours, preferred meeting length, recurring blocks).

### `https://www.googleapis.com/auth/calendar.events`

> Required for SkyTwin's calendar-management feature: with the user's approval (or automatically for events matching patterns the user has taught the twin), SkyTwin creates, modifies, or responds to calendar invites — declines auto-invites the user has marked as "always decline," accepts invitations from people on the user's trusted list, schedules suggested 1-on-1s. Each action produces an explanation record. `calendar.events.owned` would not work because the events SkyTwin needs to manage are frequently events the user does not own (incoming invites).

## Demonstration video plan

When ready to submit, record a 2–3 minute screen capture covering:

1. Open the .dmg / .exe / .AppImage SkyTwin installer; double-click; let the splash + bundled CockroachDB come up.
2. Dashboard loads on `localhost:3200`. Click "Sign in with Google."
3. Browser opens to `accounts.google.com/o/oauth2/v2/auth?...` showing the SkyTwin consent screen — language toggled to English, all five scopes listed. Read each scope aloud while pointing at it.
4. Click "Continue." Return to the SkyTwin desktop; show the "Connected" celebration card.
5. Switch to the Approvals tab; show a real Gmail signal that came through (sender, subject, classification result). Click "Approve archive."
6. Show the resulting label change in Gmail itself (open the Gmail web UI in a separate window to demonstrate the modify scope's user-facing effect).
7. Switch to the Calendar tab; show a conflict-detection card. Decline an event from the dashboard; show the resulting RSVP in Google Calendar's web UI.
8. End on the dashboard's "Recent actions" feed showing both the archive and the decline with their explanation records.

Upload as unlisted YouTube. Paste the link into the verification submission.

## What happens after we submit

- **Brand verification** (no sensitive scopes): typically reviewed in a few business days.
- **Sensitive scopes** (Calendar): a few weeks of back-and-forth on justifications, video, scope narrowness.
- **Restricted scopes** (Gmail): requires a third-party security assessment from a Google-empanelled CASA Tier 2 or 3 assessor; the assessment runs 4–8 weeks and costs $15k–$50k. After passing, Google review takes another few weeks.

Until restricted-scope verification clears, the unverified-app warning persists for users not on the test-user list. For a launch where grandma is the target user, this is the hardest single gate. Three pragmatic options:

1. **Drop the Gmail scopes** and ship Calendar-only initially. Sensitive-only verification skips the security assessment.
2. **Ship with the warning visible** and document it prominently in the install path ("you will see a Google warning the first time — click 'Advanced → Go to SkyTwin (unsafe)' — this is normal until we complete Google's security review").
3. **Self-fund the security assessment** and ship verified.

Option 2 is the right starting point for a pre-1.0 launch. Re-evaluate when usage grows enough that the assessment fee is a small fraction of monthly value delivered.
