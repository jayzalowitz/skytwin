# SkyTwin Demo — Five Minutes, Seven Steps

This is the walkthrough we use to show someone what SkyTwin does for the first
time. Aim for five minutes end-to-end. Hand it to a friend with a phone in
their other hand and read along.

> **Screenshots:** the repository's historical captures are retained under
> `docs/screenshots/` for audit provenance only. They are prohibited stale
> release assets and are not linked, embedded, or suitable for launch use. A
> fresh capture run against the current UI must be re-audited before any image
> is published. The text walkthrough below is independently
> runnable against a fresh dev install. If you're recording the launch
> video, this file is the script.

> The [`beta claim ledger`](./beta-claim-ledger.json) remains the authority for
> release status and asset disposition; its beta status is currently blocked.

> **Scope:** this operator script exercises the development seed after
> `pnpm db:seed`; it is not a description of the currently published desktop
> installers. Current source gives packaged builds a separate, short-lived,
> account-free sample session. Its database-backed views remain read-only, while
> a separate session-local simulation can approve, reject, correct, reset, and
> learn from fixed fictional proposals. It cannot open settings, persist those
> interactions, invoke providers or connectors, or run an execution adapter.
> This isolated sample is the only supported preview path. Google and Microsoft
> account connections are unavailable; do not use a real Gmail, Calendar,
> Outlook, or Microsoft 365 account for this demo.

---

## Before you start (30 seconds)

You'll need:

- A clean Chrome window (no SkyTwin localStorage).
- The desktop app running. From a fresh checkout:
  ```sh
  pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev
  ```
  Then open `http://localhost:3200`.

Use only fictional sample data. Real account connections and operator/BYO
credential setup are unsupported in the current preview.

---

## Step 1 — Land the cold tab (30 seconds)

**Goal:** open `localhost:3200` and have something useful on screen within 5
seconds.

What you'll see: the first-run wizard. It asks one question — how you want to
start.

**Supported path from here:**

- **"Just show me around"** — the development seed gives you a pre-loaded user
  (Alex) who's alive
  across every surface: ~10 recent decisions, 4 pending approvals you can
  actually click through, a populated daily briefing, "What I've learned",
  Capabilities, Search, and a trust bar at 84% climbing toward "handle most
  things". Two other personas are in the development seed too — **Pat** (a power user who handles
  everything) and **Carol** (a brand-new user earning her first trust) — so
  the dev "Switch user" button tells three different stories. No OAuth, no
  signal-ingestion wait. This is the demo path. (The showcase data lives in
  `packages/db/src/seeds/demo-showcase.ts`; counts move as we tune it.)
Google connection is displayed as unavailable rather than as an additional
path. Microsoft connection has no preview setup control; both providers remain
outside the supported sample.
Managed Google identity/Calendar is deferred, and BYO remains unsupported until
the OAuth and credential-custody architecture gates are complete.

Under the sample choice, the app recommends a maintained local model for the machine
(RAM-, architecture-, and disk-aware); "Change" opens Settings → AI. The model
is downloaded only when the user starts it, and local inference still requires
a compatible llama.cpp runtime. Everything else (tell-SkyTwin-about-yourself, the not-yet-wired
computer observer) is tucked under "More ways to start" so the first screen
isn't a wall of options.

For the rest of this walkthrough we'll use the sample profile. The wizard is
dismissible (Esc, the X, "Skip for now") so a friend who already knows what
they want can land on the dashboard in one click.

**What this proves:** the cold load does not trap a stranger behind a modal.
That sounds obvious. Pre-launch, it was the first thing every cold visitor
hit.

---

## Step 2 — Read the empty dashboard (45 seconds)

**Goal:** orient the viewer on the layout without anything in their inbox
yet.

Three columns on the home page:

- **What's coming** — the "I want to handle these — OK?" card. Items
  waiting on the user's yes/no. Right now it's the seeded approvals from
  the sample profile.
- **What happened** — the timeline of recent decisions the twin already
  made. Click through to drill into the explanation.
- **What I've learned** — the twin profile. Preferences extracted from
  observed behaviour, with their confidence levels.

The microcopy is the differentiator here. Not "Approve / Reject" — **"Yes,
do it"** and **"Not this time."** Not "Pending" — **"I want to handle these
— OK?"** When you point that out to the viewer, watch their face. The
language is the product.

**Brand-voice rule:** never regress to generic "Approve/Reject." If a future
change touches the approval buttons, it goes through `/review`.

---

## Step 3 — Confirm the sample boundary (45 seconds)

Stay in the sample. Point out that the proposals, briefing, learned preferences,
and decision history are fictional. The packaged sample's database-backed views
remain read-only; approve, reject, correct, reset, and learn interactions use a
separate session-local simulation.

Show the unavailable account-connection state. There is no connect button, credential form,
authorization URL, connector wait, or provider-status promise. This absence is
part of the release boundary, not a demo shortcut.

---

## Step 4 — Approve a decision (60 seconds)

**Goal:** show the explanation-first design — every approvable action carries
a "why."

Click any item on the "What's coming" card. The approval card expands. You
see:

- **What the twin wants to do** — one short sentence. E.g. *"Label the
  Linear newsletter as 'newsletter' and archive it."*
