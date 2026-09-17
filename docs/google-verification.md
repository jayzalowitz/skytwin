# Google integration — deferred verification and architecture plan

## Current release boundaries

The supported SkyTwin beta candidate remains gated separately. The current
unsigned `0.6.106.0` alpha offers a packaged BYO Google path beside its isolated
account-free sample; it does not ship a SkyTwin-managed Google OAuth client.

The current alpha exposes its wizard in the desktop window and to a local
browser that already has a valid SkyTwin session. A fresh browser has no
installation bootstrap authority. The user creates and supplies a Google Web
Application OAuth client; consent opens in the system browser. Source operators
can also enable the provider implementation with the exact
`SKYTWIN_GOOGLE_CONNECTION_MODE=experimental` opt-in. Neither path is evidence
of Google approval or a supported managed-client service.

This page records future work. It is not a setup guide, an approval claim, or
evidence that a personal OAuth test is suitable for release.

## Why managed connection remains deferred

Removing a default client ID is not enough to make BYO safe. Before real Google
access is supported, the same reviewed authority must cover:

- an immutable, owner-bound OAuth client generation from authorization through
  callback, storage, refresh, connector admission, and action execution;
- a one-use, replay-resistant OAuth transaction and authenticated new-user
  session handoff;
- exact granted capabilities for identity, Calendar read, Calendar write,
  Gmail read, and Gmail modify;
- connector and failure-state isolation by owner, account, and capability;
- encrypted client-secret and token custody with explicit locked-key and
  migration behavior; and
- a single-owner distribution boundary until per-owner configuration exists.

Until those gates and their adversarial tests land together, UI availability or
a successful source-development exchange must not be presented as support.
Architecture work is tracked in [issue #703](https://github.com/jayzalowitz/skytwin/issues/703).

## Intended future scope boundary

After the architecture gates, the intended default real-account request is
identity plus explicitly granted Calendar capabilities:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/calendar.readonly`
- `https://www.googleapis.com/auth/calendar.events`

Gmail remains separately optional. It may be requested only after explicit
Gmail intent and with an eligible operator/BYO client:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.modify`

SkyTwin must not request `https://mail.google.com/` or add a redundant Gmail
send scope. A denied or absent capability must prevent construction, polling,
refresh, and actions for that capability rather than merely producing provider
errors afterward.

These scopes are used by the BYO alpha/experimental path. They are not available
to the account-free beta candidate and are not a managed-client support claim.

## External Google requirements

Google classifies scopes and determines the applicable review path. Identity
scopes, sensitive Calendar scopes, and restricted Gmail scopes can have
different branding, verification, user-cap, and security-assessment
requirements. Google may change console labels and requirements, so execution
must use its current primary documentation rather than estimates copied here:

- [OAuth app production-readiness overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
- [OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies)
- [Verification requirements](https://support.google.com/cloud/answer/13464321)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)

External apps in Testing can be restricted to named testers, and grants that
include more than basic identity scopes can expire after seven days. Published
but unverified apps can retain warnings and user limits. Restricted-scope use
can require an assigned security assessment. BYO and personal-use cases still
carry the applicable publishing, warning, tester, expiry, and user-data duties.

## Managed Google access

Managed identity and Calendar access is deferred. Managed Gmail verification
and any assigned security assessment remain separately tracked in
[issue #351](https://github.com/jayzalowitz/skytwin/issues/351). No current
document, source test, console configuration, or BYO success may be described as
Google approval of a SkyTwin-managed client.

Before any managed submission, public privacy and terms pages, in-product
disclosures, exact scope behavior, deletion controls, demo material, and the
candidate artifact must all describe the same reviewed implementation.

## Preview demonstration

The beta launch-evidence demonstration is the account-free sample described
in [`demo.md`](./demo.md). It uses fictional data and has no OAuth, connector,
credential, provider, or external-action path. Do not record a real-account
Google flow as beta-candidate evidence. Real-inbox evaluators should instead use
the separately labeled [`connect-gmail.html`](./connect-gmail.html) alpha guide.
