# SkyTwin Demo — Five Minutes, Seven Steps

This is the walkthrough we use to show someone what SkyTwin does for the first
time. Aim for five minutes end-to-end. Hand it to a friend with a phone in
their other hand and read along.

> **Screenshots:** the live-UI captures the launch will use are tracked as
> a follow-up to this PR. The repo's existing demo stills live under
> [`docs/screenshots/`](./screenshots/) (`dashboard.png`, `approvals.png`,
> `decisions.png`, `onboarding.png`, `settings.png`) — those are the
> baseline; a fresh capture run against the post-Tier-2-polish UI is what
> the launch video needs. The text walkthrough below is independently
> runnable against a fresh dev install. If you're recording the launch
> video, this file is the script.

---

## Before you start (30 seconds)

You'll need:

- A clean Chrome window (no SkyTwin localStorage).
- The desktop app running. From a fresh checkout:
  ```sh
  pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev
  ```
  Then open `http://localhost:3200`.

If you'd rather not connect your real Gmail for the demo, the sample profile
in step 1 covers the same ground without needing OAuth.

---

## Step 1 — Land the cold tab (30 seconds)

**Goal:** open `localhost:3200` and have something useful on screen within 5
seconds.

What you'll see: the first-run wizard. It asks one question — how you want to
start.

**Two paths from here:**

- **"Try with a sample profile"** — gives you a pre-loaded user (Alex)
  with a handful of sample decisions across several domains and a
  populated activity log (the seed in `packages/db/src/seeds/` inserts
  around 8 decisions today; the exact count moves as we tune the demo
  data). No OAuth, no signal-ingestion wait. This is the demo path.
- **"Continue with Google"** — real Gmail + Calendar OAuth. Use this if
  you want to see the live pipeline against your own data.

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

## Step 3 — Connect Gmail (or use the seed) (45 seconds)

**If you took the sample-profile path:** skip ahead to step 4. The sample
profile already has connectors wired and signals flowing.

**If you took the live-OAuth path:** click "Connect Gmail" from the dashboard
or `#/connect-gmail`. The five-step wizard walks the user through the BYO
OAuth client setup (most users will have one bundled at launch, but the
self-hosted path is the source of truth — and it's the only path with a
screenshot in the repo today). Approve the scopes, watch the wizard
auto-advance, and you're back on the dashboard with the connection-status
dot turning green in the sidebar.

The sidebar connection dot in `apps/web/public/js/app.js` flips from the
idle grey state to a green dot with "Listening" text once SSE comes up
(falls back to "Connected" if only HTTP works, "Reconnecting…" / "Offline"
on disconnect). First signal lands within the next polling cycle —
typically 2–3 minutes from a fresh inbox; immediately if there's already
unread mail. The connector-health banner in the chrome surfaces any
per-connector failures the moment the worker observes them (#377).

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

Click **"Yes, do it."** The card collapses into the history below. The
decision is logged with your approval. On the worker's next cycle, the
action actually runs against Gmail (or the mock connector in the sample
profile).

The viewer should now understand the safety model in one sentence:
**every action has an explanation, and the explanation came from observable
evidence, and the user is the source of truth via approve/reject.** That's
the whole pitch.

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

Click **Settings** in the sidebar. Three cards worth pointing out:

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

## Step 7 — Hit the "pause everything" button (30 seconds)

**Goal:** close the demo on the panic button — the thing the user needs to
trust before they leave the app running.

Two ways to pause, both visible from Settings:

- **Per-user pause** — "Pause auto-execution" card. Click, confirm,
  optionally drop a reason. Every subsequent decision routes to manual
  approval until you resume. A sticky red banner appears at the top of
  every page reminding you you're paused; the Resume button lives on the
  banner so a panicked future-you doesn't have to navigate to find it.
- **Operator kill switch** — `SKYTWIN_AUTO_EXECUTE_DISABLED=true` env
  var on the API/worker process. Same semantics, controlled at the
  process level, can't be cleared from the UI. For self-hosters who
  need a way to silence the system without rebooting it.

End the demo here. Tell the viewer: *"If at any point I'm uncomfortable
with what it's doing, that button is on every page."* That's what they
remember.

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
- Use the sample profile, not your own Gmail. Real subjects on screen
  invite a screenshot scandal.
- Set system audio to off; record with a headset mic so background noise
  doesn't leak. The brand voice carries; ambient typing doesn't.
- Cut at five minutes. Anything you couldn't say in five was outside the
  pitch.