- **Why it picked this** — a plain-English breakdown of the evidence. E.g.
  *"You've archived every Linear digest for the last 6 weeks (12 of 12).
  Confidence: high."*
- **The two buttons** — "Yes, do it" and "Not this time." With an optional
  free-text "tell me why so I learn" field.

Click **"Yes, do it."** The card collapses into the session-local history.
Nothing runs against Gmail or any execution adapter; the sample simulates the
bounded interaction without persistence or external effects.

The viewer should now understand the demonstrated path: **this recorded action
has an explanation derived from observable evidence, and the user remains the
source of truth via approve/reject.** Release-wide explanation coverage is a
separate beta gate.

---

## Step 5 — Reject a decision (45 seconds)

**Goal:** show that feedback is bidirectional. The twin doesn't just act —
it learns from the no's.

Find another item on "What's coming." This time, instead of clicking yes,
type a one-line reason into the feedback field — something concrete, like
*"This one's from a friend, not a newsletter."* Click **"Not this time."**

The card collapses. The next time a similar-shaped signal arrives, the twin
weighs that note as evidence. Open the **What I've learned** page to see
your stated preferences alongside the inferred ones (the latter have lower
confidence and a "still learning" badge).

This is the loop. Every yes confirms a pattern. Every no with a reason
corrects one. The twin profile is the running summary.

---

## Step 6 — Visit Settings; show trust tier + spend cap (45 seconds)

**Goal:** show the user that nothing scary is on autopilot by default, and
the controls are explicit.

Click **Settings** in the sidebar. Four controls worth pointing out:

- **“Where reasoning runs”** — the explicit location selector. “On this
  device” admits only embedded inference and local-source-constrained Ollama;
  “My configured provider” may send prompts to the enabled endpoint. The
  verified-private-cloud choice is visible but unavailable until each request
  can be independently verified.

- **"How much should your twin do?"** — the trust tier selector. Five
  rungs from "Just watch" through "Full autopilot." Default is "Ask me
  first," meaning every action queues for approval. Below the buttons,
  expand **"What does it take to move up?"** — concrete bullets like
  *"20 approvals in a row, ≥85% approval ratio, at least 3 days in
  current tier."* (The values mirror `PROMOTION_THRESHOLDS` from
  `packages/shared-types/src/policy.ts` exactly; the engine and the
  copy can't drift, locked by `promotion-thresholds-shape.test.ts`.)
- **"Spending guardrails"** — per-action and daily caps in dollars.
  Defaults from `apps/web/public/js/pages/settings.js` are **$100 per
  action** and **$500 per day** (10000 and 50000 cents respectively).
  Hard limits at the policy engine — anything above the cap escalates
  to manual approval no matter the trust tier.
- **"Delete everything about me"** — at the bottom, with a red border.
  Two-stage confirm (window prompt asks the user to type DELETE), then
  the right-to-erasure flow purges every row in one transaction.

---

## Step 7 — Pause automatic action (30 seconds)

**Goal:** close the demo on the automatic-action control, with its scope
stated plainly before the user leaves the app running.

Two controls share the same auto-execution semantics, but only one is in
Settings:

- **Per-user pause** — "Pause auto-execution" card. Click, confirm,
  optionally drop a reason. Every subsequent decision routes to manual
  approval until you resume. A sticky red banner appears at the top of
  every page reminding you you're paused; the Resume button lives on the
  banner so a panicked future-you doesn't have to navigate to find it.
- **Operator-only switch** — `SKYTWIN_AUTO_EXECUTE_DISABLED=true` env
  var on the API/worker process. Same semantics, controlled at the
  process level, can't be cleared from the UI. For self-hosters who
  need a way to stop automatic action without rebooting it.

Do not call either one a whole-system pause: signal sync continues. The
global "Pause everything" button is a separate MCP-capability control and
does not pause the email/calendar path. Packaged desktop also has a tray
control that pauses worker background processing while the ready API/web
may remain available. End by showing Settings → Pause auto-execution and
saying exactly that actions now require review.

---

## Time budget

| Step | Target | Cumulative |
|---|---|---|
| 1. Cold load | 30s | 0:30 |
| 2. Empty dashboard | 45s | 1:15 |
| 3. Connect / seed | 45s | 2:00 |
| 4. Approve | 60s | 3:00 |
| 5. Reject | 45s | 3:45 |
| 6. Settings | 45s | 4:30 |
| 7. Pause | 30s | 5:00 |

If you're running long on any step, the steps to compress in this order are:
3 (skip if using the sample profile), 5 (a single sentence is enough — the
loop's the same as step 4), 6 (point at the cards but don't read every
field). Step 7 stays at full length — it's the trust moment.

---

## Recording the launch video

If you're capturing this for the launch video (the docs/launch-plan.md Tier
1.4 deliverable):

- Open Chrome in a 1280×800 window — matches the dashboard's intended
  layout without scrollbars and is small enough that overlay text reads
  clearly when downscaled for embed.
- Use the sample profile. Google and Microsoft account connections are
  unavailable, and real-account footage is not valid preview evidence.
- Set system audio to off; record with a headset mic so background noise
  doesn't leak. The brand voice carries; ambient typing doesn't.
- Cut at five minutes. Anything you couldn't say in five was outside the
  pitch.
